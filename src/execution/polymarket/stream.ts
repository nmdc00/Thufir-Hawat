import { EventEmitter } from 'eventemitter3';
import WebSocket from 'ws';

import type { ThufirConfig } from '../../core/config.js';

export interface MarketUpdate {
  marketId: string;
  prices?: Record<string, number>;
  raw: Record<string, unknown>;
}

export interface StreamEvents {
  update: (payload: MarketUpdate) => void;
  connected: () => void;
  disconnected: () => void;
  error: (err: Error) => void;
}

export function parseMarketUpdate(message: string): MarketUpdate | null {
  try {
    const data = JSON.parse(message) as Record<string, unknown>;
    const marketId =
      (data.marketId as string) ??
      (data.market_id as string) ??
      (data.market as string) ??
      (data.id as string);
    if (!marketId) {
      return null;
    }

    let prices: Record<string, number> | undefined;
    if (data.prices && typeof data.prices === 'object') {
      prices = data.prices as Record<string, number>;
    } else if (data.price && typeof data.price === 'number') {
      const outcome = (data.outcome as string) ?? 'YES';
      prices = { [outcome]: data.price as number };
    } else if (data.bestBid || data.bestAsk) {
      const bid = Number(data.bestBid ?? data.bid);
      const ask = Number(data.bestAsk ?? data.ask);
      if (!Number.isNaN(bid) || !Number.isNaN(ask)) {
        prices = {
          BID: Number.isNaN(bid) ? 0 : bid,
          ASK: Number.isNaN(ask) ? 0 : ask,
        };
      }
    }

    return { marketId: String(marketId), prices, raw: data };
  } catch {
    return null;
  }
}

export class PolymarketStreamClient extends EventEmitter<StreamEvents> {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectMs: number;
  private subscribedMarkets: string[] = [];
  private lastUpdate = new Map<string, number>();

  constructor(config: ThufirConfig) {
    super();
    const url =
      config.polymarket?.stream?.wsUrl ??
      process.env.POLYMARKET_WS_URL ??
      '';
    this.url = url;
    this.reconnectMs = Math.max(
      1000,
      (config.polymarket?.stream?.reconnectSeconds ?? 10) * 1000
    );
  }

  connect(): void {
    if (!this.url) {
      return;
    }
    this.ws = new WebSocket(this.url);
    this.ws.on('open', () => {
      this.emit('connected');
      if (this.subscribedMarkets.length > 0) {
        this.sendSubscribe(this.subscribedMarkets);
      }
    });
    this.ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString();
      const update = parseMarketUpdate(text);
      if (!update) {
        return;
      }
      this.lastUpdate.set(update.marketId, Date.now());
      this.emit('update', update);
    });
    this.ws.on('close', () => {
      this.emit('disconnected');
      this.reconnect();
    });
    this.ws.on('error', (err) => {
      this.emit('error', err as Error);
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  subscribe(markets: string[]): void {
    this.subscribedMarkets = markets;
    this.sendSubscribe(markets);
  }

  getLastUpdate(marketId: string): number | undefined {
    return this.lastUpdate.get(marketId);
  }

  private sendSubscribe(markets: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = {
      type: 'subscribe',
      markets,
    };
    this.ws.send(JSON.stringify(payload));
  }

  private reconnect(): void {
    if (!this.url) return;
    setTimeout(() => this.connect(), this.reconnectMs);
  }
}
