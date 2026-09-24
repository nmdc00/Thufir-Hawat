import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmClient } from '../../src/core/llm.js';

const previousDbPath = process.env.THUFIR_DB_PATH;
let dbPath: string;
let db: Awaited<ReturnType<typeof import('../../src/memory/db.js')['openDatabase']>>;
let closeDatabase: typeof import('../../src/memory/db.js')['closeDatabase'];
let screening: typeof import('../../src/intel/news_screening.js');

describe('durable news screening', () => {
  beforeEach(async () => {
    vi.resetModules();
    dbPath = join(mkdtempSync(join(tmpdir(), 'news-screen-')), 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const memory = await import('../../src/memory/db.js');
    closeDatabase = memory.closeDatabase;
    db = memory.openDatabase();
    screening = await import('../../src/intel/news_screening.js');
    db.prepare(`INSERT INTO intel_items (id, title, content, source, source_type, timestamp)
      VALUES ('intel-1', 'Gold falls nearly 1%', 'Spot gold dropped', '@marketfeed', 'news', ?)`).run(new Date().toISOString());
  });

  afterEach(() => {
    closeDatabase(dbPath);
    vi.resetModules();
    rmSync(dbPath, { force: true });
    rmSync(dirname(dbPath), { recursive: true, force: true });
    if (previousDbPath === undefined) delete process.env.THUFIR_DB_PATH;
    else process.env.THUFIR_DB_PATH = previousDbPath;
  });

  it('enqueues idempotently and persists a terminal NO without urgency inference', async () => {
    const activation = { id: 'activation-1', intelId: 'intel-1', source: '@marketfeed', text: 'Gold falls nearly 1%', receivedAtMs: 10, matchedKeyword: '' };
    expect(screening.enqueueNewsScreenJob('intel-1', activation)).toBe(true);
    expect(screening.enqueueNewsScreenJob('intel-1', activation)).toBe(true);
    const complete = vi.fn(async () => ({ content: 'NO', model: 'fake' }));
    const onTerminal = vi.fn();
    const worker = new screening.NewsScreenWorker({ client: { complete, meta: { provider: 'local', model: 'fake' } } as LlmClient, db, onTerminal });

    expect(await worker.processNext()).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ intelId: 'intel-1', source: '@marketfeed', activation, screen: { relevance: 'irrelevant', urgency: 'none' }, attempts: 1 }));
    expect(db.prepare('SELECT status, verdict, attempts FROM news_screen_jobs').get()).toEqual({ status: 'screened', verdict: 'NO', attempts: 1 });
    expect(await worker.processNext()).toBe(false);
  });

  it('routes a persisted terminal result again after callback failure without reclassifying', async () => {
    screening.enqueueNewsScreenJob('intel-1');
    const complete = vi.fn().mockResolvedValue({ content: 'NO', model: 'fake' });
    const callback = vi.fn().mockRejectedValueOnce(new Error('gateway unavailable')).mockResolvedValue(undefined);
    const worker = new screening.NewsScreenWorker({ client: { complete, meta: { provider: 'local', model: 'fake' } } as LlmClient, db, onTerminal: callback, pollIntervalMs: 1 });

    await worker.processNext();
    expect(db.prepare('SELECT status, attempts FROM news_screen_jobs').get()).toEqual({ status: 'routing', attempts: 1 });
    db.prepare("UPDATE news_screen_jobs SET lease_until = '2000-01-01T00:00:00.000Z'").run();
    await worker.processNext();

    expect(complete).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT status, attempts, verdict FROM news_screen_jobs').get()).toEqual({ status: 'screened', attempts: 1, verdict: 'NO' });
  });

  it('leaves a relevant job pending when the hourly call budget suppresses urgency inference', async () => {
    screening.enqueueNewsScreenJob('intel-1');
    const complete = vi.fn().mockResolvedValue({ content: 'YES', model: 'fake' });
    const worker = new screening.NewsScreenWorker({ client: { complete, meta: { provider: 'local', model: 'fake' } } as LlmClient, db, maxCallsPerMinute: 1 });

    await worker.processNext();

    expect(complete).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT status, attempts, verdict, error FROM news_screen_jobs').get()).toMatchObject({ status: 'pending', attempts: 0, verdict: null, error: 'budget_suppressed' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM news_screen_call_log').get()).toEqual({ count: 1 });
  });

  it('retries malformed responses twice, then records a visible failed outcome', async () => {
    screening.enqueueNewsScreenJob('intel-1');
    const complete = vi.fn(async () => ({ content: 'uncertain', model: 'fake' }));
    const worker = new screening.NewsScreenWorker({ client: { complete, meta: { provider: 'local', model: 'fake' } } as LlmClient, db });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await worker.processNext()).toBe(true);
      if (attempt < 2) db.prepare("UPDATE news_screen_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
    }
    expect(complete).toHaveBeenCalledTimes(3);
    expect(db.prepare('SELECT status, verdict, attempts, error FROM news_screen_jobs').get()).toMatchObject({ status: 'failed', verdict: null, attempts: 3, error: 'malformed_model_response' });
  });

  it('atomically rolls back intel storage if its screening job cannot be inserted', async () => {
    db.exec(`CREATE TRIGGER fail_news_job BEFORE INSERT ON news_screen_jobs BEGIN SELECT RAISE(ABORT, 'injected enqueue failure'); END`);
    expect(() => screening.storeIntelAndEnqueueNewsScreenJob({
      id: 'intel-atomic', title: 'Brent rises', content: 'Brent +2%', source: '@marketfeed', sourceType: 'news', timestamp: new Date().toISOString(),
    })).toThrow('injected enqueue failure');
    expect(db.prepare("SELECT 1 FROM intel_items WHERE id = 'intel-atomic'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM intel_hashes WHERE intel_id = 'intel-atomic'").get()).toBeUndefined();
  });

  it('persists sampled-out posts explicitly without admitting a classifier call', async () => {
    expect(screening.storeIntelAndMarkNewsScreenUnsampled({
      id: 'intel-unsampled', title: 'Digest', content: 'Broad market digest', source: '@marketfeed', sourceType: 'news', timestamp: new Date().toISOString(),
    })).toBe(true);
    expect(db.prepare("SELECT status, verdict FROM news_screen_jobs WHERE intel_id = 'intel-unsampled'").get()).toEqual({ status: 'unsampled', verdict: null });
  });

  it('reclaims an expired lease after worker restart and reads the stored item', async () => {
    const activation = { id: 'activation-1', intelId: 'intel-1', source: '@marketfeed', text: 'Gold falls nearly 1%', receivedAtMs: 10, matchedKeyword: '' };
    screening.enqueueNewsScreenJob('intel-1', activation);
    db.prepare(`UPDATE news_screen_jobs SET status = 'processing', attempts = 1,
      lease_until = '2000-01-01T00:00:00.000Z'`).run();
    closeDatabase(dbPath);
    vi.resetModules();
    const memory = await import('../../src/memory/db.js');
    closeDatabase = memory.closeDatabase;
    db = memory.openDatabase();
    screening = await import('../../src/intel/news_screening.js');
    const complete = vi.fn().mockResolvedValueOnce({ content: 'YES', model: 'fake' }).mockResolvedValueOnce({ content: 'URGENT', model: 'fake' });
    const onTerminal = vi.fn();
    const restartedWorker = new screening.NewsScreenWorker({ client: { complete, meta: { provider: 'local', model: 'fake' } } as LlmClient, db, onTerminal });

    expect(await restartedWorker.processNext()).toBe(true);
    expect(complete.mock.calls[0]?.[0][1]?.content).toContain('Gold falls nearly 1%');
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ intelId: 'intel-1', source: '@marketfeed', activation, screen: { relevance: 'relevant', urgency: 'urgent' }, attempts: 2 }));
    expect(db.prepare('SELECT status, verdict, urgency, attempts FROM news_screen_jobs').get()).toEqual({ status: 'screened', verdict: 'YES', urgency: 'urgent', attempts: 2 });
  });
});
