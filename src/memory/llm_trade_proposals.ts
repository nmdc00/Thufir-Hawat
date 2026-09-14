import { openDatabase } from './db.js';

export interface TradeProposalRecord {
  triggerReason: 'cadence' | 'ta_alert' | 'event';
  alertedSymbols?: string[];
  proposed: boolean;
  symbol?: string;
  side?: string;
  thesisText?: string;
  invalidationCondition?: string;
  invalidationPrice?: number | null;
  suggestedTtlMinutes?: number;
  confidence?: number;
  entryGateVerdict?: string;
  executed?: boolean;
  tradeId?: string;
  usedFallback?: boolean;
  executeTrades?: boolean;
  originatorExitStage?: string;
  originatorExitReason?: string;
  requestedLeverage?: number;
  scanId?: string;
  marketSymbols?: string[];
  allSnapshotCount?: number;
  eligibleSnapshotCount?: number;
  originatorOutcome?: string;
  originatorError?: string;
  originatorReason?: string;
}

function ensureSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_trade_proposals (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      trigger_reason         TEXT NOT NULL,
      alerted_symbols        TEXT,
      proposed               INTEGER NOT NULL,
      symbol                 TEXT,
      side                   TEXT,
      thesis_text            TEXT,
      invalidation_condition TEXT,
      invalidation_price     REAL,
      suggested_ttl_minutes  INTEGER,
      confidence             REAL,
      entry_gate_verdict     TEXT,
      executed               INTEGER NOT NULL DEFAULT 0,
      trade_id               TEXT,
      used_fallback          INTEGER NOT NULL DEFAULT 0,
      execute_trades         INTEGER,
      originator_exit_stage  TEXT,
      originator_exit_reason TEXT,
      requested_leverage     REAL,
      scan_id                TEXT,
      market_symbols         TEXT,
      all_snapshot_count     INTEGER,
      eligible_snapshot_count INTEGER,
      originator_outcome     TEXT,
      originator_error       TEXT,
      originator_reason      TEXT
    )
  `);

  const columns = db.prepare("PRAGMA table_info('llm_trade_proposals')").all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => String(column.name ?? '')));
  const addColumnIfMissing = (name: string, definition: string): void => {
    if (columnNames.has(name)) {
      return;
    }
    db.exec(`ALTER TABLE llm_trade_proposals ADD COLUMN ${definition}`);
    columnNames.add(name);
  };

  addColumnIfMissing('execute_trades', 'execute_trades INTEGER');
  addColumnIfMissing('originator_exit_stage', 'originator_exit_stage TEXT');
  addColumnIfMissing('originator_exit_reason', 'originator_exit_reason TEXT');
  addColumnIfMissing('requested_leverage', 'requested_leverage REAL');
  addColumnIfMissing('scan_id', 'scan_id TEXT');
  addColumnIfMissing('market_symbols', 'market_symbols TEXT');
  addColumnIfMissing('all_snapshot_count', 'all_snapshot_count INTEGER');
  addColumnIfMissing('eligible_snapshot_count', 'eligible_snapshot_count INTEGER');
  addColumnIfMissing('originator_outcome', 'originator_outcome TEXT');
  addColumnIfMissing('originator_error', 'originator_error TEXT');
  addColumnIfMissing('originator_reason', 'originator_reason TEXT');
}

export function recordTradeProposal(record: TradeProposalRecord): number {
  ensureSchema();
  const db = openDatabase();
  const result = db.prepare(
    `INSERT INTO llm_trade_proposals
       (trigger_reason, alerted_symbols, proposed, symbol, side, thesis_text,
        invalidation_condition, invalidation_price, suggested_ttl_minutes, confidence,
        entry_gate_verdict, executed, trade_id, used_fallback, execute_trades,
        originator_exit_stage, originator_exit_reason, requested_leverage,
        scan_id, market_symbols, all_snapshot_count, eligible_snapshot_count,
        originator_outcome, originator_error, originator_reason)
     VALUES
       (@triggerReason, @alertedSymbols, @proposed, @symbol, @side, @thesisText,
        @invalidationCondition, @invalidationPrice, @suggestedTtlMinutes, @confidence,
        @entryGateVerdict, @executed, @tradeId, @usedFallback, @executeTrades,
        @originatorExitStage, @originatorExitReason, @requestedLeverage,
        @scanId, @marketSymbols, @allSnapshotCount, @eligibleSnapshotCount,
       @originatorOutcome, @originatorError, @originatorReason)`
  ).run({
    triggerReason: record.triggerReason,
    alertedSymbols: record.alertedSymbols ? JSON.stringify(record.alertedSymbols) : null,
    proposed: record.proposed ? 1 : 0,
    symbol: record.symbol ?? null,
    side: record.side ?? null,
    thesisText: record.thesisText ?? null,
    invalidationCondition: record.invalidationCondition ?? null,
    invalidationPrice: record.invalidationPrice ?? null,
    suggestedTtlMinutes: record.suggestedTtlMinutes ?? null,
    confidence: record.confidence ?? null,
    entryGateVerdict: record.entryGateVerdict ?? null,
    executed: record.executed ? 1 : 0,
    tradeId: record.tradeId ?? null,
    usedFallback: record.usedFallback ? 1 : 0,
    executeTrades:
      typeof record.executeTrades === 'boolean' ? (record.executeTrades ? 1 : 0) : null,
    originatorExitStage: record.originatorExitStage ?? null,
    originatorExitReason: record.originatorExitReason ?? null,
    requestedLeverage: record.requestedLeverage ?? null,
    scanId: record.scanId ?? null,
    marketSymbols: record.marketSymbols ? JSON.stringify(record.marketSymbols) : null,
    allSnapshotCount: record.allSnapshotCount ?? null,
    eligibleSnapshotCount: record.eligibleSnapshotCount ?? null,
    originatorOutcome: record.originatorOutcome ?? null,
    originatorError: record.originatorError ?? null,
    originatorReason: record.originatorReason ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function updateTradeProposalOutcome(
  id: number,
  verdict: string,
  executed: boolean,
  tradeId?: string
): void {
  ensureSchema();
  const db = openDatabase();
  db.prepare(
    `UPDATE llm_trade_proposals
     SET entry_gate_verdict = @verdict, executed = @executed, trade_id = @tradeId
     WHERE id = @id`
  ).run({
    id,
    verdict,
    executed: executed ? 1 : 0,
    tradeId: tradeId ?? null,
  });
}

export function updateTradeProposalStatus(
  id: number,
  patch: {
    executeTrades?: boolean;
    originatorExitStage?: string;
    originatorExitReason?: string;
    requestedLeverage?: number;
  }
): void {
  ensureSchema();
  const db = openDatabase();
  db.prepare(
    `UPDATE llm_trade_proposals
     SET execute_trades = COALESCE(@executeTrades, execute_trades),
         originator_exit_stage = COALESCE(@originatorExitStage, originator_exit_stage),
         originator_exit_reason = COALESCE(@originatorExitReason, originator_exit_reason),
         requested_leverage = COALESCE(@requestedLeverage, requested_leverage)
     WHERE id = @id`
  ).run({
    id,
    executeTrades:
      typeof patch.executeTrades === 'boolean' ? (patch.executeTrades ? 1 : 0) : null,
    originatorExitStage: patch.originatorExitStage ?? null,
    originatorExitReason: patch.originatorExitReason ?? null,
    requestedLeverage: patch.requestedLeverage ?? null,
  });
}
