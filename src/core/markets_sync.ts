import type { ThufirConfig } from './config.js';
import { createMarketClient } from '../execution/market-client.js';
import { upsertMarketCacheBatch } from '../memory/market_cache.js';

export async function syncMarketCache(
  _config: ThufirConfig,
  limit = 200
): Promise<{ stored: number }> {
  const client = createMarketClient(_config);
  if (!client.isAvailable()) {
    return { stored: 0 };
  }
  let stored = 0;
  const markets = await client.listMarkets(limit);
  const records = markets.map((market) => ({
    id: market.id,
    question: market.question,
    description: market.description ?? null,
    outcomes: market.outcomes ?? [],
    prices: market.prices ?? {},
    volume: market.volume ?? null,
    liquidity: market.liquidity ?? null,
    endDate: market.endDate ? market.endDate.toISOString() : null,
    category: market.category ?? null,
    resolved: market.resolved ?? false,
    resolution: market.resolution ?? null,
    createdAt: null,
  }));
  if (records.length > 0) {
    upsertMarketCacheBatch(records);
    stored += records.length;
  }

  return { stored };
}

export async function refreshMarketPrices(
  _config: ThufirConfig,
  limit = 500
): Promise<{ stored: number }> {
  const client = createMarketClient(_config);
  if (!client.isAvailable()) {
    return { stored: 0 };
  }
  const markets = await client.listMarkets(limit);

  const records = markets.map((market) => ({
    id: market.id,
    question: market.question,
    description: market.description ?? null,
    outcomes: market.outcomes ?? [],
    prices: market.prices ?? {},
    volume: market.volume ?? null,
    liquidity: market.liquidity ?? null,
    endDate: market.endDate ? market.endDate.toISOString() : null,
    category: market.category ?? null,
    resolved: market.resolved ?? false,
    resolution: market.resolution ?? null,
    createdAt: null,
  }));

  if (records.length > 0) {
    upsertMarketCacheBatch(records);
  }

  return { stored: records.length };
}
