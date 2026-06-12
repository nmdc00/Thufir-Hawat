import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';
import { adjustCashBalance } from './portfolio.js';
import type { SignalWeights } from './learning.js';

export type ConfidenceLevel = 'low' | 'medium' | 'high';
export type Outcome = 'YES' | 'NO';
export type PredictionResolutionStatus =
  | 'open'
  | 'resolved_true'
  | 'resolved_false'
  | 'unresolved_error';

export interface PredictionInput {
  marketId: string;
  marketTitle: string;
  predictedOutcome?: Outcome;
  predictedProbability?: number;
  confidenceLevel?: ConfidenceLevel;
  confidenceRaw?: number;
  confidenceAdjusted?: number;
  signalScores?: SignalWeights;
  signalWeightsSnapshot?: SignalWeights;
  reasoning?: string;
  keyFactors?: string[];
  intelIds?: string[];
  domain?: string;
  createdAt?: string;
  expiresAt?: string;
  contextTags?: string[];
  sessionTag?: string;
  regimeTag?: string;
  strategyClass?: string;
  horizonMinutes?: number;
  symbol?: string;
  // Execution details (for auto-executed trades)
  executed?: boolean;
  executionPrice?: number;
  positionSize?: number;
  // PLIL v1.99: clean probability separation
  modelProbability?: number;    // Thufir's raw estimate — never market price
  marketProbability?: number;   // market-implied price at decision time
  learningComparable?: boolean;
  forecastTargetKind?: string | null;
  forecastTargetPayload?: Record<string, unknown> | null;
  comparatorSource?: string | null;
  comparatorKind?: string | null;
  comparatorPayload?: Record<string, unknown> | null;
}

export interface PredictionRecord {
  id: string;
  marketId: string;
  marketTitle: string;
  predictedOutcome?: Outcome;
  predictedProbability?: number;
  confidenceLevel?: ConfidenceLevel;
  confidenceRaw?: number;
  confidenceAdjusted?: number;
  signalScores?: SignalWeights | null;
  signalWeightsSnapshot?: SignalWeights | null;
  reasoning?: string;
  keyFactors?: string[];
  intelIds?: string[];
  domain?: string;
  sessionTag?: string;
  regimeTag?: string;
  strategyClass?: string;
  horizonMinutes?: number | null;
  symbol?: string;
  createdAt: string;
  expiresAt?: string | null;
  contextTags?: string[];
  resolutionStatus: PredictionResolutionStatus;
  resolutionMetadata?: Record<string, unknown> | null;
  resolutionError?: string | null;
  resolutionTimestamp?: string | null;
  executed: boolean;
  executionPrice?: number | null;
  positionSize?: number | null;
  outcome?: Outcome | null;
  outcomeTimestamp?: string | null;
  pnl?: number | null;
  modelProbability?: number | null;
  marketProbability?: number | null;
  learningComparable?: boolean;
  forecastTargetKind?: string | null;
  forecastTargetPayload?: Record<string, unknown> | null;
  comparatorSource?: string | null;
  comparatorKind?: string | null;
  comparatorPayload?: Record<string, unknown> | null;
  outcomeBasis?: 'final' | 'estimated' | 'legacy' | null;
}

export interface OpenPositionRecord {
  id: string;
  marketId: string;
  marketTitle: string;
  predictedOutcome?: Outcome;
  executionPrice?: number | null;
  positionSize?: number | null;
  netShares?: number | null;
  createdAt: string;
  currentPrices?: Record<string, number> | number[] | null;
}

function serializeJson(value?: string[]): string | null {
  if (!value || value.length === 0) {
    return null;
  }
  return JSON.stringify(value);
}

function serializeObject(value?: Record<string, unknown> | null): string | null {
  if (!value) {
    return null;
  }
  return JSON.stringify(value);
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, number> | number[] | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed as number[];
    }
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, number>;
    }
  } catch {
    return null;
  }
  return null;
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function parseSignalWeights(value: string | null): SignalWeights | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<SignalWeights>;
    const technical = Number(parsed.technical);
    const news = Number(parsed.news);
    const onChain = Number(parsed.onChain);
    if ([technical, news, onChain].every((entry) => Number.isFinite(entry))) {
      return { technical, news, onChain };
    }
  } catch {
    return null;
  }
  return null;
}

