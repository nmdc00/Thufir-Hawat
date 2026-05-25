import { describe, expect, it } from 'vitest';
import type { DiscoveryCandidate } from '../../src/discovery/market_selector.js';
import type { TaSnapshot } from '../../src/core/ta_surface.js';
import {
  buildOriginatorEntryGateContext,
  buildOriginatorEntryGateMarketContext,
} from '../../src/core/entry_gate_market_context.js';

const selector: DiscoveryCandidate = {
  symbol: 'BTC',
  score: 1,
  liquidityScore: 1,
  executionScore: 1,
  fundingScore: 1,
  openInterestUsd: 1_000_000_000,
  dayVolumeUsd: 100_000_000,
  fundingRate: 0,
  spreadProxyBps: 0,
};

const ta: TaSnapshot = {
  symbol: 'BTC',
  price: 70_000,
  priceVs24hHigh: -1,
  priceVs24hLow: 5,
  oiUsd: 1_000_000,
  oiDelta1hPct: 12,
  oiDelta4hPct: 5,
  fundingRatePct: 10,
  volumeVs24hAvgPct: 200,
  priceVsEma20_1h: 1.5,
  trendBias: 'up',
  alertReason: 'oi_spike_1h:12.0%',
};

describe('entry_gate_market_context', () => {
  it('derives regime, liquidity, stop geometry, and edge for originator trades', () => {
    const context = buildOriginatorEntryGateContext({
      thesisText: 'BTC breaking out with OI spike',
      confidence: 0.72,
      expectedRMultiple: 2.4,
      selector,
      ta,
      markPrice: 70_000,
      invalidationPrice: 68_000,
      leverage: 5,
      leverageMax: 50,
      triggerReason: 'ta_alert',
    });

    expect(context.marketContext.marketRegime).toBe('high_vol_expansion');
    expect(context.marketContext.volatilityBucket).toBe('high');
    expect(context.marketContext.liquidityBucket).toBe('deep');
    expect(context.marketContext.executionStatus).toBe('good');
    expect(context.marketContext.stopDistancePct).toBeCloseTo(2_000 / 70_000, 6);
    expect(context.marketContext.stopDistanceBps).toBeCloseTo(285.7, 1);
    expect(context.marketContext.liquidationMovePctAtCandidateLeverage).toBeCloseTo(0.2, 6);
    expect(context.marketContext.liquidationBufferMultiple).toBeCloseTo(7, 2);
    expect(context.marketContext.mechanicalLeverageCeiling).toBe(24);
    expect(context.gateExpectedEdge).toBeCloseTo(0.0703, 4);
    expect(context.gateRegime).toBe('high_vol_expansion | vol=high | liq=deep | exec=good');
    expect(context.gateEntryReasoning).toContain('selector=1.00');
    expect(context.gateEntryReasoning).toContain('stop=2.86%');
    expect(context.gateEntryReasoning).toContain('liq_buffer=7.00x');
  });

  it('falls back deterministically when selector and TA inputs are missing', () => {
    const context = buildOriginatorEntryGateMarketContext({
      selector: null,
      ta: null,
      markPrice: null,
      invalidationPrice: null,
      leverage: 3,
      leverageMax: 10,
      triggerReason: 'cadence',
    });

    expect(context.marketRegime).toBe('choppy');
    expect(context.volatilityBucket).toBe('medium');
    expect(context.liquidityBucket).toBe('normal');
    expect(context.executionStatus).toBe('unknown');
    expect(context.stopDistancePct).toBeNull();
    expect(context.liquidationBufferMultiple).toBeNull();
  });
});
