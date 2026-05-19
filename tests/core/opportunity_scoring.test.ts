import { describe, expect, it } from 'vitest';

import { createOpportunityCandidate } from '../../src/core/opportunity_candidates.js';

function makeCandidate(overrides?: Partial<Parameters<typeof createOpportunityCandidate>[0]>) {
  return createOpportunityCandidate({
    symbol: 'BTC',
    symbolClass: 'crypto',
    signalClass: 'momentum_breakout',
    triggerReasons: ['abnormal_volume'],
    attentionFeatures: {
      volumeAbnormalityPct: 220,
      oiAbnormalityPct: 18,
      fundingRatePct: 20,
      realizedMovePct: 4,
      eventIntensity: 0.8,
      cadenceWeight: 0.6,
    },
    structuralFeatures: {
      expectedEdge: 0.8,
      setupQuality: 0.75,
      relativeStrength: 0.7,
      signalAgreement: 0.85,
      catalystFreshness: 0.65,
      invalidationClarity: 0.9,
      expectedR: 2.8,
    },
    crowdingFeatures: {
      priceExtension: 0.2,
      oiConfirmation: 0.8,
      fundingSkew: 0.25,
      participationQuality: 0.75,
      exhaustionRisk: 0.15,
    },
    regimeFeatures: {
      marketRegime: 'breakout',
      regimeCompatibility: 0.85,
      volatilityState: 0.7,
      expansionBias: 0.8,
      trendPersistence: 0.75,
    },
    executionFeatures: {
      liquidityUsd: 8_000_000,
      spreadBps: 9,
      stopDistancePct: 1.8,
      invalidationClarity: 0.9,
      expectedR: 2.8,
      portfolioConflict: false,
      sameSymbolConflict: false,
      stackingOverride: false,
    },
    ...overrides,
  });
}

describe('opportunity scoring', () => {
  it('keeps all component scores and the weighted opportunity score bounded', () => {
    const candidate = makeCandidate();

    for (const value of Object.values(candidate.componentScores)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(candidate.opportunityScore).toBeGreaterThanOrEqual(0);
    expect(candidate.opportunityScore).toBeLessThanOrEqual(1);
  });

  it('fails hard floors for poor liquidity, weak structure, and low expected R', () => {
    const candidate = makeCandidate({
      structuralFeatures: {
        expectedEdge: 0.2,
        setupQuality: 0.25,
        relativeStrength: 0.2,
        signalAgreement: 0.3,
        catalystFreshness: 0.2,
        invalidationClarity: 0.2,
        expectedR: 1,
      },
      executionFeatures: {
        liquidityUsd: 500_000,
        spreadBps: 60,
        stopDistancePct: 0.3,
        invalidationClarity: 0.2,
        expectedR: 1,
        portfolioConflict: false,
        sameSymbolConflict: false,
        stackingOverride: false,
      },
    });

    expect(candidate.hardFloorVerdict.eligible).toBe(false);
    expect(candidate.hardFloorVerdict.failedFloors).toContain('minimum_liquidity');
    expect(candidate.hardFloorVerdict.failedFloors).toContain('minimum_execution_quality');
    expect(candidate.hardFloorVerdict.failedFloors).toContain('minimum_structural_edge');
    expect(candidate.hardFloorVerdict.failedFloors).toContain('minimum_invalidation_clarity');
    expect(candidate.hardFloorVerdict.failedFloors).toContain('minimum_expected_r');
  });

  it('fails conflict floors unless stacking override is explicit', () => {
    const candidate = makeCandidate({
      executionFeatures: {
        liquidityUsd: 8_000_000,
        spreadBps: 9,
        stopDistancePct: 1.8,
        invalidationClarity: 0.9,
        expectedR: 2.8,
        portfolioConflict: true,
        sameSymbolConflict: true,
        stackingOverride: false,
      },
    });

    expect(candidate.hardFloorVerdict.failedFloors).toContain('portfolio_conflict');
    expect(candidate.hardFloorVerdict.failedFloors).toContain('same_symbol_stacking');
  });
});
