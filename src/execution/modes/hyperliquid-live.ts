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
  private defaultSlippageBps: number;

  constructor(options: HyperliquidLiveExecutorOptions) {
    this.client = new HyperliquidClient(options.config);
    this.maxLeverage = options.config.hyperliquid?.maxLeverage ?? 5;
    this.defaultSlippageBps = options.config.hyperliquid?.defaultSlippageBps ?? 10;
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

    const leverage = Math.min(
      decision.leverage ?? this.maxLeverage,
      this.maxLeverage
    );
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

      const leverageCap = marketMeta.maxLeverage ?? this.maxLeverage;
      const appliedLeverage = Math.min(leverage, leverageCap);
      if (decision.leverage != null) {
        await exchange.updateLeverage({
          asset: marketMeta.assetId,
          isCross: true,
          leverage: appliedLeverage,
        });
      }

      const sizeStr = formatDecimal(size, marketMeta.szDecimals ?? 6);
      if (!Number.isFinite(Number(sizeStr)) || Number(sizeStr) <= 0) {
        return { executed: false, message: 'Invalid decision: size rounds to zero.' };
      }

      const orderPx =
        orderType === 'limit'
          ? price
          : price ?? (await this.estimateMarketPrice(symbol, side));
      if (!orderPx || orderPx <= 0) {
        return { executed: false, message: 'Invalid decision: missing or invalid price.' };
      }

      const priceStr = formatDecimal(orderPx, 8);
      const tif: 'Ioc' | 'Gtc' = orderType === 'market' ? 'Ioc' : 'Gtc';
      const payload: Parameters<ReturnType<HyperliquidClient['getExchangeClient']>['order']>[0] = {
        orders: [
          {
            a: marketMeta.assetId,
            b: side === 'buy',
            p: priceStr,
            s: sizeStr,
            r: reduceOnly,
            t: { limit: { tif } },
          },
        ],
        grouping: 'na' as const,
      };

      const result = await exchange.order(payload);
      const status = (result as any)?.response?.data?.statuses?.[0];
      const statusMessage = summarizeOrderStatus(status);
      if (statusMessage?.error) {
        return { executed: false, message: `Hyperliquid trade failed: ${statusMessage.error}` };
      }
      return {
        executed: true,
        message:
          statusMessage?.message ??
          `Hyperliquid order placed: ${symbol} ${side} size=${sizeStr} ${orderType}`,
      };
    } catch (error) {
      return {
        executed: false,
        message: `Hyperliquid trade failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  private async estimateMarketPrice(symbol: string, side: 'buy' | 'sell'): Promise<number> {
    const mids = await this.client.getAllMids();
    const mid = mids[symbol];
    if (typeof mid !== 'number' || !Number.isFinite(mid)) {
      throw new Error(`Missing mid price for ${symbol}.`);
    }
    const slippage = this.defaultSlippageBps / 10000;
    return side === 'buy' ? mid * (1 + slippage) : mid * (1 - slippage);
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

function formatDecimal(value: number, decimals: number): string {
  const bounded = Math.max(0, value);
  const fixed = bounded.toFixed(decimals);
  return fixed.replace(/\.?0+$/, '');
}

function summarizeOrderStatus(
  status: unknown
): { message?: string; error?: string } | null {
  if (!status || typeof status !== 'object') return null;
  if ('error' in status && typeof (status as { error?: unknown }).error === 'string') {
    return { error: (status as { error: string }).error };
  }
  if ('resting' in status && (status as { resting?: { oid?: number | string } }).resting) {
    const oid = (status as { resting?: { oid?: number | string } }).resting?.oid;
    return { message: `Hyperliquid order resting (oid=${oid ?? 'unknown'}).` };
  }
  if ('filled' in status && (status as { filled?: { oid?: number | string } }).filled) {
    const oid = (status as { filled?: { oid?: number | string } }).filled?.oid;
    return { message: `Hyperliquid order filled (oid=${oid ?? 'unknown'}).` };
  }
  return null;
}
