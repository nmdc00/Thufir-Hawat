import type { ThufirConfig } from '../../core/config.js';
import type { MarketCacheRecord } from '../../memory/market_cache.js';
import { upsertMarketCache } from '../../memory/market_cache.js';
import { createLlmClient } from '../../core/llm.js';

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Search the web for market information using available search providers.
 */
async function searchWeb(query: string, limit = 5): Promise<WebSearchResult[]> {
  // Try SerpAPI first
  const serpApiKey = process.env.SERPAPI_KEY;
  if (serpApiKey) {
    try {
      const url = new URL('https://serpapi.com/search.json');
      url.searchParams.set('engine', 'google');
      url.searchParams.set('q', query);
      url.searchParams.set('num', String(limit));
      url.searchParams.set('api_key', serpApiKey);

      const response = await fetch(url.toString());
      if (response.ok) {
        const data = (await response.json()) as {
          organic_results?: Array<{
            title?: string;
            link?: string;
            snippet?: string;
          }>;
        };
        return (data.organic_results ?? []).slice(0, limit).map((item) => ({
          title: item.title ?? '',
          url: item.link ?? '',
          snippet: item.snippet ?? '',
        }));
      }
    } catch {
      // Fall through to Brave
    }
  }

  // Try Brave Search
  const braveApiKey = process.env.BRAVE_API_KEY;
  if (braveApiKey) {
    try {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(limit));

      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': braveApiKey,
        },
      });

      if (response.ok) {
        const data = (await response.json()) as {
          web?: {
            results?: Array<{
              title?: string;
              url?: string;
              description?: string;
            }>;
          };
        };
        return (data.web?.results ?? []).slice(0, limit).map((item) => ({
          title: item.title ?? '',
          url: item.url ?? '',
          snippet: item.description ?? '',
        }));
      }
    } catch {
      // No more fallbacks
    }
  }

  return [];
}

/**
 * Use LLM to extract market information from web search results.
 */
async function extractMarketFromSearchResults(
  config: ThufirConfig,
  marketId: string,
  searchResults: WebSearchResult[]
): Promise<MarketCacheRecord | null> {
  if (searchResults.length === 0) {
    return null;
  }

  const llm = createLlmClient(config);

  const context = searchResults
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.url}`)
    .join('\n\n');

  const prompt = `You are extracting prediction market information from web search results.

Market ID: ${marketId}

Search Results:
${context}

Based on these search results, extract information about this prediction market. If the search results don't contain relevant information about this specific market, respond with: {"found": false}

If you find relevant information, respond with a JSON object:
{
  "found": true,
  "question": "The market question (what is being predicted)",
  "description": "Brief description or context about the market",
  "outcomes": ["YES", "NO"] or list of possible outcomes,
  "category": "Category like politics, sports, crypto, etc.",
  "endDate": "ISO date string if mentioned, or null",
  "resolved": false,
  "resolution": null
}

Respond ONLY with valid JSON, no other text.`;

  try {
    const response = await llm.complete([
      { role: 'user', content: prompt },
    ], { temperature: 0, maxTokens: 500 });

    const text = response.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      found: boolean;
      question?: string;
      description?: string;
      outcomes?: string[];
      category?: string;
      endDate?: string | null;
      resolved?: boolean;
      resolution?: string | null;
    };

    if (!parsed.found || !parsed.question) {
      return null;
    }

    return {
      id: marketId,
      question: parsed.question,
      description: parsed.description ?? null,
      outcomes: parsed.outcomes ?? ['YES', 'NO'],
      prices: { YES: 0.5, NO: 0.5 }, // Unknown prices default to 50/50
      volume: null,
      liquidity: null,
      endDate: parsed.endDate ?? null,
      category: parsed.category ?? null,
      resolved: parsed.resolved ?? false,
      resolution: parsed.resolution ?? null,
      createdAt: null,
    };
  } catch {
    return null;
  }
}

/**
 * Discover market information via web search when the subgraph is unavailable.
 * This function searches the web for the market and uses LLM to extract details.
 */
export async function discoverMarketFromWeb(
  config: ThufirConfig,
  marketId: string
): Promise<MarketCacheRecord | null> {
  // Build search queries - try multiple approaches
  const queries = [
    `augur turbo market ${marketId}`,
    `prediction market "${marketId}"`,
    `augur ${marketId} prediction`,
  ];

  for (const query of queries) {
    const searchResults = await searchWeb(query, 5);
    if (searchResults.length === 0) {
      continue;
    }

    const market = await extractMarketFromSearchResults(config, marketId, searchResults);
    if (market) {
      // Cache the discovered market for future lookups
      upsertMarketCache(market);
      return market;
    }
  }

  return null;
}

/**
 * Search for markets matching a query via web search.
 * Useful when the cache is empty and subgraph is unavailable.
 */
export async function searchMarketsFromWeb(
  config: ThufirConfig,
  query: string,
  limit = 10
): Promise<MarketCacheRecord[]> {
  const searchQueries = [
    `augur turbo ${query} prediction market`,
    `${query} prediction market odds`,
  ];

  const llm = createLlmClient(config);
  const discovered: MarketCacheRecord[] = [];

  for (const searchQuery of searchQueries) {
    if (discovered.length >= limit) break;

    const searchResults = await searchWeb(searchQuery, 10);
    if (searchResults.length === 0) continue;

    const context = searchResults
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`)
      .join('\n\n');

    const prompt = `You are extracting prediction market information from web search results.

Search query: "${query}"

Search Results:
${context}

Extract any prediction markets mentioned in these results. For each market found, provide:
- A unique identifier (can be derived from the market question)
- The market question
- Brief description
- Category

Respond with a JSON array of markets:
[
  {
    "id": "unique-id-or-slug",
    "question": "Market question",
    "description": "Brief description",
    "category": "Category"
  }
]

If no relevant markets found, respond with: []

Respond ONLY with valid JSON array, no other text.`;

    try {
      const response = await llm.complete([
        { role: 'user', content: prompt },
      ], { temperature: 0, maxTokens: 1000 });

      const text = response.content.trim();
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        id?: string;
        question?: string;
        description?: string;
        category?: string;
      }>;

      for (const item of parsed) {
        if (!item.question || discovered.length >= limit) continue;

        const marketRecord: MarketCacheRecord = {
          id: item.id ?? `web-${Date.now()}-${discovered.length}`,
          question: item.question,
          description: item.description ?? null,
          outcomes: ['YES', 'NO'],
          prices: { YES: 0.5, NO: 0.5 },
          volume: null,
          liquidity: null,
          endDate: null,
          category: item.category ?? null,
          resolved: false,
          resolution: null,
          createdAt: null,
        };

        // Cache for future lookups
        upsertMarketCache(marketRecord);
        discovered.push(marketRecord);
      }
    } catch {
      // Continue to next query
    }
  }

  return discovered;
}
