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
  marketSlippageBps?: number;
  modelProbability?: number; // Thufir's raw probability estimate for prediction-market trades
}

export interface TradeResult {
  executed: boolean;
  message: string;
  realizedPnlUsd?: number | null;
  feeUsd?: number | null;
  feeToken?: string | null;
  fillCount?: number | null;
  fillTimeMs?: number | null;
  orderId?: string | null;
  tradeId?: number | null;
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
