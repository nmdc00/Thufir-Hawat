import type { ExecutionAdapter, TradeDecision, TradeResult, Order } from '../executor.js';
import type { Market } from '../markets.js';

export class UnsupportedLiveExecutor implements ExecutionAdapter {
  constructor(private reason = 'Live execution adapter is not configured.') {}

  async execute(_market: Market, _decision: TradeDecision): Promise<TradeResult> {
    return { executed: false, message: this.reason };
  }

  async getOpenOrders(): Promise<Order[]> {
    return [];
  }

  async cancelOrder(_id: string): Promise<void> {
    throw new Error(this.reason);
  }
}
