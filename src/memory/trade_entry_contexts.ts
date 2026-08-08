import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';
import { TRADE_ENTRY_CONTEXT_SCHEMA_VERSION } from './learning_schema.js';

export { TRADE_ENTRY_CONTEXT_SCHEMA_VERSION };

export const EXPLICIT_UNKNOWN = 'unknown';
export const EXPLICIT_NOT_APPLICABLE = 'not_applicable';

export type TradeEntryExecutionMode = 'paper' | 'live';
export type TradeEntrySide = 'buy' | 'sell';

// State machine (TDD §1):
//   prepared -> execution_submitted -> opened
//                        `-----------> execution_failed
export type TradeEntryContextStatus = 'prepared' | 'execution_submitted' | 'opened' | 'execution_failed';

export interface TradeEntryContext {
  id: string;
  // Known at creation only for scale-ins joining an already-open lifecycle; null until the
  // `opened` transition for a brand-new lifecycle (its ID derives from the opening trade,
  // which does not exist yet in `prepared`/`execution_submitted`).
  lifecycleId: string | null;
  tradeId: number | null;
  candidateId: string;
  predictionId: string | null;
  status: TradeEntryContextStatus;
  executionIdempotencyKey: string;
  submittedAt: string | null;
  openedAt: string | null;
  failedAt: string | null;
  failurePayload: Record<string, unknown> | null;
  fillIdentityPayload: Record<string, unknown> | null;
  symbol: string;
  symbolClass: string;
  executionMode: TradeEntryExecutionMode;
  entrySide: TradeEntrySide;
  requestedSize: number;
  effectiveSize: number;
  leverage: number;
  entryNotionalUsd: number;
  riskBudgetUsd: number | null;
  riskFraction: number | null;
  expectedEdge: number | null;
  signalClass: string;
  triggerReason: string;
  entryTrigger: string;
  strategySource: string;
  sessionTag: string;
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
  tradeArchetype: string;
  invalidationType: string;
  invalidationPrice: number | null;
  thesisExpiresAt: string | null;
  timeStopAt: string | null;
  policyVersion: string;
  activeAdjustmentIds: string[];
  sourceAuthority: string;
  decisionPayload: Record<string, unknown> | null;
  contextSchemaVersion: number;
  createdAt: string;
}

export interface CreateTradeEntryContextInput {
  id?: string;
  // Only supply this for a scale-in joining an existing non-flat position; leave undefined
  // when this context may open a brand-new lifecycle (markOpened will attach it later).
  lifecycleId?: string | null;
  candidateId: string;
  predictionId: string | null;
  // Unique per submission attempt; the write-side dedup/uniqueness boundary and what crash
  // recovery reconciles against (TDD §1 "Crash recovery").
  executionIdempotencyKey: string;
  symbol: string;
  symbolClass: string;
  executionMode: TradeEntryExecutionMode;
  entrySide: TradeEntrySide;
  requestedSize: number;
  effectiveSize: number;
  leverage: number;
  entryNotionalUsd: number;
  riskBudgetUsd: number | null;
  riskFraction: number | null;
  expectedEdge: number | null;
  signalClass: string;
  triggerReason: string;
  entryTrigger: string;
  strategySource: string;
  sessionTag: string;
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
  tradeArchetype: string;
  invalidationType: string;
  invalidationPrice: number | null;
  thesisExpiresAt: string | null;
  timeStopAt: string | null;
  policyVersion: string;
  activeAdjustmentIds: string[];
  sourceAuthority: string;
  decisionPayload: Record<string, unknown> | null;
  contextSchemaVersion?: number;
}

export interface MarkOpenedInput {
  tradeId: number;
  // Required unless this context already carries a lifecycle_id (scale-in case set at
  // creation). When both are present they must agree.
  lifecycleId?: string;
  fillIdentityPayload?: Record<string, unknown> | null;
}

export interface ExecutionFailurePayload {
  reason: string;
  [key: string]: unknown;
}

const REQUIRED_CATEGORICAL_FIELDS = [
  'candidateId',
  'executionIdempotencyKey',
  'symbol',
  'symbolClass',
  'signalClass',
  'triggerReason',
  'entryTrigger',
  'strategySource',
  'sessionTag',
  'marketRegime',
  'volatilityBucket',
  'liquidityBucket',
  'tradeArchetype',
  'invalidationType',
  'policyVersion',
  'sourceAuthority',
] as const;

