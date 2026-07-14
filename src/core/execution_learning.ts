import type { ThufirConfig } from './config.js';
import type { PerpTradeJournalEntry } from '../memory/perp_trade_journal.js';
import type { LearningCaseInput } from '../memory/learning_cases.js';

export type ExecutionLearningSourceLevel =
  | 'exact'
  | 'partial'
  | 'coarse'
  | 'archetype'
  | 'prior';

export type ExecutionLearningSegment = {
  signalClass: string;
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
};

export type ExecutionLearningCase = {
  kind: 'execution_learning_case';
  caseType: 'execution_quality';
  comparable: false;
  domain: 'perp';
  entityType: 'symbol';
  entityId: string;
  executionMode: 'paper' | 'live' | null;
  sourceTradeId: number | null;
  sourceDossierId: string | null;
  sourceHypothesisId: string | null;
  createdAtMs: number | null;
  context: {
    symbol?: string | null;
    direction?: string | null;
    signalClass: string | null;
    triggerReason?: string | null;
    symbolClass?: string | null;
    session?: string | null;
    strategySource?: string | null;
    marketRegime: string | null;
    volatilityBucket: string | null;
    liquidityBucket: string | null;
    tradeArchetype: string | null;
    entryTrigger: string | null;
  };
  action: {
    side: 'buy' | 'sell' | null;
    reduceOnly: boolean;
    size: number | null;
    leverage: number | null;
    expectedEdge: number | null;
    invalidationPrice: number | null;
    timeStopAtMs: number | null;
    entryPrice: number | null;
    exitPrice: number | null;
  };
  outcome: {
    thesisCorrect: boolean | null;
    thesisInvalidationHit: boolean | null;
    exitMode: string | null;
    realizedPnlUsd: number | null;
    netRealizedPnlUsd: number | null;
    realizedFeeUsd: number | null;
    pricePathHigh: number | null;
    pricePathLow: number | null;
  };
  quality: {
    directionScore: number | null;
    timingScore: number | null;
    sizingScore: number | null;
    exitScore: number | null;
    capturedR: number | null;
    leftOnTableR: number | null;
    wouldHit2R: boolean | null;
    wouldHit3R: boolean | null;
    maeProxy: number | null;
    mfeProxy: number | null;
    compositeScore: number | null;
  };
  policyInputs: {
    reasoning: string | null;
    planContext: Record<string, unknown> | null;
    gateVerdict?: string | null;
    gateReasonCode?: string | null;
    interventionEvidence?: Record<string, unknown> | null;
  };
  sourceLinks: {
    snapshot: Record<string, unknown> | null;
  };
  pairedCases?: LearningCaseInput[];
};

