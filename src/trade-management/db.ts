import { openDatabase } from '../memory/db.js';
import type { TradeCloseRecord, TradeEnvelope, TradeReflection } from './types.js';

function toIsoNow(): string {
  return new Date().toISOString();
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function recordTradeEnvelope(envelope: TradeEnvelope): void {
  const db = openDatabase();
  db.prepare(
    `
      INSERT OR REPLACE INTO trade_envelopes (
        trade_id,
        updated_at,
        hypothesis_id,
        symbol,
        side,
        entry_price,
        size,
        leverage,
        notional_usd,
        margin_usd,
        stop_loss_pct,
        take_profit_pct,
        max_hold_seconds,
        trailing_stop_pct,
        trailing_activation_pct,
        max_loss_usd,
        proposed_json,
        thesis,
        signal_kinds,
        invalidation,
        catalyst_id,
        narrative_snapshot,
        high_water_price,
        low_water_price,
        trailing_activated,
        funding_since_open_usd,
        close_pending,
        close_pending_reason,
        close_pending_at,
        entry_cloid,
        entry_fees_usd,
        status,
        entered_at,
        expires_at,
        tp_oid,
        sl_oid
      ) VALUES (
        @tradeId,
        @updatedAt,
        @hypothesisId,
        @symbol,
        @side,
        @entryPrice,
        @size,
        @leverage,
        @notionalUsd,
        @marginUsd,
        @stopLossPct,
        @takeProfitPct,
        @maxHoldSeconds,
        @trailingStopPct,
        @trailingActivationPct,
        @maxLossUsd,
        @proposedJson,
        @thesis,
        @signalKindsJson,
        @invalidation,
        @catalystId,
        @narrativeSnapshot,
        @highWaterPrice,
        @lowWaterPrice,
        @trailingActivated,
        @fundingSinceOpenUsd,
        @closePending,
        @closePendingReason,
        @closePendingAt,
        @entryCloid,
        @entryFeesUsd,
        @status,
        @enteredAt,
        @expiresAt,
        @tpOid,
        @slOid
      )
    `
  ).run({
    tradeId: envelope.tradeId,
    updatedAt: toIsoNow(),
    hypothesisId: envelope.hypothesisId,
    symbol: envelope.symbol,
    side: envelope.side,
    entryPrice: envelope.entryPrice,
    size: envelope.size,
    leverage: envelope.leverage,
    notionalUsd: envelope.notionalUsd,
    marginUsd: envelope.marginUsd,
    stopLossPct: envelope.stopLossPct,
    takeProfitPct: envelope.takeProfitPct,
    maxHoldSeconds: envelope.maxHoldSeconds,
    trailingStopPct: envelope.trailingStopPct,
    trailingActivationPct: envelope.trailingActivationPct,
    maxLossUsd: envelope.maxLossUsd,
    proposedJson: envelope.proposed ? JSON.stringify(envelope.proposed) : null,
    thesis: envelope.thesis,
    signalKindsJson: JSON.stringify(envelope.signalKinds ?? []),
    invalidation: envelope.invalidation,
    catalystId: envelope.catalystId,
    narrativeSnapshot: envelope.narrativeSnapshot,
    highWaterPrice: envelope.highWaterPrice,
    lowWaterPrice: envelope.lowWaterPrice,
    trailingActivated: envelope.trailingActivated ? 1 : 0,
    fundingSinceOpenUsd: envelope.fundingSinceOpenUsd,
    closePending: envelope.closePending ? 1 : 0,
    closePendingReason: envelope.closePendingReason,
    closePendingAt: envelope.closePendingAt,
    entryCloid: envelope.entryCloid,
    entryFeesUsd: envelope.entryFeesUsd,
    status: envelope.status,
    enteredAt: envelope.enteredAt,
    expiresAt: envelope.expiresAt,
    tpOid: envelope.tpOid,
    slOid: envelope.slOid,
  });
}

export function getOpenTradeEnvelopeBySymbol(symbol: string): TradeEnvelope | null {
  const db = openDatabase();
  const row = db
    .prepare(
      `
        SELECT *
        FROM trade_envelopes
        WHERE symbol = ? AND status = 'open'
        ORDER BY entered_at DESC
        LIMIT 1
      `
    )
    .get(symbol) as Record<string, unknown> | undefined;
  if (!row) return null;
  return hydrateEnvelopeRow(row);
}

export function listOpenTradeEnvelopes(): TradeEnvelope[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM trade_envelopes
        WHERE status = 'open'
        ORDER BY entered_at DESC
      `
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(hydrateEnvelopeRow);
}

export function listRecentTradeCloses(limit = 20): Array<{
  tradeId: string;
  symbol: string;
  exitPrice: number;
  exitReason: string;
  pnlUsd: number;
  pnlPct: number;
  holdDurationSeconds: number;
  fundingPaidUsd: number;
  feesUsd: number;
  closedAt: string;
}> {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          trade_id as tradeId,
          symbol,
          exit_price as exitPrice,
          exit_reason as exitReason,
          pnl_usd as pnlUsd,
          pnl_pct as pnlPct,
          hold_duration_seconds as holdDurationSeconds,
          funding_paid_usd as fundingPaidUsd,
          fees_usd as feesUsd,
          closed_at as closedAt
        FROM trade_closes
        ORDER BY closed_at DESC
        LIMIT ?
      `
    )
    .all(Math.min(Math.max(limit, 1), 200)) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    tradeId: String(r.tradeId ?? ''),
    symbol: String(r.symbol ?? ''),
    exitPrice: Number(r.exitPrice ?? 0),
    exitReason: String(r.exitReason ?? ''),
    pnlUsd: Number(r.pnlUsd ?? 0),
    pnlPct: Number(r.pnlPct ?? 0),
    holdDurationSeconds: Number(r.holdDurationSeconds ?? 0),
    fundingPaidUsd: Number(r.fundingPaidUsd ?? 0),
    feesUsd: Number(r.feesUsd ?? 0),
    closedAt: String(r.closedAt ?? ''),
  }));
}