const REQUIRED_POSITIVE_NUMERIC_FIELDS = [
  'requestedSize',
  'effectiveSize',
  'leverage',
  'entryNotionalUsd',
] as const;

// Required keys that may carry an explicit null when the concept is absent at
// entry time; downstream eligibility (not this writer) decides the consequence.
const NULLABLE_NUMERIC_FIELDS = ['riskBudgetUsd', 'riskFraction', 'expectedEdge', 'invalidationPrice'] as const;
const NULLABLE_TIMESTAMP_FIELDS = ['thesisExpiresAt', 'timeStopAt'] as const;

function isMeaningfulString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateCreateInput(input: CreateTradeEntryContextInput): string[] {
  const problems: string[] = [];
  const record = input as unknown as Record<string, unknown>;

  for (const field of REQUIRED_CATEGORICAL_FIELDS) {
    if (!isMeaningfulString(record[field])) {
      problems.push(
        `${field} is required: supply a value or an explicit '${EXPLICIT_UNKNOWN}'/'${EXPLICIT_NOT_APPLICABLE}'`
      );
    }
  }

  if (input.lifecycleId != null && !isMeaningfulString(input.lifecycleId)) {
    problems.push('lifecycleId must be a non-empty string when supplied');
  }

  if (input.executionMode !== 'paper' && input.executionMode !== 'live') {
    problems.push("executionMode must be 'paper' or 'live'");
  }
  if (input.entrySide !== 'buy' && input.entrySide !== 'sell') {
    problems.push("entrySide must be 'buy' or 'sell'");
  }

  for (const field of REQUIRED_POSITIVE_NUMERIC_FIELDS) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      problems.push(`${field} is required and must be a finite number > 0`);
    }
  }

  for (const field of NULLABLE_NUMERIC_FIELDS) {
    const value = record[field];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      problems.push(`${field} must be a finite number or an explicit null`);
    }
  }

  for (const field of NULLABLE_TIMESTAMP_FIELDS) {
    const value = record[field];
    if (value !== null && !isMeaningfulString(value)) {
      problems.push(`${field} must be a timestamp string or an explicit null`);
    }
  }

  if (input.predictionId !== null && !isMeaningfulString(input.predictionId)) {
    problems.push('predictionId must be a non-empty string or an explicit null');
  }
  if (!Array.isArray(input.activeAdjustmentIds) || input.activeAdjustmentIds.some((id) => !isMeaningfulString(id))) {
    problems.push('activeAdjustmentIds is required and must be an array of non-empty strings');
  }
  if (input.decisionPayload !== null && (typeof input.decisionPayload !== 'object' || Array.isArray(input.decisionPayload))) {
    problems.push('decisionPayload must be an object or an explicit null');
  }

  return problems;
}

function parseJsonPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toTradeEntryContext(row: Record<string, unknown>): TradeEntryContext {
  let activeAdjustmentIds: string[] = [];
  if (typeof row.active_adjustment_ids === 'string' && row.active_adjustment_ids.length > 0) {
    try {
      const parsed = JSON.parse(row.active_adjustment_ids) as unknown;
      if (Array.isArray(parsed)) activeAdjustmentIds = parsed.map((entry) => String(entry));
    } catch {
      activeAdjustmentIds = [];
    }
  }

  return {
    id: String(row.id ?? ''),
    lifecycleId: row.lifecycle_id == null ? null : String(row.lifecycle_id),
    tradeId: row.trade_id == null ? null : Number(row.trade_id),
    candidateId: String(row.candidate_id ?? ''),
    predictionId: row.prediction_id == null ? null : String(row.prediction_id),
    status: row.status as TradeEntryContextStatus,
    executionIdempotencyKey: String(row.execution_idempotency_key ?? ''),
    submittedAt: row.submitted_at == null ? null : String(row.submitted_at),
    openedAt: row.opened_at == null ? null : String(row.opened_at),
    failedAt: row.failed_at == null ? null : String(row.failed_at),
    failurePayload: parseJsonPayload(row.failure_payload),
    fillIdentityPayload: parseJsonPayload(row.fill_identity_payload),
    symbol: String(row.symbol ?? ''),
    symbolClass: String(row.symbol_class ?? ''),
    executionMode: row.execution_mode as TradeEntryExecutionMode,
    entrySide: row.entry_side as TradeEntrySide,
    requestedSize: Number(row.requested_size),
    effectiveSize: Number(row.effective_size),
    leverage: Number(row.leverage),
    entryNotionalUsd: Number(row.entry_notional_usd),
    riskBudgetUsd: row.risk_budget_usd == null ? null : Number(row.risk_budget_usd),
    riskFraction: row.risk_fraction == null ? null : Number(row.risk_fraction),
    expectedEdge: row.expected_edge == null ? null : Number(row.expected_edge),
    signalClass: String(row.signal_class ?? ''),
    triggerReason: String(row.trigger_reason ?? ''),
    entryTrigger: String(row.entry_trigger ?? ''),
    strategySource: String(row.strategy_source ?? ''),
    sessionTag: String(row.session_tag ?? ''),
    marketRegime: String(row.market_regime ?? ''),
    volatilityBucket: String(row.volatility_bucket ?? ''),
    liquidityBucket: String(row.liquidity_bucket ?? ''),
    tradeArchetype: String(row.trade_archetype ?? ''),
    invalidationType: String(row.invalidation_type ?? ''),
    invalidationPrice: row.invalidation_price == null ? null : Number(row.invalidation_price),
    thesisExpiresAt: row.thesis_expires_at == null ? null : String(row.thesis_expires_at),
    timeStopAt: row.time_stop_at == null ? null : String(row.time_stop_at),
    policyVersion: String(row.policy_version ?? ''),
    activeAdjustmentIds,
    sourceAuthority: String(row.source_authority ?? ''),
    decisionPayload: parseJsonPayload(row.decision_payload),
    contextSchemaVersion: Number(row.context_schema_version ?? TRADE_ENTRY_CONTEXT_SCHEMA_VERSION),
    createdAt: String(row.created_at ?? ''),
  };
}

/**
 * Transaction A (TDD §1): insert the context in `prepared` with a unique
 * execution_idempotency_key, commit. No exchange call is ever made inside this function —
 * writer failure here must block execution, not silently manufacture context at close.
 */
export function createTradeEntryContext(input: CreateTradeEntryContextInput): TradeEntryContext {
  const problems = validateCreateInput(input);
  if (problems.length > 0) {
    throw new Error(`trade_entry_contexts write rejected — missing required entry context: ${problems.join('; ')}`);
  }

  const db = openDatabase();
  const id = input.id ?? randomUUID();
  db.prepare(
    `
      INSERT INTO trade_entry_contexts (
        id, lifecycle_id, candidate_id, prediction_id, execution_idempotency_key,
        symbol, symbol_class, execution_mode, entry_side,
        requested_size, effective_size, leverage, entry_notional_usd,
        risk_budget_usd, risk_fraction, expected_edge,
        signal_class, trigger_reason, entry_trigger, strategy_source, session_tag,
        market_regime, volatility_bucket, liquidity_bucket, trade_archetype,
        invalidation_type, invalidation_price, thesis_expires_at, time_stop_at,
        policy_version, active_adjustment_ids, source_authority,
        decision_payload, context_schema_version
      ) VALUES (
        @id, @lifecycleId, @candidateId, @predictionId, @executionIdempotencyKey,
        @symbol, @symbolClass, @executionMode, @entrySide,
        @requestedSize, @effectiveSize, @leverage, @entryNotionalUsd,
        @riskBudgetUsd, @riskFraction, @expectedEdge,
        @signalClass, @triggerReason, @entryTrigger, @strategySource, @sessionTag,
        @marketRegime, @volatilityBucket, @liquidityBucket, @tradeArchetype,
        @invalidationType, @invalidationPrice, @thesisExpiresAt, @timeStopAt,
        @policyVersion, @activeAdjustmentIds, @sourceAuthority,
        @decisionPayload, @contextSchemaVersion
      )
    `
  ).run({
    id,
    lifecycleId: input.lifecycleId ?? null,
    candidateId: input.candidateId,
    predictionId: input.predictionId,
    executionIdempotencyKey: input.executionIdempotencyKey,
    symbol: input.symbol,
    symbolClass: input.symbolClass,
    executionMode: input.executionMode,
    entrySide: input.entrySide,
    requestedSize: input.requestedSize,
    effectiveSize: input.effectiveSize,
    leverage: input.leverage,
    entryNotionalUsd: input.entryNotionalUsd,
    riskBudgetUsd: input.riskBudgetUsd,
    riskFraction: input.riskFraction,
    expectedEdge: input.expectedEdge,
    signalClass: input.signalClass,
    triggerReason: input.triggerReason,
    entryTrigger: input.entryTrigger,
    strategySource: input.strategySource,
    sessionTag: input.sessionTag,
    marketRegime: input.marketRegime,
    volatilityBucket: input.volatilityBucket,
    liquidityBucket: input.liquidityBucket,
    tradeArchetype: input.tradeArchetype,
    invalidationType: input.invalidationType,
    invalidationPrice: input.invalidationPrice,
    thesisExpiresAt: input.thesisExpiresAt,
    timeStopAt: input.timeStopAt,
    policyVersion: input.policyVersion,
    activeAdjustmentIds: JSON.stringify(input.activeAdjustmentIds),
    sourceAuthority: input.sourceAuthority,
    decisionPayload: input.decisionPayload == null ? null : JSON.stringify(input.decisionPayload),
    contextSchemaVersion: input.contextSchemaVersion ?? TRADE_ENTRY_CONTEXT_SCHEMA_VERSION,
  });

  const created = getTradeEntryContextById(id);
  if (!created) {
    throw new Error(`trade_entry_contexts insert failed for id ${id}`);
  }
  return created;
}