function isSyntheticPerpComparableInput(input: Pick<PredictionInput, 'domain' | 'marketProbability'>): boolean {
  return input.domain === 'perp' && Number(input.marketProbability) === 0.5;
}

export function normalizeLearningComparableInput(
  input: Pick<
    PredictionInput,
    'domain' | 'predictedOutcome' | 'modelProbability' | 'marketProbability' | 'learningComparable'
  >
): boolean {
  const learningComparableRequested =
    input.learningComparable ??
    (input.predictedOutcome != null &&
      input.modelProbability != null &&
      input.marketProbability != null);
  return learningComparableRequested && !isSyntheticPerpComparableInput(input);
}

function isMarketComparableComparatorKind(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('exogenous_');
}
export function createPrediction(input: PredictionInput): string {
  const db = openDatabase();
  const id = randomUUID();
  const createdAtEpoch = Date.parse(input.createdAt ?? '');
  const createdAt = Number.isFinite(createdAtEpoch)
    ? new Date(createdAtEpoch).toISOString()
    : new Date().toISOString();
  const horizonMinutes =
    typeof input.horizonMinutes === 'number' && input.horizonMinutes > 0
      ? Math.floor(input.horizonMinutes)
      : null;
  const expiresAt =
    input.expiresAt ??
    (horizonMinutes
      ? new Date(Date.parse(createdAt) + horizonMinutes * 60_000).toISOString()
      : null);

  const normalizedLearningComparable = normalizeLearningComparableInput(input);
  const learningComparable =
    input.domain === 'perp'
      ? normalizedLearningComparable && isMarketComparableComparatorKind(input.comparatorKind)
      : normalizedLearningComparable;

  const stmt = db.prepare(`
    INSERT INTO predictions (
      id,
      market_id,
      market_title,
      predicted_outcome,
      predicted_probability,
      confidence_level,
      confidence_raw,
      confidence_adjusted,
      signal_scores,
      signal_weights_snapshot,
      reasoning,
      key_factors,
      intel_ids,
      domain,
      created_at,
      session_tag,
      regime_tag,
      strategy_class,
      horizon_minutes,
      symbol,
      expires_at,
      context_tags,
      resolution_status,
      executed,
      execution_price,
      position_size,
      model_probability,
      market_probability,
      learning_comparable,
      forecast_target_kind,
      forecast_target_payload,
      comparator_source,
      comparator_kind,
      comparator_payload
    ) VALUES (
      @id,
      @marketId,
      @marketTitle,
      @predictedOutcome,
      @predictedProbability,
      @confidenceLevel,
      @confidenceRaw,
      @confidenceAdjusted,
      @signalScores,
      @signalWeightsSnapshot,
      @reasoning,
      @keyFactors,
      @intelIds,
      @domain,
      @createdAt,
      @sessionTag,
      @regimeTag,
      @strategyClass,
      @horizonMinutes,
      @symbol,
      @expiresAt,
      @contextTags,
      @resolutionStatus,
      @executed,
      @executionPrice,
      @positionSize,
      @modelProbability,
      @marketProbability,
      @learningComparable,
      @forecastTargetKind,
      @forecastTargetPayload,
      @comparatorSource,
      @comparatorKind,
      @comparatorPayload
    )
  `);

  stmt.run({
    id,
    marketId: input.marketId,
    marketTitle: input.marketTitle,
    predictedOutcome: input.predictedOutcome ?? null,
    predictedProbability: input.predictedProbability ?? null,
    confidenceLevel: input.confidenceLevel ?? null,
    confidenceRaw: input.confidenceRaw ?? null,
    confidenceAdjusted: input.confidenceAdjusted ?? null,
    signalScores: input.signalScores ? JSON.stringify(input.signalScores) : null,
    signalWeightsSnapshot: input.signalWeightsSnapshot
      ? JSON.stringify(input.signalWeightsSnapshot)
      : null,
    reasoning: input.reasoning ?? null,
    keyFactors: serializeJson(input.keyFactors),
    intelIds: serializeJson(input.intelIds),
    domain: input.domain ?? null,
    createdAt,
    sessionTag: input.sessionTag ?? null,
    regimeTag: input.regimeTag ?? null,
    strategyClass: input.strategyClass ?? null,
    horizonMinutes,
    symbol: input.symbol ?? null,
    expiresAt,
    contextTags: serializeJson(input.contextTags),
    resolutionStatus: 'open',
    executed: input.executed ? 1 : 0,
    executionPrice: input.executionPrice ?? null,
    positionSize: input.positionSize ?? null,
    modelProbability: input.modelProbability ?? null,
    marketProbability: input.marketProbability ?? null,
    learningComparable: learningComparable ? 1 : 0,
    forecastTargetKind: input.forecastTargetKind ?? null,
    forecastTargetPayload: serializeObject(input.forecastTargetPayload ?? null),
    comparatorSource: input.comparatorSource ?? null,
    comparatorKind: input.comparatorKind ?? null,
    comparatorPayload: serializeObject(input.comparatorPayload ?? null),
  });

  return id;
}

