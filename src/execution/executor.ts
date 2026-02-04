import type { Market } from './markets.js';

export interface TradeDecision {
  action: 'buy' | 'sell' | 'hold';
  outcome?: 'YES' | 'NO';
  amount?: number;
  symbol?: string;
  side?: 'buy' | 'sell';
  size?: number;
  price?: number;
  leverage?: number;
  reduceOnly?: boolean;
  orderType?: 'market' | 'limit';
  confidence?: 'low' | 'medium' | 'high';
  reasoning?: string;
}

export interface TradeResult {
  executed: boolean;
  message: string;
}

export interface Order {
  id: string;
  marketId: string;
  outcome?: 'YES' | 'NO';
  side?: 'buy' | 'sell';
  price?: number | null;
  amount?: number | null;
  status?: string;
  createdAt?: string;
}

export interface ExecutionAdapter {
  execute(market: Market, decision: TradeDecision): Promise<TradeResult>;
  getOpenOrders(): Promise<Order[]>;
  cancelOrder(id: string, options?: { symbol?: string }): Promise<void>;
}