/**
 * Mark a context `execution_submitted` immediately before the exchange call (TDD §1 step 2).
 * Only valid from `prepared`.
 */
export function markExecutionSubmitted(contextId: string): TradeEntryContext {
  const db = openDatabase();
  const result = db
    .prepare(
      `UPDATE trade_entry_contexts
       SET status = 'execution_submitted', submitted_at = datetime('now')
       WHERE id = @contextId AND status = 'prepared'`
    )
    .run({ contextId });

  if (result.changes === 0) {
    const existing = getTradeEntryContextById(contextId);
    if (!existing) {
      throw new Error(`Trade entry context not found: ${contextId}`);
    }
    throw new Error(
      `trade_entry_contexts ${contextId} cannot transition to execution_submitted from status '${existing.status}' (expected 'prepared')`
    );
  }

  const updated = getTradeEntryContextById(contextId);
  if (!updated) {
    throw new Error(`Trade entry context not found after submit: ${contextId}`);
  }
  return updated;
}

/**
 * Transaction B success path (TDD §1 step 3): attach trade_id and fill identity, and mark
 * `opened`. Only valid from `execution_submitted`. lifecycleId is required unless the context
 * already carries one (the scale-in case, where the lifecycle already existed at creation);
 * when both are present they must agree — this is the single-shot "attach once" semantics for
 * lifecycle_id, folded in alongside trade_id's existing once-only attachment.
 */
