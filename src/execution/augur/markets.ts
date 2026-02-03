import type { ThufirConfig } from '../../core/config.js';
import type { MarketCacheRecord } from '../../memory/market_cache.js';
import { getMarketCache, listMarketCache, searchMarketCache } from '../../memory/market_cache.js';
import type { Market } from '../markets.js';
export type { Market } from '../markets.js';
import { AugurTurboClient, type AugurPosition } from './client.js';
import { normalizeAugurMarket } from './normalize.js';
import { ethers } from 'ethers';

export class AugurMarketClient {
  private client: AugurTurboClient;

  constructor(config: ThufirConfig) {
    const rpcUrl = config.augur?.rpcUrl ?? config.polymarket?.rpcUrl;
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl ?? 'https://polygon-rpc.com');
    this.client = new AugurTurboClient(config, provider);
  }

  async listMarkets(limit = 20): Promise<Market[]> {
    const cached = listMarketCache(limit);
    if (cached.length > 0) {
      return cached.map((record) => this.marketFromCache(record));
    }
    const raw = await this.client.getMarkets({ limit });
    return raw.map(normalizeAugurMarket);
  }

  async searchMarkets(query: string, limit = 10): Promise<Market[]> {
    const cached = searchMarketCache(query, limit);
    if (cached.length > 0) {
      return cached.map((record) => this.marketFromCache(record));
    }
    const raw = await this.client.getMarkets({ limit: Math.max(50, limit) });
    const needle = query.toLowerCase();
    const filtered = raw.filter((m) => normalizeAugurMarket(m).question.toLowerCase().includes(needle));
    return filtered.slice(0, limit).map(normalizeAugurMarket);
  }

  async getMarket(marketId: string): Promise<Market> {
    // Check cache first since the Augur subgraph endpoint has been deprecated
    const cached = getMarketCache(marketId);
    if (cached) {
      return this.marketFromCache(cached);
    }
    const raw = await this.client.getMarket(marketId);
    if (!raw) {
      throw new Error(`Augur market not found: ${marketId}`);
    }
    return normalizeAugurMarket(raw);
  }

  async getPositions(address: string): Promise<AugurPosition[]> {
    return this.client.getPositions(address);
  }

  private marketFromCache(record: MarketCacheRecord): Market {
    return {
      id: record.id,
      question: record.question,
      description: record.description ?? undefined,
      outcomes: record.outcomes ?? [],
      prices: record.prices ?? {},
      volume: record.volume ?? undefined,
      liquidity: record.liquidity ?? undefined,
      endDate: record.endDate ? new Date(record.endDate) : undefined,
      category: record.category ?? undefined,
      resolved: record.resolved ?? undefined,
      resolution: record.resolution ?? undefined,
      createdAt: record.createdAt ? new Date(record.createdAt) : new Date(),
      platform: 'augur',
      augur: undefined,
    };
  }
}
