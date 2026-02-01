# Web Tools Implementation Plan

## Status: Planned
**Created:** 2026-01-27
**Priority:** High - Enhances agent research capabilities

---

## Overview

Add two web tools to give Thufir real-time internet access:

| Tool | Purpose | Provider |
|------|---------|----------|
| `web_search` | Search the web for information | SerpAPI (primary) + Brave (fallback) |
| `web_fetch` | Fetch and extract web page content | Direct fetch + Readability |

---

## Phase 10: Web Search Tool

### Problem

The agent can only search:
- Polymarket markets (`market_search`)
- Stored intel database (`intel_search`)
- Twitter (`twitter_search`)

It cannot search the general web for news, research, or context.

### Solution

Add `web_search` tool with dual provider support:
1. **SerpAPI** (primary) - You already have `SERPAPI_KEY`, 100 free searches/month
2. **Brave Search** (fallback) - 2,000 free queries/month

### Implementation

#### 10.1 Add Tool Schema

**File:** `src/core/tool-schemas.ts`

```typescript
{
  name: 'web_search',
  description: 'Search the web for information. Use for research, news, facts, or context not available in other tools.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (e.g., "Fed interest rate decision January 2026")'
      },
      limit: {
        type: 'number',
        description: 'Maximum results (default: 5, max: 10)'
      }
    },
    required: ['query']
  }
}
```

#### 10.2 Add Tool Executor

**File:** `src/core/tool-executor.ts`

```typescript
case 'web_search': {
  const query = String(toolInput.query ?? '').trim();
  const limit = Math.min(Math.max(Number(toolInput.limit ?? 5), 1), 10);
  if (!query) {
    return { success: false, error: 'Missing query' };
  }

  // Try SerpAPI first (you have this key)
  const serpResult = await searchWebViaSerpApi(query, limit);
  if (serpResult.success) {
    return serpResult;
  }

  // Fallback to Brave Search
  const braveResult = await searchWebViaBrave(query, limit);
  if (braveResult.success) {
    return braveResult;
  }

  return {
    success: false,
    error: `Web search failed: SerpAPI: ${serpResult.error}. Brave: ${braveResult.error}`,
  };
}

async function searchWebViaSerpApi(
  query: string,
  limit: number
): Promise<ToolResult> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return { success: false, error: 'SerpAPI key not configured' };
  }

  try {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(limit));
    url.searchParams.set('api_key', apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      return { success: false, error: `SerpAPI: ${response.status}` };
    }

    const data = (await response.json()) as {
      organic_results?: Array<{
        title?: string;
        link?: string;
        snippet?: string;
        date?: string;
        source?: string;
      }>;
    };

    const results = (data.organic_results ?? []).slice(0, limit).map((r) => ({
      title: r.title ?? '',
      url: r.link ?? '',
      snippet: r.snippet ?? '',
      date: r.date ?? null,
      source: r.source ?? null,
    }));

    return { success: true, data: { query, provider: 'serpapi', results } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

async function searchWebViaBrave(
  query: string,
  limit: number
): Promise<ToolResult> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'Brave API key not configured' };
  }

  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));

    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!response.ok) {
      return { success: false, error: `Brave: ${response.status}` };
    }

    const data = (await response.json()) as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          age?: string;
        }>;
      };
    };

    const results = (data.web?.results ?? []).slice(0, limit).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
      date: r.age ?? null,
    }));

    return { success: true, data: { query, provider: 'brave', results } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}
```

### Environment Variables

```bash
# Already have
SERPAPI_KEY=...

# Optional (for fallback)
BRAVE_API_KEY=...   # Get from https://brave.com/search/api/
```

### Rate Limits

| Provider | Free Tier | Paid |
|----------|-----------|------|
| SerpAPI | 100/month | $50/mo for 5,000 |
| Brave | 2,000/month | $5/mo for 20,000 |

---

## Phase 11: Web Fetch Tool

### Problem

The agent can search the web but cannot read full web page content. When it finds a relevant URL, it cannot extract the actual content.

### Solution

Add `web_fetch` tool that:
1. Fetches URL content
2. Converts HTML to readable markdown/text
3. Truncates to reasonable size for LLM context

### Implementation

#### 11.1 Add Tool Schema

**File:** `src/core/tool-schemas.ts`

```typescript
{
  name: 'web_fetch',
  description: 'Fetch and extract content from a web page URL. Returns readable text/markdown. Use after web_search to read full articles.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch (must be http or https)'
      },
      max_chars: {
        type: 'number',
        description: 'Maximum characters to return (default: 10000, max: 50000)'
      }
    },
    required: ['url']
  }
}
```

