import { openDatabase } from './db.js';
import { storeDecisionArtifact } from './decision_artifacts.js';

export type PerpTradeJournalOutcome = 'executed' | 'failed' | 'blocked';

export type PerpTradeJournalEntry = {
  kind: 'perp_trade_journal';
  execution_mode?: 'paper' | 'live' | null;
  tradeId?: number | null;
  hypothesisId?: string | null;
  symbol: string;
  side?: 'buy' | 'sell' | null;
  size?: number | null;
  leverage?: number | null;
  orderType?: 'market' | 'limit' | null;
  reduceOnly?: boolean | null;
  markPrice?: number | null;
  confidence?: string | null;
  reasoning?: string | null;
  policyReasonCode?: string | null;
  policyReason?: string | null;
  policySizeMultiplier?: number | null;
  entryGateVerdict?: 'approve' | 'reject' | 'resize' | null;
  entryGateReasonCode?: string | null;
  estimatedNotionalUsd?: number | null;
  estimatedFeeRate?: number | null;
  estimatedFeeType?: 'taker' | 'maker' | null;
  estimatedFeeUsd?: number | null;
  realizedFeeUsd?: number | null;
  realizedFeeToken?: string | null;
  realizedFillCount?: number | null;
  realizedOrderId?: number | null;
  realizedFillTimeMs?: number | null;
  feeObservationError?: string | null;
  signalClass?: string | null;
  symbolClass?: string | null;
  marketRegime?: 'trending' | 'choppy' | 'high_vol_expansion' | 'low_vol_compression' | null;
  volatilityBucket?: 'low' | 'medium' | 'high' | null;
  liquidityBucket?: 'thin' | 'normal' | 'deep' | null;
  expectedEdge?: number | null;
  thesisCorrect?: boolean | null;
  entryTrigger?: 'news' | 'technical' | 'hybrid' | null;
  newsSubtype?: string | null;
  newsSources?: string[] | null;
  newsSourceCount?: number | null;
  noveltyScore?: number | null;
  marketConfirmationScore?: number | null;
  thesisExpiresAtMs?: number | null;
  tradeArchetype?: 'scalp' | 'intraday' | 'swing' | null;
  invalidationType?: 'price_level' | 'structure_break' | null;
  invalidationPrice?: number | null;
  timeStopAtMs?: number | null;
  takeProfitR?: number | null;
  trailMode?: 'none' | 'atr' | 'structure' | null;
  emergencyOverride?: boolean | null;
  emergencyReason?: string | null;
  thesisInvalidationHit?: boolean | null;
  // TODO(v2.3.7-followup): trim legacy `take_profit` and `time_exit` values
  // after older rows/callers no longer require compatibility decoding.
  exitMode?:
    | 'thesis_invalidation'
    | 'dynamic_profit_protection'
    | 'risk_reduction'
    | 'emergency_risk'
    | 'take_profit'
    | 'time_exit'
    | 'manual'
    | 'unknown'
    | null;
  emotionalExitFlag?: boolean | null;
  thesisEvaluationReason?: string | null;
  maeProxy?: number | null;
  mfeProxy?: number | null;
  directionScore?: number | null;
  timingScore?: number | null;
  sizingScore?: number | null;
  exitScore?: number | null;
  capturedR?: number | null;
  leftOnTableR?: number | null;
  wouldHit2R?: boolean | null;
  wouldHit3R?: boolean | null;
  direction_score?: number | null;
  timing_score?: number | null;
  sizing_score?: number | null;
  exit_score?: number | null;
  captured_r?: number | null;
  left_on_table_r?: number | null;
  would_hit_2r?: boolean | null;
  would_hit_3r?: boolean | null;
  outcome: PerpTradeJournalOutcome;
  message?: string | null;
  error?: string | null;
  snapshot?: Record<string, unknown> | null;
  planContext?: Record<string, unknown> | null;
};

export function recordPerpTradeJournal(entry: PerpTradeJournalEntry): void {
  const fingerprint = entry.tradeId ? `${entry.symbol}:${entry.tradeId}` : null;
  storeDecisionArtifact({
    source: 'perps',
    kind: entry.kind,
    marketId: entry.symbol,
    fingerprint,
    outcome: entry.outcome,
    payload: entry,
  });
}

export function listPerpTradeJournals(params?: {
  symbol?: string;
  limit?: number;
}): PerpTradeJournalEntry[] {
  const db = openDatabase();
  const limit = Math.min(Math.max(params?.limit ?? 50, 1), 500);
  const symbol = params?.symbol ?? null;
  const rows = db
    .prepare(
      `
        SELECT payload
        FROM decision_artifacts
        WHERE kind = 'perp_trade_journal'
          AND (? IS NULL OR market_id = ?)
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(symbol, symbol, limit) as Array<{ payload?: string }>;

  const out: PerpTradeJournalEntry[] = [];
  for (const row of rows) {
    if (!row?.payload) continue;
    try {
      const parsed = JSON.parse(row.payload) as PerpTradeJournalEntry;
      if (parsed && parsed.kind === 'perp_trade_journal') {
        out.push(parsed);
      }
    } catch {
      // ignore unparseable payloads
    }
  }
  return out;
}
