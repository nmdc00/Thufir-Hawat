import type { ThufirConfig } from '../../core/config.js';
import type { Market } from '../markets.js';
import { HyperliquidClient } from './client.js';

export class HyperliquidMarketClient {
  private client: HyperliquidClient;
  private symbols: string[];

  constructor(private config: ThufirConfig) {
    this.client = new HyperliquidClient(config);
    this.symbols = config.hyperliquid?.symbols ?? [];
  }

  isAvailable(): boolean {
    return this.config.hyperliquid?.enabled !== false;
  }

  async listMarkets(limit = 50): Promise<Market[]> {
    const markets = await this.client.listPerpMarkets();
    const mids = await this.client.getAllMids();
    const filtered = this.symbols.length
      ? markets.filter((m) => this.symbols.includes(m.symbol))
      : markets;
    return filtered.slice(0, limit).map((m) => ({
      id: m.symbol,
      question: `Perp: ${m.symbol}`,
      outcomes: ['LONG', 'SHORT'],
      prices: {},
      platform: 'hyperliquid',
      kind: 'perp',
      symbol: m.symbol,
      markPrice: mids[m.symbol],
      metadata: {
        assetId: m.assetId,
        maxLeverage: m.maxLeverage,
        szDecimals: m.szDecimals,
      },
    }));
  }

  async searchMarkets(query: string, limit = 10): Promise<Market[]> {
    const needle = query.toLowerCase();
    const markets = await this.listMarkets(500);
    const filtered = markets.filter((m) =>
      (m.symbol ?? m.id).toLowerCase().includes(needle)
    );
    return filtered.slice(0, limit);
  }

  async getMarket(symbol: string): Promise<Market> {
    const markets = await this.listMarkets(500);
    const match = markets.find((m) => m.symbol === symbol || m.id === symbol);
    if (!match) {
      throw new Error(`Hyperliquid market not found: ${symbol}`);
    }
    return match;
  }
}
