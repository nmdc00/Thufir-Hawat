import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbRun = vi.fn(() => ({}));
const dbPrepare = vi.fn((sql: string) => {
  if (sql.includes('COUNT(*)')) {
    return { get: () => ({ c: 0 }) };
  }
  return { run: dbRun, all: () => [] };
});
const dbExec = vi.fn();

vi.mock('../../src/discovery/engine.js', () => ({
  runDiscovery: async () => ({
    clusters: [
      {
        id: 'c1',
        symbol: 'BTC/USDT',
        directionalBias: 'up',
        confidence: 0.8,
        timeHorizon: 'hours',
        signals: [],
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
  recordPerpTrade: vi.fn(() => 1),
}));

vi.mock('../../src/memory/perp_trade_journal.js', () => ({
  recordPerpTradeJournal: vi.fn(),
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
  inferBroadMarketPosture: () => 'neutral',
  isSignalClassAllowedForRegime: () => true,
  resolveLiquidityBucket: () => 'normal',
  resolveVolatilityBucket: () => 'medium',
}));

vi.mock('../../src/core/signal_performance.js', () => ({
  summarizeSignalPerformance: () => ({ sampleCount: 0, expectancy: 0.5, variance: 0.5 }),
  summarizeComparableSignalPerformance: () => ({ sampleCount: 0, expectancy: 0.5, variance: 0.5 }),
}));

vi.mock('../../src/memory/autonomy_policy_state.js', () => ({
  getAutonomyPolicyState: () => ({
    minEdgeOverride: null,
    maxTradesPerScanOverride: null,
    leverageCapOverride: null,
    observationOnlyUntilMs: null,
    reason: null,
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

describe('AutonomousManager scan snapshot reuse', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T00:00:00.000Z'));
    vi.clearAllMocks();
  });

  it('includes scan snapshot metadata in execution reasoning', async () => {
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
        content: JSON.stringify({ verdict: 'approve', reasoning: 'ok' , stopLevelPrice: null, equityAtRiskPct: 2.5, targetRR: 2.0 }),
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
        autonomy: { enabled: true, fullAuto: true, scanIntervalSeconds: 300, minEdge: 0.05, maxTradesPerScan: 1 },
        hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 },
      } as any
    );

    await manager.runScan();

    const reasoning = String(executor.execute.mock.calls[0]?.[1]?.reasoning ?? '');
    expect(reasoning).toContain('snapshotId=scan_');
    expect(reasoning).toContain('snapshotTs=');
    expect(reasoning).toContain('snapshotAgeMs=');
  });
});
