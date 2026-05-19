import { describe, expect, it } from 'vitest';

import {
  detectOpportunitySymbolClass,
  normalizeOpportunityFeatures,
} from '../../src/core/opportunity_normalization.js';

describe('opportunity normalization', () => {
  it('keeps cross-asset parity for equal relative abnormalities', () => {
    const crypto = normalizeOpportunityFeatures({
      symbolClass: 'crypto',
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
    });

    const xyz = normalizeOpportunityFeatures({
      symbolClass: 'xyz',
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
    });

    expect(crypto.volumeAbnormality).toBeCloseTo(xyz.volumeAbnormality, 8);
    expect(crypto.oiAbnormality).toBeCloseTo(xyz.oiAbnormality, 8);
    expect(crypto.realizedMoveAbnormality).toBeCloseTo(xyz.realizedMoveAbnormality, 8);
    expect(crypto.liquidityQuality).toBeCloseTo(xyz.liquidityQuality, 8);
    expect(crypto.spreadQuality).toBeCloseTo(xyz.spreadQuality, 8);
    expect(crypto.stopDistanceQuality).toBeCloseTo(xyz.stopDistanceQuality, 8);
    expect(crypto.expectedRQuality).toBeCloseTo(xyz.expectedRQuality, 8);
    expect(xyz.fundingAbnormality).toBe(0.5);
  });

  it('bounds normalization outputs to the unit interval', () => {
    const normalized = normalizeOpportunityFeatures({
      symbolClass: 'crypto',
      attentionFeatures: {
        volumeAbnormalityPct: 10_000,
        oiAbnormalityPct: 10_000,
        fundingRatePct: 10_000,
        realizedMovePct: 10_000,
        eventIntensity: 0,
        cadenceWeight: 0,
      },
      executionFeatures: {
        liquidityUsd: 10_000_000_000,
        spreadBps: 0,
        stopDistancePct: 10_000,
        invalidationClarity: 1,
        expectedR: 10_000,
        portfolioConflict: false,
        sameSymbolConflict: false,
        stackingOverride: false,
      },
    });

    for (const value of Object.values(normalized)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('detects xyz symbols by prefix', () => {
    expect(detectOpportunitySymbolClass('XYZ:SPY')).toBe('xyz');
    expect(detectOpportunitySymbolClass('BTC')).toBe('crypto');
  });
});
