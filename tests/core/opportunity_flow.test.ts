import { describe, expect, it } from 'vitest';

import { scoreAndRankOpportunityCandidates } from '../../src/core/opportunity_ranker.js';
import type { OpportunityCandidateInput } from '../../src/core/opportunity_types.js';

function makeInput(
  symbol: string,
  overrides: Partial<OpportunityCandidateInput> = {}
): OpportunityCandidateInput {
  return {
    symbol,
    symbolClass: symbol.startsWith('XYZ:') ? 'xyz' : 'crypto',
    signalClass: 'momentum_breakout',
    triggerReasons: ['cadence_inclusion'],
    attentionFeatures: {
      volumeAbnormalityPct: 140,
      oiAbnormalityPct: 10,
      fundingRatePct: symbol.startsWith('XYZ:') ? null : 18,
      realizedMovePct: 3,
      eventIntensity: 0.1,
      cadenceWeight: 1,
    },
    structuralFeatures: {
      expectedEdge: 0.65,
      setupQuality: 0.68,
      relativeStrength: 0.66,
      signalAgreement: 0.7,
      catalystFreshness: 0.45,
      invalidationClarity: 0.74,
      expectedR: 2.2,
    },
    crowdingFeatures: {
      priceExtension: 0.25,
      oiConfirmation: 0.7,
      fundingSkew: 0.2,
      participationQuality: 0.72,
      exhaustionRisk: 0.18,
    },
    regimeFeatures: {
      marketRegime: 'breakout',
      regimeCompatibility: 0.78,
      volatilityState: 0.62,
      expansionBias: 0.75,
      trendPersistence: 0.7,
    },
    executionFeatures: {
      liquidityUsd: symbol.startsWith('XYZ:') ? 600_000 : 6_000_000,
      spreadBps: symbol.startsWith('XYZ:') ? 40 : 15,
      stopDistancePct: 2.5,
      invalidationClarity: 0.76,
      expectedR: 2.2,
      portfolioConflict: false,
      sameSymbolConflict: false,
      stackingOverride: false,
    },
    ...overrides,
  };
}