#### 11.2 Add Dependencies

```bash
pnpm add @mozilla/readability jsdom
pnpm add -D @types/jsdom
```

#### 11.3 Add Tool Executor

**File:** `src/core/tool-executor.ts`

```typescript
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

case 'web_fetch': {
  const url = String(toolInput.url ?? '').trim();
  const maxChars = Math.min(Math.max(Number(toolInput.max_chars ?? 10000), 100), 50000);

  if (!url) {
    return { success: false, error: 'Missing URL' };
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { success: false, error: 'URL must start with http:// or https://' };
  }

  return fetchAndExtract(url, maxChars);
}

async function fetchAndExtract(
  url: string,
  maxChars: number
): Promise<ToolResult> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Thufir/1.0; +https://github.com/thufir)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return { success: false, error: `Fetch failed: ${response.status}` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      // Not HTML - return raw text truncated
      const text = await response.text();
      return {
        success: true,
        data: {
          url,
          title: null,
          content: text.slice(0, maxChars),
          truncated: text.length > maxChars,
        },
      };
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) {
      // Readability failed - return raw text
      const text = dom.window.document.body?.textContent ?? '';
      const cleaned = text.replace(/\s+/g, ' ').trim();
      return {
        success: true,
        data: {
          url,
          title: dom.window.document.title ?? null,
          content: cleaned.slice(0, maxChars),
          truncated: cleaned.length > maxChars,
        },
      };
    }

    const content = article.textContent.replace(/\s+/g, ' ').trim();
    return {
      success: true,
      data: {
        url,
        title: article.title ?? null,
        byline: article.byline ?? null,
        content: content.slice(0, maxChars),
        truncated: content.length > maxChars,
        length: article.length,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}
```

### Security Considerations

1. **SSRF Protection** - Only allow http/https URLs
2. **Timeout** - Add fetch timeout (10s default)
3. **Size Limit** - Limit response size before parsing
4. **Domain Blocklist** - Optional blocklist for internal IPs

```typescript
// Add timeout
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10000);

const response = await fetch(url, {
  signal: controller.signal,
  // ...
});

clearTimeout(timeout);
```

---

## System Prompt Updates

**File:** `src/core/conversation.ts`

Add to SYSTEM_PROMPT:

```
### web_search
Search the web for information, news, research, or facts. Use when you need current information not available in other tools.

### web_fetch
Fetch and read content from a web page URL. Use after web_search to read full articles or when given a URL to analyze.
```

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/core/tool-schemas.ts` | MODIFY | Add `web_search` and `web_fetch` schemas |
| `src/core/tool-executor.ts` | MODIFY | Add handlers and helper functions |
| `src/core/conversation.ts` | MODIFY | Update system prompt |
| `package.json` | MODIFY | Add `@mozilla/readability`, `jsdom` |
| `tests/tool-calling-web.test.ts` | CREATE | Tests for web tools |

---

## Deliverables

### Phase 10: Web Search
- [ ] Add `web_search` tool schema
- [ ] Implement `searchWebViaSerpApi()` function
- [ ] Implement `searchWebViaBrave()` fallback
- [ ] Update system prompt
- [ ] Add tests

### Phase 11: Web Fetch
- [ ] Add `web_fetch` tool schema
- [ ] Install `@mozilla/readability` and `jsdom`
- [ ] Implement `fetchAndExtract()` function
- [ ] Add timeout and SSRF protection
- [ ] Update system prompt
- [ ] Add tests

---

## Usage Examples

### Web Search
```
User: "What's the latest news on the Fed?"
LLM: [calls web_search with query "Federal Reserve news January 2026"]
     → Gets search results with titles, URLs, snippets
     → Summarizes findings for user
```

### Web Fetch
```
User: "Can you read this article? https://example.com/fed-decision"
LLM: [calls web_fetch with url]
     → Gets extracted article content
     → Analyzes and summarizes
```

### Combined
```
User: "Research the latest on AI regulation"
LLM: [calls web_search for "AI regulation 2026"]
     → Gets top results
     [calls web_fetch on most relevant URL]
     → Gets full article content
     → Provides comprehensive analysis
```

---

## After Implementation

Thufir will have **8 tools**:

| Tool | Purpose |
|------|---------|
| `market_search` | Search Polymarket |
| `market_get` | Get market details |
| `intel_search` | Search stored intel |
| `intel_recent` | Get recent intel |
| `calibration_stats` | User track record |
| `twitter_search` | Real-time Twitter |
| `web_search` | Search the web |
| `web_fetch` | Read web pages |
