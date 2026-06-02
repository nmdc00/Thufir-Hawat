import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export type CloseKind = 'partial_reduce' | 'full_close';
export type CloseFinalizationJobStatus =
  | 'pending'
  | 'running'
  | 'finalized'
  | 'failed_retryable'
  | 'failed_terminal';

export type TradeCloseEventInput = {
  id?: string;
  lifecycleId: string;
  tradeId?: number | null;
  symbol: string;
  executionMode?: 'paper' | 'live' | null;
  side?: 'buy' | 'sell' | null;
  closeKind: CloseKind;
  sizeReduced?: number | null;
  remainingSize?: number | null;
  realizedPnlUsd?: number | null;
  netRealizedPnlUsd?: number | null;
  realizedFeeUsd?: number | null;
  exitPrice?: number | null;
  exitMode?: string | null;
  thesisInvalidationHit?: boolean | null;
  sourceAuthority?: string | null;
  entryJournalPayload?: Record<string, unknown> | null;
  closeJournalPayload?: Record<string, unknown> | null;
  snapshotPayload?: Record<string, unknown> | null;
  bootstrapQuality?: string | null;
};

export type TradeCloseEvent = Required<Omit<TradeCloseEventInput, 'id'>> & {
  id: string;
  createdAt: string;
  updatedAt: string | null;
};

export type CloseFinalizationJob = {
  id: string;
  closeEventId: string;
  lifecycleId: string;
  tradeId: number | null;
  symbol: string;
  status: CloseFinalizationJobStatus;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
};

export type TradeClose = {
  id: string;
  closeEventId: string;
  lifecycleId: string;
  tradeId: number | null;
  symbol: string;
  closedSide: 'long' | 'short' | null;
  executionMode: 'paper' | 'live' | null;
  openedAt: string | null;
  closedAt: string;
  holdSeconds: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  totalOpenedSize: number | null;
  totalReducedSize: number | null;
  finalCloseSize: number | null;
  grossRealizedPnlUsd: number | null;
  feesUsd: number | null;
  netRealizedPnlUsd: number | null;
  capturedR: number | null;
  leftOnTableR: number | null;
  exitMode: string | null;
  thesisInvalidationHit: boolean | null;
  thesisCorrect: boolean | null;
  directionScore: number | null;
  timingScore: number | null;
  sizingScore: number | null;
  exitScore: number | null;
  compositeScore: number | null;
  linkedPredictionId: string | null;
  sourceLearningCaseId: string | null;
  sourceAuthority: string | null;
  bootstrapQuality: string | null;
  deterministicStatus: string;
  llmReflectionStatus: string;
  facts: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string | null;
};

function json(value: Record<string, unknown> | null | undefined): string | null {
  return value == null ? null : JSON.stringify(value);
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function boolToDb(value: boolean | null | undefined): number | null {
  return value == null ? null : value ? 1 : 0;
}

function dbToBool(value: unknown): boolean | null {
  if (value == null) return null;
  if (Number(value) === 1) return true;
  if (Number(value) === 0) return false;
  return null;
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function tableColumns(tableName: string): Set<string> {
  const db = openDatabase();
  const rows = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => String(row.name ?? '')));
}

function closePnlPct(input: Omit<TradeClose, 'createdAt' | 'updatedAt'>): number {
  if (
    input.entryPrice != null &&
    input.exitPrice != null &&
    Number.isFinite(input.entryPrice) &&
    Number.isFinite(input.exitPrice) &&
    input.entryPrice !== 0
  ) {
    const sideMultiplier = input.closedSide === 'short' ? -1 : 1;
    return ((input.exitPrice - input.entryPrice) / input.entryPrice) * sideMultiplier;
  }
  return 0;
}

