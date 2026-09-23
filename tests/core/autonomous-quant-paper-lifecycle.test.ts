import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const runDiscovery = vi.hoisted(() => vi.fn());
vi.mock('../../src/discovery/engine.js', () => ({ runDiscovery }));
vi.mock('../../src/execution/perp-risk.js', () => ({
  checkPerpRiskLimits: async () => ({ allowed: true }),
}));

import { closeDatabase, openDatabase } from '../../src/memory/db.js';
import { AutonomousManager } from '../../src/core/autonomous.js';

describe('autonomous quant paper entry lifecycle', () => {
  let dbDir: string;
  let previousDbPath: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-02-16T14:00:00.000Z'));
    previousDbPath = process.env.THUFIR_DB_PATH;
    dbDir = mkdtempSync(join(tmpdir(), 'quant-paper-lifecycle-'));
    process.env.THUFIR_DB_PATH = join(dbDir, 'runtime.sqlite');
    runDiscovery.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeDatabase(process.env.THUFIR_DB_PATH);
    rmSync(dbDir, { recursive: true, force: true });
    if (previousDbPath === undefined) delete process.env.THUFIR_DB_PATH;
    else process.env.THUFIR_DB_PATH = previousDbPath;
    expect(existsSync(dbDir)).toBe(false);
  });

  it('transports quant evidence through the real gate and persists an approved paper open', async () => {
    const expression = {
      id: 'expr_quant_runtime',
      hypothesisId: 'hyp_quant_runtime',
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      signalClass: 'momentum_breakout' as const,
      marketRegime: 'trending' as const,
      volatilityBucket: 'medium' as const,
      liquidityBucket: 'deep' as const,
      confidence: 0.9,
      expectedEdge: 0.2,
      entryZone: 'market',
      invalidation: '95',
      expectedMove: 'Controlled directional continuation',
      orderType: 'market' as const,
      leverage: 1,
      probeSizeUsd: 10,
      tradePlan: { invalidationPrice: 95, targetPrice: 110, expectedRMultiple: 2, suggestedTtlMinutes: 90, provenance: 'strategy' as const },
      newsTrigger: null,
      contextPack: {
        regime: {
          marketRegime: 'trending' as const,
          volatilityBucket: 'medium' as const,
          liquidityBucket: 'deep' as const,
          confidence: 0.9,
          source: 'provider' as const,
        },
        executionQuality: {
          status: 'good' as const,
          score: 0.9,
          recentWinRate: null,
          slippageBps: null,
          notes: ['provider-confirmed execution quality'],
          source: 'provider' as const,
        },
        event: {
          kind: 'technical' as const,
          subtype: null,
          catalyst: 'Trend continuation evidence',
          confidence: null,
          expiresAtMs: null,
          source: 'derived' as const,
        },
        portfolioState: {
          posture: 'neutral' as const,
          availableBalanceUsd: null,
          netExposureUsd: null,
          openPositions: null,
          source: 'default' as const,
        },
        missing: [],
      },
    };
    const cluster = {
      id: 'cluster_quant_runtime',
      symbol: 'BTC/USDT',
      directionalBias: 'up' as const,
      confidence: 0.9,
      timeHorizon: 'hours' as const,
      signals: [{
        id: 'price_quant_runtime',
        kind: 'price_vol_regime' as const,
        symbol: 'BTC/USDT',
        directionalBias: 'up' as const,
        confidence: 0.9,
        timeHorizon: 'hours' as const,
        metrics: { trend: 0.03, volZ: 0.4 },
      }],
    };
    runDiscovery.mockResolvedValueOnce({
      clusters: [cluster],
      hypotheses: [],
      expressions: [expression],
      selector: { source: 'configured', symbols: ['BTC'] },
    });

    const { PaperExecutor } = await import('../../src/execution/modes/paper.js');
    const approve = JSON.stringify({
      verdict: 'approve',
      reasoning: 'Controlled evidence-backed approval',
      stopLevelPrice: 95,
      equityAtRiskPct: 99,
      targetRR: null,
      suggestedLeverage: 1,
    });
    const complete = vi.fn(async () => ({ content: approve, model: 'controlled' }));
    const marketClient = {
      getMarket: vi.fn(async () => ({
        symbol: 'BTC',
        markPrice: 100,
        kind: 'perp',
        metadata: { maxLeverage: 10 },
      })),
    } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    } as any;
    const config = {
      execution: { mode: 'paper', provider: 'hyperliquid' },
      paper: { initialCashUsdc: 200 },
      autonomy: {
        enabled: true,
        fullAuto: true,
        minEdge: 0.05,
        maxTradesPerScan: 1,
        maxCandidateReviewsPerScan: 1,
        llmEntryGate: { enabled: true, gateCooldownMinutes: 0 },
      },
      hyperliquid: { maxLeverage: 10, minOrderNotionalUsd: 10 },
      wallet: { limits: { daily: 100 } },
    } as any;
    const manager = new AutonomousManager(
      { complete } as any,
      { complete } as any,
      marketClient,
      new PaperExecutor({ initialCashUsdc: 200 }),
      limiter,
      config,
    );

    const result = await manager.runScan();
    expect(result).toContain('symbol=BTC side=buy');
    expect(complete).toHaveBeenCalledOnce();
    const messages = complete.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    const prompt = messages.find((message) => message.role === 'user')?.content ?? '';
    expect(prompt).toContain('Liquidity bucket: deep');
    expect(prompt).toContain('Trend bias: up');
    expect(prompt).toContain('Execution score: 0.90');
    expect(prompt).toContain('provider-confirmed execution quality');
    expect(prompt).toContain('"source":"discovery"');
    expect(prompt).toContain('Missing numeric plan fields: none');
    expect(prompt).not.toMatch(/undefinedR|undefinedmin/);

    const db = openDatabase();
    const gate = db.prepare(`
      SELECT verdict, reason_code, equity_at_risk_pct, model_equity_at_risk_pct,
             risk_source, account_equity_usd, stop_provenance, missing_plan_fields,
             stop_level_price, target_rr
      FROM llm_entry_gate_log WHERE symbol = 'BTC' ORDER BY id DESC LIMIT 1
    `).get() as any;
    expect(gate).toMatchObject({
      verdict: 'approve',
      reason_code: 'approve',
      equity_at_risk_pct: 0.25,
      model_equity_at_risk_pct: 99,
      risk_source: 'calculated',
      account_equity_usd: 200,
      stop_provenance: 'thesis_derived',
      missing_plan_fields: '[]',
      stop_level_price: 95,
      target_rr: null,
    });

    const trade = db.prepare(
      'SELECT id, symbol, side, execution_mode, status FROM perp_trades ORDER BY id DESC LIMIT 1'
    ).get() as any;
    expect(trade).toMatchObject({
      symbol: 'BTC', side: 'buy', execution_mode: 'paper', status: 'position_open',
    });
    const fill = db.prepare(
      'SELECT order_id, symbol, side, fill_price FROM paper_perp_fills ORDER BY id DESC LIMIT 1'
    ).get() as any;
    expect(fill).toMatchObject({ symbol: 'BTC', side: 'buy' });
    expect(Number(fill.fill_price)).toBeCloseTo(100.05, 8);
    const position = db.prepare(
      'SELECT symbol, side, size, entry_price FROM paper_perp_positions ORDER BY updated_at DESC LIMIT 1'
    ).get() as any;
    expect(position).toMatchObject({ symbol: 'BTC', side: 'long' });
    expect(Number(position.entry_price)).toBeCloseTo(100.05, 8);
    const journalRow = db.prepare(
      "SELECT payload FROM decision_artifacts WHERE kind = 'perp_trade_journal' AND outcome = 'executed' ORDER BY id DESC LIMIT 1"
    ).get() as any;
    const journal = JSON.parse(journalRow.payload);
    expect(journal).toMatchObject({
      outcome: 'executed', tradeId: trade.id, symbol: 'BTC',
      entryGateVerdict: gate.verdict, entryGateReasonCode: gate.reason_code,
    });
  }, 30_000);
});
