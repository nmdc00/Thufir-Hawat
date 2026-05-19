import { openDatabase } from './db.js';

export interface PerpTradeInput {
  hypothesisId?: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  executionMode?: 'paper' | 'live' | null;
  price?: number | null;
  leverage?: number | null;
  orderType?: 'market' | 'limit' | null;
  status?: string | null;
}

export interface PerpTradeRecord extends PerpTradeInput {
  id: number;
  createdAt: string;
}

function ensurePerpTradesExecutionModeSchema(): void {
  const db = openDatabase();
  const rows = db.prepare("PRAGMA table_info('perp_trades')").all() as Array<{ name?: string }>;
  const hasExecutionMode = rows.some((row) => String(row.name ?? '') === 'execution_mode');
  if (!hasExecutionMode) {
    db.exec("ALTER TABLE perp_trades ADD COLUMN execution_mode TEXT");
  }
}

function ensurePerpPositionLifecycleSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS perp_position_lifecycles (
      symbol TEXT PRIMARY KEY,
      trade_id INTEGER NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('long', 'short')),
      opened_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trade_id) REFERENCES perp_trades(id) ON DELETE CASCADE
    );
  `);
}

export function recordPerpTrade(input: PerpTradeInput): number {
  ensurePerpTradesExecutionModeSchema();
  const db = openDatabase();
  const result = db.prepare(
    `
      INSERT INTO perp_trades (
        hypothesis_id,
        symbol,
        side,
        size,
        execution_mode,
        price,
        leverage,
        order_type,
        status
      ) VALUES (
        @hypothesisId,
        @symbol,
        @side,
        @size,
        @executionMode,
        @price,
        @leverage,
        @orderType,
        @status
      )
    `
  ).run({
    hypothesisId: input.hypothesisId ?? null,
    symbol: input.symbol,
    side: input.side,
    size: input.size,
    executionMode: input.executionMode ?? null,
    price: input.price ?? null,
    leverage: input.leverage ?? null,
    orderType: input.orderType ?? null,
    status: input.status ?? null,
  });
  return Number(result.lastInsertRowid ?? 0);
}

export function getActivePerpPositionTradeId(symbol: string): number | null {
  ensurePerpPositionLifecycleSchema();
  const db = openDatabase();
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return null;
  const row = db
    .prepare(
      `
        SELECT ppl.trade_id
        FROM perp_position_lifecycles ppl
        INNER JOIN perp_trades pt ON pt.id = ppl.trade_id
        WHERE ppl.symbol = ?
        LIMIT 1
      `
    )
    .get(normalized) as { trade_id?: number } | undefined;
  if (!row) {
    const orphaned = db
      .prepare(
        `
          SELECT trade_id
          FROM perp_position_lifecycles
          WHERE symbol = ?
          LIMIT 1
        `
      )
      .get(normalized) as { trade_id?: number } | undefined;
    if (orphaned) {
      clearActivePerpPositionLifecycle(normalized);
    }
    return null;
  }
  const tradeId = Number(row.trade_id ?? NaN);
  return Number.isFinite(tradeId) && tradeId > 0 ? tradeId : null;
}

export function clearOrphanedPerpPositionLifecycles(): number {
  ensurePerpPositionLifecycleSchema();
  const db = openDatabase();
  const result = db.prepare(
    `
      DELETE FROM perp_position_lifecycles
      WHERE trade_id NOT IN (
        SELECT id FROM perp_trades
      )
    `
  ).run();
  return result.changes ?? 0;
}

export function setActivePerpPositionLifecycle(input: {
  symbol: string;
  tradeId: number;
  side: 'long' | 'short';
}): void {
  ensurePerpPositionLifecycleSchema();
  const db = openDatabase();
  const symbol = input.symbol.trim().toUpperCase();
  if (!symbol) {
    return;
  }
  db.prepare(
    `
      INSERT INTO perp_position_lifecycles (symbol, trade_id, side, opened_at, updated_at)
      VALUES (@symbol, @tradeId, @side, datetime('now'), datetime('now'))
      ON CONFLICT(symbol) DO UPDATE SET
        trade_id = excluded.trade_id,
        side = excluded.side,
        updated_at = datetime('now')
    `
  ).run({
    symbol,
    tradeId: input.tradeId,
    side: input.side,
  });
}

export function clearActivePerpPositionLifecycle(symbol: string): void {
  ensurePerpPositionLifecycleSchema();
  const db = openDatabase();
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return;
  db.prepare(`DELETE FROM perp_position_lifecycles WHERE symbol = ?`).run(normalized);
}

export function listPerpTrades(params?: { symbol?: string; limit?: number }): PerpTradeRecord[] {
  ensurePerpTradesExecutionModeSchema();
  const db = openDatabase();
  const limit = Math.min(Math.max(params?.limit ?? 50, 1), 500);
  const symbol = params?.symbol ?? null;
  const rows = db
    .prepare(
      `
        SELECT id,
               created_at,
               hypothesis_id,
               symbol,
               side,
               size,
               execution_mode,
               price,
               leverage,
               order_type,
               status
        FROM perp_trades
        WHERE (? IS NULL OR symbol = ?)
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(symbol, symbol, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id),
    createdAt: String(row.created_at ?? ''),
    hypothesisId: row.hypothesis_id == null ? null : String(row.hypothesis_id),
    symbol: String(row.symbol ?? ''),
    side: (row.side as 'buy' | 'sell') ?? 'buy',
    size: Number(row.size ?? 0),
    executionMode:
      row.execution_mode === 'paper' || row.execution_mode === 'live'
        ? (row.execution_mode as 'paper' | 'live')
        : null,
    price: row.price == null ? null : Number(row.price),
    leverage: row.leverage == null ? null : Number(row.leverage),
    orderType:
      row.order_type === 'market' || row.order_type === 'limit'
        ? (row.order_type as 'market' | 'limit')
        : null,
    status: row.status == null ? null : String(row.status),
  }));
}