export function listPredictions(options?: {
  domain?: string;
  limit?: number;
}): PredictionRecord[] {
  const db = openDatabase();
  const limit = options?.limit ?? 20;

  const base = `
    SELECT
      id,
      market_id as marketId,
      market_title as marketTitle,
      predicted_outcome as predictedOutcome,
      predicted_probability as predictedProbability,
      confidence_level as confidenceLevel,
      confidence_raw as confidenceRaw,
      confidence_adjusted as confidenceAdjusted,
      signal_scores as signalScores,
      signal_weights_snapshot as signalWeightsSnapshot,
      reasoning,
      key_factors as keyFactors,
      intel_ids as intelIds,
      domain,
      session_tag as sessionTag,
      regime_tag as regimeTag,
      strategy_class as strategyClass,
      horizon_minutes as horizonMinutes,
      symbol,
      created_at as createdAt,
      expires_at as expiresAt,
      context_tags as contextTags,
      resolution_status as resolutionStatus,
      resolution_metadata as resolutionMetadata,
      resolution_error as resolutionError,
      resolution_timestamp as resolutionTimestamp,
      executed,
      execution_price as executionPrice,
      position_size as positionSize,
      outcome,
      outcome_timestamp as outcomeTimestamp,
      pnl,
      model_probability as modelProbability,
      market_probability as marketProbability,
      learning_comparable as learningComparable,
      forecast_target_kind as forecastTargetKind,
      forecast_target_payload as forecastTargetPayload,
      comparator_source as comparatorSource,
      comparator_kind as comparatorKind,
      comparator_payload as comparatorPayload,
      outcome_basis as outcomeBasis
    FROM predictions
  `;

  let rows: Array<Record<string, unknown>>;
  if (options?.domain) {
    const stmt = db.prepare(
      `${base} WHERE domain = ? ORDER BY created_at DESC LIMIT ?`
    );
    rows = stmt.all(options.domain, limit) as Array<Record<string, unknown>>;
  } else {
    const stmt = db.prepare(`${base} ORDER BY created_at DESC LIMIT ?`);
    rows = stmt.all(limit) as Array<Record<string, unknown>>;
  }

  return rows.map((row) => ({
    id: String(row.id),
    marketId: String(row.marketId),
    marketTitle: String(row.marketTitle),
    predictedOutcome: (row.predictedOutcome as Outcome) ?? undefined,
    predictedProbability: row.predictedProbability as number | undefined,
    confidenceLevel: row.confidenceLevel as ConfidenceLevel | undefined,
    confidenceRaw: row.confidenceRaw as number | undefined,
    confidenceAdjusted: row.confidenceAdjusted as number | undefined,
    signalScores: parseSignalWeights((row.signalScores as string | null) ?? null),
    signalWeightsSnapshot: parseSignalWeights((row.signalWeightsSnapshot as string | null) ?? null),
    reasoning: (row.reasoning as string) ?? undefined,
    keyFactors: parseJsonArray((row.keyFactors as string | null) ?? null),
    intelIds: parseJsonArray((row.intelIds as string | null) ?? null),
    domain: (row.domain as string) ?? undefined,
    sessionTag: (row.sessionTag as string) ?? undefined,
    regimeTag: (row.regimeTag as string) ?? undefined,
    strategyClass: (row.strategyClass as string) ?? undefined,
    horizonMinutes:
      row.horizonMinutes === null || row.horizonMinutes === undefined
        ? null
        : Number(row.horizonMinutes),
    symbol: (row.symbol as string) ?? undefined,
    createdAt: String(row.createdAt),
    expiresAt: (row.expiresAt as string | null) ?? null,
    contextTags: parseJsonArray((row.contextTags as string | null) ?? null),
    resolutionStatus:
      (row.resolutionStatus as PredictionResolutionStatus | null) ?? 'open',
    resolutionMetadata: parseJsonRecord((row.resolutionMetadata as string | null) ?? null),
    resolutionError: (row.resolutionError as string | null) ?? null,
    resolutionTimestamp: (row.resolutionTimestamp as string | null) ?? null,
    executed: Boolean(row.executed),
    executionPrice: row.executionPrice as number | null,
    positionSize: row.positionSize as number | null,
    outcome: (row.outcome as Outcome | null) ?? null,
    outcomeTimestamp: (row.outcomeTimestamp as string | null) ?? null,
    pnl: row.pnl as number | null,
    modelProbability: row.modelProbability as number | null,
    marketProbability: row.marketProbability as number | null,
    learningComparable: Boolean(row.learningComparable),
    forecastTargetKind: (row.forecastTargetKind as string | null) ?? null,
    forecastTargetPayload: parseJsonRecord((row.forecastTargetPayload as string | null) ?? null),
    comparatorSource: (row.comparatorSource as string | null) ?? null,
    comparatorKind: (row.comparatorKind as string | null) ?? null,
    comparatorPayload: parseJsonRecord((row.comparatorPayload as string | null) ?? null),
    outcomeBasis: (row.outcomeBasis as 'final' | 'estimated' | 'legacy' | null) ?? null,
  }));
}

