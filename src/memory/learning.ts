import { openDatabase } from './db.js';

export interface SignalWeights {
  technical: number;
  news: number;
  onChain: number;
}

export interface LearningEventInput {
  predictionId?: string | null;
  marketId: string;
  domain?: string | null;
  predictedOutcome?: string | null;
  predictedProbability?: number | null;
  outcome?: string | null;
  brier?: number | null;
  pnl?: number | null;
  edge?: number | null;
  confidenceRaw?: number | null;
  confidenceAdjusted?: number | null;
  signalScores?: SignalWeights | null;
  signalWeights?: SignalWeights | null;
  marketSnapshot?: Record<string, unknown> | null;
  modelVersion?: string | null;
  notes?: Record<string, unknown> | null;
}

function serialize(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parse<T>(value: unknown): T | null {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function recordLearningEvent(input: LearningEventInput): number {
  const db = openDatabase();
  const res = db
    .prepare(
      `
        INSERT INTO learning_events (
          prediction_id,
          market_id,
          domain,
          predicted_outcome,
          predicted_probability,
          outcome,
          brier,
          pnl,
          edge,
          confidence_raw,
          confidence_adjusted,
          signal_scores,
          signal_weights,
          market_snapshot,
          model_version,
          notes
        ) VALUES (
          @predictionId,
          @marketId,
          @domain,
          @predictedOutcome,
          @predictedProbability,
          @outcome,
          @brier,
          @pnl,
          @edge,
          @confidenceRaw,
          @confidenceAdjusted,
          @signalScores,
          @signalWeights,
          @marketSnapshot,
          @modelVersion,
          @notes
        )
      `
    )
    .run({
      predictionId: input.predictionId ?? null,
      marketId: input.marketId,
      domain: input.domain ?? 'global',
      predictedOutcome: input.predictedOutcome ?? null,
      predictedProbability: input.predictedProbability ?? null,
      outcome: input.outcome ?? null,
      brier: input.brier ?? null,
      pnl: input.pnl ?? null,
      edge: input.edge ?? null,
      confidenceRaw: input.confidenceRaw ?? null,
      confidenceAdjusted: input.confidenceAdjusted ?? null,
      signalScores: serialize(input.signalScores ?? null),
      signalWeights: serialize(input.signalWeights ?? null),
      marketSnapshot: serialize(input.marketSnapshot ?? null),
      modelVersion: input.modelVersion ?? null,
      notes: serialize(input.notes ?? null),
    });
  return Number(res.lastInsertRowid ?? 0);
}

export function getSignalWeights(domain = 'global'): SignalWeights | null {
  const db = openDatabase();
  const row = db
    .prepare(
      `
        SELECT weights
        FROM signal_weights
        WHERE domain = ?
        LIMIT 1
      `
    )
    .get(domain) as { weights?: string } | undefined;
  if (!row?.weights) return null;
  return parse<SignalWeights>(row.weights);
}

export function setSignalWeights(domain: string, weights: SignalWeights, samples = 0): void {
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO signal_weights (domain, weights, samples)
      VALUES (?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        weights = excluded.weights,
        samples = excluded.samples,
        updated_at = datetime('now')
    `
  ).run(domain, JSON.stringify(weights), samples);
}

export function updateSignalWeights(params: {
  domain?: string;
  scores: SignalWeights;
  weights: SignalWeights;
  outcome: 0 | 1;
  learningRate?: number;
}): { updated: SignalWeights; delta: SignalWeights } {
  const lr = params.learningRate ?? 0.05;
  const p = (params.weights.technical * params.scores.technical +
    params.weights.news * params.scores.news +
    params.weights.onChain * params.scores.onChain + 1) / 2;
  const error = p - params.outcome;
  const dTech = lr * 2 * error * (params.scores.technical / 2);
  const dNews = lr * 2 * error * (params.scores.news / 2);
  const dOn = lr * 2 * error * (params.scores.onChain / 2);

  let tech = params.weights.technical - dTech;
  let news = params.weights.news - dNews;
  let onChain = params.weights.onChain - dOn;

  tech = Math.min(Math.max(tech, 0), 1);
  news = Math.min(Math.max(news, 0), 1);
  onChain = Math.min(Math.max(onChain, 0), 1);
  const sum = tech + news + onChain || 1;
  const updated = {
    technical: tech / sum,
    news: news / sum,
    onChain: onChain / sum,
  };
  const delta = {
    technical: updated.technical - params.weights.technical,
    news: updated.news - params.weights.news,
    onChain: updated.onChain - params.weights.onChain,
  };
  return { updated, delta };
}

export function recordWeightUpdate(params: {
  learningEventId?: number | null;
  domain?: string;
  delta: SignalWeights;
  method?: string;
  learningRate?: number;
}): void {
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO weight_updates (
        learning_event_id,
        domain,
        delta,
        method,
        learning_rate
      ) VALUES (
        @learningEventId,
        @domain,
        @delta,
        @method,
        @learningRate
      )
    `
  ).run({
    learningEventId: params.learningEventId ?? null,
    domain: params.domain ?? 'global',
    delta: JSON.stringify(params.delta),
    method: params.method ?? 'brier-gradient',
    learningRate: params.learningRate ?? 0.05,
  });
}
