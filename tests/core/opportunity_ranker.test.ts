import { describe, expect, it } from 'vitest';

import { scoreAndRankOpportunityCandidates } from '../../src/core/opportunity_ranker.js';

describe('opportunity ranker', () => {
  it('ranks deterministically and only shortlists eligible candidates', () => {
    const inputs = [
      {
        symbol: 'ETH',
        symbolClass: 'crypto' as const,
        signalClass: 'momentum_breakout',
        attentionFeatures: {
          volumeAbnormalityPct: 180,
          oiAbnormalityPct: 12,
          fundingRatePct: 18,
          realizedMovePct: 4,
          eventIntensity: 0.4,
          cadenceWeight: 0.7,
        },
        structuralFeatures: {
          expectedEdge: 0.7,
          setupQuality: 0.72,
          relativeStrength: 0.68,
          signalAgreement: 0.74,
          catalystFreshness: 0.6,
          invalidationClarity: 0.8,
          expectedR: 2.6,
        },
        crowdingFeatures: {
          priceExtension: 0.22,
          oiConfirmation: 0.76,
          fundingSkew: 0.24,
          participationQuality: 0.7,
          exhaustionRisk: 0.2,
        },
        regimeFeatures: {
          marketRegime: 'breakout' as const,
          regimeCompatibility: 0.8,
          volatilityState: 0.72,
          expansionBias: 0.76,
          trendPersistence: 0.74,
        },
        executionFeatures: {
          liquidityUsd: 6_000_000,
          spreadBps: 10,
          stopDistancePct: 1.6,
          invalidationClarity: 0.82,
          expectedR: 2.6,
          portfolioConflict: false,
          sameSymbolConflict: false,
          stackingOverride: false,
        },
      },
      {
        symbol: 'BTC',
        symbolClass: 'crypto' as const,
        signalClass: 'momentum_breakout',
        attentionFeatures: {
          volumeAbnormalityPct: 160,
          oiAbnormalityPct: 10,
          fundingRatePct: 15,
          realizedMovePct: 3.5,
          eventIntensity: 0.45,
          cadenceWeight: 0.7,
        },
        structuralFeatures: {
          expectedEdge: 0.75,
          setupQuality: 0.76,
          relativeStrength: 0.72,
          signalAgreement: 0.78,
          catalystFreshness: 0.62,
          invalidationClarity: 0.84,
          expectedR: 2.7,
        },
        crowdingFeatures: {
          priceExtension: 0.18,
          oiConfirmation: 0.79,
          fundingSkew: 0.22,
          participationQuality: 0.73,
          exhaustionRisk: 0.16,
        },
        regimeFeatures: {
          marketRegime: 'breakout' as const,
          regimeCompatibility: 0.83,
          volatilityState: 0.73,
          expansionBias: 0.8,
          trendPersistence: 0.76,
        },
        executionFeatures: {
          liquidityUsd: 10_000_000,
          spreadBps: 8,
          stopDistancePct: 1.5,
          invalidationClarity: 0.84,
          expectedR: 2.7,
          portfolioConflict: false,
          sameSymbolConflict: false,
          stackingOverride: false,
        },
      },
      {
        symbol: 'XYZ:SPY',
        symbolClass: 'xyz' as const,
        signalClass: 'mean_reversion',
        attentionFeatures: {
          volumeAbnormalityPct: 70,
          oiAbnormalityPct: 5,
          fundingRatePct: null,
          realizedMovePct: 1.2,
          eventIntensity: 0.3,
          cadenceWeight: 0.6,
        },
        structuralFeatures: {
          expectedEdge: 0.35,
          setupQuality: 0.32,
          relativeStrength: 0.3,
          signalAgreement: 0.3,
          catalystFreshness: 0.25,
          invalidationClarity: 0.35,
          expectedR: 1.1,
        },
        crowdingFeatures: {
          priceExtension: 0.6,
          oiConfirmation: 0.3,
          fundingSkew: 0,
          participationQuality: 0.35,
          exhaustionRisk: 0.55,
        },
        regimeFeatures: {
          marketRegime: 'reversion' as const,
          regimeCompatibility: 0.4,
          volatilityState: 0.35,
          expansionBias: 0.3,
          trendPersistence: 0.3,
        },
        executionFeatures: {
          liquidityUsd: 150_000,
          spreadBps: 75,
          stopDistancePct: 0.5,
          invalidationClarity: 0.3,
          expectedR: 1.1,
          portfolioConflict: false,
          sameSymbolConflict: false,
          stackingOverride: false,
        },
      },
    ];

    const createdAt = new Date('2026-05-19T12:00:00.000Z');
    const first = scoreAndRankOpportunityCandidates(inputs, {
      shortlistSize: 2,
      scanId: 'scan-123',
      createdAt,
    });
    const second = scoreAndRankOpportunityCandidates(inputs, {
      shortlistSize: 2,
      scanId: 'scan-123',
      createdAt,
    });

    expect(first.rankedCandidates.map((candidate) => candidate.symbol)).toEqual(['BTC', 'ETH', 'XYZ:SPY']);
    expect(second.rankedCandidates.map((candidate) => candidate.symbol)).toEqual(['BTC', 'ETH', 'XYZ:SPY']);
    expect(first.shortlist.map((candidate) => candidate.symbol)).toEqual(['BTC', 'ETH']);
    expect(first.records).toEqual(second.records);
    expect(first.records[0]).toMatchObject({
      scanId: 'scan-123',
      symbol: 'BTC',
      rank: 1,
      selectedForShortlist: true,
      createdAt: '2026-05-19T12:00:00.000Z',
    });
    expect(first.records[2]?.failedFloors.length).toBeGreaterThan(0);
    expect(first.records[2]?.selectedForShortlist).toBe(false);
  });
});
