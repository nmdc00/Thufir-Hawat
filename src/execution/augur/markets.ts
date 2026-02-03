import type { ThufirConfig } from '../../core/config.js';
import type { MarketCacheRecord } from '../../memory/market_cache.js';
import { getMarketCache, listMarketCache, searchMarketCache } from '../../memory/market_cache.js';
import type { Market } from '../markets.js';
export type { Market } from '../markets.js';
import { AugurTurboClient, type AugurPosition } from './client.js';
import { normalizeAugurMarket } from './normalize.js';
import { discoverMarketFromWeb, searchMarketsFromWeb } from './web_discovery.js';
import { ethers } from 'ethers';

export class AugurMarketClient {
  private client: AugurTurboClient;
  private config: ThufirConfig;

  constructor(config: ThufirConfig) {
    this.config = config;
    const rpcUrl = config.augur?.rpcUrl;
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
    // Check cache first
    const cached = searchMarketCache(query, limit);
    if (cached.length > 0) {
      return cached.map((record) => this.marketFromCache(record));
    }

    // Try subgraph (may fail if deprecated)
    try {
      const raw = await this.client.getMarkets({ limit: Math.max(50, limit) });
      const needle = query.toLowerCase();
      const filtered = raw.filter((m) => normalizeAugurMarket(m).question.toLowerCase().includes(needle));
      if (filtered.length > 0) {
        return filtered.slice(0, limit).map(normalizeAugurMarket);
      }
    } catch {
      // Subgraph failed, try web discovery
    }

    // Web discovery fallback - search the web for matching markets
    const discovered = await searchMarketsFromWeb(this.config, query, limit);
    return discovered.map((record) => this.marketFromCache(record));
  }

  async getMarket(marketId: string): Promise<Market> {
    // Check cache first since the Augur subgraph endpoint has been deprecated
    const cached = getMarketCache(marketId);
    if (cached) {
      return this.marketFromCache(cached);
    }

    // Try subgraph (may fail if deprecated)
    try {
      const raw = await this.client.getMarket(marketId);
      if (raw) {
        return normalizeAugurMarket(raw);
      }
    } catch {
      // Subgraph failed, try web discovery fallback
    }

    // Web discovery fallback - search the web and use LLM to extract market info
    const discovered = await discoverMarketFromWeb(this.config, marketId);
    if (discovered) {
      return this.marketFromCache(discovered);
    }

    throw new Error(`Augur market not found: ${marketId}`);
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
