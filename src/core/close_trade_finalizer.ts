import type { ThufirConfig } from './config.js';
import { materializeTradePolicyAdjustmentFromLearningCase } from './trade_policy_materialization.js';
import {
  getActivePerpPositionTradeId,
  recordPerpTrade,
  setActivePerpPositionLifecycle,
} from '../memory/perp_trades.js';
import { listPaperPerpPositions } from '../memory/paper_perps.js';
import { storeDecisionArtifact } from '../memory/decision_artifacts.js';
import {
  claimDueCloseFinalizationJob,
  getTradeCloseEvent,
  insertRegretLearningCase,
  insertTradeReflection,
  markCloseFinalizationJobFailed,
  markCloseFinalizationJobFinalized,
  recoverExpiredCloseFinalizationLeases,
  upsertTradeClose,
} from '../memory/close_trade_finalizer.js';
import { listLearningCases } from '../memory/learning_cases.js';

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function average(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function sideFromCloseSide(closeSide: 'buy' | 'sell' | null): 'long' | 'short' | null {
  if (closeSide === 'sell') return 'long';
  if (closeSide === 'buy') return 'short';
  return null;
}

function deterministicCodes(params: {
  thesisCorrect: boolean | null;
  capturedR: number | null;
  leftOnTableR: number | null;
  compositeScore: number | null;
  exitMode: string | null;
}): { worked: string[]; failed: string[]; lessons: string[] } {
  const worked: string[] = [];
  const failed: string[] = [];
  const lessons: string[] = [];
  if (params.thesisCorrect === true) worked.push('thesis_played_out');
  if (params.thesisCorrect === false) {
    failed.push('thesis_failed');
    lessons.push('tighten_entry_confirmation');
  }
  if (params.capturedR != null && params.capturedR >= 1) worked.push('captured_positive_r');
  if (params.capturedR != null && params.capturedR < 0) {
    failed.push('negative_r_close');
    lessons.push('respect_invalidation_or_reduce_risk');
  }
  if (params.leftOnTableR != null && params.leftOnTableR > 1) {
    failed.push('left_on_table');
    lessons.push('review_exit_timing');
  }
  if (params.compositeScore != null && params.compositeScore < 0.45) {
    failed.push('low_execution_quality');
    lessons.push('downweight_similar_scope_until_quality_recovers');
  }
  if (params.exitMode === 'thesis_invalidation') {
    lessons.push('log_invalidation_context_for_future_filters');
  }
  return { worked, failed, lessons: Array.from(new Set(lessons)) };
}

export function finalizeCloseEvent(params: {
  config: ThufirConfig;
  closeEventId: string;
}): { tradeCloseId: string } {
  const event = getTradeCloseEvent(params.closeEventId);
  if (event.closeKind !== 'full_close') {
    return { tradeCloseId: event.id };
  }

  const closePayload = event.closeJournalPayload ?? {};
  const entryPayload = event.entryJournalPayload ?? {};
  const snapshot = event.snapshotPayload ?? {};
  const linkedLearningCase = listLearningCases({
    caseType: 'execution_quality',
    domain: 'perp',
    entityType: 'symbol',
    entityId: event.symbol,
    sourceTradeId: event.tradeId ?? undefined,
    limit: 1,
  })[0] ?? null;

  const directionScore = num(closePayload.directionScore ?? closePayload.direction_score ?? linkedLearningCase?.qualityScores?.directionScore);
  const timingScore = num(closePayload.timingScore ?? closePayload.timing_score ?? linkedLearningCase?.qualityScores?.timingScore);
  const sizingScore = num(closePayload.sizingScore ?? closePayload.sizing_score ?? linkedLearningCase?.qualityScores?.sizingScore);
  const exitScore = num(closePayload.exitScore ?? closePayload.exit_score ?? linkedLearningCase?.qualityScores?.exitScore);
  const compositeScore = average([directionScore, timingScore, sizingScore, exitScore]);
  const thesisCorrect = bool(closePayload.thesisCorrect ?? linkedLearningCase?.outcome?.thesisCorrect);
  const capturedR = num(closePayload.capturedR ?? closePayload.captured_r ?? linkedLearningCase?.qualityScores?.capturedR);
  const leftOnTableR = num(closePayload.leftOnTableR ?? closePayload.left_on_table_r ?? linkedLearningCase?.qualityScores?.leftOnTableR);
  const entryPrice = num(snapshot.entryPrice ?? closePayload.entryPrice ?? entryPayload.markPrice);
  const exitPrice = event.exitPrice ?? num(snapshot.exitPrice ?? closePayload.markPrice);
  const feesUsd = event.realizedFeeUsd ?? num(closePayload.realizedFeeUsd);
  const grossPnl = event.realizedPnlUsd ?? num(closePayload.realizedPnlUsd);
  const netPnl = event.netRealizedPnlUsd ?? (grossPnl != null ? grossPnl - (feesUsd ?? 0) : null);
  const openedAt = stringOrNull(entryPayload.createdAt) ?? null;
  const closedAt = event.createdAt;
  const holdSeconds =
    openedAt != null && Number.isFinite(Date.parse(openedAt)) && Number.isFinite(Date.parse(closedAt))
      ? Math.max(0, Math.floor((Date.parse(closedAt) - Date.parse(openedAt)) / 1000))
      : null;

  const tradeClose = upsertTradeClose({
    id: event.id,
    closeEventId: event.id,
    lifecycleId: event.lifecycleId,
    tradeId: event.tradeId,
    symbol: event.symbol,
    closedSide: sideFromCloseSide(event.side),
    executionMode: event.executionMode,
    openedAt,
    closedAt,
    holdSeconds,
    entryPrice,
    exitPrice,
    totalOpenedSize: num(entryPayload.size),
    totalReducedSize: event.sizeReduced,
    finalCloseSize: event.sizeReduced,
    grossRealizedPnlUsd: grossPnl,
    feesUsd,
    netRealizedPnlUsd: netPnl,
    capturedR,
    leftOnTableR,
    exitMode: event.exitMode,
    thesisInvalidationHit: event.thesisInvalidationHit,
    thesisCorrect,
    directionScore,
    timingScore,
    sizingScore,
    exitScore,
    compositeScore,
    linkedPredictionId: stringOrNull(snapshot.predictionId ?? closePayload.prediction_id),
    sourceLearningCaseId: linkedLearningCase?.id ?? null,
    sourceAuthority: event.sourceAuthority,
    bootstrapQuality: event.bootstrapQuality,
    deterministicStatus: 'finalized',
    llmReflectionStatus: 'not_requested',
    facts: {
      closeEvent: event,
      closeJournal: closePayload,
      entryJournal: entryPayload,
      learningCaseId: linkedLearningCase?.id ?? null,
    },
  });

  const codes = deterministicCodes({
    thesisCorrect,
    capturedR,
    leftOnTableR,
    compositeScore,
    exitMode: event.exitMode,
  });
  insertTradeReflection({
    tradeCloseId: tradeClose.id,
    thesisCorrect,
    timingCorrect: timingScore == null ? null : timingScore >= 0.5,
    exitReasonAppropriate: exitScore == null ? null : exitScore >= 0.5,
    whatWorked: codes.worked,
    whatFailed: codes.failed,
    lessonForNextTrade: codes.lessons,
    sourceFacts: {
      capturedR,
      leftOnTableR,
      compositeScore,
      thesisCorrect,
      exitMode: event.exitMode,
    },
    confidence: compositeScore,
  });

  if (capturedR != null && capturedR < 0) {
    insertRegretLearningCase({
      tradeCloseId: tradeClose.id,
      lifecycleId: event.lifecycleId,
      symbol: event.symbol,
      regretType: 'negative_r_close',
      severity: Math.min(1, Math.abs(capturedR)),
      evidence: { capturedR, thesisCorrect, exitMode: event.exitMode },
      policyEvidence: { signalClass: closePayload.signalClass, marketRegime: closePayload.marketRegime },
    });
  }
  if (leftOnTableR != null && leftOnTableR > 1) {
    insertRegretLearningCase({
      tradeCloseId: tradeClose.id,
      lifecycleId: event.lifecycleId,
      symbol: event.symbol,
      regretType: 'closed_too_early',
      severity: Math.min(1, leftOnTableR / 3),
      evidence: { leftOnTableR, capturedR },
      policyEvidence: { signalClass: closePayload.signalClass, marketRegime: closePayload.marketRegime },
    });
  }

  if (linkedLearningCase) {
    materializeTradePolicyAdjustmentFromLearningCase({
      config: params.config,
      learningCase: linkedLearningCase,
      tradeCloseId: tradeClose.id,
    });
  }

  return { tradeCloseId: tradeClose.id };
}

export function runDueCloseFinalizationJobs(params: {
  config: ThufirConfig;
  workerId?: string;
  limit?: number;
}): { finalized: number; failed: number; recovered: number } {
  const recovered = recoverExpiredCloseFinalizationLeases();
  let finalized = 0;
  let failed = 0;
  const limit = Math.max(1, params.limit ?? 10);
  for (let i = 0; i < limit; i += 1) {
    const job = claimDueCloseFinalizationJob({ workerId: params.workerId });
    if (!job) break;
    try {
      finalizeCloseEvent({ config: params.config, closeEventId: job.closeEventId });
      markCloseFinalizationJobFinalized(job.id);
      finalized += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markCloseFinalizationJobFailed(job.id, message, job.attempts);
      failed += 1;
    }
  }
  return { finalized, failed, recovered };
}

export function startCloseTradeFinalizerWorker(params: {
  config: ThufirConfig;
  intervalMs?: number;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
}): { stop: () => void } {
  const intervalMs = Math.max(1000, params.intervalMs ?? 5000);
  const run = () => {
    const result = runDueCloseFinalizationJobs({
      config: params.config,
      workerId: `gateway-${process.pid}`,
      limit: 10,
    });
    if (result.finalized > 0 || result.failed > 0 || result.recovered > 0) {
      params.logger?.info?.(
        `Close finalizer: finalized=${result.finalized} failed=${result.failed} recovered=${result.recovered}`
      );
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  run();
  return { stop: () => clearInterval(timer) };
}

export function bootstrapOpenPerpPositionLifecycles(params?: {
  mode?: 'paper';
  initialCashUsdc?: number;
  source?: string;
}): { inspected: number; bootstrapped: number; skipped: number } {
  const mode = params?.mode ?? 'paper';
  const initialCashUsdc = params?.initialCashUsdc ?? 200;
  const source = params?.source ?? 'close_finalizer_bootstrap';
  const positions = mode === 'paper' ? listPaperPerpPositions(initialCashUsdc) : [];
  let bootstrapped = 0;
  let skipped = 0;

  for (const position of positions) {
    const symbol = position.symbol.trim().toUpperCase();
    if (!symbol || position.size <= 0) {
      skipped += 1;
      continue;
    }
    const existingTradeId = getActivePerpPositionTradeId(symbol);
    if (existingTradeId != null) {
      skipped += 1;
      continue;
    }
    const tradeId = recordPerpTrade({
      hypothesisId: null,
      symbol,
      side: position.side === 'long' ? 'buy' : 'sell',
      size: position.size,
      executionMode: mode,
      price: position.entryPrice,
      leverage: position.leverage,
      orderType: 'market',
      status: 'executed',
    });
    setActivePerpPositionLifecycle({
      symbol,
      tradeId,
      side: position.side,
    });
    storeDecisionArtifact({
      source: 'perps',
      kind: 'close_finalizer_bootstrap',
      marketId: symbol,
      fingerprint: `${symbol}:${tradeId}`,
      outcome: 'executed',
      payload: {
        source,
        mode,
        symbol,
        side: position.side,
        size: position.size,
        entryPrice: position.entryPrice,
        leverage: position.leverage,
        bootstrapQuality: 'open_position_snapshot',
      },
    });
    bootstrapped += 1;
  }

  return {
    inspected: positions.length,
    bootstrapped,
    skipped,
  };
}