export function getPrediction(id: string): PredictionRecord | null {
  const db = openDatabase();
  const stmt = db.prepare(
    `
      SELECT
        id,
        market_id as marketId,
        market_title as marketTitle,
        predicted_outcome as predictedOutcome,
        predicted_probability as predictedProbability,
        confidence_level as confidenceLevel,
        confidence_raw as confidenceRaw,
        confidence_adjusted as confidenceAdjusted,
        signal_scores as signalScores,
        signal_weights_snapshot as signalWeightsSnapshot,
        reasoning,
        key_factors as keyFactors,
        intel_ids as intelIds,
        domain,
        session_tag as sessionTag,
        regime_tag as regimeTag,
        strategy_class as strategyClass,
        horizon_minutes as horizonMinutes,
        symbol,
        created_at as createdAt,
        expires_at as expiresAt,
        context_tags as contextTags,
        resolution_status as resolutionStatus,
        resolution_metadata as resolutionMetadata,
        resolution_error as resolutionError,
        resolution_timestamp as resolutionTimestamp,
        executed,
        execution_price as executionPrice,
        position_size as positionSize,
        outcome,
        outcome_timestamp as outcomeTimestamp,
        pnl,
        model_probability as modelProbability,
        market_probability as marketProbability,
        learning_comparable as learningComparable,
        forecast_target_kind as forecastTargetKind,
        forecast_target_payload as forecastTargetPayload,
        comparator_source as comparatorSource,
        comparator_kind as comparatorKind,
        comparator_payload as comparatorPayload,
        outcome_basis as outcomeBasis
      FROM predictions
      WHERE id = ?
      LIMIT 1
    `
  );

  const row = stmt.get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    marketId: String(row.marketId),
    marketTitle: String(row.marketTitle),
    predictedOutcome: (row.predictedOutcome as Outcome) ?? undefined,
    predictedProbability: row.predictedProbability as number | undefined,
    confidenceLevel: row.confidenceLevel as ConfidenceLevel | undefined,
    confidenceRaw: row.confidenceRaw as number | undefined,
    confidenceAdjusted: row.confidenceAdjusted as number | undefined,
    signalScores: parseSignalWeights((row.signalScores as string | null) ?? null),
    signalWeightsSnapshot: parseSignalWeights((row.signalWeightsSnapshot as string | null) ?? null),
    reasoning: (row.reasoning as string) ?? undefined,
    keyFactors: parseJsonArray((row.keyFactors as string | null) ?? null),
    intelIds: parseJsonArray((row.intelIds as string | null) ?? null),
    domain: (row.domain as string) ?? undefined,
    sessionTag: (row.sessionTag as string) ?? undefined,
    regimeTag: (row.regimeTag as string) ?? undefined,
    strategyClass: (row.strategyClass as string) ?? undefined,
    horizonMinutes:
      row.horizonMinutes === null || row.horizonMinutes === undefined
        ? null
        : Number(row.horizonMinutes),
    symbol: (row.symbol as string) ?? undefined,
    createdAt: String(row.createdAt),
    expiresAt: (row.expiresAt as string | null) ?? null,
    contextTags: parseJsonArray((row.contextTags as string | null) ?? null),
    resolutionStatus:
      (row.resolutionStatus as PredictionResolutionStatus | null) ?? 'open',
    resolutionMetadata: parseJsonRecord((row.resolutionMetadata as string | null) ?? null),
    resolutionError: (row.resolutionError as string | null) ?? null,
    resolutionTimestamp: (row.resolutionTimestamp as string | null) ?? null,
    executed: Boolean(row.executed),
    executionPrice: row.executionPrice as number | null,
    positionSize: row.positionSize as number | null,
    outcome: (row.outcome as Outcome | null) ?? null,
    outcomeTimestamp: (row.outcomeTimestamp as string | null) ?? null,
    pnl: row.pnl as number | null,
    modelProbability: row.modelProbability as number | null,
    marketProbability: row.marketProbability as number | null,
    learningComparable: Boolean(row.learningComparable),
    forecastTargetKind: (row.forecastTargetKind as string | null) ?? null,
    forecastTargetPayload: parseJsonRecord((row.forecastTargetPayload as string | null) ?? null),
    comparatorSource: (row.comparatorSource as string | null) ?? null,
    comparatorKind: (row.comparatorKind as string | null) ?? null,
    comparatorPayload: parseJsonRecord((row.comparatorPayload as string | null) ?? null),
    outcomeBasis: (row.outcomeBasis as 'final' | 'estimated' | 'legacy' | null) ?? null,
  };
}