export function recordTradeCloseEvent(input: TradeCloseEventInput): TradeCloseEvent {
  const db = openDatabase();
  const id = input.id ?? randomUUID();
  db.prepare(
    `
      INSERT INTO trade_close_events (
        id, lifecycle_id, trade_id, symbol, execution_mode, side, close_kind,
        size_reduced, remaining_size, realized_pnl_usd, net_realized_pnl_usd,
        realized_fee_usd, exit_price, exit_mode, thesis_invalidation_hit,
        source_authority, entry_journal_payload, close_journal_payload,
        snapshot_payload, bootstrap_quality, updated_at
      ) VALUES (
        @id, @lifecycleId, @tradeId, @symbol, @executionMode, @side, @closeKind,
        @sizeReduced, @remainingSize, @realizedPnlUsd, @netRealizedPnlUsd,
        @realizedFeeUsd, @exitPrice, @exitMode, @thesisInvalidationHit,
        @sourceAuthority, @entryJournalPayload, @closeJournalPayload,
        @snapshotPayload, @bootstrapQuality, datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        updated_at = datetime('now')
    `
  ).run({
    id,
    lifecycleId: input.lifecycleId,
    tradeId: input.tradeId ?? null,
    symbol: input.symbol.trim().toUpperCase(),
    executionMode: input.executionMode ?? null,
    side: input.side ?? null,
    closeKind: input.closeKind,
    sizeReduced: input.sizeReduced ?? null,
    remainingSize: input.remainingSize ?? null,
    realizedPnlUsd: input.realizedPnlUsd ?? null,
    netRealizedPnlUsd: input.netRealizedPnlUsd ?? null,
    realizedFeeUsd: input.realizedFeeUsd ?? null,
    exitPrice: input.exitPrice ?? null,
    exitMode: input.exitMode ?? null,
    thesisInvalidationHit: boolToDb(input.thesisInvalidationHit),
    sourceAuthority: input.sourceAuthority ?? null,
    entryJournalPayload: json(input.entryJournalPayload),
    closeJournalPayload: json(input.closeJournalPayload),
    snapshotPayload: json(input.snapshotPayload),
    bootstrapQuality: input.bootstrapQuality ?? null,
  });
  return getTradeCloseEvent(id);
}

export function enqueueCloseFinalizationJob(input: {
  closeEventId: string;
  lifecycleId: string;
  tradeId?: number | null;
  symbol: string;
}): CloseFinalizationJob {
  const db = openDatabase();
  const id = randomUUID();
  db.prepare(
    `
      INSERT INTO close_finalization_jobs (
        id, close_event_id, lifecycle_id, trade_id, symbol, status, next_attempt_at, updated_at
      ) VALUES (
        @id, @closeEventId, @lifecycleId, @tradeId, @symbol, 'pending', datetime('now'), datetime('now')
      )
      ON CONFLICT(close_event_id) DO UPDATE SET
        updated_at = datetime('now')
    `
  ).run({
    id,
    closeEventId: input.closeEventId,
    lifecycleId: input.lifecycleId,
    tradeId: input.tradeId ?? null,
    symbol: input.symbol.trim().toUpperCase(),
  });
  return getCloseFinalizationJobByCloseEventId(input.closeEventId);
}

