import type { Market } from './markets.js';
import type { ThufirConfig } from '../core/config.js';
import { HyperliquidMarketClient } from './hyperliquid/markets.js';

export class MarketClientUnavailableError extends Error {
  constructor(message = 'Market client is not configured.') {
    super(message);
    this.name = 'MarketClientUnavailableError';
  }
}

export interface MarketClient {
  isAvailable(): boolean;
  listMarkets(limit?: number): Promise<Market[]>;
  searchMarkets(query: string, limit?: number): Promise<Market[]>;
  getMarket(marketId: string): Promise<Market>;
  getPositions?(address: string): Promise<unknown[]>;
}

export class NullMarketClient implements MarketClient {
  isAvailable(): boolean {
    return false;
  }

  async listMarkets(): Promise<Market[]> {
    return [];
  }

  async searchMarkets(): Promise<Market[]> {
    return [];
  }

  async getMarket(_marketId: string): Promise<Market> {
    throw new MarketClientUnavailableError();
  }

  async getPositions(): Promise<unknown[]> {
    return [];
  }
}

export function createMarketClient(config?: ThufirConfig): MarketClient {
  if (!config) {
    return new NullMarketClient();
  }
  if (config.execution?.provider === 'hyperliquid' && config.hyperliquid?.enabled !== false) {
    return new HyperliquidMarketClient(config);
  }
  return new NullMarketClient();
}
