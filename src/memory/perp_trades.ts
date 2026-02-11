import { openDatabase } from './db.js';

export interface PerpTradeInput {
  hypothesisId?: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  price?: number | null;
  leverage?: number | null;
  orderType?: 'market' | 'limit' | null;
  status?: string | null;
}

export interface PerpTradeRecord extends PerpTradeInput {
  id: number;
  createdAt: string;
}

export function recordPerpTrade(input: PerpTradeInput): void {
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO perp_trades (
        hypothesis_id,
        symbol,
        side,
        size,
        price,
        leverage,
        order_type,
        status
      ) VALUES (
        @hypothesisId,
        @symbol,
        @side,
        @size,
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
    price: input.price ?? null,
    leverage: input.leverage ?? null,
    orderType: input.orderType ?? null,
    status: input.status ?? null,
  });
}

export function listPerpTrades(params?: { symbol?: string; limit?: number }): PerpTradeRecord[] {
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
    price: row.price == null ? null : Number(row.price),
    leverage: row.leverage == null ? null : Number(row.leverage),
    orderType:
      row.order_type === 'market' || row.order_type === 'limit'
        ? (row.order_type as 'market' | 'limit')
        : null,
    status: row.status == null ? null : String(row.status),
  }));
}
