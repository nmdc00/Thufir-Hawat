import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  classifyMarketRegime,
  computeFractionalKellyFraction,
  evaluateCalibrationSegmentPolicy,
  evaluateDailyTradeCap,
  evaluateGlobalTradeGate,
  evaluateNewsEntryGate,
  isSignalClassAllowedForRegime,
  shouldForceObservationMode,
} from '../../src/core/autonomy_policy.js';
import { openDatabase } from '../../src/memory/db.js';
import { createTradePolicyAdjustment } from '../../src/memory/trade_policy_adjustments.js';

describe('autonomy_policy', () => {
  it('classifies regimes deterministically from price/vol signal metrics', () => {
    const base = {
      id: 'c1',
      symbol: 'BTC/USDT',
      directionalBias: 'up',
      confidence: 0.8,
      timeHorizon: 'hours',
      signals: [
        {
          id: 's1',
          kind: 'price_vol_regime',
          symbol: 'BTC/USDT',
          directionalBias: 'up',
          confidence: 0.9,
          timeHorizon: 'hours',
          metrics: { trend: 0.02, volZ: 0.2 },
        },
      ],
    } as any;

    expect(classifyMarketRegime(base)).toBe('trending');
    expect(
      classifyMarketRegime({
        ...base,
        signals: [{ ...base.signals[0], metrics: { trend: 0.001, volZ: 1.2 } }],
      })
    ).toBe('high_vol_expansion');
    expect(
      classifyMarketRegime({
        ...base,
        signals: [{ ...base.signals[0], metrics: { trend: 0.001, volZ: -0.8 } }],
      })
    ).toBe('low_vol_compression');
  });

  it('allows all known signal classes in any regime, blocks only unknown', () => {
    // Regime matrix was removed — regime fit is accounted for in adaptive-edge
    // segment expectancy. All known signal classes are now permitted everywhere.
    expect(isSignalClassAllowedForRegime('momentum_breakout', 'trending')).toBe(true);
    expect(isSignalClassAllowedForRegime('mean_reversion', 'trending')).toBe(true);
    expect(isSignalClassAllowedForRegime('mean_reversion', 'choppy')).toBe(true);
    expect(isSignalClassAllowedForRegime('liquidation_cascade', 'choppy')).toBe(true);
    expect(isSignalClassAllowedForRegime('momentum_breakout', 'low_vol_compression')).toBe(true);
    expect(isSignalClassAllowedForRegime('unknown', 'trending')).toBe(false);
  });

  it('gates news entries by novelty/confirmation/liquidity/volatility/expiry', () => {
    const config = {
      autonomy: {
        newsEntry: {
          minNoveltyScore: 0.6,
          minMarketConfirmationScore: 0.55,
          minLiquidityScore: 0.4,
          minVolatilityScore: 0.25,
          minSourceCount: 1,
        },
      },
    } as any;

    const expr = {
      newsTrigger: {
        enabled: true,
        noveltyScore: 0.7,
        marketConfirmationScore: 0.7,
        liquidityScore: 0.8,
        volatilityScore: 0.9,
        sources: [{ source: 'newsapi', ref: 'intel:1' }],
        expiresAtMs: Date.now() + 60_000,
      },
    } as any;

    expect(evaluateNewsEntryGate(config, expr).allowed).toBe(true);
    expect(
      evaluateNewsEntryGate(config, {
        ...expr,
        newsTrigger: { ...expr.newsTrigger, noveltyScore: 0.2 },
      }).allowed
    ).toBe(false);
    expect(
      evaluateNewsEntryGate(config, {
        ...expr,
        newsTrigger: { ...expr.newsTrigger, sources: [] },
      }).allowed
    ).toBe(false);
    expect(
      evaluateNewsEntryGate(config, {
        ...expr,
        newsTrigger: { ...expr.newsTrigger, expiresAtMs: Date.now() - 1 },
      }).allowed
    ).toBe(false);
  });

  it('computes bounded fractional kelly fraction', () => {
    const low = computeFractionalKellyFraction({
      expectedEdge: 0.01,
      signalExpectancy: 0.1,
      signalVariance: 1,
      sampleCount: 2,
    });
    const high = computeFractionalKellyFraction({
      expectedEdge: 0.2,
      signalExpectancy: 0.9,
      signalVariance: 0.2,
      sampleCount: 40,
      maxFraction: 0.25,
    });

    expect(low).toBeGreaterThanOrEqual(0.01);
    expect(high).toBeLessThanOrEqual(0.25);
    expect(high).toBeGreaterThan(low);
  });

  it('activates observation-mode trigger when thesisCorrect false in 3/5', () => {
    const entries = [
      { thesisCorrect: false },
      { thesisCorrect: false },
      { thesisCorrect: true },
      { thesisCorrect: false },
      { thesisCorrect: true },
    ] as any;

    const result = shouldForceObservationMode(entries, { window: 5, minFalse: 3 });
    expect(result.active).toBe(true);
    expect(result.falseCount).toBe(3);
  });

  it('allows disabling daily trade cap and bypassing cap for strong edge', () => {
    const disabled = evaluateDailyTradeCap({
      maxTradesPerDayRaw: 0,
      todayCount: 100,
      expectedEdge: 0.01,
      bypassMinEdgeRaw: 0.12,
    });
    expect(disabled.blocked).toBe(false);

    const bypassed = evaluateDailyTradeCap({
      maxTradesPerDayRaw: 25,
      todayCount: 30,
      expectedEdge: 0.2,
      bypassMinEdgeRaw: 0.12,
    });
    expect(bypassed.blocked).toBe(false);

    const blocked = evaluateDailyTradeCap({
      maxTradesPerDayRaw: 25,
      todayCount: 30,
      expectedEdge: 0.05,
      bypassMinEdgeRaw: 0.12,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toMatch(/maxTradesPerDay reached/i);
  });

  it('calibration segment policy falls back before minimum samples', () => {
    const result = evaluateCalibrationSegmentPolicy(
      {
        autonomy: {
          calibrationRisk: {
            minSamples: 5,
            downweightBelowAccuracy: 0.6,
            blockBelowAccuracy: 0.3,
          },
        },
      } as any,
      [
        { signalClass: 'mean_reversion', thesisCorrect: true },
        { signalClass: 'mean_reversion', thesisCorrect: false },
      ] as any,
      { signalClass: 'mean_reversion' }
    );

    expect(result.action).toBe('none');
    expect(result.sizeMultiplier).toBe(1);
    expect(result.reasonCode).toBe('calibration.segment.fallback_insufficient_samples');
    expect(result.reason).toMatch(/insufficient calibration samples/i);
  });

  it('calibration segment policy downweights poor segments after threshold', () => {
    const result = evaluateCalibrationSegmentPolicy(
      {
        autonomy: {
          calibrationRisk: {
            minSamples: 4,
            downweightBelowAccuracy: 0.6,
            blockBelowAccuracy: 0.2,
            downweightMultiplier: 0.4,
          },
        },
      } as any,
      [
        { signalClass: 'mean_reversion', marketRegime: 'choppy', thesisCorrect: true },
        { signalClass: 'mean_reversion', marketRegime: 'choppy', thesisCorrect: false },
        { signalClass: 'mean_reversion', marketRegime: 'choppy', thesisCorrect: false },
        { signalClass: 'mean_reversion', marketRegime: 'choppy', thesisCorrect: false },
      ] as any,
      { signalClass: 'mean_reversion', marketRegime: 'choppy' }
    );

    expect(result.action).toBe('downweight');
    expect(result.sizeMultiplier).toBe(0.4);
    expect(result.reasonCode).toBe('calibration.segment.downweight');
    expect(result.reason).toMatch(/downweighted by calibration policy/i);
  });

  it('calibration segment policy blocks severely underperforming segments', () => {
    const result = evaluateCalibrationSegmentPolicy(
      {
        autonomy: {
          calibrationRisk: {
            minSamples: 4,
            downweightBelowAccuracy: 0.7,
            blockBelowAccuracy: 0.3,
            blockEnabled: true,
          },
        },
      } as any,
      [
        { signalClass: 'momentum_breakout', volatilityBucket: 'high', thesisCorrect: false },
        { signalClass: 'momentum_breakout', volatilityBucket: 'high', thesisCorrect: false },
        { signalClass: 'momentum_breakout', volatilityBucket: 'high', thesisCorrect: false },
        { signalClass: 'momentum_breakout', volatilityBucket: 'high', thesisCorrect: true },
      ] as any,
      { signalClass: 'momentum_breakout', volatilityBucket: 'high' }
    );

    expect(result.action).toBe('block');
    expect(result.sizeMultiplier).toBe(0);
    expect(result.reasonCode).toBe('calibration.segment.block');
    expect(result.reason).toMatch(/blocked by calibration policy/i);
  });

  it('applies a persisted trade policy adjustment inside the global trade gate', () => {
    process.env.THUFIR_DB_PATH = join(mkdtempSync(join(tmpdir(), 'thufir-autonomy-policy-')), 'thufir.sqlite');
    openDatabase();
    createTradePolicyAdjustment({
      domain: 'perp',
      signalClass: 'momentum_breakout',
      marketRegime: 'trending',
      action: 'downweight',
      sizeMultiplier: 0.4,
      evidenceCount: 3,
      rationale: 'segment recently degraded',
    });

    const result = evaluateGlobalTradeGate(
      {
        autonomy: {
          enabled: true,
          signalPerformance: { minSamples: 99 },
          calibrationRisk: { enabled: false },
          tradeQuality: { enabled: false },
        },
      } as any,
      {
        signalClass: 'momentum_breakout',
        marketRegime: 'trending',
      }
    );

    expect(result.allowed).toBe(true);
    expect(result.reasonCode).toBe('policy:size:downweight');
    expect(result.sizeMultiplier).toBeCloseTo(0.4, 6);
    expect(result.activeAdjustmentIds).toHaveLength(1);
  });
});
