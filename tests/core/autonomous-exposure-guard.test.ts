import { describe, expect, it, vi } from 'vitest';

const dbRun = vi.fn(() => ({}));
const dbPrepare = vi.fn((sql: string) => {
  if (sql.includes('COUNT(*)')) return { get: () => ({ c: 0 }) };
  return { run: dbRun, all: () => [] };
});
const recordEntryGateDecision = vi.fn();
const executeToolCall = vi.fn(async () => ({
  success: true,
  data: { executed: true, message: 'paper ok' },
}));

vi.mock('../../src/discovery/engine.js', () => ({
  runDiscovery: async () => ({
    clusters: [],
    hypotheses: [],
    expressions: [
      {
        id: 'expr_1',
        hypothesisId: 'hyp_eth',
        symbol: 'ETH',
        side: 'buy',
        signalClass: 'momentum_breakout',
        confidence: 0.8,
        expectedEdge: 0.12,
        entryZone: 'market',
        invalidation: 'below 0.9',
        expectedMove: 'ETH upside continuation',
        orderType: 'market',
        leverage: 3,
        probeSizeUsd: 20,
        newsTrigger: null,
      },
    ],
  }),
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
  evaluateGlobalTradeGate: () => ({ allowed: true }),
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
    observationOnlyUntilMs: null,
    reason: null,
    updatedAt: new Date().toISOString(),
  }),
}));

vi.mock('../../src/memory/trades.js', () => ({
  listOpenPositionsFromTrades: () => [],
}));

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => ({
    exec: vi.fn(),
    prepare: dbPrepare,
  }),
}));

vi.mock('../../src/memory/paper_perps.js', () => ({
  listPaperPerpPositions: () => [
    {
      symbol: 'BTC',
      side: 'long',
      size: 300,
      entryPrice: 1,
      leverage: 1,
      openedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  listPaperPerpPositionsWithMark: () => [
    {
      symbol: 'BTC',
      side: 'long',
      size: 300,
      entryPrice: 1,
      currentMarkPrice: 1,
      leverage: 1,
      unrealizedPnlUsd: 0,
      openedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  getPaperPerpBookSummary: vi.fn(() => ({ cashBalanceUsdc: 100 })),
}));

vi.mock('../../src/memory/position_exit_policy.js', () => ({
  getPositionExitPolicy: () => null,
  upsertPositionExitPolicy: vi.fn(),
}));

vi.mock('../../src/memory/llm_entry_gate_log.js', () => ({
  recordEntryGateDecision,
}));

vi.mock('../../src/core/tool-executor.js', () => ({
  executeToolCall,
}));

const baseConfig = {
  autonomy: {
    enabled: true,
    fullAuto: true,
    scanIntervalSeconds: 300,
    minEdge: 0.05,
    maxTradesPerScan: 1,
    exposure: {
      enabled: true,
      maxGrossLeverage: 3,
      maxNetLeverage: 2,
      maxClusterPercent: 75,
      clusters: { 'crypto-majors': ['BTC', 'ETH'] },
    },
  },
  hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 },
  execution: { mode: 'paper' },
  paper: { initialCashUsdc: 100 },
} as any;

describe('autonomous portfolio exposure guard', () => {
  it('blocks saturated books before the LLM entry gate', async () => {
    vi.clearAllMocks();
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llmComplete = vi.fn();
    const llm = { complete: llmComplete } as any;
    const executor = {
      execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })),
    } as any;
    const marketClient = {
      getMarket: async () => ({ symbol: 'ETH', markPrice: 1, metadata: { maxLeverage: 10 } }),
    } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: true }),
      confirm: vi.fn(),
      release: vi.fn(),
    } as any;

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    const result = await (manager as any).runDiscoveryScan({ executeTrades: true });

    expect(result).toContain('exposure_gross_cap');
    expect(llmComplete).not.toHaveBeenCalled();
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(recordEntryGateDecision).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'ETH',
      verdict: 'reject',
      reasonCode: 'exposure_gross_cap',
      llmConsulted: false,
    }));
  }, 20_000);

  it('bypasses the guard when disabled', async () => {
    vi.clearAllMocks();
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llmComplete = vi.fn(async () => ({
      content: JSON.stringify({
        verdict: 'approve',
        reasoning: 'ok',
        stopLevelPrice: 0.9,
        equityAtRiskPct: 2.5,
        targetRR: 2,
      }),
      model: 'test',
    }));
    const llm = { complete: llmComplete } as any;
    const marketClient = {
      getMarket: async () => ({ symbol: 'ETH', markPrice: 1, metadata: { maxLeverage: 10 } }),
    } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: true }),
      confirm: vi.fn(),
      release: vi.fn(),
    } as any;

    const manager = new AutonomousManager(
      llm,
      llm,
      marketClient,
      { execute: vi.fn() } as any,
      limiter,
      { ...baseConfig, autonomy: { ...baseConfig.autonomy, exposure: { ...baseConfig.autonomy.exposure, enabled: false } } },
    );
    await (manager as any).runDiscoveryScan({ executeTrades: true });

    expect(llmComplete).toHaveBeenCalledTimes(1);
  }, 20_000);
});