export function updateTradeEnvelopeRuntimeState(params: {
  tradeId: string;
  highWaterPrice?: number | null;
  lowWaterPrice?: number | null;
  trailingActivated?: boolean;
  fundingSinceOpenUsd?: number | null;
}): void {
  const db = openDatabase();
  const existing = db
    .prepare(
      `SELECT high_water_price, low_water_price, trailing_activated, funding_since_open_usd FROM trade_envelopes WHERE trade_id = ?`
    )
    .get(params.tradeId) as
    | {
        high_water_price: number | null;
        low_water_price: number | null;
        trailing_activated: number | null;
        funding_since_open_usd?: number | null;
      }
    | undefined;
  if (!existing) return;

  const highWaterPrice =
    params.highWaterPrice !== undefined ? params.highWaterPrice : (existing.high_water_price as number | null);
  const lowWaterPrice =
    params.lowWaterPrice !== undefined ? params.lowWaterPrice : (existing.low_water_price as number | null);
  const trailingActivated =
    params.trailingActivated !== undefined
      ? params.trailingActivated
      : Boolean(existing.trailing_activated ?? 0);
  const fundingSinceOpenUsd =
    params.fundingSinceOpenUsd !== undefined
      ? params.fundingSinceOpenUsd
      : (existing.funding_since_open_usd as number | null | undefined) ?? null;

  db.prepare(
    `
      UPDATE trade_envelopes
      SET updated_at = @updatedAt,
          high_water_price = @highWaterPrice,
          low_water_price = @lowWaterPrice,
          trailing_activated = @trailingActivated,
          funding_since_open_usd = @fundingSinceOpenUsd
      WHERE trade_id = @tradeId
    `
  ).run({
    updatedAt: toIsoNow(),
    tradeId: params.tradeId,
    highWaterPrice,
    lowWaterPrice,
    trailingActivated: trailingActivated ? 1 : 0,
    fundingSinceOpenUsd,
  });
}

export function setTradeClosePending(params: {
  tradeId: string;
  pending: boolean;
  reason?: string | null;
}): void {
  const db = openDatabase();
  db.prepare(
    `
      UPDATE trade_envelopes
      SET updated_at = @updatedAt,
          close_pending = @pending,
          close_pending_reason = @reason,
          close_pending_at = @pendingAt
      WHERE trade_id = @tradeId
    `
  ).run({
    updatedAt: toIsoNow(),
    tradeId: params.tradeId,
    pending: params.pending ? 1 : 0,
    reason: params.pending ? params.reason ?? null : null,
    pendingAt: params.pending ? toIsoNow() : null,
  });
}

