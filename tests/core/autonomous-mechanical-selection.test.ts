import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  expressions: [] as Array<Record<string, unknown>>,
  gateVerdicts: [] as Array<'approve' | 'reject' | 'resize'>,
  cooldownSymbol: null as string | null,
  cooldown: null as { lastRejectAt: string; lastEdge: number } | null,
  riskAllowed: true,
}));

const executeToolCall = vi.fn(async () => ({
  success: true,
  data: { executed: true, message: 'ok' },
}));
const dbRun = vi.fn(() => ({}));
const dbPrepare = vi.fn((sql: string) => {
  if (sql.includes('COUNT(*)')) {
    return { get: () => ({ c: 0 }) };
  }
  if (sql.includes('FROM gate_verdict_cooldowns')) {
    return {
      get: ({ symbol }: { symbol: string }) =>
        symbol === testState.cooldownSymbol ? testState.cooldown : null,
    };
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
      {
        id: 'c2',
        symbol: 'ETH/USDT',
        directionalBias: 'up',
        confidence: 0.8,
        timeHorizon: 'hours',
        signals: [],
      },
    ],
    hypotheses: [],
    // Intentionally unsorted to verify deterministic mechanical ranking.
    expressions: testState.expressions,
  }),
}));

testState.expressions = [
      {
        id: 'expr_eth',
        hypothesisId: 'hyp_eth',
        symbol: 'ETH/USDT',
        side: 'buy',
        signalClass: 'momentum_breakout',
        confidence: 0.75,
        expectedEdge: 0.06,
        entryZone: 'market',
        invalidation: 'x',
        expectedMove: 'ETH continuation',
        orderType: 'market',
        leverage: 3,
        probeSizeUsd: 20,
        newsTrigger: null,
        tradePlan: { invalidationPrice: 950, targetPrice: 1100, expectedRMultiple: 2, suggestedTtlMinutes: 120, provenance: 'test-signal' },
      },
      {
        id: 'expr_btc',
        hypothesisId: 'hyp_btc',
        symbol: 'BTC/USDT',
        side: 'buy',
        signalClass: 'momentum_breakout',
        confidence: 0.8,
        expectedEdge: 0.09,
        entryZone: 'market',
        invalidation: 'x',
        expectedMove: 'BTC continuation',
        orderType: 'market',
        leverage: 3,
        probeSizeUsd: 20,
        newsTrigger: null,
        tradePlan: { invalidationPrice: 950, targetPrice: 1100, expectedRMultiple: 2, suggestedTtlMinutes: 120, provenance: 'test-signal' },
      },
    ];

vi.mock('../../src/memory/perp_trades.js', () => ({
  recordPerpTrade: vi.fn(() => 1),
}));

vi.mock('../../src/memory/perp_trade_journal.js', () => ({
  recordPerpTradeJournal: vi.fn(),
  listPerpTradeJournals: () => [],
}));

vi.mock('../../src/execution/perp-risk.js', () => ({
  checkPerpRiskLimits: async () =>
    testState.riskAllowed ? { allowed: true } : { allowed: false, reason: 'risk cap' },
}));

