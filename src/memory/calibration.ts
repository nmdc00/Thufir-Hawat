import { openDatabase } from './db.js';
import { LEGACY_PERP_CONTAMINATION_WHERE_SQL } from './learning_schema.js';
import { adjustCashBalance } from './portfolio.js';
import { listTradesByPrediction } from './trades.js';
import {
  getSignalWeights,
  recordLearningEvent,
} from './learning.js';
import { listLearningCases, updateLearningCaseOutcome } from './learning_cases.js';

export interface CalibrationSummary {
  domain: string;
  totalPredictions: number;
  resolvedPredictions: number;
  accuracy: number | null;
  avgBrier: number | null;
}

interface PredictionOutcomeRow {
  outcome?: string | null;
  marketId?: string;
  domain?: string | null;
  predictedOutcome?: string;
  predictedProbability?: number | null;
  confidenceRaw?: number | null;
  confidenceAdjusted?: number | null;
  modelProbability?: number | null;
  marketProbability?: number | null;
  signalScores?: string | null;
  signalWeightsSnapshot?: string | null;
  learningComparable?: number;
  outcomeBasis?: 'final' | 'estimated' | 'legacy' | null;
  executed?: number;
  executionPrice?: number | null;
  positionSize?: number | null;
}

function resolvePreferredModelProbability(prediction: PredictionOutcomeRow | undefined): number | null {
  if (typeof prediction?.modelProbability === 'number' && Number.isFinite(prediction.modelProbability)) {
    return prediction.modelProbability;
  }
  if (
    typeof prediction?.predictedProbability === 'number' &&
    Number.isFinite(prediction.predictedProbability)
  ) {
    return prediction.predictedProbability;
  }
  return null;
}

function computeBrier(probability: number | null, outcome: 'YES' | 'NO'): number | null {
  if (probability === null) {
    return null;
  }
  const outcomeValue = outcome === 'YES' ? 1 : 0;
  return Math.pow(probability - outcomeValue, 2);
}

function syncComparableLearningCaseOutcome(input: {
  predictionId: string;
  outcome: 'YES' | 'NO';
  outcomeBasis: 'final' | 'estimated';
  outcomeTimestamp: string;
  resolutionStatus: 'resolved_true' | 'resolved_false';
  brier: number | null;
  pnl: number | null;
  resolutionMetadata?: Record<string, unknown> | null;
}): void {
  const learningCase = listLearningCases({
    caseType: 'comparable_forecast',
    sourcePredictionId: input.predictionId,
    limit: 1,
  })[0];
  if (!learningCase) {
    return;
  }
  updateLearningCaseOutcome({
    id: learningCase.id,
    outcome: {
      outcome: input.outcome,
      outcomeValue: input.outcome === 'YES' ? 1 : 0,
      outcomeBasis: input.outcomeBasis,
      resolutionStatus: input.resolutionStatus,
      resolvedAt: input.outcomeTimestamp,
      brier: input.brier,
      pnl: input.pnl,
      resolutionMetadata: input.resolutionMetadata ?? null,
    },
    policyInputs: {
      sourceTrack: 'comparable_forecast',
      comparableIncluded: input.outcomeBasis === 'final' && learningCase.comparable,
    },
    comparable:
      input.outcomeBasis === 'estimated' && learningCase.comparable
        ? false
        : undefined,
    exclusionReason:
      input.outcomeBasis === 'estimated' && learningCase.comparable
        ? 'estimated_outcome_only'
        : undefined,
  });
}