export function markTradeClosed(tradeId: string): void {
  const db = openDatabase();
  db.prepare(
    `
      UPDATE trade_envelopes
      SET updated_at = @updatedAt, status = 'closed'
      WHERE trade_id = @tradeId
    `
  ).run({ updatedAt: toIsoNow(), tradeId });
}

export function recordTradeCloseRecord(close: TradeCloseRecord): void {
  const db = openDatabase();
  db.prepare(
    `
      INSERT OR REPLACE INTO trade_closes (
        trade_id,
        symbol,
        exit_price,
        exit_reason,
        pnl_usd,
        pnl_pct,
        hold_duration_seconds,
        funding_paid_usd,
        fees_usd,
        closed_at
      ) VALUES (
        @tradeId,
        @symbol,
        @exitPrice,
        @exitReason,
        @pnlUsd,
        @pnlPct,
        @holdDurationSeconds,
        @fundingPaidUsd,
        @feesUsd,
        @closedAt
      )
    `
  ).run(close);
}

export function recordTradeReflection(reflection: TradeReflection): void {
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO trade_reflections (
        trade_id,
        thesis_correct,
        timing_correct,
        exit_reason_appropriate,
        what_worked,
        what_failed,
        lesson_for_next_trade
      ) VALUES (
        @tradeId,
        @thesisCorrect,
        @timingCorrect,
        @exitReasonAppropriate,
        @whatWorked,
        @whatFailed,
        @lessonForNextTrade
      )
    `
  ).run({
    tradeId: reflection.tradeId,
    thesisCorrect: reflection.thesisCorrect ? 1 : 0,
    timingCorrect: reflection.timingCorrect ? 1 : 0,
    exitReasonAppropriate: reflection.exitReasonAppropriate ? 1 : 0,
    whatWorked: reflection.whatWorked,
    whatFailed: reflection.whatFailed,
    lessonForNextTrade: reflection.lessonForNextTrade,
  });
}

export function recordTradeSignals(params: {
  tradeId: string;
  symbol: string;
  signals: Array<{
    kind: string;
    weight?: number | null;
    directionalBias?: string | null;
    timeHorizon?: string | null;
  }>;
}): void {
  const db = openDatabase();
  const insert = db.prepare(
    `
      INSERT INTO trade_signals (
        trade_id,
        symbol,
        signal_kind,
        weight,
        directional_bias,
        time_horizon
      ) VALUES (
        @tradeId,
        @symbol,
        @signalKind,
        @weight,
        @directionalBias,
        @timeHorizon
      )
    `
  );
  const tx = db.transaction(() => {
    for (const s of params.signals) {
      insert.run({
        tradeId: params.tradeId,
        symbol: params.symbol,
        signalKind: s.kind,
        weight: s.weight ?? null,
        directionalBias: s.directionalBias ?? null,
        timeHorizon: s.timeHorizon ?? null,
      });
    }
  });
  tx();
}

export function recordTradePriceSample(params: {
  tradeId: string;
  symbol: string;
  midPrice: number;
}): void {
  if (!Number.isFinite(params.midPrice) || params.midPrice <= 0) return;
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO trade_price_samples (trade_id, symbol, mid_price)
      VALUES (@tradeId, @symbol, @midPrice)
    `
  ).run({
    tradeId: params.tradeId,
    symbol: params.symbol,
    midPrice: params.midPrice,
  });
}

