import fetch from 'node-fetch';

import type { ThufirConfig } from '../../core/config.js';
import { PolymarketCLOBClient } from './clob.js';
import type { MarketCacheRecord } from '../../memory/market_cache.js';
import { listMarketCache, searchMarketCache } from '../../memory/market_cache.js';

export interface MarketToken {
  token_id: string;
  outcome: string;
  price?: number;
  winner?: boolean;
}

export interface Market {
  id: string;
  conditionId: string;  // The condition ID used for order signing
  question: string;
  description?: string;
  outcomes: string[];
  prices: Record<string, number>;
  tokens?: MarketToken[];  // Token IDs for each outcome (may need to fetch from CLOB)
  clobTokenIds?: [string, string] | null;  // [YES token, NO token]
  volume?: number;
  liquidity?: number;
  endDate?: string;
  category?: string;
  resolved?: boolean;
  resolution?: string;
  negRisk?: boolean;  // Whether this is a negative risk market
}

export interface MarketPageResult {
  markets: Market[];
  nextOffset?: number;
}

export class PolymarketMarketClient {
  private gammaUrl: string;

  constructor(config: ThufirConfig) {
    this.gammaUrl = config.polymarket.api.gamma.replace(/\/$/, '');
  }

  async listMarkets(limit = 20): Promise<Market[]> {
    const cached = listMarketCache(limit);
    if (cached.length > 0) {
      return cached.map((record) => this.marketFromCache(record));
    }
    const page = await this.fetchMarketsPage({ limit, active: true, closed: false });
    return page.markets;
  }

  async searchMarkets(query: string, limit = 10): Promise<Market[]> {
    const cached = searchMarketCache(query, limit);
    if (cached.length > 0) {
      return cached.map((record) => this.marketFromCache(record));
    }
    const results: Market[] = [];
    let offset = 0;
    const maxPages = 5;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await this.fetchMarketsPage({
        limit,
        offset,
        search: query,
        active: true,
        closed: false,
      });
      results.push(...page.markets);
      if (results.length >= limit) {
        return results.slice(0, limit);
      }
      if (page.nextOffset != null) {
        offset = page.nextOffset;
      } else if (page.markets.length < limit) {
        break;
      } else {
        offset += limit;
      }
    }

    if (results.length > 0) {
      return results.slice(0, limit);
    }