export function recordExecution(params: {
  id: string;
  executionPrice?: number | null;
  positionSize?: number | null;
  cashDelta?: number | null;
}): void {
  const db = openDatabase();
  const stmt = db.prepare(`
    UPDATE predictions
    SET executed = 1,
        execution_price = @executionPrice,
        position_size = @positionSize
    WHERE id = @id
  `);

  stmt.run({
    id: params.id,
    executionPrice: params.executionPrice ?? null,
    positionSize: params.positionSize ?? null,
  });

  if (params.cashDelta !== null && params.cashDelta !== undefined) {
    adjustCashBalance(params.cashDelta);
    return;
  }

  if (params.positionSize && params.positionSize > 0) {
    adjustCashBalance(-Math.abs(params.positionSize));
  }
}

export function listUnresolvedPredictions(limit = 50): Array<{
  id: string;
  marketId: string;
}> {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT id, market_id as marketId
        FROM predictions
        WHERE outcome IS NULL
          AND COALESCE(resolution_status, 'open') = 'open'
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    marketId: String(row.marketId),
  }));
}

export function listOpenPositions(limit = 50): OpenPositionRecord[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT id,
               market_id as marketId,
               market_title as marketTitle,
               predicted_outcome as predictedOutcome,
               execution_price as executionPrice,
               position_size as positionSize,
               created_at as createdAt,
               current_prices as currentPrices
        FROM open_positions
        LIMIT ?
      `
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    marketId: String(row.marketId),
    marketTitle: String(row.marketTitle),
    predictedOutcome: (row.predictedOutcome as Outcome) ?? undefined,
    executionPrice: row.executionPrice as number | null,
    positionSize: row.positionSize as number | null,
    createdAt: String(row.createdAt),
    currentPrices: parseJsonObject((row.currentPrices as string | null) ?? null),
  }));
}

export function listDuePredictionsForResolution(
  asOfIso: string,
  limit = 50
): Array<{
  id: string;
  marketId: string;
  domain?: string | null;
  predictedOutcome?: Outcome | null;
  predictedProbability?: number | null;
  createdAt: string;
  expiresAt: string;
  horizonMinutes?: number | null;
}> {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          market_id as marketId,
          domain,
          predicted_outcome as predictedOutcome,
          predicted_probability as predictedProbability,
          created_at as createdAt,
          expires_at as expiresAt,
          horizon_minutes as horizonMinutes
        FROM predictions
        WHERE resolution_status = 'open'
          AND expires_at IS NOT NULL
          AND expires_at <= @asOfIso
        ORDER BY expires_at ASC
        LIMIT @limit
      `
    )
    .all({ asOfIso, limit }) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    marketId: String(row.marketId),
    domain: (row.domain as string | null) ?? null,
    predictedOutcome: (row.predictedOutcome as Outcome | null) ?? null,
    predictedProbability:
      row.predictedProbability === null || row.predictedProbability === undefined
        ? null
        : Number(row.predictedProbability),
    createdAt: String(row.createdAt),
    expiresAt: String(row.expiresAt),
    horizonMinutes:
      row.horizonMinutes === null || row.horizonMinutes === undefined
        ? null
        : Number(row.horizonMinutes),
  }));
}