export type ExecutionSegmentSummary = {
  sourceLevel: ExecutionLearningSourceLevel;
  sampleCount: number;
  expectancy: number | null;
  confidenceWeight: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toFiniteOrNull(input: unknown): number | null {
  const value = Number(input);
  return Number.isFinite(value) ? value : null;
}

function meanOrNull(values: Array<number | null>): number | null {
  const usable = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (usable.length === 0) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function weightedMean(values: number[], weights: number[]): number {
  if (values.length === 0 || values.length !== weights.length) return 0;
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0) return 0;
  return values.reduce((sum, value, index) => sum + value * (weights[index] ?? 0), 0) / totalWeight;
}

function parseCreatedAtMs(snapshot: Record<string, unknown> | null | undefined): number | null {
  const fromMs = toFiniteOrNull(snapshot?.createdAtMs);
  if (fromMs != null) return fromMs;
  const iso = snapshot?.createdAtIso;
  if (typeof iso !== 'string' || iso.trim().length === 0) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function levelPenalty(level: ExecutionLearningSourceLevel): number {
  switch (level) {
    case 'exact': return 1;
    case 'partial': return 0.85;
    case 'coarse': return 0.7;
    case 'archetype': return 0.55;
    case 'prior': return 0;
  }
}

function matchesLevel(
  learningCase: ExecutionLearningCase,
  segment: ExecutionLearningSegment,
  level: Exclude<ExecutionLearningSourceLevel, 'prior'>
): boolean {
  const context = learningCase.context;
  if (context.signalClass !== segment.signalClass) return false;
  if (level === 'archetype') return true;
  if (context.marketRegime !== segment.marketRegime) return false;
  if (level === 'coarse') return true;
  if (context.volatilityBucket !== segment.volatilityBucket) return false;
  if (level === 'partial') return true;
  return context.liquidityBucket === segment.liquidityBucket;
}

function extractExpectancy(learningCase: ExecutionLearningCase): number | null {
  return toFiniteOrNull(learningCase.quality.capturedR);
}

export function normalizeJournalEntriesToExecutionLearningCases(
  journals: PerpTradeJournalEntry[]
): ExecutionLearningCase[] {
  const normalized: ExecutionLearningCase[] = [];

  for (const entry of journals) {
    if (entry.kind !== 'perp_trade_journal' || entry.outcome !== 'executed' || entry.reduceOnly !== true) {
      continue;
    }

    const snapshot = entry.snapshot ?? null;
    const directionScore = toFiniteOrNull(entry.directionScore ?? entry.direction_score);
    const timingScore = toFiniteOrNull(entry.timingScore ?? entry.timing_score);
    const sizingScore = toFiniteOrNull(entry.sizingScore ?? entry.sizing_score);
    const exitScore = toFiniteOrNull(entry.exitScore ?? entry.exit_score);

    normalized.push({
      kind: 'execution_learning_case',
      caseType: 'execution_quality',
      comparable: false,
      domain: 'perp',
      entityType: 'symbol',
      entityId: entry.symbol,
      executionMode: entry.execution_mode ?? null,
      sourceTradeId: entry.tradeId ?? null,
      sourceDossierId: null,
      sourceHypothesisId: entry.hypothesisId ?? null,
      createdAtMs: parseCreatedAtMs(snapshot),
      context: {
        symbol: entry.symbol,
        direction:
          (snapshot?.direction as string | null | undefined) ??
          (entry.side === 'buy' ? 'long' : entry.side === 'sell' ? 'short' : null),
        signalClass: entry.signalClass ?? null,
        triggerReason: (snapshot?.triggerReason as string | null | undefined) ?? null,
        symbolClass: (snapshot?.symbolClass as string | null | undefined) ?? null,
        session: (snapshot?.session as string | null | undefined) ?? null,
        strategySource: (snapshot?.strategySource as string | null | undefined) ?? null,
        marketRegime: entry.marketRegime ?? null,
        volatilityBucket: entry.volatilityBucket ?? null,
        liquidityBucket: entry.liquidityBucket ?? null,
        tradeArchetype: entry.tradeArchetype ?? null,
        entryTrigger: entry.entryTrigger ?? null,
      },
      action: {
        side: entry.side ?? null,
        reduceOnly: true,
        size: toFiniteOrNull(entry.size),
        leverage: toFiniteOrNull(entry.leverage),
        expectedEdge: toFiniteOrNull(entry.expectedEdge),
        invalidationPrice: toFiniteOrNull(entry.invalidationPrice),
        timeStopAtMs: toFiniteOrNull(entry.timeStopAtMs),
        entryPrice: toFiniteOrNull(snapshot?.entryPrice),
        exitPrice: toFiniteOrNull(snapshot?.exitPrice),
      },
      outcome: {
        thesisCorrect: entry.thesisCorrect ?? null,
        thesisInvalidationHit: entry.thesisInvalidationHit ?? null,
        exitMode: entry.exitMode ?? null,
        realizedPnlUsd: null,
        netRealizedPnlUsd: null,
        realizedFeeUsd: toFiniteOrNull(entry.realizedFeeUsd),
        pricePathHigh: toFiniteOrNull(snapshot?.pricePathHigh),
        pricePathLow: toFiniteOrNull(snapshot?.pricePathLow),
      },
      quality: {
        directionScore,
        timingScore,
        sizingScore,
        exitScore,
        capturedR: toFiniteOrNull(entry.capturedR ?? entry.captured_r),
        leftOnTableR: toFiniteOrNull(entry.leftOnTableR ?? entry.left_on_table_r),
        wouldHit2R: entry.wouldHit2R ?? entry.would_hit_2r ?? null,
        wouldHit3R: entry.wouldHit3R ?? entry.would_hit_3r ?? null,
        maeProxy: toFiniteOrNull(entry.maeProxy),
        mfeProxy: toFiniteOrNull(entry.mfeProxy),
        compositeScore: meanOrNull([directionScore, timingScore, sizingScore, exitScore]),
      },
      policyInputs: {
        reasoning: entry.reasoning ?? null,
        planContext: entry.planContext ?? null,
      },
      sourceLinks: {
        snapshot,
      },
    });
  }

  return normalized;
}

export function computeExecutionSegmentSummary(params: {
  cases: ExecutionLearningCase[];
  segment: ExecutionLearningSegment;
  sourceLevel: Exclude<ExecutionLearningSourceLevel, 'prior'>;
  minSamples: number;
  decayHalfLifeDays: number | null;
  nowMs?: number;
}): ExecutionSegmentSummary {
  const nowMs = params.nowMs ?? Date.now();
  const matchingCases = params.cases.filter(
    (learningCase) =>
      matchesLevel(learningCase, params.segment, params.sourceLevel) &&
      extractExpectancy(learningCase) != null
  );

  if (matchingCases.length === 0) {
    return {
      sourceLevel: params.sourceLevel,
      sampleCount: 0,
      expectancy: null,
      confidenceWeight: 0,
    };
  }

  const values = matchingCases
    .map((learningCase) => extractExpectancy(learningCase))
    .filter((value): value is number => value != null);

  let expectancy: number;
  if (params.decayHalfLifeDays != null && params.decayHalfLifeDays > 0) {
    const halfLifeMs = params.decayHalfLifeDays * 24 * 60 * 60 * 1000;
    const weights = matchingCases.map((learningCase) => {
      const createdAtMs = learningCase.createdAtMs ?? nowMs;
      const ageMs = Math.max(0, nowMs - createdAtMs);
      return Math.pow(2, -(ageMs / halfLifeMs));
    });
    expectancy = weightedMean(values, weights);
  } else {
    expectancy = values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  const sampleWeight = clamp(
    matchingCases.length / Math.max(1, params.minSamples * 3),
    0,
    1
  );
  return {
    sourceLevel: params.sourceLevel,
    sampleCount: matchingCases.length,
    expectancy,
    confidenceWeight: sampleWeight * levelPenalty(params.sourceLevel),
  };
}

export function resolveHierarchicalExecutionEdge(params: {
  config: ThufirConfig;
  cases: ExecutionLearningCase[];
  segment: ExecutionLearningSegment;
  signalStrength: number;
  nowMs?: number;
}): {
  edge: number;
  source: 'prior' | 'blended' | 'empirical';
  sourceLevel: ExecutionLearningSourceLevel;
  sampleCount: number;
  empiricalExpectancy: number | null;
  priorEdge: number;
  signalStrengthMultiplier: number;
  confidenceWeight: number;
} {
  const adaptiveCfg = (params.config.autonomy as Record<string, any> | undefined)?.adaptiveEdge ?? {};
  const enabled = adaptiveCfg.enabled !== false;
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
  const clampedSignalStrength = clamp(params.signalStrength, 0, 1);
  const signalStrengthMultiplier =
    1 - signalScaleFactor + clampedSignalStrength * signalScaleFactor * 2;

  if (!enabled) {
    return {
      edge: 0,
      source: 'prior',
      sourceLevel: 'prior',
      sampleCount: 0,
      empiricalExpectancy: null,
      priorEdge,
      signalStrengthMultiplier,
      confidenceWeight: 0,
    };
  }

  const levels: Array<Exclude<ExecutionLearningSourceLevel, 'prior'>> = [
    'exact', 'partial', 'coarse', 'archetype',
  ];
  const selected = levels
    .map((sourceLevel) => computeExecutionSegmentSummary({
      cases: params.cases,
      segment: params.segment,
      sourceLevel,
      minSamples,
      decayHalfLifeDays,
      nowMs: params.nowMs,
    }))
    .find((summary) => summary.sampleCount > 0);

  if (!selected || selected.expectancy == null) {
    return {
      edge: Math.max(0, priorEdge * signalStrengthMultiplier),
      source: 'prior',
      sourceLevel: 'prior',
      sampleCount: 0,
      empiricalExpectancy: null,
      priorEdge,
      signalStrengthMultiplier,
      confidenceWeight: 0,
    };
  }

  const blendedExpectancy =
    (1 - selected.confidenceWeight) * priorEdge +
    selected.confidenceWeight * selected.expectancy;
  return {
    edge: Math.max(0, blendedExpectancy * signalStrengthMultiplier),
    source: selected.confidenceWeight >= 1 ? 'empirical' : 'blended',
    sourceLevel: selected.sourceLevel,
    sampleCount: selected.sampleCount,
    empiricalExpectancy: selected.expectancy,
    priorEdge,
    signalStrengthMultiplier,
    confidenceWeight: selected.confidenceWeight,
  };
}
