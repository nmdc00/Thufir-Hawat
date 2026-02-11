import { randomUUID } from 'node:crypto';

import type { ThufirConfig } from './config.js';
import { createLlmClient, createTrivialTaskClient } from './llm.js';
import { withExecutionContextIfMissing } from './llm_infra.js';
import { listWatchlist } from '../memory/watchlist.js';
import { listRecentIntel, storeIntel, type StoredIntel } from '../intel/store.js';
import { createMarketClient } from '../execution/market-client.js';
import { listQueryCapableRoamingSources } from '../intel/sources_registry.js';
import {
  listLearnedProactiveQueries,
  recordProactiveQueryOutcome,
} from '../memory/proactive_queries.js';
import { executeToolCall } from './tool-executor.js';
import {
  runIntelPipelineDetailedWithOverrides,
  type IntelPipelineResult,
} from '../intel/pipeline.js';

export interface ProactiveSearchResult extends IntelPipelineResult {
  queries: string[];
  rounds: number;
  learnedSeedQueries: string[];
}

export function formatProactiveSummary(result: ProactiveSearchResult): string {
  const titles = result.storedItems
    .map((item) => item.title)
    .filter((title): title is string => typeof title === 'string')
    .slice(0, 6);
  return [
    `🔎 Proactive Search (${result.storedCount} new item(s))`,
    `Rounds: ${result.rounds}`,
    result.learnedSeedQueries.length > 0
      ? `Learned seeds: ${result.learnedSeedQueries.slice(0, 5).join('; ')}`
      : '',
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

function toIsoTimestamp(input?: string | null): string {
  if (!input) {
    return new Date().toISOString();
  }
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) {
    return new Date().toISOString();
  }
  return new Date(parsed).toISOString();
}

async function buildQueriesFromWatchlist(
  _config: ThufirConfig,
  watchlistLimit: number
): Promise<string[]> {
  const watchlist = listWatchlist();
  if (watchlist.length === 0) {
    return [];
  }
  const client = createMarketClient(_config);
  if (!client.isAvailable()) {
    return watchlist.slice(0, watchlistLimit).map((item) => item.marketId);
  }
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
  const llm = createTrivialTaskClient(config) ?? createLlmClient(config);
  const prompt = [
    'You are generating short, high-signal web search queries for market intelligence.',
    `Return a JSON array of up to ${maxQueries} queries.`,
    'Rules: keep each query under 8 words; no quotes; no numbering; no extra text.',
    'Base queries:',
    ...rawQueries.map((q) => `- ${q}`),
  ].join('\n');

  try {
    const response = await withExecutionContextIfMissing(
      { mode: 'LIGHT_REASONING', critical: false, reason: 'proactive_query_refine', source: 'proactive' },
      () =>
        llm.complete([
          { role: 'system', content: 'You are a concise query generator.' },
          { role: 'user', content: prompt },
        ])
    );
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

async function generateFollowUpQueriesWithLlm(
  config: ThufirConfig,
  options: {
    previousQueries: string[];
    evidence: string[];
    maxQueries: number;
  }
): Promise<string[]> {
  if (options.maxQueries <= 0 || options.evidence.length === 0) {
    return [];
  }

  const llm = createTrivialTaskClient(config) ?? createLlmClient(config);
  const prompt = [
    'Generate follow-up web search queries for market intelligence.',
    `Return a JSON array of up to ${options.maxQueries} queries.`,
    'Rules: under 8 words per query; no quotes; no numbering; no extra text.',
    'Do not repeat existing queries.',
    'Existing queries:',
    ...options.previousQueries.map((query) => `- ${query}`),
    'Evidence:',
    ...options.evidence.slice(0, 20).map((line) => `- ${line}`),
  ].join('\n');

  try {
    const response = await withExecutionContextIfMissing(
      {
        mode: 'LIGHT_REASONING',
        critical: false,
        reason: 'proactive_follow_up_queries',
        source: 'proactive',
      },
      () =>
        llm.complete([
          { role: 'system', content: 'You are a concise query generator.' },
          { role: 'user', content: prompt },
        ])
    );
    const parsed = JSON.parse(response.content) as string[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    const existing = new Set(options.previousQueries.map((query) => query.toLowerCase()));
    return uniq(
      parsed
        .map(normalizeQuery)
        .filter((query) => query.length > 0 && !existing.has(query.toLowerCase()))
    ).slice(0, options.maxQueries);
  } catch {
    return [];
  }
}

type WebSearchResultItem = {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string | null;
  source?: string | null;
};

type WebSearchData = {
  provider?: string;
  query?: string;
  results?: WebSearchResultItem[];
};

type WebFetchData = {
  url?: string;
  title?: string | null;
  content?: string;
};

function parseWebSearchData(data: unknown): WebSearchData {
  if (!data || typeof data !== 'object') return {};
  const obj = data as Record<string, unknown>;
  const results = Array.isArray(obj.results)
    ? obj.results.filter((item) => item && typeof item === 'object') as WebSearchResultItem[]
    : [];
  return {
    provider: typeof obj.provider === 'string' ? obj.provider : undefined,
    query: typeof obj.query === 'string' ? obj.query : undefined,
    results,
  };
}

function parseWebFetchData(data: unknown): WebFetchData {
  if (!data || typeof data !== 'object') return {};
  const obj = data as Record<string, unknown>;
  return {
    url: typeof obj.url === 'string' ? obj.url : undefined,
    title: typeof obj.title === 'string' || obj.title === null ? (obj.title as string | null) : null,
    content: typeof obj.content === 'string' ? obj.content : undefined,
  };
}

async function runWebResearchForQuery(
  config: ThufirConfig,
  query: string,
  options: {
    webLimitPerQuery: number;
    fetchPerQuery: number;
    fetchMaxChars: number;
  }
): Promise<{
  storedItems: StoredIntel[];
  storedCount: number;
  webResultsCount: number;
  fetchedPagesCount: number;
  evidence: string[];
}> {
  const marketClient = createMarketClient(config);
  const toolCtx = { config, marketClient };
  const searchResult = await executeToolCall(
    'web_search',
    { query, limit: options.webLimitPerQuery },
    toolCtx
  );

  if (!searchResult.success) {
    recordProactiveQueryOutcome({
      query,
      succeeded: false,
      error: searchResult.error,
    });
    return {
      storedItems: [],
      storedCount: 0,
      webResultsCount: 0,
      fetchedPagesCount: 0,
      evidence: [],
    };
  }

  const parsedSearch = parseWebSearchData(searchResult.data);
  const provider = parsedSearch.provider ?? 'unknown';
  const webResults = (parsedSearch.results ?? []).slice(0, options.webLimitPerQuery);

  const storedItems: StoredIntel[] = [];
  const evidence: string[] = [];
  for (const result of webResults) {
    const title = normalizeQuery(result.title ?? '');
    const url = result.url?.trim();
    if (!title && !url) {
      continue;
    }
    const snippet = typeof result.snippet === 'string' ? result.snippet.trim() : '';
    const sourceName = result.source ? `${provider}:${result.source}` : provider;
    const item: StoredIntel = {
      id: randomUUID(),
      title: title || url || query,
      content: snippet || undefined,
      source: `web_search:${sourceName}`,
      sourceType: 'news',
      url: url || undefined,
      timestamp: toIsoTimestamp(result.date),
    };
    const inserted = storeIntel(item);
    if (inserted) {
      storedItems.push(item);
      evidence.push(`${item.title}${snippet ? ` — ${snippet.slice(0, 180)}` : ''}`);
    }
  }

  const seenUrls = new Set<string>();
  let fetchedPagesCount = 0;
  for (const result of webResults) {
    if (fetchedPagesCount >= options.fetchPerQuery) {
      break;
    }
    const url = result.url?.trim();
    if (!url || seenUrls.has(url)) {
      continue;
    }
    seenUrls.add(url);

    const fetchResult = await executeToolCall(
      'web_fetch',
      { url, max_chars: options.fetchMaxChars },
      toolCtx
    );
    if (!fetchResult.success) {
      continue;
    }
    const fetched = parseWebFetchData(fetchResult.data);
    if (!fetched.content || fetched.content.trim().length === 0) {
      continue;
    }
    const item: StoredIntel = {
      id: randomUUID(),
      title: normalizeQuery(fetched.title ?? result.title ?? query) || query,
      content: fetched.content,
      source: 'web_fetch',
      sourceType: 'custom',
      url: fetched.url ?? url,
      timestamp: new Date().toISOString(),
    };
    const inserted = storeIntel(item);
    if (inserted) {
      storedItems.push(item);
      evidence.push(`${item.title} (full page)`);
    }
    fetchedPagesCount += 1;
  }

  recordProactiveQueryOutcome({
    query,
    storedItems: storedItems.length,
    webResults: webResults.length,
    fetchedPages: fetchedPagesCount,
    succeeded: true,
  });

  return {
    storedItems,
    storedCount: storedItems.length,
    webResultsCount: webResults.length,
    fetchedPagesCount,
    evidence,
  };
}

export async function runProactiveSearch(
  config: ThufirConfig,
  options?: {
    maxQueries?: number;
    watchlistLimit?: number;
    useLlm?: boolean;
    recentIntelLimit?: number;
    extraQueries?: string[];
    iterations?: number;
    webLimitPerQuery?: number;
    fetchPerQuery?: number;
    fetchMaxChars?: number;
    includeLearnedQueries?: boolean;
    learnedQueryLimit?: number;
  }
): Promise<ProactiveSearchResult> {
  const maxQueries = Math.max(1, options?.maxQueries ?? 8);
  const watchlistLimit = Math.max(1, options?.watchlistLimit ?? 20);
  const useLlm = options?.useLlm ?? true;
  const recentIntelLimit = Math.max(0, options?.recentIntelLimit ?? 25);
  const extraQueries = options?.extraQueries ?? [];
  const iterations = Math.min(3, Math.max(1, options?.iterations ?? 2));
  const webLimitPerQuery = Math.min(Math.max(1, options?.webLimitPerQuery ?? 5), 10);
  const fetchPerQuery = Math.min(Math.max(0, options?.fetchPerQuery ?? 1), 3);
  const fetchMaxChars = Math.min(Math.max(500, options?.fetchMaxChars ?? 4000), 50_000);
  const includeLearnedQueries = options?.includeLearnedQueries ?? true;
  const learnedQueryLimit = Math.min(Math.max(1, options?.learnedQueryLimit ?? 8), 50);

  const watchlistQueries = await buildQueriesFromWatchlist(config, watchlistLimit);
  const intelQueries = recentIntelLimit > 0 ? buildQueriesFromIntel(recentIntelLimit) : [];
  const learnedQueries = includeLearnedQueries ? listLearnedProactiveQueries(learnedQueryLimit) : [];
  const combined = uniq(
    [...extraQueries, ...learnedQueries, ...watchlistQueries, ...intelQueries]
      .map(normalizeQuery)
      .filter(Boolean)
  );
  const seedQueries = useLlm
    ? await refineQueriesWithLlm(config, combined, maxQueries)
    : combined.slice(0, maxQueries);
  const seenQueries = new Set<string>();
  const executedQueries: string[] = [];
  let plannedQueries = [...seedQueries];

  let storedItems: StoredIntel[] = [];
  let storedCount = 0;

  let rounds = 0;
  while (rounds < iterations && executedQueries.length < maxQueries) {
    const remaining = maxQueries - executedQueries.length;
    const roundQueries = plannedQueries
      .map(normalizeQuery)
      .filter((query) => {
        const key = query.toLowerCase();
        if (!query || seenQueries.has(key)) {
          return false;
        }
        seenQueries.add(key);
        return true;
      })
      .slice(0, remaining);

    if (roundQueries.length === 0) {
      break;
    }

    rounds += 1;
    const evidence: string[] = [];
    for (const query of roundQueries) {
      const result = await runWebResearchForQuery(config, query, {
        webLimitPerQuery,
        fetchPerQuery,
        fetchMaxChars,
      });
      executedQueries.push(query);
      storedItems = storedItems.concat(result.storedItems);
      storedCount += result.storedCount;
      evidence.push(...result.evidence.slice(0, 4));
    }

    if (!useLlm || rounds >= iterations || executedQueries.length >= maxQueries) {
      break;
    }
    plannedQueries = await generateFollowUpQueriesWithLlm(config, {
      previousQueries: executedQueries,
      evidence,
      maxQueries: maxQueries - executedQueries.length,
    });
    if (plannedQueries.length === 0) {
      break;
    }
  }

  if (executedQueries.length > 0) {
    const allowedSources = listQueryCapableRoamingSources(config).map((entry) => entry.name);
    if (allowedSources.length > 0) {
      const result = await runIntelPipelineDetailedWithOverrides(config, {
        newsapiQueries: allowedSources.includes('newsapi') ? executedQueries : undefined,
        googlenewsQueries: allowedSources.includes('googlenews') ? executedQueries : undefined,
        twitterKeywords: allowedSources.includes('twitter') ? executedQueries : undefined,
      });
      storedItems = storedItems.concat(result.storedItems);
      storedCount += result.storedCount;
    }
  }

  return {
    storedCount,
    storedItems,
    queries: executedQueries,
    rounds,
    learnedSeedQueries: learnedQueries,
  };
}