export function recordOutcome(params: {
  id: string;
  outcome: 'YES' | 'NO';
  outcomeBasis?: 'final' | 'estimated';
  outcomeTimestamp?: string;
  resolutionMetadata?: Record<string, unknown> | null;
  pnl?: number | null;
}): void {
  const db = openDatabase();
  const prediction = db
    .prepare(
      `
        SELECT outcome,
               market_id as marketId,
               domain,
               predicted_outcome as predictedOutcome,
               predicted_probability as predictedProbability,
               confidence_raw as confidenceRaw,
               confidence_adjusted as confidenceAdjusted,
               model_probability as modelProbability,
               market_probability as marketProbability,
               signal_scores as signalScores,
               signal_weights_snapshot as signalWeightsSnapshot,
               learning_comparable as learningComparable,
               outcome_basis as outcomeBasis,
               executed,
               execution_price as executionPrice,
               position_size as positionSize
        FROM predictions
        WHERE id = ?
      `
    )
    .get(params.id) as PredictionOutcomeRow | undefined;

  if (prediction?.outcome) {
    return;
  }

  const normalizedPredictedOutcome =
    typeof prediction?.predictedOutcome === 'string'
      ? prediction.predictedOutcome.toUpperCase()
      : null;
  const resolutionStatus =
    normalizedPredictedOutcome === params.outcome
      ? 'resolved_true'
      : 'resolved_false';

  const preferredModelProbability = resolvePreferredModelProbability(prediction);
  const brier = computeBrier(preferredModelProbability, params.outcome);

  let pnl: number | null = null;
  let payout: number | null = null;
  const trades = listTradesByPrediction(params.id);
  if (trades.length > 0) {
    const cashFlow = trades.reduce((sum, trade) => {
      const amount = trade.amount ?? 0;
      return sum + (trade.side === 'sell' ? amount : -amount);
    }, 0);
    const sharesByOutcome = new Map<string, number>();
    for (const trade of trades) {
      const shares = trade.shares ?? 0;
      const key = trade.outcome;
      const current = sharesByOutcome.get(key) ?? 0;
      sharesByOutcome.set(
        key,
        current + (trade.side === 'sell' ? -shares : shares)
      );
    }
    payout = sharesByOutcome.get(params.outcome) ?? 0;
    pnl = cashFlow + payout;
  } else if (prediction?.executed && prediction.positionSize) {
    const positionSize = prediction.positionSize;
    if ((prediction.predictedOutcome ?? '').toUpperCase() === params.outcome) {
      if (prediction.executionPrice && prediction.executionPrice > 0) {
        const shares = positionSize / prediction.executionPrice;
        payout = shares;
        pnl = shares - positionSize;
      }
    } else {
      pnl = -positionSize;
    }
  }

  if (typeof params.pnl === 'number' && Number.isFinite(params.pnl)) {
    pnl = params.pnl;
  }

  const outcomeTimestamp = params.outcomeTimestamp ?? new Date().toISOString();
  const outcomeBasis = params.outcomeBasis ?? 'estimated';

  db.prepare(
    `
      UPDATE predictions
      SET outcome = @outcome,
          outcome_timestamp = @outcomeTimestamp,
          resolution_status = @resolutionStatus,
          resolution_error = NULL,
          resolution_metadata = @resolutionMetadata,
          resolution_timestamp = @resolutionTimestamp,
          brier_contribution = @brier,
          pnl = @pnl,
          outcome_basis = @outcomeBasis
      WHERE id = @id
    `
  ).run({
    id: params.id,
    outcome: params.outcome,
    outcomeTimestamp,
    resolutionStatus,
    resolutionMetadata: params.resolutionMetadata
      ? JSON.stringify(params.resolutionMetadata)
      : null,
    resolutionTimestamp: outcomeTimestamp,
    brier,
    pnl,
    outcomeBasis,
  });

  db.prepare(
    `
      UPDATE predictions
      SET learning_comparable = 0
      WHERE id = ?
        AND ${LEGACY_PERP_CONTAMINATION_WHERE_SQL}
    `
  ).run(params.id);

  if (payout && payout > 0) {
    adjustCashBalance(payout);
  }

  syncComparableLearningCaseOutcome({
    predictionId: params.id,
    outcome: params.outcome,
    outcomeBasis,
    outcomeTimestamp,
    resolutionStatus,
    brier,
    pnl,
    resolutionMetadata: params.resolutionMetadata ?? null,
  });

  if (prediction?.marketId) {
    const parsedSignalScores =
      typeof prediction.signalScores === 'string'
        ? (JSON.parse(prediction.signalScores) as { technical?: number; news?: number; onChain?: number })
        : null;
    const parsedSignalWeights =
      typeof prediction.signalWeightsSnapshot === 'string'
        ? (JSON.parse(prediction.signalWeightsSnapshot) as {
            technical?: number;
            news?: number;
            onChain?: number;
          })
        : null;
    recordLearningEvent({
      predictionId: params.id,
      marketId: prediction.marketId,
      domain: prediction.domain ?? 'global',
      predictedOutcome: prediction.predictedOutcome ?? null,
      predictedProbability: preferredModelProbability,
      outcome: params.outcome,
      brier,
      pnl,
      confidenceRaw: prediction.confidenceRaw ?? null,
      confidenceAdjusted: prediction.confidenceAdjusted ?? null,
      signalScores:
        parsedSignalScores &&
        Number.isFinite(Number(parsedSignalScores.technical)) &&
        Number.isFinite(Number(parsedSignalScores.news)) &&
        Number.isFinite(Number(parsedSignalScores.onChain))
          ? {
              technical: Number(parsedSignalScores.technical),
              news: Number(parsedSignalScores.news),
              onChain: Number(parsedSignalScores.onChain),
            }
          : null,
      signalWeights:
        parsedSignalWeights &&
        Number.isFinite(Number(parsedSignalWeights.technical)) &&
        Number.isFinite(Number(parsedSignalWeights.news)) &&
        Number.isFinite(Number(parsedSignalWeights.onChain))
          ? {
              technical: Number(parsedSignalWeights.technical),
              news: Number(parsedSignalWeights.news),
              onChain: Number(parsedSignalWeights.onChain),
            }
          : getSignalWeights(prediction.domain ?? 'global'),
      notes: {
        comparable: Boolean(prediction.learningComparable),
        marketProbability: prediction.marketProbability ?? null,
        modelProbability: prediction.modelProbability ?? null,
        outcomeBasis: outcomeBasis ?? prediction.outcomeBasis ?? 'estimated',
      },
    });
  }
}

