import type { ExecutionAdapter, TradeDecision, TradeResult, Order } from '../executor.js';
import type { Market } from '../markets.js';
import type { ThufirConfig } from '../../core/config.js';
import { HyperliquidClient } from '../hyperliquid/client.js';

export interface HyperliquidLiveExecutorOptions {
  config: ThufirConfig;
}

export class HyperliquidLiveExecutor implements ExecutionAdapter {
  private client: HyperliquidClient;
  private maxLeverage: number;

  constructor(options: HyperliquidLiveExecutorOptions) {
    this.client = new HyperliquidClient(options.config);
    this.maxLeverage = options.config.hyperliquid?.maxLeverage ?? 5;
  }

  async execute(market: Market, decision: TradeDecision): Promise<TradeResult> {
    if (decision.action === 'hold') {
      return { executed: false, message: 'Hold decision; no trade executed.' };
    }

    const symbol = decision.symbol ?? market.symbol ?? market.id;
    const side = decision.side ?? decision.action;
    const size = decision.size ?? decision.amount;
    if (!symbol || !side || !size || size <= 0) {
      return { executed: false, message: 'Invalid decision: missing symbol/side/size.' };
    }

    const leverage = Math.min(decision.leverage ?? this.maxLeverage, this.maxLeverage);
    const orderType = decision.orderType ?? 'market';
    const price = decision.price ?? null;
    const reduceOnly = decision.reduceOnly ?? false;

    try {
      const exchange = this.client.getExchangeClient();
      const markets = await this.client.listPerpMarkets();
      const marketMeta = markets.find((m) => m.symbol === symbol);
      if (!marketMeta) {
        return { executed: false, message: `Unknown Hyperliquid symbol: ${symbol}` };
      }
      const payload = {
        asset: marketMeta.assetId,
        isBuy: side === 'buy',
        sz: size,
        limitPx: orderType === 'limit' ? price ?? 0 : undefined,
        orderType: orderType === 'limit' ? 'limit' : 'market',
        reduceOnly,
        leverage,
      };
      const result =
        typeof (exchange as any).placeOrder === 'function'
          ? await (exchange as any).placeOrder(payload)
          : await (exchange as any).order(payload);
      return {
        executed: true,
        message: `Hyperliquid order placed: ${symbol} ${side} size=${size} ${orderType}`,
      };
    } catch (error) {
      return {
        executed: false,
        message: `Hyperliquid trade failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  async getOpenOrders(): Promise<Order[]> {
    const raw = await this.client.getOpenOrders();
    const orders = Array.isArray(raw) ? raw : [];
    return orders.map((order) => {
      const coin = String((order as { coin?: string }).coin ?? '');
      const sideRaw = String((order as { side?: string }).side ?? '');
      const side = sideRaw === 'B' ? 'buy' : sideRaw === 'A' ? 'sell' : undefined;
      const price = Number((order as { limitPx?: string | number }).limitPx ?? NaN);
      const amount = Number((order as { sz?: string | number }).sz ?? NaN);
      const oid = (order as { oid?: number | string }).oid;
      const timestamp = Number((order as { timestamp?: number | string }).timestamp ?? NaN);
      return {
        id: oid != null ? String(oid) : '',
        marketId: coin,
        side,
        price: Number.isFinite(price) ? price : null,
        amount: Number.isFinite(amount) ? amount : null,
        status: 'open',
        createdAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined,
      };
    });
  }

  async cancelOrder(id: string): Promise<void> {
    const oid = Number(id);
    if (!Number.isFinite(oid)) {
      throw new Error(`Invalid order id: ${id}`);
    }

    const openOrders = await this.client.getOpenOrders();
    const match = Array.isArray(openOrders)
      ? openOrders.find((order) => Number((order as { oid?: number | string }).oid) === oid)
      : null;
    if (!match) {
      throw new Error(`Open order not found: ${id}`);
    }

    const coin = String((match as { coin?: string }).coin ?? '');
    const markets = await this.client.listPerpMarkets();
    const marketMeta = markets.find((m) => m.symbol === coin);
    if (!marketMeta) {
      throw new Error(`Unknown Hyperliquid symbol: ${coin}`);
    }

    const exchange = this.client.getExchangeClient();
    await exchange.cancel({
      cancels: [{ a: marketMeta.assetId, o: oid }],
    });
  }
}