export function markOpened(contextId: string, input: MarkOpenedInput): TradeEntryContext {
  if (!Number.isInteger(input.tradeId)) {
    throw new Error('markOpened requires an integer tradeId');
  }

  const existing = getTradeEntryContextById(contextId);
  if (!existing) {
    throw new Error(`Trade entry context not found: ${contextId}`);
  }

  if (existing.lifecycleId && input.lifecycleId && existing.lifecycleId !== input.lifecycleId) {
    throw new Error(
      `trade_entry_contexts.lifecycle_id already attached for ${contextId} (existing ${existing.lifecycleId}, attempted ${input.lifecycleId})`
    );
  }
  const lifecycleId = existing.lifecycleId ?? input.lifecycleId ?? null;
  if (!lifecycleId) {
    throw new Error(`markOpened(${contextId}) requires a lifecycleId — none provided and none already attached`);
  }

  const db = openDatabase();
  const result = db
    .prepare(
      `UPDATE trade_entry_contexts
       SET status = 'opened',
           opened_at = datetime('now'),
           trade_id = @tradeId,
           lifecycle_id = @lifecycleId,
           fill_identity_payload = @fillIdentityPayload
       WHERE id = @contextId
         AND status = 'execution_submitted'
         AND (trade_id IS NULL OR trade_id = @tradeId)
         AND (lifecycle_id IS NULL OR lifecycle_id = @lifecycleId)`
    )
    .run({
      contextId,
      tradeId: input.tradeId,
      lifecycleId,
      fillIdentityPayload: input.fillIdentityPayload == null ? null : JSON.stringify(input.fillIdentityPayload),
    });

  if (result.changes === 0) {
    const current = getTradeEntryContextById(contextId);
    if (!current) {
      throw new Error(`Trade entry context not found: ${contextId}`);
    }
    if (current.status !== 'execution_submitted') {
      throw new Error(
        `trade_entry_contexts ${contextId} cannot transition to opened from status '${current.status}' (expected 'execution_submitted')`
      );
    }
    throw new Error(
      `trade_entry_contexts ${contextId} opened-transition mismatch (existing tradeId=${current.tradeId}, lifecycleId=${current.lifecycleId}; attempted tradeId=${input.tradeId}, lifecycleId=${lifecycleId})`
    );
  }

  const updated = getTradeEntryContextById(contextId);
  if (!updated) {
    throw new Error(`Trade entry context not found after open: ${contextId}`);
  }
  return updated;
}

/**
 * Transaction B failure path (TDD §1 step 3) and crash-recovery terminal path: mark
 * `execution_failed` with the failure payload. Callable from `prepared` (e.g. abandoned before
 * submission) or `execution_submitted` (e.g. no matching execution found). Terminal — never
 * acquires a lifecycle.
 */
export function markExecutionFailed(contextId: string, failurePayload: ExecutionFailurePayload): TradeEntryContext {
  if (!failurePayload || !isMeaningfulString(failurePayload.reason)) {
    throw new Error('markExecutionFailed requires a failurePayload.reason');
  }

  const db = openDatabase();
  const result = db
    .prepare(
      `UPDATE trade_entry_contexts
       SET status = 'execution_failed', failed_at = datetime('now'), failure_payload = @failurePayload
       WHERE id = @contextId AND status IN ('prepared', 'execution_submitted')`
    )
    .run({ contextId, failurePayload: JSON.stringify(failurePayload) });

  if (result.changes === 0) {
    const existing = getTradeEntryContextById(contextId);
    if (!existing) {
      throw new Error(`Trade entry context not found: ${contextId}`);
    }
    throw new Error(
      `trade_entry_contexts ${contextId} cannot transition to execution_failed from status '${existing.status}' (expected 'prepared' or 'execution_submitted')`
    );
  }

  const updated = getTradeEntryContextById(contextId);
  if (!updated) {
    throw new Error(`Trade entry context not found after failure: ${contextId}`);
  }
  return updated;
}

export interface StaleExecutionMatch {
  tradeId: number;
  lifecycleId: string;
  fillIdentityPayload?: Record<string, unknown> | null;
}

export interface ReconcileStaleTradeEntryContextsOptions {
  // Contexts stuck in `prepared` older than this are treated as abandoned before submission.
  submissionTimeoutMs: number;
  // Contexts stuck in `execution_submitted` are only reconciled after this long has passed
  // since submission — the exchange's declared visibility window for the order/fill to appear
  // under its idempotency key.
  executionVisibilityWindowMs: number;
  // Decoupled execution-authority lookup (e.g. exchange order/fill history) keyed on
  // execution_idempotency_key. Returns null when no matching execution is found.
  findExecutionByIdempotencyKey: (executionIdempotencyKey: string) => StaleExecutionMatch | null;
}

export interface ReconcileStaleTradeEntryContextsResult {
  abandonedContextIds: string[];
  reconciledOpenedContextIds: string[];
  reconciledFailedContextIds: string[];
}

/**
 * Crash-recovery sweep (TDD §1 "Crash recovery"). Run on startup and periodically.
 */