export function countFinalPredictions(): number {
  const db = openDatabase();
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM learning_examples').get() as
      | { c: number }
      | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

export function listCalibrationSummaries(): CalibrationSummary[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          domain,
          COUNT(*) as totalPredictions,
          SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolvedPredictions,
          AVG(CASE
            WHEN outcome IS NOT NULL THEN
              CASE WHEN predicted_outcome = outcome THEN 1.0 ELSE 0.0 END
            ELSE NULL
          END) as accuracy,
          AVG(CASE
            WHEN outcome IS NOT NULL THEN brier_contribution
            ELSE NULL
          END) as avgBrier
        FROM predictions
        GROUP BY domain
      `
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    domain: String(row.domain ?? 'unknown'),
    totalPredictions: Number(row.totalPredictions ?? 0),
    resolvedPredictions: Number(row.resolvedPredictions ?? 0),
    accuracy:
      row.accuracy === null || row.accuracy === undefined
        ? null
        : Number(row.accuracy),
    avgBrier:
      row.avgBrier === null || row.avgBrier === undefined
        ? null
        : Number(row.avgBrier),
  }));
}

export function listResolvedPredictions(limit = 50): Array<{
  id: string;
  marketTitle: string;
  predictedOutcome?: string;
  predictedProbability?: number;
  outcome?: string;
  brier?: number;
  outcomeTimestamp?: string;
  domain?: string;
}> {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT id, market_title as marketTitle, predicted_outcome as predictedOutcome,
               predicted_probability as predictedProbability, outcome, brier_contribution as brier,
               outcome_timestamp as outcomeTimestamp, domain
        FROM predictions
        WHERE outcome IS NOT NULL
        ORDER BY outcome_timestamp DESC
        LIMIT ?
      `
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    marketTitle: String(row.marketTitle),
    predictedOutcome: row.predictedOutcome ? String(row.predictedOutcome) : undefined,
    predictedProbability:
      row.predictedProbability === null || row.predictedProbability === undefined
        ? undefined
        : Number(row.predictedProbability),
    outcome: row.outcome ? String(row.outcome) : undefined,
    brier:
      row.brier === null || row.brier === undefined ? undefined : Number(row.brier),
    outcomeTimestamp: row.outcomeTimestamp ? String(row.outcomeTimestamp) : undefined,
    domain: row.domain ? String(row.domain) : undefined,
  }));
}
