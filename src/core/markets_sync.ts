import fetch from 'node-fetch';

import type { ThufirConfig } from './config.js';
import { PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { upsertMarketCacheBatch } from '../memory/market_cache.js';

export async function syncMarketCache(
  config: ThufirConfig,
  limit = 200,
  maxPages = 25
): Promise<{ stored: number }> {
  const client = new PolymarketMarketClient(config);
  let offset = 0;
  let stored = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const pageResult = await client.fetchMarketsPage({
      limit,
      offset,
      active: true,
      closed: false,
    });

    const records = pageResult.markets.map((market) => ({
      id: market.id,
      question: market.question,
      description: market.description ?? null,
      outcomes: market.outcomes ?? [],
      prices: market.prices ?? {},
      volume: market.volume ?? null,
      liquidity: market.liquidity ?? null,
      endDate: market.endDate ?? null,
      category: market.category ?? null,
      resolved: market.resolved ?? false,
      resolution: market.resolution ?? null,
      createdAt: null,
    }));

    if (records.length > 0) {
      upsertMarketCacheBatch(records);
      stored += records.length;
    }

    if (pageResult.nextOffset != null) {
      offset = pageResult.nextOffset;
    } else if (pageResult.markets.length < limit) {
      break;
    } else {
      offset += limit;
    }
  }

  return { stored };
}

export async function refreshMarketPrices(
  config: ThufirConfig,
  limit = 500
): Promise<{ stored: number }> {
  const gammaUrl = config.polymarket.api.gamma.replace(/\/$/, '');
  const url = new URL(`${gammaUrl}/markets`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('active', 'true');
  url.searchParams.set('closed', 'false');

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to refresh market prices: ${response.status}`);
  }
  const data = (await response.json()) as any;
  const list = Array.isArray(data) ? data : data.markets ?? data.results ?? [];
  const client = new PolymarketMarketClient(config);
  const markets = list.map((raw: any) => client.normalizeRawMarket(raw));

  const records = markets.map((market: any) => ({
    id: market.id,
    question: market.question,
    description: market.description ?? null,
    outcomes: market.outcomes ?? [],
    prices: market.prices ?? {},
    volume: market.volume ?? null,
    liquidity: market.liquidity ?? null,
    endDate: market.endDate ?? null,
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