vi.mock('../../src/core/autonomy_policy.js', () => ({
  applyReflectionMutation: () => ({ mutated: false, state: {} }),
  classifyMarketRegime: () => 'trending',
  classifySignalClass: () => 'momentum_breakout',
  computeFractionalKellyFraction: () => 0.25,
  evaluateGlobalTradeGate: () => ({
    allowed: true,
    sizeMultiplier: 0.5,
    reasonCode: 'policy.decision_quality',
    reason: 'quality.segment.downweight: score below threshold',
    policyState: {},
  }),
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

vi.mock('../../src/core/tool-executor.js', () => ({
  executeToolCall,
}));

describe('AutonomousManager mechanical expression selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-16T14:00:00.000Z'));
    testState.gateVerdicts = [];
    testState.cooldownSymbol = null;
    testState.cooldown = null;
    testState.riskAllowed = true;
    executeToolCall.mockClear();
    dbRun.mockClear();
    dbPrepare.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('selects highest-edge expression first without LLM selection call', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const executor = {
      execute: vi.fn(async () => ({ executed: true, message: 'ok' })),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    } as any;
    const marketClient = {
      getMarket: async (symbol: string) => ({ symbol, markPrice: 1000, metadata: { maxLeverage: 10 } }),
    } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    } as any;

    const gateLlm = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({
          verdict: testState.gateVerdicts.shift() ?? 'approve',
          reasoning: 'ok',
          stopLevelPrice: 980,
          equityAtRiskPct: 2.5,
          targetRR: 2.0,
        }),
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

    expect(executeToolCall).toHaveBeenCalledTimes(1);
    const firstToolInput = executeToolCall.mock.calls[0]?.[1];
    expect(firstToolInput?.symbol).toBe('BTC');
    expect(Number(firstToolInput?.size ?? 0)).toBeCloseTo(0.0115, 8);
  }, 20000);

  it('reviews the next ranked candidate after a rejection and executes one trade', async () => {
    testState.expressions = [
      { ...testState.expressions[1], id: 'expr_btc', symbol: 'BTC/USDT', expectedEdge: 0.09 },
      { ...testState.expressions[0], id: 'expr_eth', symbol: 'ETH/USDT', expectedEdge: 0.08 },
      { ...testState.expressions[0], id: 'expr_sol', symbol: 'SOL/USDT', expectedEdge: 0.07 },
    ];
    testState.gateVerdicts = ['reject', 'approve'];
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const gateLlm = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({
          verdict: testState.gateVerdicts.shift() ?? 'reject',
          reasoning: 'test verdict',
          stopLevelPrice: 980,
          equityAtRiskPct: 2.5,
          targetRR: 2.0,
        }),
        model: 'test',
      })),
    } as any;
    const manager = new AutonomousManager(
      gateLlm,
      gateLlm,
      { getMarket: async (symbol: string) => ({ symbol, markPrice: 1000, metadata: { maxLeverage: 10 } }) } as any,
      {} as any,
      { getRemainingDaily: () => 100, checkAndReserve: async () => ({ allowed: true }), confirm: () => {}, release: () => {} } as any,
      {
        autonomy: {
          enabled: true,
          fullAuto: true,
          minEdge: 0.05,
          requireHighConfidence: false,
          maxTradesPerScan: 1,
          maxCandidateReviewsPerScan: 3,
        },
        hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 },
      } as any,
    );

    const result = await manager.runScan();

    expect(gateLlm.complete).toHaveBeenCalledTimes(2);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(executeToolCall.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ symbol: 'ETH' }));
    expect(result).toContain('test verdict');
  }, 20000);

  it('skips a cooled-down top candidate so it cannot starve the next candidate', async () => {
    testState.expressions = [
      { ...testState.expressions[1], id: 'expr_btc', symbol: 'BTC/USDT', expectedEdge: 0.09 },
      { ...testState.expressions[0], id: 'expr_eth', symbol: 'ETH/USDT', expectedEdge: 0.08 },
    ];
    testState.cooldown = {
      lastRejectAt: new Date(Date.now() - 60_000).toISOString(),
      lastEdge: 0.09,
    };
    testState.cooldownSymbol = 'BTC';
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const gateLlm = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ verdict: 'approve', reasoning: 'approved after cooldown skip', stopLevelPrice: 980, equityAtRiskPct: 2.5, targetRR: 2.0 }),
        model: 'test',
      })),
    } as any;
    const manager = new AutonomousManager(
      gateLlm,
      gateLlm,
      { getMarket: async (symbol: string) => ({ symbol, markPrice: 1000, metadata: { maxLeverage: 10 } }) } as any,
      {} as any,
      { getRemainingDaily: () => 100, checkAndReserve: async () => ({ allowed: true }), confirm: () => {}, release: () => {} } as any,
      { autonomy: { enabled: true, fullAuto: true, minEdge: 0.05, maxTradesPerScan: 1, maxCandidateReviewsPerScan: 3, llmEntryGate: { gateCooldownMinutes: 60 } }, hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 } } as any,
    );

    const result = await manager.runScan();

    expect(result).toContain('BTC: Skipped (entry gate cooldown active)');
    expect(gateLlm.complete).toHaveBeenCalledTimes(1);
    expect(executeToolCall.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ symbol: 'ETH' }));
  }, 20000);

  it('caps rejected candidates at three entry reviews', async () => {
    testState.expressions = ['BTC', 'ETH', 'SOL', 'XRP'].map((symbol, index) => ({
      ...testState.expressions[0],
      id: `expr_${symbol.toLowerCase()}`,
      symbol: `${symbol}/USDT`,
      expectedEdge: 0.09 - index * 0.01,
    }));
    testState.gateVerdicts = ['reject', 'reject', 'reject', 'reject'];
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const gateLlm = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ verdict: testState.gateVerdicts.shift() ?? 'reject', reasoning: 'rejected', stopLevelPrice: 980, equityAtRiskPct: 2.5, targetRR: 2.0 }),
        model: 'test',
      })),
    } as any;
    const manager = new AutonomousManager(
      gateLlm,
      gateLlm,
      { getMarket: async (symbol: string) => ({ symbol, markPrice: 1000, metadata: { maxLeverage: 10 } }) } as any,
      {} as any,
      { getRemainingDaily: () => 100, checkAndReserve: async () => ({ allowed: true }), confirm: () => {}, release: () => {} } as any,
      { autonomy: { enabled: true, fullAuto: true, minEdge: 0.05, maxTradesPerScan: 1, maxCandidateReviewsPerScan: 3 }, hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 } } as any,
    );

    const result = await manager.runScan();

    expect(gateLlm.complete).toHaveBeenCalledTimes(3);
    expect(executeToolCall).not.toHaveBeenCalled();
    expect(result).not.toContain('XRP');
  }, 20000);

  it('stops after one successful execution even when another candidate would approve', async () => {
    testState.expressions = [
      { ...testState.expressions[1], id: 'expr_btc', symbol: 'BTC/USDT', expectedEdge: 0.09 },
      { ...testState.expressions[0], id: 'expr_eth', symbol: 'ETH/USDT', expectedEdge: 0.08 },
    ];
    testState.gateVerdicts = ['approve', 'approve'];
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const gateLlm = {
      complete: vi.fn(async () => ({ content: JSON.stringify({ verdict: testState.gateVerdicts.shift() ?? 'approve', reasoning: 'approved', stopLevelPrice: 980, equityAtRiskPct: 2.5, targetRR: 2.0 }), model: 'test' })),
    } as any;
    const manager = new AutonomousManager(
      gateLlm,
      gateLlm,
      { getMarket: async (symbol: string) => ({ symbol, markPrice: 1000, metadata: { maxLeverage: 10 } }) } as any,
      {} as any,
      { getRemainingDaily: () => 100, checkAndReserve: async () => ({ allowed: true }), confirm: () => {}, release: () => {} } as any,
      { autonomy: { enabled: true, fullAuto: true, minEdge: 0.05, maxTradesPerScan: 1, maxCandidateReviewsPerScan: 3 }, hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 } } as any,
    );

    await manager.runScan();

    expect(gateLlm.complete).toHaveBeenCalledTimes(1);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  }, 20000);

  it('skips an unresolvable market and continues to the next ranked candidate', async () => {
    testState.expressions = [
      { ...testState.expressions[1], id: 'expr_ambiguous', symbol: 'SOL/USDT', expectedEdge: 0.09 },
      { ...testState.expressions[0], id: 'expr_eth', symbol: 'ETH/USDT', expectedEdge: 0.08 },
    ];
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const gateLlm = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ verdict: 'approve', reasoning: 'approved', stopLevelPrice: 980, equityAtRiskPct: 2.5, targetRR: 2.0 }),
        model: 'test',
      })),
    } as any;
    const manager = new AutonomousManager(
      gateLlm,
      gateLlm,
      { getMarket: async (symbol: string) => {
        if (symbol === 'SOL') throw new Error('Ambiguous Hyperliquid market symbol SOL');
        return { symbol, markPrice: 1000, metadata: { maxLeverage: 10 } };
      } } as any,
      {} as any,
      { getRemainingDaily: () => 100, checkAndReserve: async () => ({ allowed: true }), confirm: () => {}, release: () => {} } as any,
      { autonomy: { enabled: true, fullAuto: true, minEdge: 0.05, maxTradesPerScan: 1, maxCandidateReviewsPerScan: 3 }, hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 } } as any,
    );

    const result = await manager.runScan();

    expect(result).toContain('SOL: Skipped (market resolution failed');
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(executeToolCall.mock.calls[0]?.[1]?.symbol).toBe('ETH');
  }, 20000);

  it('keeps risk checks before entry review and execution', async () => {
    testState.riskAllowed = false;
    testState.expressions = [
      { ...testState.expressions[1], id: 'expr_btc', symbol: 'BTC/USDT', expectedEdge: 0.09 },
    ];
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const gateLlm = { complete: vi.fn() } as any;
    const manager = new AutonomousManager(
      gateLlm,
      gateLlm,
      { getMarket: async (symbol: string) => ({ symbol, markPrice: 1000, metadata: { maxLeverage: 10 } }) } as any,
      {} as any,
      { getRemainingDaily: () => 100, checkAndReserve: async () => ({ allowed: true }), confirm: () => {}, release: () => {} } as any,
      { autonomy: { enabled: true, fullAuto: true, minEdge: 0.05, maxTradesPerScan: 1, maxCandidateReviewsPerScan: 3 }, hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 } } as any,
    );

    const result = await manager.runScan();

    expect(result).toContain('risk cap');
    expect(gateLlm.complete).not.toHaveBeenCalled();
    expect(executeToolCall).not.toHaveBeenCalled();
  }, 20000);
});
