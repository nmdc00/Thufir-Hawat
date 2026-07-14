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
import {
  normalizeJournalEntriesToExecutionLearningCases,
  resolveHierarchicalExecutionEdge,
  type ExecutionLearningSourceLevel,
} from './execution_learning.js';

export type AdaptiveEdgeSegment = {
  signalClass: string;
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
};

export type AdaptiveEdgeResult = {
  edge: number;
  source: 'prior' | 'empirical' | 'blended';
  sourceLevel?: ExecutionLearningSourceLevel;
  sampleCount: number;
  empiricalExpectancy: number | null;
  priorEdge: number;
  signalStrengthMultiplier: number;
  confidenceWeight?: number;
};

function weightedMean(values: number[], weights: number[]): number {
  if (values.length === 0) return 0;
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) return 0;
  return values.reduce((sum, v, i) => sum + v * (weights[i] ?? 0), 0) / totalWeight;
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
  const learningCases = normalizeJournalEntriesToExecutionLearningCases(journals);
  const result = resolveHierarchicalExecutionEdge({
    config,
    cases: learningCases,
    segment,
    signalStrength,
  });

  return {
    edge: result.edge,
    source: result.source,
    sourceLevel: result.sourceLevel,
    sampleCount: result.sampleCount,
    empiricalExpectancy: result.empiricalExpectancy,
    priorEdge: result.priorEdge,
    signalStrengthMultiplier: result.signalStrengthMultiplier,
    confidenceWeight: result.confidenceWeight,
  };
}
