import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TelegramChannelMonitor } from '../../src/intel/telegram_monitor.js';
import { NewsScreenWorker } from '../../src/intel/news_screening.js';
import { closeDatabase, openDatabase } from '../../src/memory/db.js';
import { GatewayNewsRouter } from '../../src/gateway/news_router.js';
import { consumeScheduledNewsDigest, recordNewsRoute } from '../../src/intel/news_routing.js';

const market = {
  id: 'hyper:BRENT', symbol: 'BRENT', question: 'Perp: BRENT', outcomes: ['LONG', 'SHORT'],
  prices: {}, platform: 'hyperliquid', kind: 'perp' as const,
};

describe('monitor to worker to gateway news routing', () => {
  let dbPath = '';
  let tempDir = '';
  let previousDbPath: string | undefined;

  afterEach(() => {
    if (dbPath) closeDatabase(dbPath);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    if (previousDbPath == null) delete process.env.THUFIR_DB_PATH;
    else process.env.THUFIR_DB_PATH = previousDbPath;
    dbPath = '';
    tempDir = '';
  });

  function setup(mode: 'sampled_shadow' | 'full_shadow' | 'active', cap = 4, sampleRate = 1) {
    previousDbPath = process.env.THUFIR_DB_PATH;
    tempDir = mkdtempSync(join(tmpdir(), 'thufir-news-routing-'));
    dbPath = join(tempDir, 'news.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);
    const scan = vi.fn().mockResolvedValue(true);
    const listMarkets = vi.fn().mockResolvedValue([market]);
    const router = new GatewayNewsRouter({
      db,
      rolloutMode: mode,
      scansPerHour: cap,
      marketClient: { isAvailable: () => true, listMarkets, searchMarkets: vi.fn(), getMarket: vi.fn() },
      requestEventScan: scan,
    });
    const monitor = new TelegramChannelMonitor({
      channels: { telegram: { monitor: { newsScreenRollout: mode, newsScreenSampleRate: sampleRate } } },
    } as any, vi.fn());
    return { db, scan, listMarkets, router, monitor };
  }

  function worker(db: Database.Database, router: GatewayNewsRouter) {
    const client = {
      meta: { provider: 'local' as const, model: 'fake', kind: 'trivial' as const },
      complete: vi.fn(async (messages: Array<{ content: string }>) => {
        const text = messages.map((message) => message.content).join('\n').toLowerCase();
        if (text.includes('reply exactly yes or no')) {
          return { model: 'fake', content: text.includes('pharmaceutical') ? 'NO' : 'YES' };
        }
        return { model: 'fake', content: text.includes('brent') ? 'URGENT' : 'ROUTINE' };
      }),
    };
    return new NewsScreenWorker({ client, db, pollIntervalMs: 5, onTerminal: router.onTerminal });
  }

  it('screens non-keyword posts, deduplicates push plus poll, routes urgent mapped news under cap, and batches routine impact', async () => {
    const { db, scan, listMarkets, router, monitor } = setup('active', 2);
    const gold = 'Gold futures drop 0.9% after the dollar strengthens';
    const brentOne = 'Brent crude gains 2.2% after a fresh supply disruption';
    const brentTwo = 'Brent crude gains 2.1% after a fresh supply disruption';
    const brentThree = 'Brent futures tumble as quarterly inventories unexpectedly swell';
    const brentFour = 'Brent contracts jump when a Norwegian terminal shuts during repairs';
    const unrelated = 'Pharmaceutical company announces a new oncology trial';

    await monitor.processMessage(gold, 'marketfeed', new Set(), false);
    await monitor.processMessage(gold, 'marketfeed', new Set(), false); // push, then poll
    await Promise.all([
      monitor.processMessage(brentOne, 'marketfeed', new Set(), false),
      monitor.processMessage(brentTwo, 'marketfeed', new Set(), false),
      monitor.processMessage(brentThree, 'marketfeed', new Set(), false),
      monitor.processMessage(brentFour, 'marketfeed', new Set(), false),
      monitor.processMessage(unrelated, 'marketfeed', new Set(), false),
    ]);

    expect(db.prepare('SELECT COUNT(*) AS count FROM intel_items').get()).toMatchObject({ count: 6 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM news_screen_jobs').get()).toMatchObject({ count: 6 });

    const screeningWorker = worker(db, router);
    while (await screeningWorker.processNext()) { /* process the durable queue one job at a time */ }
    expect(db.prepare("SELECT COUNT(*) AS count FROM news_screen_jobs WHERE status = 'screened'").get()).toMatchObject({ count: 6 });

    const digest = consumeScheduledNewsDigest({ db });
    expect(digest.references).toHaveLength(1);
    expect(digest.text).toContain('Gold futures');
    expect(await router.drainUrgent(10)).toBe(2);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(listMarkets).toHaveBeenCalledOnce();
    expect(scan.mock.calls[0][0]).toMatchObject({ intelId: expect.any(String), source: '@marketfeed' });
    expect(db.prepare("SELECT COUNT(*) AS count FROM gateway_news_routes WHERE route_outcome = 'suppressed_duplicate_event'").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM gateway_news_routes WHERE route_outcome = 'suppressed_hourly_budget'").get()).toMatchObject({ count: 1 });

    const assess = vi.fn().mockResolvedValue('NEWS_IMPACT: Gold exposure is affected by the sharp move; review the existing risk.');
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await router.runRoutineBriefing({ digest, scanResult: 'scheduled scan reviewed held positions and watchlist', recipients: ['1', '2'], assess, send }))
      .toBe('sent');
    expect(assess).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
    await router.runRoutineBriefing({ digest, scanResult: 'same scheduled cycle', recipients: ['1', '2'], assess, send });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps shadow results out of active routing and routine scans', async () => {
    const { db, scan, router, monitor } = setup('full_shadow');
    await monitor.processMessage('Gold futures fall 1.1% as Treasury yields rise', 'marketfeed', new Set(), false);
    const screeningWorker = worker(db, router);
    await screeningWorker.processNext();
    expect(db.prepare("SELECT route_outcome FROM gateway_news_routes").get()).toMatchObject({ route_outcome: 'shadow_only' });
    expect(consumeScheduledNewsDigest({ db }).references).toHaveLength(0);
    expect(await router.drainUrgent()).toBe(0);
    expect(scan).not.toHaveBeenCalled();
  });

  it('records unsampled posts without creating inference work', async () => {
    const { db, router, monitor, listMarkets } = setup('sampled_shadow', 4, 0);
    await monitor.processMessage('Gold futures are modestly lower today', 'marketfeed', new Set(), false);
    expect(db.prepare("SELECT status FROM news_screen_jobs").get()).toMatchObject({ status: 'unsampled' });
    expect(await worker(db, router).processNext()).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM gateway_news_routes').get()).toMatchObject({ count: 0 });
    expect(await router.drainUrgent()).toBe(0);
    expect(listMarkets).not.toHaveBeenCalled();
  });

  it('keeps screened legacy keyword activations during sampled shadow within the safe routing gates', async () => {
    const { db, scan, router, monitor } = setup('sampled_shadow', 4, 0);
    await monitor.processMessage(
      'BREAKING: Brent crude rises after a confirmed supply outage',
      'marketfeed', new Set(['breaking']), false,
    );
    expect(db.prepare('SELECT status FROM news_screen_jobs').get()).toMatchObject({ status: 'pending' });
    await worker(db, router).processNext();
    expect(db.prepare('SELECT legacy_keyword_hit, route_outcome FROM gateway_news_routes').get())
      .toMatchObject({ legacy_keyword_hit: 1, route_outcome: 'pending' });
    expect(scan).not.toHaveBeenCalled();
    expect(await router.drainUrgent()).toBe(1);
    expect(scan).toHaveBeenCalledOnce();
  });

  it('does not send a routine briefing for BREAKING_OK', async () => {
    const { db, router, monitor } = setup('active');
    await monitor.processMessage('Gold futures rise 0.8% while the dollar weakens', 'marketfeed', new Set(), false);
    await worker(db, router).processNext();
    const digest = consumeScheduledNewsDigest({ db });
    const assess = vi.fn().mockResolvedValue('BREAKING_OK');
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await router.runRoutineBriefing({ digest, scanResult: 'normal scan', recipients: ['1'], assess, send })).toBe('no_impact');
    expect(assess).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves routine headlines unacknowledged when the assessment output is malformed', async () => {
    const { db, router, monitor } = setup('active');
    await monitor.processMessage('Gold futures rise 0.8% while the dollar weakens', 'marketfeed', new Set(), false);
    await worker(db, router).processNext();
    const digest = consumeScheduledNewsDigest({ db });
    const assess = vi.fn().mockResolvedValue('maybe gold matters');
    const send = vi.fn().mockResolvedValue(undefined);
    await expect(router.runRoutineBriefing({ digest, scanResult: 'normal scan', recipients: ['1'], assess, send }))
      .rejects.toThrow('malformed_routine_news_assessment');
    expect(send).not.toHaveBeenCalled();
    expect(consumeScheduledNewsDigest({ db }).references).toHaveLength(1);
  });

  it('preserves cooldown suppression and never turns a scan rejection into an order', async () => {
    const { db, monitor } = setup('active');
    await monitor.processMessage('Brent crude jumps after a confirmed pipeline explosion', 'marketfeed', new Set(), false);
    let orderCalls = 0;
    const requestScan = vi.fn(async () => {
      // Represents the existing event cooldown rejecting the activation.
      return false;
    });
    const router = new GatewayNewsRouter({
      db,
      rolloutMode: 'active',
      scansPerHour: 4,
      marketClient: { isAvailable: () => true, listMarkets: async () => [market], searchMarkets: vi.fn(), getMarket: vi.fn() },
      requestEventScan: requestScan,
    });
    await worker(db, router).processNext();
    expect(await router.drainUrgent()).toBe(0);
    expect(requestScan).toHaveBeenCalledOnce();
    expect(orderCalls).toBe(0);
    expect(db.prepare('SELECT route_outcome FROM gateway_news_routes').get()).toMatchObject({ route_outcome: 'suppressed_event_cooldown' });
  });

  it('returns from an 11-post burst while local classification is still held in flight', async () => {
    const { db, monitor, router } = setup('active');
    let release!: (value: { model: string; content: string }) => void;
    const deferred = new Promise<{ model: string; content: string }>((resolve) => { release = resolve; });
    const client = {
      meta: { provider: 'local' as const, model: 'fake', kind: 'trivial' as const },
      complete: vi.fn().mockReturnValueOnce(deferred).mockResolvedValue({ model: 'fake', content: 'NO' }),
    };
    const screeningWorker = new NewsScreenWorker({ client, db, onTerminal: router.onTerminal });
    await monitor.processMessage('Gold and Brent market update 0: futures move by 1%', 'marketfeed', new Set(), false);
    const inFlightClassification = screeningWorker.processNext();
    await Promise.resolve();
    const posts = Array.from({ length: 10 }, (_, offset) => {
      const index = offset + 1;
      return monitor.processMessage(`Gold and Brent market update ${index}: futures move by ${index + 1}%`, 'marketfeed', new Set(), false);
    });
    await Promise.all(posts);
    expect(client.complete).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT COUNT(*) AS count FROM news_screen_jobs').get()).toMatchObject({ count: 11 });
    release({ model: 'fake', content: 'NO' });
    await inFlightClassification;
    while (await screeningWorker.processNext()) { /* drain remaining posts */ }
    expect(db.prepare("SELECT COUNT(*) AS count FROM news_screen_jobs WHERE status = 'screened'").get()).toMatchObject({ count: 11 });
  });

  it('keeps a durable scan dispatch key across router restart', async () => {
    const { db, scan, router, monitor } = setup('active', 4);
    await monitor.processMessage('Brent crude rises after an oil supply shock', 'marketfeed', new Set(), false);
    const screeningWorker = worker(db, router);
    await screeningWorker.processNext();
    expect(await router.drainUrgent()).toBe(1);
    db.prepare("UPDATE gateway_news_routes SET route_outcome = 'pending'").run();
    const restartedRouter = new GatewayNewsRouter({
      db,
      rolloutMode: 'active',
      scansPerHour: 4,
      marketClient: { isAvailable: () => true, listMarkets: async () => [market], searchMarkets: vi.fn(), getMarket: vi.fn() },
      requestEventScan: scan,
    });
    await restartedRouter.drainUrgent();
    expect(scan).toHaveBeenCalledOnce();
  });
});
