import { openDatabase } from './db.js';
import { adjustCashBalance } from './portfolio.js';
import { listTradesByPrediction } from './trades.js';
import { recordLearningEvent } from './learning.js';

export interface CalibrationSummary {
  domain: string;
  totalPredictions: number;
  resolvedPredictions: number;
  accuracy: number | null;
  avgBrier: number | null;
}

export function recordOutcome(params: {
  id: string;
  outcome: 'YES' | 'NO';
  outcomeTimestamp?: string;
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
               executed,
               execution_price as executionPrice,
               position_size as positionSize
        FROM predictions
        WHERE id = ?
      `
    )
    .get(params.id) as
    | {
        outcome?: string | null;
        marketId?: string;
        domain?: string | null;
        predictedOutcome?: string;
        predictedProbability?: number;
        executed?: number;
        executionPrice?: number | null;
        positionSize?: number | null;
      }
    | undefined;

  if (prediction?.outcome) {
    return;
  }

  const predictedProbability = prediction?.predictedProbability ?? null;
  const outcomeValue = params.outcome === 'YES' ? 1 : 0;
  const brier =
    predictedProbability === null ? null : Math.pow(predictedProbability - outcomeValue, 2);

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

  db.prepare(
    `
      UPDATE predictions
      SET outcome = @outcome,
          outcome_timestamp = @outcomeTimestamp,
          brier_contribution = @brier,
          pnl = @pnl
      WHERE id = @id
    `
  ).run({
    id: params.id,
    outcome: params.outcome,
    outcomeTimestamp: params.outcomeTimestamp ?? new Date().toISOString(),
    brier,
    pnl,
  });

  if (payout && payout > 0) {
    adjustCashBalance(payout);
  }

  if (prediction?.marketId) {
    recordLearningEvent({
      predictionId: params.id,
      marketId: prediction.marketId,
      domain: prediction.domain ?? 'global',
      predictedOutcome: prediction.predictedOutcome ?? null,
      predictedProbability: predictedProbability,
      outcome: params.outcome,
      brier,
      pnl,
    });
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
