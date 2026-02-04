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
