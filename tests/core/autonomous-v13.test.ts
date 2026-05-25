import { describe, expect, it, vi } from 'vitest';

const recordPerpTradeJournal = vi.fn();
const recordPerpTrade = vi.fn(() => 1);
const dbRun = vi.fn(() => ({}));
const dbPrepare = vi.fn((sql: string) => {
  if (sql.includes('COUNT(*)')) {
    return { get: () => ({ c: 0 }) };
  }
  return { run: dbRun, all: () => [] };
});
const dbExec = vi.fn();
let mockObservationOnlyUntilMs = Date.now() + 60_000;

vi.mock('../../src/discovery/engine.js', () => ({
  runDiscovery: async () => ({
    clusters: [
      {
        id: 'c1',
        symbol: 'BTC/USDT',
        directionalBias: 'up',
        confidence: 0.8,
        timeHorizon: 'hours',
        signals: [
          {
            id: 's1',
            kind: 'price_vol_regime',
            symbol: 'BTC/USDT',
            directionalBias: 'up',
            confidence: 0.8,
            timeHorizon: 'hours',
            metrics: { trend: 0.02, volZ: 0.4 },
          },
          {
            id: 's2',
            kind: 'orderflow_imbalance',
            symbol: 'BTC/USDT',
            directionalBias: 'up',
            confidence: 0.7,
            timeHorizon: 'minutes',
            metrics: { tradeCount: 8, imbalance: 0.3 },
          },
        ],
      },
    ],
    hypotheses: [],
    expressions: [
      {
        id: 'expr_1',
        hypothesisId: 'hyp_BTC_trend',
        symbol: 'BTC/USDT',
        side: 'buy',
        signalClass: 'momentum_breakout',
        confidence: 0.8,
        expectedEdge: 0.08,
        entryZone: 'market',
        invalidation: 'x',
        expectedMove: 'BTC sees upside continuation',
        orderType: 'market',
        leverage: 5,
        probeSizeUsd: 20,
        newsTrigger: null,
      },
    ],
  }),
}));

vi.mock('../../src/memory/perp_trades.js', () => ({
  recordPerpTrade,
}));

vi.mock('../../src/memory/perp_trade_journal.js', () => ({
  recordPerpTradeJournal,
  listPerpTradeJournals: () => [],
}));

vi.mock('../../src/execution/perp-risk.js', () => ({
  checkPerpRiskLimits: async () => ({ allowed: true }),
}));

vi.mock('../../src/core/autonomy_policy.js', () => ({
  applyReflectionMutation: () => ({ mutated: false, state: {} }),
  classifyMarketRegime: () => 'trending',
  classifySignalClass: () => 'momentum_breakout',
  computeFractionalKellyFraction: () => 0.25,
  evaluateGlobalTradeGate: () => ({ allowed: true, policyState: {} }),
  evaluateNewsEntryGate: () => ({ allowed: true }),
  isSignalClassAllowedForRegime: () => true,
  resolveLiquidityBucket: () => 'normal',
  resolveVolatilityBucket: () => 'medium',
}));

vi.mock('../../src/core/signal_performance.js', () => ({
  summarizeSignalPerformance: () => ({ sampleCount: 0, expectancy: 0.5, variance: 0.5 }),
}));

vi.mock('../../src/memory/autonomy_policy_state.js', () => ({
  getAutonomyPolicyState: () => ({
    minEdgeOverride: null,
    maxTradesPerScanOverride: null,
    leverageCapOverride: null,
    observationOnlyUntilMs: mockObservationOnlyUntilMs,
    reason: 'test observation',
    updatedAt: new Date().toISOString(),
  }),
}));

vi.mock('../../src/core/daily_pnl.js', () => ({
  getDailyPnLRollup: () => ({ realizedPnl: 0, unrealizedPnl: 0, totalPnl: 0, byDomain: [] }),
}));

vi.mock('../../src/memory/trades.js', () => ({
  listOpenPositionsFromTrades: () => [],
}));

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => ({
    exec: dbExec,
    prepare: dbPrepare,
  }),
}));

vi.mock('../../src/memory/paper_perps.js', () => ({
  listPaperPerpPositions: () => [],
  listPaperPerpPositionsWithMark: () => [],
  getPaperPerpBookSummary: () => ({ cashBalanceUsdc: 200 }),
}));

vi.mock('../../src/memory/position_exit_policy.js', () => ({
  getPositionExitPolicy: () => null,
  upsertPositionExitPolicy: vi.fn(),
}));

vi.mock('../../src/memory/llm_entry_gate_log.js', () => ({
  recordEntryGateDecision: vi.fn(),
}));

const executeToolCall = vi.fn(async () => {
  recordPerpTrade();
  return {
    success: true,
    data: { executed: true, message: 'ok' },
  };
});

vi.mock('../../src/core/tool-executor.js', () => ({
  executeToolCall,
}));

describe('AutonomousManager v1.3 observation mode', () => {
  it('suppresses live execution and journals would-trade entries when observation-only is active', async () => {
    mockObservationOnlyUntilMs = Date.now() + 60_000;
    const { AutonomousManager } = await import('../../src/core/autonomous.js');

    const executor = {
      execute: vi.fn(async () => ({ executed: true, message: 'ok' })),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    } as any;
    const marketClient = {
      getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }),
    } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    } as any;

    const manager = new AutonomousManager(
      {} as any,
      {} as any,
      marketClient,
      executor,
      limiter,
      {
        autonomy: { enabled: true, fullAuto: true, scanIntervalSeconds: 300, minEdge: 0.05, maxTradesPerScan: 3 },
        hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 },
      } as any
    );

    const text = await manager.runScan();

    expect(text).toContain('observation-only mode');
    expect(text).toContain('context_pack{');
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(recordPerpTradeJournal).toHaveBeenCalled();
    expect(recordPerpTrade).not.toHaveBeenCalled();
  });

  it('records autonomous_trades rows when autonomous execution runs', async () => {
    mockObservationOnlyUntilMs = null;
    dbRun.mockClear();
    dbPrepare.mockClear();
    recordPerpTrade.mockClear();

    const { AutonomousManager } = await import('../../src/core/autonomous.js');

    const executor = {
      execute: vi.fn(async () => ({ executed: true, message: 'ok' })),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    } as any;
    const marketClient = {
      getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }),
    } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    } as any;

    const gateLlm = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ verdict: 'approve', reasoning: 'ok' , stopLevelPrice: 68000, equityAtRiskPct: 2.5, targetRR: 2.0 }),
        model: 'test',
      })),
    } as any;

    const manager = new AutonomousManager(
      gateLlm,
      gateLlm,
      marketClient,
      executor,
      limiter,
      {
        autonomy: { enabled: true, fullAuto: true, scanIntervalSeconds: 300, minEdge: 0.05, maxTradesPerScan: 3 },
        hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 },
      } as any
    );

    await manager.runScan();

    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(recordPerpTrade).toHaveBeenCalled();
    expect(
      dbPrepare.mock.calls.some((args) => String(args[0]).includes('INSERT INTO autonomous_trades'))
    ).toBe(true);
    expect(dbRun).toHaveBeenCalled();
  });
});