export function findOpenPerpPrediction(symbol: string): {
  id: string;
  predictedOutcome: Outcome;
  createdAt: string;
} | null {
  const db = openDatabase();
  const normalized = symbol.trim().toUpperCase();
  const row = db
    .prepare(
      `SELECT id, predicted_outcome as predictedOutcome, created_at as createdAt
       FROM predictions
       WHERE symbol = ? AND domain = 'perp' AND resolution_status = 'open'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(normalized) as { id: string; predictedOutcome: string; createdAt: string } | undefined;
  if (!row || (row.predictedOutcome !== 'YES' && row.predictedOutcome !== 'NO')) return null;
  return {
    id: row.id,
    predictedOutcome: row.predictedOutcome as Outcome,
    createdAt: row.createdAt,
  };
}

export function findOpenPerpPredictionById(
  id: string,
  symbol: string
): {
  id: string;
  predictedOutcome: Outcome;
  createdAt: string;
} | null {
  const db = openDatabase();
  const normalized = symbol.trim().toUpperCase();
  const row = db
    .prepare(
      `SELECT id, predicted_outcome as predictedOutcome, created_at as createdAt
       FROM predictions
       WHERE id = ?
         AND symbol = ?
         AND domain = 'perp'
         AND resolution_status = 'open'
       LIMIT 1`
    )
    .get(id, normalized) as { id: string; predictedOutcome: string; createdAt: string } | undefined;
  if (!row || (row.predictedOutcome !== 'YES' && row.predictedOutcome !== 'NO')) return null;
  return {
    id: row.id,
    predictedOutcome: row.predictedOutcome as Outcome,
    createdAt: row.createdAt,
  };
}

export function markPredictionResolutionError(params: {
  id: string;
  error: string;
  metadata?: Record<string, unknown> | null;
  resolutionTimestamp?: string;
}): void {
  const db = openDatabase();
  db.prepare(
    `
      UPDATE predictions
      SET resolution_status = 'unresolved_error',
          resolution_error = @error,
          resolution_metadata = @metadata,
          resolution_timestamp = @resolutionTimestamp
      WHERE id = @id
        AND resolution_status = 'open'
    `
  ).run({
    id: params.id,
    error: params.error,
    metadata: serializeObject(params.metadata ?? null),
    resolutionTimestamp: params.resolutionTimestamp ?? new Date().toISOString(),
  });
}