export function listRecentTradePriceSamples(params: {
  tradeId: string;
  limit?: number;
}): Array<{ createdAt: string; midPrice: number }> {
  const db = openDatabase();
  const limit = Math.min(Math.max(params.limit ?? 30, 1), 500);
  const rows = db
    .prepare(
      `
        SELECT created_at as createdAt, mid_price as midPrice
        FROM trade_price_samples
        WHERE trade_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(params.tradeId, limit) as Array<{ createdAt?: string; midPrice?: number }>;
  return rows
    .filter((r) => typeof r.createdAt === 'string' && Number.isFinite(Number(r.midPrice)))
    .map((r) => ({ createdAt: String(r.createdAt), midPrice: Number(r.midPrice) }));
}

export function countTradeEntriesToday(): number {
  const db = openDatabase();
  const today = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare(
      `
        SELECT COUNT(*) as n
        FROM trade_envelopes
        WHERE substr(entered_at, 1, 10) = ?
      `
    )
    .get(today) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

export function getLastCloseForSymbol(symbol: string): { closedAt: string; exitReason: string; pnlUsd: number } | null {
  const db = openDatabase();
  const row = db
    .prepare(
      `
        SELECT closed_at as closedAt, exit_reason as exitReason, pnl_usd as pnlUsd
        FROM trade_closes
        WHERE symbol = ?
        ORDER BY closed_at DESC
        LIMIT 1
      `
    )
    .get(symbol) as { closedAt?: string; exitReason?: string; pnlUsd?: number } | undefined;
  if (!row?.closedAt) return null;
  return { closedAt: String(row.closedAt), exitReason: String(row.exitReason ?? ''), pnlUsd: Number(row.pnlUsd ?? 0) };
}

export function listRecentClosePnl(limit: number): Array<{ pnlUsd: number; closedAt: string }> {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT pnl_usd as pnlUsd, closed_at as closedAt
        FROM trade_closes
        ORDER BY closed_at DESC
        LIMIT ?
      `
    )
    .all(Math.min(Math.max(limit, 1), 500)) as Array<{ pnlUsd?: number; closedAt?: string }>;
  return rows
    .filter((r) => typeof r.closedAt === 'string' && r.closedAt.length > 0)
    .map((r) => ({ pnlUsd: Number(r.pnlUsd ?? 0), closedAt: String(r.closedAt) }));
}

function hydrateEnvelopeRow(row: Record<string, unknown>): TradeEnvelope {
  return {
    tradeId: String(row.trade_id ?? ''),
    hypothesisId: row.hypothesis_id == null ? null : String(row.hypothesis_id),
    symbol: String(row.symbol ?? ''),
    side: (row.side as any) === 'sell' ? 'sell' : 'buy',
    entryPrice: Number(row.entry_price ?? 0),
    size: Number(row.size ?? 0),
    leverage: row.leverage == null ? null : Number(row.leverage),
    notionalUsd: row.notional_usd == null ? null : Number(row.notional_usd),
    marginUsd: row.margin_usd == null ? null : Number(row.margin_usd),
    stopLossPct: Number(row.stop_loss_pct ?? 0),
    takeProfitPct: Number(row.take_profit_pct ?? 0),
    maxHoldSeconds: Number(row.max_hold_seconds ?? 0),
    trailingStopPct: row.trailing_stop_pct == null ? null : Number(row.trailing_stop_pct),
    trailingActivationPct: Number(row.trailing_activation_pct ?? 0),
    maxLossUsd: row.max_loss_usd == null ? null : Number(row.max_loss_usd),
    proposed: parseJsonObject(row.proposed_json == null ? null : String(row.proposed_json)),
    thesis: row.thesis == null ? null : String(row.thesis),
    signalKinds: parseJsonArray(row.signal_kinds == null ? null : String(row.signal_kinds)),
    invalidation: row.invalidation == null ? null : String(row.invalidation),
    catalystId: row.catalyst_id == null ? null : String(row.catalyst_id),
    narrativeSnapshot: row.narrative_snapshot == null ? null : String(row.narrative_snapshot),
    highWaterPrice: row.high_water_price == null ? null : Number(row.high_water_price),
    lowWaterPrice: row.low_water_price == null ? null : Number(row.low_water_price),
    trailingActivated: Boolean(row.trailing_activated ?? 0),
    fundingSinceOpenUsd:
      row.funding_since_open_usd == null ? null : Number(row.funding_since_open_usd),

    closePending: Boolean(row.close_pending ?? 0),
    closePendingReason:
      row.close_pending_reason == null ? null : String(row.close_pending_reason),
    closePendingAt:
      row.close_pending_at == null ? null : String(row.close_pending_at),

    entryCloid: row.entry_cloid == null ? null : String(row.entry_cloid),
    entryFeesUsd: row.entry_fees_usd == null ? null : Number(row.entry_fees_usd),
    enteredAt: String(row.entered_at ?? ''),
    expiresAt: String(row.expires_at ?? ''),
    tpOid: row.tp_oid == null ? null : String(row.tp_oid),
    slOid: row.sl_oid == null ? null : String(row.sl_oid),
    status: row.status === 'closed' ? 'closed' : 'open',
  };
}
