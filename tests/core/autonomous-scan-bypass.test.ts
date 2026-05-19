/**
 * autonomous-scan-bypass.test.ts
 *
 * Verifies that the autonomous scan pipeline (discovery → filter → evaluate) does NOT
 * invoke the LLM beyond the intentional entry gate call (v1.97).
 * The entry gate makes exactly 1 LLM call per trade candidate before execution.
 * Only the synthesis/enrichment step after trade execution may use it additionally.
 */
import { describe, expect, it, vi } from 'vitest';

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
        expectedEdge: 0.12,
        entryZone: 'market',
        invalidation: 'x',
        expectedMove: 'BTC sees upside continuation',
        orderType: 'market',
        leverage: 3,
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
  evaluateGlobalTradeGate: () => ({ allowed: true }),
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
  getPaperPerpBookSummary: vi.fn(() => ({ cashBalanceUsdc: 200 })),
}));

vi.mock('../../src/memory/position_exit_policy.js', () => ({
  getPositionExitPolicy: () => null,
  upsertPositionExitPolicy: vi.fn(),
}));

vi.mock('../../src/memory/llm_entry_gate_log.js', () => ({
  recordEntryGateDecision: vi.fn(),
}));

const baseConfig = {
  autonomy: {
    enabled: true,
    fullAuto: true,
    scanIntervalSeconds: 300,
    minEdge: 0.05,
    maxTradesPerScan: 1,
  },
  hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 },
} as any;

describe('autonomous scan bypass — LLM not called for discovery/filter/evaluate', () => {
  it('completes a full scan — entry gate makes exactly 1 LLM call per candidate (no enrichment)', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    // Gate returns approve so execution proceeds; async enrichment disabled.
    const llmComplete = vi.fn(async () => ({
      content: JSON.stringify({ verdict: 'approve', reasoning: 'ok' , stopLevelPrice: null, equityAtRiskPct: 2.5, targetRR: 2.0 }),
      model: 'test',
    }));
    const llm = { complete: llmComplete } as any;
    const executor = {
      execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })),
    } as any;
    const marketClient = {
      getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }),
    } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: true }),
      confirm: vi.fn(),
      release: vi.fn(),
    } as any;

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan();

    // Exactly 1 LLM call: the entry gate. Discovery/filter/evaluate pipeline is deterministic.
    // No enrichment (asyncEnrichment disabled by default), so no additional calls.
    expect(llmComplete).toHaveBeenCalledTimes(1);
  });

  it('calls LLM exactly twice for gate + async enrichment when asyncEnrichment is enabled', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    // First call: entry gate (returns approve JSON), second call: enrichment synthesis
    const llmComplete = vi.fn()
      .mockResolvedValueOnce({ content: JSON.stringify({ verdict: 'approve', reasoning: 'go' , stopLevelPrice: null, equityAtRiskPct: 2.5, targetRR: 2.0 }), model: 'test' })
      .mockResolvedValue({ content: 'trade annotated', model: 'test' });
    const llm = { complete: llmComplete } as any;
    const executor = {
      execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })),
    } as any;
    const marketClient = {
      getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }),
    } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: true }),
      confirm: vi.fn(),
      release: vi.fn(),
    } as any;

    const configWithEnrichment = {
      ...baseConfig,
      autonomy: {
        ...baseConfig.autonomy,
        asyncEnrichment: { enabled: true, timeoutMs: 2000, maxChars: 200 },
      },
    };

    const manager = new AutonomousManager(
      llm,
      llm,
      marketClient,
      executor,
      limiter,
      configWithEnrichment
    );
    await manager.runScan();

    // Wait for the async enrichment fire-and-forget to complete
    await new Promise((r) => setTimeout(r, 50));

    // 2 LLM calls: 1 for entry gate (approve), 1 for async enrichment synthesis
    // Not 3+ (no orchestrator plan+execute pattern)
    expect(llmComplete).toHaveBeenCalledTimes(2);
    // The enrichment call (2nd) is a simple role-based message, not a plan payload
    const [messages] = llmComplete.mock.calls[1]!;
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[1]).toMatchObject({ role: 'user' });
  });

  it('scan returns expression results without touching LLM when no trades meet threshold', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llmComplete = vi.fn();
    const llm = { complete: llmComplete } as any;
    const executor = { execute: vi.fn() } as any;
    const marketClient = {
      getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: {} }),
    } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: false, reason: 'test limit' }),
      confirm: vi.fn(),
      release: vi.fn(),
    } as any;

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    const result = await manager.runScan();

    expect(result).toBeTruthy();
    expect(llmComplete).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('skips the entry gate entirely when autonomy.llmEntryGate.enabled is false', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llmComplete = vi.fn();
    const llm = { complete: llmComplete } as any;
    const executor = {
      execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })),
    } as any;
    const marketClient = {
      getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }),
    } as any;
    const limiter = {
      getRemainingDaily: () => 100,
      checkAndReserve: async () => ({ allowed: true }),
      confirm: vi.fn(),
      release: vi.fn(),
    } as any;

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, {
      ...baseConfig,
      autonomy: {
        ...baseConfig.autonomy,
        llmEntryGate: { enabled: false },
      },
    });
    await manager.runScan();

    expect(llmComplete).not.toHaveBeenCalled();
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('equity guard: blocks new entries when free cash is zero (ignores unrealized PnL)', async () => {
    // Previously the guard used cashBalanceUsdc + unrealizedPnl, allowing trades while
    // unrealized gains masked exhausted free cash. Now it uses cashBalanceUsdc only.
    const { getPaperPerpBookSummary } = await import('../../src/memory/paper_perps.js');
    vi.mocked(getPaperPerpBookSummary).mockReturnValue({ cashBalanceUsdc: 0 } as any);

    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const llm = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: 'approve', reasoning: 'ok' , stopLevelPrice: null, equityAtRiskPct: 2.5, targetRR: 2.0 }),
        model: 'test',
      }),
    } as any;
    const marketClient = {
      getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }),
    } as any;
    const limiter = {
      getRemainingDaily: () => 1000,
      checkAndReserve: async () => ({ allowed: true }),
      confirm: vi.fn(),
      release: vi.fn(),
    } as any;

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan();

    // Free cash = 0, so remaining = 0, so probeUsd < minOrder, so trade is skipped
    expect(executor.execute).not.toHaveBeenCalled();

    // Restore for other tests
    vi.mocked(getPaperPerpBookSummary).mockReturnValue({ cashBalanceUsdc: 200 } as any);
  });
});
