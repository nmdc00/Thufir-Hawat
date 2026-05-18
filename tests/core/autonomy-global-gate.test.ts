import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/memory/autonomy_policy_state.js', () => ({
  getAutonomyPolicyState: vi.fn(() => ({
    minEdgeOverride: null,
    maxTradesPerScanOverride: null,
    leverageCapOverride: null,
    observationOnlyUntilMs: null,
    reason: null,
    updatedAt: new Date(0).toISOString(),
  })),
  upsertAutonomyPolicyState: vi.fn(),
}));

vi.mock('../../src/memory/perp_trade_journal.js', () => ({
  listPerpTradeJournals: vi.fn(() => []),
}));

vi.mock('../../src/core/signal_performance.js', () => ({
  summarizeSignalPerformance: vi.fn(() => ({
    sampleCount: 0,
    sharpeLike: 10,
    expectancy: 0.2,
    variance: 1,
  })),
}));

vi.mock('../../src/core/daily_pnl.js', () => ({
  getDailyPnLRollup: vi.fn(),
}));

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: vi.fn(() => ({
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ c: 0 })),
      all: vi.fn(() => []),
    })),
  })),
}));

import { evaluateGlobalTradeGate } from '../../src/core/autonomy_policy.js';
import { getDailyPnLRollup } from '../../src/core/daily_pnl.js';
import { listPerpTradeJournals } from '../../src/memory/perp_trade_journal.js';

describe('evaluateGlobalTradeGate drawdown cap', () => {
  beforeEach(() => {
    vi.mocked(getDailyPnLRollup).mockReturnValue({
      date: '2026-02-17',
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      byDomain: [],
    });
    vi.mocked(listPerpTradeJournals).mockReturnValue([]);
  });

  it('allows trading when realized P&L is above drawdown threshold', () => {
    vi.mocked(getDailyPnLRollup).mockReturnValue({
      date: '2026-02-17',
      realizedPnl: -99,
      unrealizedPnl: 0,
      totalPnl: -99,
      byDomain: [],
    });

    const result = evaluateGlobalTradeGate(
      {
        autonomy: {
          enabled: true,
          fullAuto: true,
          dailyDrawdownCapUsd: 100,
          maxTradesPerDay: 25,
        },
      } as any,
      { expectedEdge: 0.08 }
    );

    expect(result.allowed).toBe(true);
    expect(result.reasonCode).toBeUndefined();
  });

  it('blocks trading when realized P&L reaches drawdown threshold', () => {
    vi.mocked(getDailyPnLRollup).mockReturnValue({
      date: '2026-02-17',
      realizedPnl: -100,
      unrealizedPnl: 0,
      totalPnl: -100,
      byDomain: [],
    });

    const result = evaluateGlobalTradeGate(
      {
        autonomy: {
          enabled: true,
          fullAuto: true,
          dailyDrawdownCapUsd: 100,
          maxTradesPerDay: 25,
        },
      } as any,
      { expectedEdge: 0.08 }
    );

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('policy.daily_drawdown_cap');
    expect(result.reason).toMatch(/drawdown cap/i);
  });

  it('blocks trading when realized P&L exceeds drawdown threshold', () => {
    vi.mocked(getDailyPnLRollup).mockReturnValue({
      date: '2026-02-17',
      realizedPnl: -101,
      unrealizedPnl: 0,
      totalPnl: -101,
      byDomain: [],
    });

    const result = evaluateGlobalTradeGate(
      {
        autonomy: {
          enabled: true,
          fullAuto: true,
          dailyDrawdownCapUsd: 100,
          maxTradesPerDay: 25,
        },
      } as any,
      { expectedEdge: 0.2 }
    );

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('policy.daily_drawdown_cap');
  });

  it('blocks trading for low decision quality segments when enabled', () => {
    vi.mocked(listPerpTradeJournals).mockReturnValue(
      Array.from({ length: 12 }).map(() => ({
        kind: 'perp_trade_journal',
        symbol: 'BTC',
        outcome: 'executed',
        reduceOnly: true,
        signalClass: 'momentum_breakout',
        marketRegime: 'trending',
        volatilityBucket: 'high',
        liquidityBucket: 'deep',
        directionScore: 0.2,
        timingScore: 0.3,
        sizingScore: 0.25,
        exitScore: 0.2,
      })) as any
    );
    const result = evaluateGlobalTradeGate(
      {
        autonomy: {
          enabled: true,
          fullAuto: true,
          maxTradesPerDay: 25,
          tradeQuality: {
            enabled: true,
            minSamples: 10,
            blockBelowScore: 0.4,
            downweightBelowScore: 0.6,
            downweightMultiplier: 0.5,
          },
        },
      } as any,
      {
        expectedEdge: 0.08,
        signalClass: 'momentum_breakout',
        marketRegime: 'trending',
        volatilityBucket: 'high',
        liquidityBucket: 'deep',
      }
    );
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('policy.decision_quality');
  });

  it('downweights size for mid-quality decision segments when enabled', () => {
    vi.mocked(listPerpTradeJournals).mockReturnValue(
      Array.from({ length: 12 }).map(() => ({
        kind: 'perp_trade_journal',
        symbol: 'BTC',
        outcome: 'executed',
        reduceOnly: true,
        signalClass: 'momentum_breakout',
        marketRegime: 'trending',
        volatilityBucket: 'high',
        liquidityBucket: 'deep',
        directionScore: 0.65,
        timingScore: 0.55,
        sizingScore: 0.6,
        exitScore: 0.55,
      })) as any
    );
    const result = evaluateGlobalTradeGate(
      {
        autonomy: {
          enabled: true,
          fullAuto: true,
          maxTradesPerDay: 25,
          tradeQuality: {
            enabled: true,
            minSamples: 10,
            blockBelowScore: 0.4,
            downweightBelowScore: 0.7,
            downweightMultiplier: 0.5,
          },
        },
      } as any,
      {
        expectedEdge: 0.08,
        signalClass: 'momentum_breakout',
        marketRegime: 'trending',
        volatilityBucket: 'high',
        liquidityBucket: 'deep',
      }
    );
    expect(result.allowed).toBe(true);
    expect(result.sizeMultiplier).toBeCloseTo(0.5, 8);
    expect(result.reasonCode).toBe('policy.decision_quality');
  });
});
