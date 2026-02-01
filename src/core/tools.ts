import type { ThufirConfig } from './config.js';
import type { Market, PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { listCalibrationSummaries } from '../memory/calibration.js';
import { listMarketCategories } from '../memory/market_cache.js';
import { listRecentIntel, searchIntel } from '../intel/store.js';
import { IntelVectorStore } from '../intel/vectorstore.js';

export type ToolResult = Record<string, unknown>;

export interface ToolContext {
  config: ThufirConfig;
  marketClient: PolymarketMarketClient;
}

type ToolHandler = (ctx: ToolContext, params: Record<string, unknown>) => Promise<ToolResult>;

type CacheEntry = {
  value: ToolResult;
  storedAt: number;
  ttlMs: number;
};

export interface ToolRegistryOptions {
  defaultTtlMs?: number;
  ttlByTool?: Record<string, number>;
  enableLogs?: boolean;
}

export class ToolRegistry {
  private cache = new Map<string, CacheEntry>();
  private handlers: Record<string, ToolHandler> = {};
  private defaultTtlMs: number;
  private ttlByTool: Record<string, number>;
  private enableLogs: boolean;

  constructor(options: ToolRegistryOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 30_000;
    this.ttlByTool = options.ttlByTool ?? {};
    this.enableLogs = options.enableLogs ?? process.env.THUFIR_TOOL_LOG === '1';

    this.handlers['market.get'] = async (ctx, params) => {
      const id = String(params.marketId ?? '');
      const market = await ctx.marketClient.getMarket(id);
      return { market };
    };

    this.handlers['market.search'] = async (ctx, params) => {
      const query = String(params.query ?? '');
      const limit = Number(params.limit ?? 5);
      const markets = await ctx.marketClient.searchMarkets(query, limit);
      return { markets };
    };

    this.handlers['market.categories'] = async (_ctx, params) => {
      const limit = Number(params.limit ?? 20);
      const categories = listMarketCategories(limit);
      return { categories };
    };

    this.handlers['intel.search'] = async (_ctx, params) => {
      const query = String(params.query ?? '');
      const limit = Number(params.limit ?? 5);
      const fromDays =
        params.fromDays === undefined ? 14 : Number(params.fromDays ?? 14);
      const items = searchIntel({ query, limit, fromDays });
      return { items };
    };

    this.handlers['intel.recent'] = async (_ctx, params) => {
      const limit = Number(params.limit ?? 10);
      const items = listRecentIntel(limit);
      return { items };
    };

    this.handlers['intel.semantic'] = async (ctx, params) => {
      if (!ctx.config.intel?.embeddings?.enabled) {
        return { items: [] };
      }
      const query = String(params.query ?? '');
      const limit = Number(params.limit ?? 5);
      const vectorStore = new IntelVectorStore(ctx.config);
      const hits = await vectorStore.query(query, limit);
      return { hits };
    };

    this.handlers['calibration.summary'] = async (_ctx, params) => {
      const domain = params.domain ? String(params.domain) : undefined;
      const summaries = listCalibrationSummaries();
      const match = domain
        ? summaries.filter((summary) => summary.domain === domain)
        : summaries;
      return { summaries: match };
    };
  }

  async run(name: string, ctx: ToolContext, params: Record<string, unknown>): Promise<ToolResult> {
    const key = `${name}:${JSON.stringify(params)}`;
    const ttlMs = this.ttlByTool[name] ?? this.defaultTtlMs;
    const cached = this.cache.get(key);
    if (cached && ttlMs > 0) {
      const age = Date.now() - cached.storedAt;
      if (age <= cached.ttlMs) {
        if (this.enableLogs) {
          console.log(`[tools] cache hit ${name} (${age}ms old)`);
        }
        return cached.value;
      }
      this.cache.delete(key);
    }
    const handler = this.handlers[name];
    if (!handler) {
      return { error: `Unknown tool: ${name}` };
    }
    const start = Date.now();
    const result = await handler(ctx, params);
    if (ttlMs > 0) {
      this.cache.set(key, { value: result, storedAt: Date.now(), ttlMs });
    }
    if (this.enableLogs) {
      console.log(`[tools] ran ${name} in ${Date.now() - start}ms`);
    }
    return result;
  }

  clear(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}

export function getMarketFromResult(result: ToolResult): Market | null {
  const market = (result as { market?: Market }).market;
  return market ?? null;
}