describe('opportunity flow', () => {
  it('noisy_volume_spike_xyz loses to constructive_crypto_breakout', () => {
    const result = scoreAndRankOpportunityCandidates([
      makeInput('XYZ:TSLA', {
        triggerReasons: ['volume_spike'],
        attentionFeatures: {
          volumeAbnormalityPct: 280,
          oiAbnormalityPct: 2,
          fundingRatePct: null,
          realizedMovePct: 1.2,
          eventIntensity: 0,
          cadenceWeight: 1,
        },
        structuralFeatures: {
          expectedEdge: 0.28,
          setupQuality: 0.25,
          relativeStrength: 0.3,
          signalAgreement: 0.32,
          catalystFreshness: 0.18,
          invalidationClarity: 0.35,
          expectedR: 1.3,
        },
        crowdingFeatures: {
          priceExtension: 0.82,
          oiConfirmation: 0.25,
          fundingSkew: 0,
          participationQuality: 0.3,
          exhaustionRisk: 0.8,
        },
        regimeFeatures: {
          marketRegime: 'reversion',
          regimeCompatibility: 0.32,
          volatilityState: 0.4,
          expansionBias: 0.3,
          trendPersistence: 0.25,
        },
        executionFeatures: {
          liquidityUsd: 220_000,
          spreadBps: 85,
          stopDistancePct: 1.2,
          invalidationClarity: 0.3,
          expectedR: 1.3,
          portfolioConflict: false,
          sameSymbolConflict: false,
          stackingOverride: false,
        },
      }),
      makeInput('ETH', {
        triggerReasons: ['oi_spike_1h', 'volume_spike'],
        attentionFeatures: {
          volumeAbnormalityPct: 150,
          oiAbnormalityPct: 14,
          fundingRatePct: 16,
          realizedMovePct: 4.1,
          eventIntensity: 0.2,
          cadenceWeight: 1,
        },
        structuralFeatures: {
          expectedEdge: 0.75,
          setupQuality: 0.8,
          relativeStrength: 0.76,
          signalAgreement: 0.82,
          catalystFreshness: 0.58,
          invalidationClarity: 0.85,
          expectedR: 2.8,
        },
      }),
    ]);

    expect(result.rankedCandidates[0]?.symbol).toBe('ETH');
    expect(result.shortlist.map((candidate) => candidate.symbol)).toEqual(['ETH']);
  });

  it('constructive_crypto_breakout outranks crowded_crypto_squeeze', () => {
    const result = scoreAndRankOpportunityCandidates([
      makeInput('SOL', {
        triggerReasons: ['funding_extreme', 'oi_spike_1h'],
        crowdingFeatures: {
          priceExtension: 0.9,
          oiConfirmation: 0.92,
          fundingSkew: 0.95,
          participationQuality: 0.45,
          exhaustionRisk: 0.88,
        },
      }),
      makeInput('BTC', {
        triggerReasons: ['oi_spike_1h'],
        crowdingFeatures: {
          priceExtension: 0.18,
          oiConfirmation: 0.72,
          fundingSkew: 0.22,
          participationQuality: 0.78,
          exhaustionRisk: 0.15,
        },
      }),
    ]);

    expect(result.rankedCandidates[0]?.symbol).toBe('BTC');
  });

  it('illiquid_xyz_breakout is excluded from shortlist by hard floors', () => {
    const result = scoreAndRankOpportunityCandidates([
      makeInput('XYZ:NVDA', {
        triggerReasons: ['event_trigger', 'volume_spike'],
        structuralFeatures: {
          expectedEdge: 0.72,
          setupQuality: 0.78,
          relativeStrength: 0.74,
          signalAgreement: 0.76,
          catalystFreshness: 0.8,
          invalidationClarity: 0.8,
          expectedR: 2.6,
        },
        executionFeatures: {
          liquidityUsd: 150_000,
          spreadBps: 95,
          stopDistancePct: 1.1,
          invalidationClarity: 0.35,
          expectedR: 1.4,
          portfolioConflict: false,
          sameSymbolConflict: false,
          stackingOverride: false,
        },
      }),
      makeInput('BTC'),
    ]);

    const illiquid = result.records.find((record) => record.symbol === 'XYZ:NVDA');
    expect(illiquid?.failedFloors).toContain('minimum_liquidity');
    expect(illiquid?.selectedForShortlist).toBe(false);
  });

  it('mean_reversion_in_wrong_regime ranks below aligned breakout setups', () => {
    const result = scoreAndRankOpportunityCandidates([
      makeInput('XYZ:QQQ', {
        signalClass: 'mean_reversion',
        structuralFeatures: {
          expectedEdge: 0.42,
          setupQuality: 0.38,
          relativeStrength: 0.34,
          signalAgreement: 0.36,
          catalystFreshness: 0.2,
          invalidationClarity: 0.5,
          expectedR: 1.6,
        },
        regimeFeatures: {
          marketRegime: 'breakout',
          regimeCompatibility: 0.08,
          volatilityState: 0.78,
          expansionBias: 0.88,
          trendPersistence: 0.82,
        },
        crowdingFeatures: {
          priceExtension: 0.62,
          oiConfirmation: 0.34,
          fundingSkew: 0,
          participationQuality: 0.3,
          exhaustionRisk: 0.6,
        },
      }),
      makeInput('ETH'),
    ]);

    expect(result.rankedCandidates[0]?.symbol).toBe('ETH');
    expect(result.records.find((record) => record.symbol === 'XYZ:QQQ')?.rank).toBe(2);
  });

  it('cross_asset_equal_quality ranks by substance rather than asset label', () => {
    const result = scoreAndRankOpportunityCandidates([
      makeInput('BTC', {
        attentionFeatures: {
          volumeAbnormalityPct: 150,
          oiAbnormalityPct: 12,
          fundingRatePct: 25,
          realizedMovePct: 5,
          eventIntensity: 0,
          cadenceWeight: 0,
        },
        executionFeatures: {
          liquidityUsd: 5_000_000,
          spreadBps: 15,
          stopDistancePct: 2.5,
          invalidationClarity: 0.8,
          expectedR: 3,
          portfolioConflict: false,
          sameSymbolConflict: false,
          stackingOverride: false,
        },
      }),
      makeInput('XYZ:SPY', {
        signalClass: 'momentum_breakout',
        attentionFeatures: {
          volumeAbnormalityPct: 60,
          oiAbnormalityPct: 8,
          fundingRatePct: null,
          realizedMovePct: 2,
          eventIntensity: 0,
          cadenceWeight: 0,
        },
        executionFeatures: {
          liquidityUsd: 500_000,
          spreadBps: 40,
          stopDistancePct: 3,
          invalidationClarity: 0.8,
          expectedR: 2.5,
          portfolioConflict: false,
          sameSymbolConflict: false,
          stackingOverride: false,
        },
      }),
    ]);

    expect(result.records.map((record) => record.symbol)).toEqual(['BTC', 'XYZ:SPY']);
    expect(result.records[0]?.opportunityScore).toBeCloseTo(result.records[1]?.opportunityScore ?? 0, 2);
  });

  it('records shortlist inclusion and exclusion explicitly for every fixture row', () => {
    const result = scoreAndRankOpportunityCandidates([
      makeInput('BTC'),
      makeInput('ETH'),
      makeInput('XYZ:SPY', {
        executionFeatures: {
          liquidityUsd: 120_000,
          spreadBps: 120,
          stopDistancePct: 1.1,
          invalidationClarity: 0.2,
          expectedR: 1.1,
          portfolioConflict: false,
          sameSymbolConflict: false,
          stackingOverride: false,
        },
      }),
    ], { shortlistSize: 2, scanId: 'scan-flow' });

    expect(result.records).toHaveLength(3);
    expect(result.records.filter((record) => record.selectedForShortlist)).toHaveLength(2);
    expect(result.records.filter((record) => !record.selectedForShortlist)).toHaveLength(1);
  });
});
