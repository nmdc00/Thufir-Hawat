import type { ThufirConfig } from './config.js';
import { createLlmClient } from './llm.js';
import { listWatchlist } from '../memory/watchlist.js';
import { listRecentIntel, type StoredIntel } from '../intel/store.js';
import { PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { listQueryCapableRoamingSources } from '../intel/sources_registry.js';
import {
  runIntelPipelineDetailedWithOverrides,
  type IntelPipelineResult,
} from '../intel/pipeline.js';

export interface ProactiveSearchResult extends IntelPipelineResult {
  queries: string[];
}

export function formatProactiveSummary(result: ProactiveSearchResult): string {
  const titles = result.storedItems
    .map((item) => item.title)
    .filter((title): title is string => typeof title === 'string')
    .slice(0, 6);
  return [
    `🔎 Proactive Search (${result.storedCount} new item(s))`,
    result.queries.length > 0 ? `Queries: ${result.queries.join('; ')}` : '',
    titles.length > 0 ? `Top items: ${titles.join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeQuery(query: string): string {
  return query
    .replace(/\s+/g, ' ')
    .replace(/[“”"]/g, '')
    .trim();
}

function uniq(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function extractEntities(text: string): string[] {
  const cleaned = text.replace(/[^\w\s'-]/g, ' ');
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const entities: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const phrase = current.join(' ');
    if (phrase.length >= 3) {
      entities.push(phrase);
    }
    current = [];
  };

  for (const token of tokens) {
    const isAcronym = token.length >= 2 && token === token.toUpperCase();
    const isCapitalized = token.length > 1 && token[0] === token[0]?.toUpperCase();
    const isNumber = /^\d{2,}$/.test(token);

    if (isAcronym || isCapitalized) {
      current.push(token);
      continue;
    }
    if (isNumber && current.length > 0) {
      current.push(token);
      continue;
    }
    flush();
  }
  flush();

  return Array.from(new Set(entities));
}

async function buildQueriesFromWatchlist(
  config: ThufirConfig,
  watchlistLimit: number
): Promise<string[]> {
  const watchlist = listWatchlist();
  if (watchlist.length === 0) {
    return [];
  }
  const client = new PolymarketMarketClient(config);
  const queries: string[] = [];
  for (const item of watchlist.slice(0, watchlistLimit)) {
    try {
      const market = await client.getMarket(item.marketId);
      if (market.question) {
        queries.push(normalizeQuery(market.question));
      } else {
        queries.push(item.marketId);
      }
    } catch {
      queries.push(item.marketId);
    }
  }
  return queries;
}

function buildQueriesFromIntel(limit: number): string[] {
  const recent = listRecentIntel(limit);
  if (recent.length === 0) return [];

  const queries: string[] = [];
  for (const item of recent) {
    if (item.title) queries.push(normalizeQuery(item.title));
    if (item.content) {
      const entities = extractEntities(item.content);
      queries.push(...entities.slice(0, 3));
    }
  }
  return queries;
}

async function refineQueriesWithLlm(
  config: ThufirConfig,
  rawQueries: string[],
  maxQueries: number
): Promise<string[]> {
  if (rawQueries.length === 0) return [];
  const llm = createLlmClient(config);
  const prompt = [
    'You are generating short, high-signal web search queries for market intelligence.',
    `Return a JSON array of up to ${maxQueries} queries.`,
    'Rules: keep each query under 8 words; no quotes; no numbering; no extra text.',
    'Base queries:',
    ...rawQueries.map((q) => `- ${q}`),
  ].join('\n');

  try {
    const response = await llm.complete([
      { role: 'system', content: 'You are a concise query generator.' },
      { role: 'user', content: prompt },
    ]);
    const raw = response.content.trim();
    const parsed = JSON.parse(raw) as string[];
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeQuery).filter(Boolean).slice(0, maxQueries);
    }
  } catch {
    // fall back to raw queries
  }

  return rawQueries.slice(0, maxQueries);
}


export async function runProactiveSearch(
  config: ThufirConfig,
  options?: {
    maxQueries?: number;
    watchlistLimit?: number;
    useLlm?: boolean;
    recentIntelLimit?: number;
    extraQueries?: string[];
  }
): Promise<ProactiveSearchResult> {
  const maxQueries = Math.max(1, options?.maxQueries ?? 8);
  const watchlistLimit = Math.max(1, options?.watchlistLimit ?? 20);
  const useLlm = options?.useLlm ?? true;
  const recentIntelLimit = Math.max(0, options?.recentIntelLimit ?? 25);
  const extraQueries = options?.extraQueries ?? [];

  const watchlistQueries = await buildQueriesFromWatchlist(config, watchlistLimit);
  const intelQueries = recentIntelLimit > 0 ? buildQueriesFromIntel(recentIntelLimit) : [];
  const combined = uniq(
    [...extraQueries, ...watchlistQueries, ...intelQueries].map(normalizeQuery).filter(Boolean)
  );
  const queries = useLlm
    ? await refineQueriesWithLlm(config, combined, maxQueries)
    : combined.slice(0, maxQueries);

  let storedItems: StoredIntel[] = [];
  let storedCount = 0;
  if (queries.length > 0) {
    const allowedSources = listQueryCapableRoamingSources(config).map((entry) => entry.name);
    if (allowedSources.length === 0) {
      return { storedCount: 0, storedItems: [], queries };
    }
    const result = await runIntelPipelineDetailedWithOverrides(config, {
      newsapiQueries: allowedSources.includes('newsapi') ? queries : undefined,
      googlenewsQueries: allowedSources.includes('googlenews') ? queries : undefined,
      twitterKeywords: allowedSources.includes('twitter') ? queries : undefined,
    });
    storedItems = storedItems.concat(result.storedItems);
    storedCount += result.storedCount;
  }

  return {
    storedCount,
    storedItems,
    queries,
  };
}
