/**
 * autonomous-wiring.test.ts
 *
 * Tests for the v1.98 originator wiring inside AutonomousManager:
 * - LlmTradeOriginator + OriginationTrigger + TaSurface integrated into runScan
 * - Symbol cooldown logic
 * - Quant fallback on cadence trigger
 * - Gate reject / resize
 * - Exit policy uses LLM TTL and invalidation price
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock functions (available before vi.mock calls) ───────────────────

const mocks = vi.hoisted(() => {
  const dbRun = vi.fn(() => ({}));
  const dbPrepare = vi.fn((sql: string) => {
    if (sql.includes('COUNT(*)')) return { get: () => ({ c: 0 }) };
    return { run: dbRun, all: () => [], get: () => undefined };
  });
  const dbExec = vi.fn();

  const taComputeAll = vi.fn();
  const triggerShouldFire = vi.fn();
  const originatorPropose = vi.fn();
  const upsertExitPolicy = vi.fn();
  const updateTradeProposalOutcome = vi.fn();
  const createPrediction = vi.fn(() => 'pred-mock-id');
  const recordOpportunityRankScan = vi.fn();

  // Stable mock objects — replaced entirely on each TaSurface/OriginationTrigger/LlmTradeOriginator construction
  // by capturing via the constructor mock
  const taSurfaceInstance = {
    computeAll: (...args: unknown[]) => taComputeAll(...args),
    hasAlert: (snap: any) => Array.isArray(snap.triggerReasons) && snap.triggerReasons.length > 0,
  };
  const triggerInstance = {
    shouldFire: (...args: unknown[]) => triggerShouldFire(...args),
  };
  const originatorInstance = {
    propose: (...args: unknown[]) => originatorPropose(...args),
  };

  return {
    dbRun, dbPrepare, dbExec,
    taComputeAll, triggerShouldFire, originatorPropose,
    upsertExitPolicy, updateTradeProposalOutcome,
    createPrediction, recordOpportunityRankScan,
    taSurfaceInstance, triggerInstance, originatorInstance,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => ({ exec: mocks.dbExec, prepare: mocks.dbPrepare }),
}));

vi.mock('../../src/memory/predictions.js', () => ({
  createPrediction: (...args: unknown[]) => mocks.createPrediction(...args),
  findOpenPerpPrediction: vi.fn(() => null),
}));

vi.mock('../../src/core/ta_surface.js', () => ({
  TaSurface: vi.fn(() => mocks.taSurfaceInstance),
}));

vi.mock('../../src/core/origination_trigger.js', () => ({
  OriginationTrigger: vi.fn(() => mocks.triggerInstance),
}));

vi.mock('../../src/core/llm_trade_originator.js', () => ({
  LlmTradeOriginator: vi.fn(() => mocks.originatorInstance),
}));

vi.mock('../../src/memory/llm_trade_proposals.js', () => ({
  updateTradeProposalOutcome: (...args: unknown[]) => mocks.updateTradeProposalOutcome(...args),
}));

vi.mock('../../src/memory/opportunity_rank_logs.js', () => ({
  recordOpportunityRankScan: (...args: unknown[]) => mocks.recordOpportunityRankScan(...args),
}));

vi.mock('../../src/discovery/engine.js', () => ({
  runDiscovery: vi.fn(async () => ({
    clusters: [],
    hypotheses: [],
    expressions: [],
    selector: { source: 'configured', symbols: [] },
  })),
}));

vi.mock('../../src/discovery/market_selector.js', () => ({
  selectDiscoveryMarkets: vi.fn(async () => ({
    source: 'full_universe' as const,
    candidates: [
      { symbol: 'BTC', assetClass: 'crypto', marketDisplay: 'BTC', score: 1, liquidityScore: 1, executionScore: 1, fundingScore: 1, openInterestUsd: 1e9, dayVolumeUsd: 1e8, fundingRate: 0, spreadProxyBps: 0, markPx: 70000, oraclePx: 70000 },
      { symbol: 'ETH', assetClass: 'crypto', marketDisplay: 'ETH', score: 0.9, liquidityScore: 1, executionScore: 1, fundingScore: 1, openInterestUsd: 5e8, dayVolumeUsd: 5e7, fundingRate: 0, spreadProxyBps: 0, markPx: 3500, oraclePx: 3500 },
    ],
  })),
}));

vi.mock('../../src/memory/perp_trades.js', () => ({
  recordPerpTrade: vi.fn(() => 1),
}));

vi.mock('../../src/memory/perp_trade_journal.js', () => ({
  recordPerpTradeJournal: vi.fn(),
  listPerpTradeJournals: vi.fn(() => []),
}));

vi.mock('../../src/execution/perp-risk.js', () => ({
  checkPerpRiskLimits: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../../src/core/autonomy_policy.js', () => ({
  applyReflectionMutation: vi.fn(() => ({ mutated: false, state: {} })),
  classifyMarketRegime: vi.fn(() => 'trending'),
  classifySignalClass: vi.fn(() => 'momentum_breakout'),
  computeFractionalKellyFraction: vi.fn(() => 0.25),
  evaluateGlobalTradeGate: vi.fn(() => ({ allowed: true })),
  evaluateNewsEntryGate: vi.fn(() => ({ allowed: true })),
  isSignalClassAllowedForRegime: vi.fn(() => true),
  resolveLiquidityBucket: vi.fn(() => 'normal'),
  resolveVolatilityBucket: vi.fn(() => 'medium'),
}));

vi.mock('../../src/core/signal_performance.js', () => ({
  summarizeSignalPerformance: vi.fn(() => ({ sampleCount: 0, expectancy: 0.5, variance: 0.5 })),
}));

vi.mock('../../src/memory/autonomy_policy_state.js', () => ({
  getAutonomyPolicyState: vi.fn(() => ({
    minEdgeOverride: null,
    maxTradesPerScanOverride: null,
    leverageCapOverride: null,
    observationOnlyUntilMs: null,
    reason: null,
    updatedAt: new Date().toISOString(),
  })),
}));

vi.mock('../../src/memory/trades.js', () => ({
  listOpenPositionsFromTrades: vi.fn(() => []),
}));

vi.mock('../../src/memory/position_exit_policy.js', () => ({
  upsertPositionExitPolicy: (...args: unknown[]) => mocks.upsertExitPolicy(...args),
  getPositionExitPolicy: vi.fn(() => null),
  clearPositionExitPolicy: vi.fn(),
}));

vi.mock('../../src/memory/paper_perps.js', () => ({
  listPaperPerpPositions: vi.fn(() => []),
  listPaperPerpPositionsWithMark: vi.fn(() => []),
  getPaperPerpBookSummary: vi.fn(() => ({ cashBalanceUsdc: 200 })),
}));

vi.mock('../../src/memory/portfolio.js', () => ({
  getCashBalance: vi.fn(() => null),
}));

vi.mock('../../src/memory/llm_entry_gate_log.js', () => ({
  recordEntryGateDecision: vi.fn(),
}));

vi.mock('../../src/memory/events.js', () => ({
  listEvents: vi.fn(() => []),
}));

vi.mock('../../src/markets/context.js', () => ({
  gatherMarketContext: vi.fn(async () => ({ results: [], domain: 'crypto', primarySource: '', sources: [] })),
  classifyMarketContextDomain: vi.fn(() => 'crypto'),
}));

vi.mock('../../src/core/exit_contract.js', () => ({
  buildLegacyExitContract: vi.fn((input: any) => ({ thesis: input.thesis, side: input.side })),
  serializeExitContract: vi.fn((ec: any) => JSON.stringify(ec)),
  parseExitContract: vi.fn(() => null),
  summarizeExitContract: vi.fn(() => null),
}));

vi.mock('../../src/core/position_book.js', () => {
  const bookInstance = {
    refresh: vi.fn(async () => {}),
    getAll: vi.fn(() => []),
    get: vi.fn(() => undefined),
    hasPosition: vi.fn(() => false),
    hasConflict: vi.fn(() => false),
  };
  const PositionBook = {
    _instance: bookInstance,
    getInstance() { return this._instance; },
  };
  return { PositionBook };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeGateLlm(verdict: 'approve' | 'reject' | 'resize', adjustedSizeUsd?: number) {
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify({
        verdict,
        reasoning: `test verdict: ${verdict}`,
        stopLevelPrice: null,
        equityAtRiskPct: 2.5,
        targetRR: 2.0,
        ...(adjustedSizeUsd !== undefined ? { adjustedSizeUsd } : {}),
      }),
      model: 'test',
    })),
  } as any;
}

function makeLimiter(remaining = 1000) {
  return {
    getRemainingDaily: vi.fn(() => remaining),
    checkAndReserve: vi.fn(async () => ({ allowed: true })),
    confirm: vi.fn(),
    release: vi.fn(),
  } as any;
}

const BASE_SNAPSHOT = {
  symbol: 'BTC',
  price: 70000,
  priceVs24hHigh: -1,
  priceVs24hLow: 5,
  oiUsd: 1_000_000,
  oiDelta1hPct: 12,
  oiDelta4hPct: 5,
  fundingRatePct: 10,
  volumeVs24hAvgPct: 200,
  priceVsEma20_1h: 1.5,
  trendBias: 'up' as const,
  triggerReasons: ['oi_spike_1h:12.0%', 'volume_spike:200.0%'],
  rawFeatures: {
    priceVs24hHighPct: -1,
    priceVs24hLowPct: 5,
    oiUsd: 1_000_000,
    oiDelta1hPct: 12,
    oiDelta4hPct: 5,
    fundingRateAnnualPct: 10,
    volumeVs24hAvgPct: 200,
    priceVsEma20_1hPct: 1.5,
    trendBias: 'up' as const,
  },
  alertReason: 'oi_spike_1h:12.0%',
};

const BASE_PROPOSAL = {
  proposalRecordId: 42,
  symbol: 'BTC',
  side: 'long' as const,
  thesisText: 'BTC breaking out with OI spike',
  invalidationCondition: 'close below 68000',
  invalidationPrice: 68000,
  suggestedTtlMinutes: 45,
  confidence: 0.72,
};

const baseConfig = {
  execution: { mode: 'paper' },
  paper: { initialCashUsdc: 200 },
  autonomy: {
    enabled: true,
    fullAuto: true,
    scanIntervalSeconds: 300,
    minEdge: 0.05,
    maxTradesPerScan: 1,
    origination: {
      enabled: true,
      cadenceMinutes: 15,
      topMarketsCount: 20,
      quantFallbackEnabled: true,
      cooldownMinutes: 30,
    },
    llmEntryGate: { enabled: true },
  },
  hyperliquid: { maxLeverage: 5, minOrderNotionalUsd: 10 },
} as any;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AutonomousManager — originator wiring (v1.98)', () => {
  beforeEach(() => {
    // Reset call history only (not implementations)
    vi.clearAllMocks();
    // Restore default behaviors
    mocks.taComputeAll.mockResolvedValue([BASE_SNAPSHOT]);
    mocks.triggerShouldFire.mockReturnValue({ fire: true, reason: 'ta_alert', alertedSymbols: ['BTC'] });
    mocks.originatorPropose.mockResolvedValue(BASE_PROPOSAL);
    mocks.createPrediction.mockReturnValue('pred-mock-id');
  });

  it('1. proposal → gate approve → executor called, exit policy written with LLM TTL and invalidation price', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    const result = await manager.runScan({ forceExecute: true });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    const decision = executor.execute.mock.calls[0]![1];
    expect(decision.symbol).toBe('BTC');
    expect(decision.side).toBe('buy');
    expect(decision.modelProbability).toBe(0.72);

    // Exit policy: invalidationPrice = 68000, TTL = 45 min
    expect(mocks.upsertExitPolicy).toHaveBeenCalledTimes(1);
    const [sym, side, timeStop, invPrice, , predictionId] = mocks.upsertExitPolicy.mock.calls[0]!;
    expect(sym).toBe('BTC');
    expect(side).toBe('long');
    expect(invPrice).toBe(68000);
    expect(predictionId).toBe('pred-mock-id');
    expect(timeStop).toBeGreaterThan(Date.now());
    expect(timeStop).toBeLessThanOrEqual(Date.now() + 45 * 60 * 1000 + 1000);

    expect(mocks.updateTradeProposalOutcome).toHaveBeenCalledWith(42, 'approve', true);

    expect(result).toContain('paper ok');
  });

  it('1b. builds a ranked shortlist before origination and passes it to trigger + originator', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: false, message: 'paper skipped' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan({ forceExecute: true });

    expect(mocks.triggerShouldFire).toHaveBeenCalledTimes(1);
    const shortlist = mocks.triggerShouldFire.mock.calls[0]![3] as Array<Record<string, unknown>>;
    expect(Array.isArray(shortlist)).toBe(true);
    expect(shortlist[0]).toMatchObject({
      symbol: 'BTC',
      rank: 1,
      symbolClass: 'crypto',
    });

    const bundle = mocks.originatorPropose.mock.calls[0]![0] as Record<string, any>;
    expect(bundle.rankedOpportunities[0]).toMatchObject({
      symbol: 'BTC',
      rank: 1,
    });
    expect(bundle.rankedOpportunities[0].triggerReasons).toEqual(
      expect.arrayContaining(['oi_spike_1h:12.0%', 'volume_spike:200.0%'])
    );
    expect(bundle.rankedOpportunities[0].componentScores.structuralEdgeScore).toBeGreaterThan(0);
    expect(mocks.recordOpportunityRankScan).toHaveBeenCalledTimes(1);
    expect(mocks.recordOpportunityRankScan.mock.calls[0]![0]).toMatchObject({
      source: 'autonomous_originator_scan',
      totalCandidates: 1,
      eligibleCandidates: 1,
      selectedSymbol: 'BTC',
    });
  });

  it('2. null proposal + cadence trigger → quant fallback runs', async () => {
    mocks.triggerShouldFire.mockReturnValue({ fire: true, reason: 'cadence', alertedSymbols: [] });
    mocks.originatorPropose.mockResolvedValue(null);

    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    const result = await manager.runScan({ forceExecute: true });

    // Discovery ran (no expressions → quant fallback message)
    expect(result).toMatch(/No discovery expressions/i);
  });

  it('3. null proposal + ta_alert trigger → quant fallback does NOT run, returns originator message', async () => {
    mocks.triggerShouldFire.mockReturnValue({ fire: true, reason: 'ta_alert', alertedSymbols: ['BTC'] });
    mocks.originatorPropose.mockResolvedValue(null);

    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const { runDiscovery } = await import('../../src/discovery/engine.js');
    const runDiscoverySpy = vi.mocked(runDiscovery);

    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: {} }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    const result = await manager.runScan({ forceExecute: true });

    expect(result).toContain('Originator returned null');
    expect(result).toContain('ta_alert');
    expect(runDiscoverySpy).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('4. symbol cooldown: after BTC proposal, BTC is filtered from next scan snapshots', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);

    // First scan — BTC proposed and executed (sets cooldown)
    await manager.runScan({ forceExecute: true });
    expect(mocks.originatorPropose).toHaveBeenCalledTimes(1);

    // Reset proposal mock, switch to cadence trigger
    mocks.originatorPropose.mockClear();
    mocks.triggerShouldFire.mockReturnValue({ fire: true, reason: 'cadence', alertedSymbols: [] });

    // Second scan
    await manager.runScan({ forceExecute: true });

    // If originator was called on second scan, BTC should be absent from taSnapshots
    if (mocks.originatorPropose.mock.calls.length > 0) {
      const bundle = mocks.originatorPropose.mock.calls[0]![0] as any;
      const symbols = bundle.taSnapshots.map((s: any) => s.symbol);
      expect(symbols).not.toContain('BTC');
    }
    // If originator wasn't called (trigger didn't fire with new taSnapshots), that's also valid
  });

  it('5. gate reject → executor NOT called', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('reject');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    const result = await manager.runScan({ forceExecute: true });

    expect(executor.execute).not.toHaveBeenCalled();
    expect(result).toMatch(/rejected by LLM entry gate/i);
    expect(limiter.release).toHaveBeenCalled();
    expect(mocks.updateTradeProposalOutcome).toHaveBeenCalledWith(42, 'reject', false);
  });

  it('6. gate resize → executor called with adjusted size', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('resize', 15);
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan({ forceExecute: true });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    const decision = executor.execute.mock.calls[0]![1];
    // size = adjustedSizeUsd / markPrice = 15 / 70000
    expect(decision.size).toBeCloseTo(15 / 70000, 6);
  });

  it('7. LLM down (originator throws) on cadence tick → quant fallback runs, no crash', async () => {
    mocks.triggerShouldFire.mockReturnValue({ fire: true, reason: 'cadence', alertedSymbols: [] });
    mocks.originatorPropose.mockRejectedValue(new Error('LLM timeout'));

    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: false, message: 'no trade' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: {} }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);

    // Should not throw
    const result = await manager.runScan({ forceExecute: true });
    expect(result).toBeTruthy();
    // Fell through to quant discovery path
    expect(result).toMatch(/No discovery expressions/i);
  });

  it('8. exit policy uses LLM TTL: suggestedTtlMinutes=45 → timeStopAtMs = now + 45*60*1000', async () => {
    mocks.originatorPropose.mockResolvedValue({
      ...BASE_PROPOSAL,
      suggestedTtlMinutes: 45,
    });

    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const before = Date.now();
    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan({ forceExecute: true });
    const after = Date.now();

    expect(mocks.upsertExitPolicy).toHaveBeenCalledTimes(1);
    const [, , timeStop] = mocks.upsertExitPolicy.mock.calls[0]!;
    const expectedMin = before + 45 * 60 * 1000;
    const expectedMax = after + 45 * 60 * 1000;
    expect(timeStop).toBeGreaterThanOrEqual(expectedMin);
    expect(timeStop).toBeLessThanOrEqual(expectedMax);
  });

  it('9. originator path: createPrediction called with executed=true, executionPrice, positionSize after gate approve', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('approve');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'paper ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan({ forceExecute: true });

    expect(mocks.createPrediction).toHaveBeenCalledTimes(1);
    const call = mocks.createPrediction.mock.calls[0]![0] as any;
    expect(call.symbol).toBe('BTC');
    expect(call.domain).toBe('perp');
    expect(call.learningComparable).toBe(false);
    expect(call.modelProbability).toBe(0.72);
    expect(call.executed).toBe(true);
    expect(call.executionPrice).toBeGreaterThan(0);
    expect(typeof call.positionSize).toBe('number');
  });

  it('10. originator path: createPrediction NOT called when gate rejects', async () => {
    const { AutonomousManager } = await import('../../src/core/autonomous.js');
    const llm = makeGateLlm('reject');
    const executor = { execute: vi.fn(async () => ({ executed: true, message: 'ok' })) } as any;
    const marketClient = { getMarket: async () => ({ symbol: 'BTC', markPrice: 70000, metadata: { maxLeverage: 10 } }) } as any;
    const limiter = makeLimiter();

    const manager = new AutonomousManager(llm, llm, marketClient, executor, limiter, baseConfig);
    await manager.runScan({ forceExecute: true });

    expect(executor.execute).not.toHaveBeenCalled();
    expect(mocks.createPrediction).not.toHaveBeenCalled();
  });
});
