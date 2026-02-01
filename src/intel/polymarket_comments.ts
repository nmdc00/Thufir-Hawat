import type { ThufirConfig } from '../core/config.js';
import { PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { listWatchlist } from '../memory/watchlist.js';

export interface PolymarketCommentItem {
  title: string;
  content?: string;
  url?: string;
  publishedAt: string;
  source: string;
  category?: string;
}

interface CommentResponse {
  id?: string;
  body?: string | null;
  parentEntityID?: number | null;
  createdAt?: string | null;
  profile?: { pseudonym?: string | null; name?: string | null } | null;
}

export class PolymarketCommentsFetcher {
  private gammaUrl: string;
  private marketClient: PolymarketMarketClient;

  constructor(private config: ThufirConfig, marketClient?: PolymarketMarketClient) {
    this.gammaUrl = config.polymarket.api.gamma.replace(/\/$/, '');
    this.marketClient = marketClient ?? new PolymarketMarketClient(config);
  }

  async fetch(): Promise<PolymarketCommentItem[]> {
    const cfg = this.config.intel?.sources?.polymarketComments;
    if (!cfg?.enabled) {
      return [];
    }

    const marketIds = new Set<string>();
    if (cfg.trackWatchlist ?? true) {
      for (const item of listWatchlist(cfg.watchlistLimit ?? 50)) {
        marketIds.add(item.marketId);
      }
    }

    const topCount = cfg.trackTopMarkets ?? 0;
    if (topCount > 0) {
      const markets = await this.marketClient.listMarkets(topCount);
      for (const market of markets) {
        if (market.id) {
          marketIds.add(market.id);
        }
      }
    }

    const limit = Math.max(1, Math.min(200, cfg.maxCommentsPerMarket ?? 20));
    const items: PolymarketCommentItem[] = [];

    for (const marketId of marketIds) {
      try {
        const url = new URL(`${this.gammaUrl}/comments`);
        url.searchParams.set('parent_entity_type', 'market');
        url.searchParams.set('parent_entity_id', marketId);
        url.searchParams.set('limit', String(limit));
        if (cfg.holdersOnly) {
          url.searchParams.set('holders_only', 'true');
        }
        if (cfg.getPositions) {
          url.searchParams.set('get_positions', 'true');
        }
        if (cfg.order) {
          url.searchParams.set('order', cfg.order);
        }
        if (cfg.ascending !== undefined) {
          url.searchParams.set('ascending', cfg.ascending ? 'true' : 'false');
        }

        const response = await fetch(url.toString());
        if (!response.ok) {
          continue;
        }
        const data = (await response.json()) as CommentResponse[];
        for (const comment of data ?? []) {
          const body = (comment.body ?? '').trim();
          if (!body) {
            continue;
          }
          const author =
            comment.profile?.pseudonym ??
            comment.profile?.name ??
            'unknown';
          items.push({
            title: `Polymarket comment by ${author}`,
            content: body,
            url: `https://polymarket.com/market/${marketId}`,
            publishedAt: comment.createdAt ?? new Date().toISOString(),
            source: 'Polymarket comments',
          });
        }
      } catch {
        // ignore fetch errors to keep pipeline running
      }
    }

    return items;
  }
}
