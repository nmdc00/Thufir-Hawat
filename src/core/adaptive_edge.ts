/**
 * Adaptive Edge Estimation
 *
 * Replaces the synthetic `confidence * 0.1` edge formula with a history-grounded
 * estimate derived from the agent's trade journal (capturedR per closed trade).
 *
 * Before minSamples: returns a conservative prior modulated by signal strength.
 * After minSamples: blends prior and empirical R-expectancy, saturating toward
 * empirical as sample count grows.
 */

import type { ThufirConfig } from './config.js';
import type { PerpTradeJournalEntry } from '../memory/perp_trade_journal.js';

export type AdaptiveEdgeSegment = {
  signalClass: string;
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
};

export type AdaptiveEdgeResult = {
  edge: number;
  source: 'prior' | 'empirical' | 'blended';
  sampleCount: number;
  empiricalExpectancy: number | null;
  priorEdge: number;
  signalStrengthMultiplier: number;
};

function weightedMean(values: number[], weights: number[]): number {
  if (values.length === 0) return 0;
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) return 0;
  return values.reduce((sum, v, i) => sum + v * (weights[i] ?? 0), 0) / totalWeight;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Compute empirical R-expectancy from closed trades in a segment.
 * Returns null when no qualifying entries exist.
 */
export function computeSegmentExpectancy(
  journals: PerpTradeJournalEntry[],
  segment: AdaptiveEdgeSegment,
  decayHalfLifeDays: number | null,
  nowMs = Date.now()
): { expectancy: number | null; sampleCount: number } {
  const entries = journals.filter(
    (e) =>
      e.outcome === 'executed' &&
      e.capturedR != null &&
      e.signalClass === segment.signalClass &&
      e.marketRegime === segment.marketRegime &&
      e.volatilityBucket === segment.volatilityBucket &&
      e.liquidityBucket === segment.liquidityBucket
  );

  if (entries.length === 0) {
    return { expectancy: null, sampleCount: 0 };
  }

  const values = entries.map((e) => Number(e.capturedR));

  if (decayHalfLifeDays != null && decayHalfLifeDays > 0) {
    const halfLifeMs = decayHalfLifeDays * 24 * 60 * 60 * 1000;
    const weights = entries.map((e) => {
      const createdMs = e.snapshot?.createdAtMs
        ? Number(e.snapshot.createdAtMs)
        : nowMs;
      const ageMs = Math.max(0, nowMs - createdMs);
      return Math.pow(2, -(ageMs / halfLifeMs));
    });
    return {
      expectancy: weightedMean(values, weights),
      sampleCount: entries.length,
    };
  }

  const expectancy = values.reduce((a, b) => a + b, 0) / values.length;
  return { expectancy, sampleCount: entries.length };
}

/**
 * Resolve the adaptive edge for an expression candidate.
 *
 * @param config       - ThufirConfig (reads autonomy.adaptiveEdge)
 * @param journals     - Recent trade journal entries (caller decides window)
 * @param segment      - The 4-dimensional segment for this expression
 * @param signalStrength - Discovery confidence [0, 1]
 */
export function resolveAdaptiveEdge(
  config: ThufirConfig,
  journals: PerpTradeJournalEntry[],
  segment: AdaptiveEdgeSegment,
  signalStrength: number
): AdaptiveEdgeResult {
  const adaptiveCfg = (config.autonomy as any)?.adaptiveEdge ?? {};
  const enabled = adaptiveCfg.enabled !== false; // default on

  const priorEdge = Number.isFinite(Number(adaptiveCfg.priorEdge))
    ? clamp(Number(adaptiveCfg.priorEdge), 0, 1)
    : 0.03;
  const minSamples = Number.isFinite(Number(adaptiveCfg.minSamples))
    ? Math.max(1, Math.floor(Number(adaptiveCfg.minSamples)))
    : 10;
  const signalScaleFactor = Number.isFinite(Number(adaptiveCfg.signalScaleFactor))
    ? clamp(Number(adaptiveCfg.signalScaleFactor), 0, 1)
    : 0.5;
  const decayHalfLifeDays = Number.isFinite(Number(adaptiveCfg.decayHalfLifeDays))
    ? Number(adaptiveCfg.decayHalfLifeDays)
    : null;

  // Signal strength multiplier: [1 - scale, 1 + scale]
  const clamped = clamp(signalStrength, 0, 1);
  const signalStrengthMultiplier = 1 - signalScaleFactor + clamped * signalScaleFactor * 2;

  if (!enabled) {
    // Legacy path — caller should use confidence * 0.1 directly, but we handle it here
    // for the guard in expressions.ts
    return {
      edge: 0,
      source: 'prior',
      sampleCount: 0,
      empiricalExpectancy: null,
      priorEdge,
      signalStrengthMultiplier,
    };
  }

  const { expectancy, sampleCount } = computeSegmentExpectancy(
    journals,
    segment,
    decayHalfLifeDays
  );

  if (sampleCount < minSamples || expectancy === null) {
    const edge = Math.max(0, priorEdge * signalStrengthMultiplier);
    return {
      edge,
      source: 'prior',
      sampleCount,
      empiricalExpectancy: expectancy,
      priorEdge,
      signalStrengthMultiplier,
    };
  }

  // Blend weight saturates at 1.0 when sampleCount reaches 3× minSamples
  const blendWeight = clamp(sampleCount / (minSamples * 3), 0, 1);
  const blendedExpectancy = (1 - blendWeight) * priorEdge + blendWeight * expectancy;
  const edge = Math.max(0, blendedExpectancy * signalStrengthMultiplier);

  const source = blendWeight >= 1 ? 'empirical' : 'blended';

  return {
    edge,
    source,
    sampleCount,
    empiricalExpectancy: expectancy,
    priorEdge,
    signalStrengthMultiplier,
  };
}