export function reconcileStaleTradeEntryContexts(
  options: ReconcileStaleTradeEntryContextsOptions
): ReconcileStaleTradeEntryContextsResult {
  const db = openDatabase();
  const submissionTimeoutSeconds = Math.max(0, Math.floor(options.submissionTimeoutMs / 1000));
  const visibilityWindowSeconds = Math.max(0, Math.floor(options.executionVisibilityWindowMs / 1000));

  const abandonedContextIds: string[] = [];
  const reconciledOpenedContextIds: string[] = [];
  const reconciledFailedContextIds: string[] = [];

  // Compare like-typed datetime() strings rather than strftime('%s', ...) (TEXT) against an
  // arithmetic difference (INTEGER) — SQLite's storage-class comparison rules always order
  // TEXT above INTEGER regardless of numeric value, so that mixed comparison silently never
  // matches.
  const stalePrepared = db
    .prepare(
      `SELECT id FROM trade_entry_contexts
       WHERE status = 'prepared'
         AND created_at <= datetime('now', '-' || @submissionTimeoutSeconds || ' seconds')`
    )
    .all({ submissionTimeoutSeconds }) as Array<{ id: string }>;

  for (const row of stalePrepared) {
    markExecutionFailed(row.id, { reason: 'abandoned_before_submit' });
    abandonedContextIds.push(row.id);
  }

  const staleSubmitted = db
    .prepare(
      `SELECT id, execution_idempotency_key AS executionIdempotencyKey FROM trade_entry_contexts
       WHERE status = 'execution_submitted'
         AND submitted_at IS NOT NULL
         AND submitted_at <= datetime('now', '-' || @visibilityWindowSeconds || ' seconds')`
    )
    .all({ visibilityWindowSeconds }) as Array<{ id: string; executionIdempotencyKey: string }>;

  for (const row of staleSubmitted) {
    const match = options.findExecutionByIdempotencyKey(row.executionIdempotencyKey);
    if (match) {
      markOpened(row.id, {
        tradeId: match.tradeId,
        lifecycleId: match.lifecycleId,
        fillIdentityPayload: match.fillIdentityPayload ?? null,
      });
      reconciledOpenedContextIds.push(row.id);
    } else {
      markExecutionFailed(row.id, { reason: 'no_execution_found' });
      reconciledFailedContextIds.push(row.id);
    }
  }

  return { abandonedContextIds, reconciledOpenedContextIds, reconciledFailedContextIds };
}

export function getTradeEntryContextById(id: string): TradeEntryContext | null {
  const db = openDatabase();
  const row = db
    .prepare('SELECT * FROM trade_entry_contexts WHERE id = ? LIMIT 1')
    .get(id) as Record<string, unknown> | undefined;
  return row ? toTradeEntryContext(row) : null;
}

export function getTradeEntryContextByExecutionIdempotencyKey(executionIdempotencyKey: string): TradeEntryContext | null {
  const db = openDatabase();
  const row = db
    .prepare('SELECT * FROM trade_entry_contexts WHERE execution_idempotency_key = ? LIMIT 1')
    .get(executionIdempotencyKey) as Record<string, unknown> | undefined;
  return row ? toTradeEntryContext(row) : null;
}

/**
 * Returns the primary (earliest-created) context for a lifecycle. Multiple contexts can share
 * one lifecycle_id (scale-ins, TDD §1a); the first context on the lifecycle is primary for
 * decision-snapshot purposes. Use getTradeEntryContextsByLifecycleId to enumerate all of them.
 */
export function getTradeEntryContextByLifecycleId(lifecycleId: string): TradeEntryContext | null {
  const db = openDatabase();
  const row = db
    .prepare('SELECT * FROM trade_entry_contexts WHERE lifecycle_id = ? ORDER BY created_at ASC, id ASC LIMIT 1')
    .get(lifecycleId) as Record<string, unknown> | undefined;
  return row ? toTradeEntryContext(row) : null;
}

export function getTradeEntryContextsByLifecycleId(lifecycleId: string): TradeEntryContext[] {
  const db = openDatabase();
  const rows = db
    .prepare('SELECT * FROM trade_entry_contexts WHERE lifecycle_id = ? ORDER BY created_at ASC, id ASC')
    .all(lifecycleId) as Array<Record<string, unknown>>;
  return rows.map(toTradeEntryContext);
}