export function getTradeCloseEvent(id: string): TradeCloseEvent {
  const db = openDatabase();
  const row = db.prepare('SELECT * FROM trade_close_events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Trade close event not found: ${id}`);
  return {
    id: String(row.id),
    lifecycleId: String(row.lifecycle_id),
    tradeId: num(row.trade_id),
    symbol: String(row.symbol),
    executionMode: row.execution_mode === 'paper' || row.execution_mode === 'live' ? row.execution_mode : null,
    side: row.side === 'buy' || row.side === 'sell' ? row.side : null,
    closeKind: row.close_kind === 'partial_reduce' ? 'partial_reduce' : 'full_close',
    sizeReduced: num(row.size_reduced),
    remainingSize: num(row.remaining_size),
    realizedPnlUsd: num(row.realized_pnl_usd),
    netRealizedPnlUsd: num(row.net_realized_pnl_usd),
    realizedFeeUsd: num(row.realized_fee_usd),
    exitPrice: num(row.exit_price),
    exitMode: row.exit_mode == null ? null : String(row.exit_mode),
    thesisInvalidationHit: dbToBool(row.thesis_invalidation_hit),
    sourceAuthority: row.source_authority == null ? null : String(row.source_authority),
    entryJournalPayload: parseJson(row.entry_journal_payload),
    closeJournalPayload: parseJson(row.close_journal_payload),
    snapshotPayload: parseJson(row.snapshot_payload),
    bootstrapQuality: row.bootstrap_quality == null ? null : String(row.bootstrap_quality),
    createdAt: String(row.created_at ?? ''),
    updatedAt: row.updated_at == null ? null : String(row.updated_at),
  };
}

export function getCloseFinalizationJobByCloseEventId(closeEventId: string): CloseFinalizationJob {
  const db = openDatabase();
  const row = db.prepare('SELECT * FROM close_finalization_jobs WHERE close_event_id = ?').get(closeEventId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Close finalization job not found: ${closeEventId}`);
  return toJob(row);
}

function toJob(row: Record<string, unknown>): CloseFinalizationJob {
  return {
    id: String(row.id),
    closeEventId: String(row.close_event_id),
    lifecycleId: String(row.lifecycle_id),
    tradeId: num(row.trade_id),
    symbol: String(row.symbol),
    status: String(row.status) as CloseFinalizationJobStatus,
    attempts: Number(row.attempts ?? 0),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at == null ? null : String(row.lease_expires_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    nextAttemptAt: row.next_attempt_at == null ? null : String(row.next_attempt_at),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    finalizedAt: row.finalized_at == null ? null : String(row.finalized_at),
  };
}

export function claimDueCloseFinalizationJob(params?: {
  workerId?: string;
  leaseSeconds?: number;
}): CloseFinalizationJob | null {
  const db = openDatabase();
  const workerId = params?.workerId ?? `close-finalizer-${process.pid}`;
  const leaseSeconds = Math.max(5, params?.leaseSeconds ?? 30);
  const row = db
    .prepare(
      `
        SELECT *
        FROM close_finalization_jobs
        WHERE status IN ('pending', 'failed_retryable')
          AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
        ORDER BY created_at ASC
        LIMIT 1
      `
    )
    .get() as Record<string, unknown> | undefined;
  if (!row) return null;
  db.prepare(
    `
      UPDATE close_finalization_jobs
      SET status = 'running',
          attempts = attempts + 1,
          lease_owner = @workerId,
          lease_expires_at = datetime('now', @leaseModifier),
          updated_at = datetime('now')
      WHERE id = @id
    `
  ).run({ id: row.id, workerId, leaseModifier: `+${leaseSeconds} seconds` });
  return toJob({ ...row, status: 'running', lease_owner: workerId, attempts: Number(row.attempts ?? 0) + 1 });
}

export function markCloseFinalizationJobFinalized(jobId: string): void {
  const db = openDatabase();
  db.prepare(
    `
      UPDATE close_finalization_jobs
      SET status = 'finalized',
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          finalized_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `
  ).run(jobId);
}

export function markCloseFinalizationJobFailed(jobId: string, error: string, attempts: number): void {
  const db = openDatabase();
  const retryable = attempts < 3;
  const delay = attempts <= 1 ? '+0 seconds' : attempts === 2 ? '+15 seconds' : '+60 seconds';
  db.prepare(
    `
      UPDATE close_finalization_jobs
      SET status = @status,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = @error,
          next_attempt_at = datetime('now', @delay),
          updated_at = datetime('now')
      WHERE id = @jobId
    `
  ).run({
    jobId,
    status: retryable ? 'failed_retryable' : 'failed_terminal',
    error: error.slice(0, 2000),
    delay,
  });
}

export function recoverExpiredCloseFinalizationLeases(): number {
  const db = openDatabase();
  const result = db
    .prepare(
      `
        UPDATE close_finalization_jobs
        SET status = 'failed_retryable',
            lease_owner = NULL,
            lease_expires_at = NULL,
            next_attempt_at = datetime('now'),
            updated_at = datetime('now'),
            last_error = COALESCE(last_error, 'lease expired')
        WHERE status = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= datetime('now')
      `
    )
    .run();
  return Number(result.changes ?? 0);
}

export function upsertTradeClose(input: Omit<TradeClose, 'createdAt' | 'updatedAt'>): TradeClose {
  const db = openDatabase();
  const columns = tableColumns('trade_closes');
  const values: Record<string, unknown> = {
    id: input.id,
    closeEventId: input.closeEventId,
    lifecycleId: input.lifecycleId,
    tradeId: input.tradeId,
    symbol: input.symbol,
    closedSide: input.closedSide,
    executionMode: input.executionMode,
    openedAt: input.openedAt,
    closedAt: input.closedAt,
    holdSeconds: input.holdSeconds,
    entryPrice: input.entryPrice,
    exitPrice: input.exitPrice,
    totalOpenedSize: input.totalOpenedSize,
    totalReducedSize: input.totalReducedSize,
    finalCloseSize: input.finalCloseSize,
    grossRealizedPnlUsd: input.grossRealizedPnlUsd,
    feesUsd: input.feesUsd,
    netRealizedPnlUsd: input.netRealizedPnlUsd,
    capturedR: input.capturedR,
    leftOnTableR: input.leftOnTableR,
    exitMode: input.exitMode,
    thesisInvalidationHit: boolToDb(input.thesisInvalidationHit),
    thesisCorrect: boolToDb(input.thesisCorrect),
    directionScore: input.directionScore,
    timingScore: input.timingScore,
    sizingScore: input.sizingScore,
    exitScore: input.exitScore,
    compositeScore: input.compositeScore,
    linkedPredictionId: input.linkedPredictionId,
    sourceLearningCaseId: input.sourceLearningCaseId,
    sourceAuthority: input.sourceAuthority,
    bootstrapQuality: input.bootstrapQuality,
    deterministicStatus: input.deterministicStatus,
    llmReflectionStatus: input.llmReflectionStatus,
    facts: json(input.facts),
    exitReason: input.exitMode ?? 'unknown',
    pnlUsd: input.netRealizedPnlUsd ?? input.grossRealizedPnlUsd ?? 0,
    pnlPct: closePnlPct(input),
    holdDurationSeconds: input.holdSeconds ?? 0,
    fundingPaidUsd: 0,
  };
  const insertColumns: Array<{ column: string; param: string; sql?: string }> = [
    { column: 'id', param: 'id' },
    { column: 'close_event_id', param: 'closeEventId' },
    { column: 'lifecycle_id', param: 'lifecycleId' },
    { column: 'trade_id', param: 'tradeId' },
    { column: 'symbol', param: 'symbol' },
    { column: 'closed_side', param: 'closedSide' },
    { column: 'execution_mode', param: 'executionMode' },
    { column: 'opened_at', param: 'openedAt' },
    { column: 'closed_at', param: 'closedAt' },
    { column: 'hold_seconds', param: 'holdSeconds' },
    { column: 'entry_price', param: 'entryPrice' },
    { column: 'exit_price', param: 'exitPrice' },
    { column: 'total_opened_size', param: 'totalOpenedSize' },
    { column: 'total_reduced_size', param: 'totalReducedSize' },
    { column: 'final_close_size', param: 'finalCloseSize' },
    { column: 'gross_realized_pnl_usd', param: 'grossRealizedPnlUsd' },
    { column: 'fees_usd', param: 'feesUsd' },
    { column: 'net_realized_pnl_usd', param: 'netRealizedPnlUsd' },
    { column: 'captured_r', param: 'capturedR' },
    { column: 'left_on_table_r', param: 'leftOnTableR' },
    { column: 'exit_mode', param: 'exitMode' },
    { column: 'thesis_invalidation_hit', param: 'thesisInvalidationHit' },
    { column: 'thesis_correct', param: 'thesisCorrect' },
    { column: 'direction_score', param: 'directionScore' },
    { column: 'timing_score', param: 'timingScore' },
    { column: 'sizing_score', param: 'sizingScore' },
    { column: 'exit_score', param: 'exitScore' },
    { column: 'composite_score', param: 'compositeScore' },
    { column: 'linked_prediction_id', param: 'linkedPredictionId' },
    { column: 'source_learning_case_id', param: 'sourceLearningCaseId' },
    { column: 'source_authority', param: 'sourceAuthority' },
    { column: 'bootstrap_quality', param: 'bootstrapQuality' },
    { column: 'deterministic_status', param: 'deterministicStatus' },
    { column: 'llm_reflection_status', param: 'llmReflectionStatus' },
    { column: 'facts_payload', param: 'facts' },
    { column: 'exit_reason', param: 'exitReason' },
    { column: 'pnl_usd', param: 'pnlUsd' },
    { column: 'pnl_pct', param: 'pnlPct' },
    { column: 'hold_duration_seconds', param: 'holdDurationSeconds' },
    { column: 'funding_paid_usd', param: 'fundingPaidUsd' },
    { column: 'updated_at', param: 'updatedAt', sql: "datetime('now')" },
  ].filter((column) => columns.has(column.column));
  db.prepare(
    `
      INSERT INTO trade_closes (
        ${insertColumns.map((column) => column.column).join(', ')}
      ) VALUES (
        ${insertColumns.map((column) => column.sql ?? `@${column.param}`).join(', ')}
      )
      ON CONFLICT(close_event_id) DO UPDATE SET
        source_learning_case_id = COALESCE(excluded.source_learning_case_id, trade_closes.source_learning_case_id),
        facts_payload = excluded.facts_payload,
        updated_at = datetime('now')
    `
  ).run(values);
  return getTradeCloseByCloseEventId(input.closeEventId);
}

export function getTradeCloseByCloseEventId(closeEventId: string): TradeClose {
  const db = openDatabase();
  const row = db.prepare('SELECT * FROM trade_closes WHERE close_event_id = ?').get(closeEventId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Trade close not found: ${closeEventId}`);
  return {
    id: String(row.id),
    closeEventId: String(row.close_event_id),
    lifecycleId: String(row.lifecycle_id),
    tradeId: num(row.trade_id),
    symbol: String(row.symbol),
    closedSide: row.closed_side === 'long' || row.closed_side === 'short' ? row.closed_side : null,
    executionMode: row.execution_mode === 'paper' || row.execution_mode === 'live' ? row.execution_mode : null,
    openedAt: row.opened_at == null ? null : String(row.opened_at),
    closedAt: String(row.closed_at ?? ''),
    holdSeconds: num(row.hold_seconds),
    entryPrice: num(row.entry_price),
    exitPrice: num(row.exit_price),
    totalOpenedSize: num(row.total_opened_size),
    totalReducedSize: num(row.total_reduced_size),
    finalCloseSize: num(row.final_close_size),
    grossRealizedPnlUsd: num(row.gross_realized_pnl_usd),
    feesUsd: num(row.fees_usd),
    netRealizedPnlUsd: num(row.net_realized_pnl_usd),
    capturedR: num(row.captured_r),
    leftOnTableR: num(row.left_on_table_r),
    exitMode: row.exit_mode == null ? null : String(row.exit_mode),
    thesisInvalidationHit: dbToBool(row.thesis_invalidation_hit),
    thesisCorrect: dbToBool(row.thesis_correct),
    directionScore: num(row.direction_score),
    timingScore: num(row.timing_score),
    sizingScore: num(row.sizing_score),
    exitScore: num(row.exit_score),
    compositeScore: num(row.composite_score),
    linkedPredictionId: row.linked_prediction_id == null ? null : String(row.linked_prediction_id),
    sourceLearningCaseId: row.source_learning_case_id == null ? null : String(row.source_learning_case_id),
    sourceAuthority: row.source_authority == null ? null : String(row.source_authority),
    bootstrapQuality: row.bootstrap_quality == null ? null : String(row.bootstrap_quality),
    deterministicStatus: String(row.deterministic_status ?? 'finalized'),
    llmReflectionStatus: String(row.llm_reflection_status ?? 'not_requested'),
    facts: parseJson(row.facts_payload),
    createdAt: String(row.created_at ?? ''),
    updatedAt: row.updated_at == null ? null : String(row.updated_at),
  };
}

export function insertTradeReflection(input: {
  tradeCloseId: string;
  thesisCorrect: boolean | null;
  timingCorrect: boolean | null;
  exitReasonAppropriate: boolean | null;
  whatWorked: string[];
  whatFailed: string[];
  lessonForNextTrade: string[];
  sourceFacts: Record<string, unknown>;
  confidence: number | null;
}): void {
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO trade_reflections (
        id, trade_close_id, thesis_correct, timing_correct, exit_reason_appropriate,
        what_worked, what_failed, lesson_for_next_trade, source_facts, confidence,
        llm_status, updated_at
      ) VALUES (
        @id, @tradeCloseId, @thesisCorrect, @timingCorrect, @exitReasonAppropriate,
        @whatWorked, @whatFailed, @lessonForNextTrade, @sourceFacts, @confidence,
        'not_requested', datetime('now')
      )
      ON CONFLICT(trade_close_id) DO UPDATE SET
        thesis_correct = excluded.thesis_correct,
        timing_correct = excluded.timing_correct,
        exit_reason_appropriate = excluded.exit_reason_appropriate,
        what_worked = excluded.what_worked,
        what_failed = excluded.what_failed,
        lesson_for_next_trade = excluded.lesson_for_next_trade,
        source_facts = excluded.source_facts,
        confidence = excluded.confidence,
        updated_at = datetime('now')
    `
  ).run({
    id: randomUUID(),
    tradeCloseId: input.tradeCloseId,
    thesisCorrect: boolToDb(input.thesisCorrect),
    timingCorrect: boolToDb(input.timingCorrect),
    exitReasonAppropriate: boolToDb(input.exitReasonAppropriate),
    whatWorked: JSON.stringify(input.whatWorked),
    whatFailed: JSON.stringify(input.whatFailed),
    lessonForNextTrade: JSON.stringify(input.lessonForNextTrade),
    sourceFacts: JSON.stringify(input.sourceFacts),
    confidence: input.confidence,
  });
}

export function insertRegretLearningCase(input: {
  tradeCloseId: string;
  lifecycleId: string;
  symbol: string;
  regretType: string;
  severity: number | null;
  evidence: Record<string, unknown>;
  policyEvidence: Record<string, unknown>;
}): void {
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO regret_learning_cases (
        id, trade_close_id, lifecycle_id, symbol, regret_type, severity,
        evidence_payload, policy_evidence_payload
      ) VALUES (
        @id, @tradeCloseId, @lifecycleId, @symbol, @regretType, @severity,
        @evidence, @policyEvidence
      )
    `
  ).run({
    id: randomUUID(),
    tradeCloseId: input.tradeCloseId,
    lifecycleId: input.lifecycleId,
    symbol: input.symbol,
    regretType: input.regretType,
    severity: input.severity,
    evidence: JSON.stringify(input.evidence),
    policyEvidence: JSON.stringify(input.policyEvidence),
  });
}
