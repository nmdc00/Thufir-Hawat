import type { PerpTradeJournalEntry } from '../memory/perp_trade_journal.js';
import type { LearningCaseInput } from '../memory/learning_cases.js';

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

function toFiniteOrNull(input: unknown): number | null {
  const value = Number(input);
  return Number.isFinite(value) ? value : null;
}

function meanOrNull(values: Array<number | null>): number | null {
  const usable = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (usable.length === 0) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function parseCreatedAtMs(snapshot: Record<string, unknown> | null | undefined): number | null {
  const fromMs = toFiniteOrNull(snapshot?.createdAtMs);
  if (fromMs != null) return fromMs;
  const iso = snapshot?.createdAtIso;
  if (typeof iso !== 'string' || iso.trim().length === 0) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
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
