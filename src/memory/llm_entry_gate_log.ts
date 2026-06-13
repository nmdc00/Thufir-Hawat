import { openDatabase } from './db.js';
import { registerRetentionPolicy } from './retention.js';

export interface EntryGateLogEntry {
  symbol: string;
  side: string;
  notionalUsd: number;
  verdict: string;
  reasoning: string;
  reasonCode?: string;
  adjustedSizeUsd?: number;
  usedFallback: boolean;
  signalClass?: string;
  regime?: string;
  session?: string;
  edge?: number;
  stopLevelPrice?: number | null;
  equityAtRiskPct?: number;
  targetRR?: number;
  suggestedLeverage?: number;
  mechanicalLeverageCeiling?: number | null;
  stopDistancePct?: number | null;
  liquidityScore?: number | null;
  executionScore?: number | null;
  liquidityBucket?: string | null;
}

registerRetentionPolicy({
  table: 'llm_entry_gate_log',
  timestampColumn: 'created_at',
  retainDays: 90,
  whereSql: "verdict NOT IN ('approve', 'resize')",
});

function ensureSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_entry_gate_log (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      symbol              TEXT NOT NULL,
      side                TEXT NOT NULL,
      notional_usd        REAL NOT NULL,
      verdict             TEXT NOT NULL,
      reasoning           TEXT NOT NULL,
      reason_code         TEXT,
      adjusted_size_usd   REAL,
      used_fallback       INTEGER NOT NULL DEFAULT 0,
      signal_class        TEXT,
      regime              TEXT,
      session             TEXT,
      edge                REAL,
      stop_level_price    REAL,
      equity_at_risk_pct  REAL,
      target_rr           REAL,
      suggested_leverage  REAL,
      mechanical_leverage_ceiling REAL,
      stop_distance_pct   REAL,
      liquidity_score     REAL,
      execution_score     REAL,
      liquidity_bucket    TEXT
    )
  `);

  const columns = db.prepare("PRAGMA table_info('llm_entry_gate_log')").all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => String(column.name ?? '')));
  const addColumnIfMissing = (name: string, definition: string): void => {
    if (columnNames.has(name)) {
      return;
    }
    db.exec(`ALTER TABLE llm_entry_gate_log ADD COLUMN ${definition}`);
    columnNames.add(name);
  };

  addColumnIfMissing('stop_level_price', 'stop_level_price REAL');
  addColumnIfMissing('equity_at_risk_pct', 'equity_at_risk_pct REAL');
  addColumnIfMissing('target_rr', 'target_rr REAL');
  addColumnIfMissing('suggested_leverage', 'suggested_leverage REAL');
  addColumnIfMissing('reason_code', 'reason_code TEXT');
  addColumnIfMissing('mechanical_leverage_ceiling', 'mechanical_leverage_ceiling REAL');
  addColumnIfMissing('stop_distance_pct', 'stop_distance_pct REAL');
  addColumnIfMissing('liquidity_score', 'liquidity_score REAL');
  addColumnIfMissing('execution_score', 'execution_score REAL');
  addColumnIfMissing('liquidity_bucket', 'liquidity_bucket TEXT');
}

export function recordEntryGateDecision(entry: EntryGateLogEntry): void {
  ensureSchema();
  const db = openDatabase();
  db.prepare(
    `INSERT INTO llm_entry_gate_log
       (symbol, side, notional_usd, verdict, reasoning, reason_code, adjusted_size_usd, used_fallback, signal_class, regime, session, edge, stop_level_price, equity_at_risk_pct, target_rr, suggested_leverage, mechanical_leverage_ceiling, stop_distance_pct, liquidity_score, execution_score, liquidity_bucket)
     VALUES
       (@symbol, @side, @notionalUsd, @verdict, @reasoning, @reasonCode, @adjustedSizeUsd, @usedFallback, @signalClass, @regime, @session, @edge, @stopLevelPrice, @equityAtRiskPct, @targetRR, @suggestedLeverage, @mechanicalLeverageCeiling, @stopDistancePct, @liquidityScore, @executionScore, @liquidityBucket)`
  ).run({
    symbol: entry.symbol,
    side: entry.side,
    notionalUsd: entry.notionalUsd,
    verdict: entry.verdict,
    reasoning: entry.reasoning,
    reasonCode: entry.reasonCode ?? null,
    adjustedSizeUsd: entry.adjustedSizeUsd ?? null,
    usedFallback: entry.usedFallback ? 1 : 0,
    signalClass: entry.signalClass ?? null,
    regime: entry.regime ?? null,
    session: entry.session ?? null,
    edge: entry.edge ?? null,
    stopLevelPrice: entry.stopLevelPrice ?? null,
    equityAtRiskPct: entry.equityAtRiskPct ?? null,
    targetRR: entry.targetRR ?? null,
    suggestedLeverage: entry.suggestedLeverage ?? null,
    mechanicalLeverageCeiling: entry.mechanicalLeverageCeiling ?? null,
    stopDistancePct: entry.stopDistancePct ?? null,
    liquidityScore: entry.liquidityScore ?? null,
    executionScore: entry.executionScore ?? null,
    liquidityBucket: entry.liquidityBucket ?? null,
  });
}