    const all = await this.listMarkets(100);
    const queryLower = query.toLowerCase();
    return all
      .filter((m) => m.question.toLowerCase().includes(queryLower))
      .slice(0, limit);
  }

  async getMarket(marketId: string): Promise<Market> {
    const url = new URL(`${this.gammaUrl}/markets/${marketId}`);
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Failed to fetch market ${marketId}: ${response.status}`);
    }
    const data = (await response.json()) as any;
    return this.normalizeMarket(data);
  }

  private normalizeMarket(raw: any): Market {
    const outcomes =
      raw.outcomes ??
      raw.outcomesArray ??
      (typeof raw.outcomes === 'string' ? JSON.parse(raw.outcomes) : []);

    let prices: Record<string, number> | number[] = {};
    if (raw.prices) {
      prices = typeof raw.prices === 'string' ? JSON.parse(raw.prices) : raw.prices;
    } else if (raw.outcomePrices) {
      prices =
        typeof raw.outcomePrices === 'string'
          ? JSON.parse(raw.outcomePrices)
          : raw.outcomePrices;
    }

    if (Array.isArray(prices)) {
      const normalizedOutcomes = Array.isArray(outcomes) ? outcomes : [];
      const mapped: Record<string, number> = {};
      for (let i = 0; i < prices.length; i += 1) {
        const key = String(normalizedOutcomes[i] ?? i);
        const value = Number(prices[i]);
        if (!Number.isNaN(value)) {
          mapped[key] = value;
        }
      }
      prices = mapped;
    }

    // Extract token IDs - critical for order placement
    let tokens: MarketToken[] = [];
    let clobTokenIds: [string, string] | null = null;

    // Try tokens array format (from CLOB API)
    if (raw.tokens && Array.isArray(raw.tokens)) {
      tokens = raw.tokens.map((t: any) => ({
        token_id: String(t.token_id ?? t.tokenId ?? ''),
        outcome: String(t.outcome ?? ''),
        price: t.price != null ? Number(t.price) : undefined,
        winner: t.winner,
      }));
    }

    // Try clobTokenIds format (from Gamma API)
    if (raw.clobTokenIds) {
      const ids = typeof raw.clobTokenIds === 'string'
        ? JSON.parse(raw.clobTokenIds)
        : raw.clobTokenIds;
      if (Array.isArray(ids) && ids.length >= 2) {
        clobTokenIds = [String(ids[0]), String(ids[1])];
        // Build tokens from clobTokenIds if not already present
        if (tokens.length === 0) {
          tokens = [
            { token_id: clobTokenIds[0], outcome: 'Yes' },
            { token_id: clobTokenIds[1], outcome: 'No' },
          ];
        }
      }
    }

    // Try conditionId + side format (alternative)
    if (tokens.length === 0 && raw.conditionId) {
      // Some APIs provide condition ID and we need to query for tokens separately
      // Mark as needing token fetch
    }

    return {
      id: String(raw.id ?? raw.marketId ?? raw.condition_id ?? ''),
      conditionId: String(raw.conditionId ?? raw.condition_id ?? raw.id ?? ''),
      question: String(raw.question ?? raw.title ?? raw.marketTitle ?? ''),
      description: raw.description ?? raw.rules ?? raw.marketDescription ?? undefined,
      outcomes: Array.isArray(outcomes) ? outcomes : [],
      prices: prices ?? {},
      tokens: tokens.length > 0 ? tokens : undefined,
      clobTokenIds: clobTokenIds ?? undefined,
      volume: raw.volume ?? raw.volume24h ?? raw.volumeUsd,
      liquidity: raw.liquidity ?? raw.liquidityUsd,
      endDate: raw.endDate ?? raw.end_date ?? raw.closeTime,
      category: raw.category ?? raw.groupSlug,
      resolved: raw.resolved ?? raw.isResolved ?? false,
      resolution: raw.resolution ?? raw.resolvedOutcome ?? raw.outcome ?? undefined,
      negRisk: raw.negRisk ?? raw.neg_risk ?? (raw.enableOrderBook === false ? true : undefined),
    };
  }

  normalizeRawMarket(raw: any): Market {
    return this.normalizeMarket(raw);
  }

  private marketFromCache(record: MarketCacheRecord): Market {
    return {
      id: record.id,
      conditionId: record.id,
      question: record.question,
      description: record.description ?? undefined,
      outcomes: record.outcomes ?? [],
      prices: record.prices ?? {},
      volume: record.volume ?? undefined,
      liquidity: record.liquidity ?? undefined,
      endDate: record.endDate ?? undefined,
      category: record.category ?? undefined,
      resolved: record.resolved ?? undefined,
      resolution: record.resolution ?? undefined,
    };
  }

  async fetchMarketsPage(options: {
    limit?: number;
    offset?: number;
    search?: string;
    active?: boolean;
    closed?: boolean;
  }): Promise<MarketPageResult> {
    const url = new URL(`${this.gammaUrl}/markets`);
    if (options.limit != null) url.searchParams.set('limit', String(options.limit));
    if (options.offset != null) url.searchParams.set('offset', String(options.offset));
    if (options.search) url.searchParams.set('search', options.search);
    if (options.active != null) url.searchParams.set('active', options.active ? 'true' : 'false');
    if (options.closed != null) url.searchParams.set('closed', options.closed ? 'true' : 'false');

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Failed to fetch markets: ${response.status}`);
    }
    const data = (await response.json()) as any;
    const list = Array.isArray(data) ? data : data.markets ?? data.results ?? [];
    const nextOffset =
      typeof data.next_offset === 'number'
        ? data.next_offset
        : typeof data.nextOffset === 'number'
          ? data.nextOffset
          : typeof data.next === 'number'
            ? data.next
            : undefined;

    return {
      markets: list.map((raw: any) => this.normalizeMarket(raw)),
      nextOffset,
    };
  }

  /**
   * Enrich a market with token IDs from the CLOB API.
   * Call this before executing trades to ensure token IDs are available.
   */
  async enrichWithTokenIds(market: Market, clobClient: PolymarketCLOBClient): Promise<Market> {
    // If tokens already present, no need to fetch
    if (market.tokens && market.tokens.length >= 2) {
      return market;
    }
    if (market.clobTokenIds && market.clobTokenIds.length >= 2) {
      return market;
    }

    // Fetch from CLOB API
    const conditionId = market.conditionId || market.id;
    try {
      const tokenIds = await clobClient.getTokenIds(conditionId);
      if (tokenIds) {
        return {
          ...market,
          clobTokenIds: tokenIds,
          tokens: [
            { token_id: tokenIds[0], outcome: 'Yes' },
            { token_id: tokenIds[1], outcome: 'No' },
          ],
        };
      }
    } catch (error) {
      console.warn(`[PolymarketMarketClient] Failed to fetch token IDs for ${conditionId}:`, error);
    }

    return market;
  }
}
