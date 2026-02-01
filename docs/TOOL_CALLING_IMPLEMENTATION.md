# Tool Calling Implementation Plan

## Status: Implemented
**Created:** 2026-01-27
**Priority:** Critical - Blocking agent functionality

---

## Problem Statement

Thufir's LLM cannot invoke tools. The system prompt tells the agent it has tools, but:

1. No `tools` parameter is passed to `messages.create()`
2. No agentic loop handles `tool_use` → `tool_result` cycles
3. Context is injected automatically but the LLM doesn't know how to request more

**Current behavior:** Tool calling is implemented for Anthropic and OpenAI (fallback on rate limits).

**Desired behavior:** The LLM can call tools like `intel.search`, `market.search`, and receive results.

---

## Current Architecture

### LLM Client (`src/core/llm.ts`)

```
AnthropicClient.complete()
  → client.messages.create({ model, max_tokens, system, messages })
  → Returns text response only
```

**Implemented:**
- `tools` parameter in API call
- `tool_use` block handling
- `tool_result` message construction
- Agentic loop (repeat until no tool calls)

### Tool Registry (`src/core/tools.ts`)

Tools are defined:
- `market.get` - Get market by ID
- `market.search` - Search markets by query
- `intel.search` - Search intel store
- `intel.recent` - Get recent intel
- `intel.semantic` - Semantic search (if embeddings enabled)
- `calibration.summary` - Get calibration stats

**These tools are now exposed to the LLM.**

### Conversation Handler (`src/core/conversation.ts`)

Currently:
- Injects context via `buildIntelContext()`, `buildSemanticIntelContext()`
- Auto-searches markets via `extractSearchTopics()` regex
- LLM cannot request additional searches

---

## How Clawdbot Does It

Clawdbot uses `@mariozechner/pi-agent-core` library:

```
1. Define tools as AgentTool objects
2. Call streamSimple() with tools
3. Library handles:
   - Sending tools to LLM
   - Receiving tool_use blocks
   - Executing tool handlers
   - Sending tool_result back
   - Looping until text-only response
```

**We will NOT use pi-agent-core** - instead, implement native Anthropic tool calling.

---

## Implementation Plan

### Phase 1: Tool Schema Definition (Complete)

**File:** `src/core/tool-schemas.ts` (new)

Define Anthropic-compatible tool schemas for each tool:

```typescript
import type { Tool } from '@anthropic-ai/sdk/resources/messages';

export const THUFIR_TOOLS: Tool[] = [
  {
    name: 'market_search',
    description: 'Search for prediction markets on Polymarket by query. Use this when the user asks about a topic and you want to find relevant markets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'The search query (e.g., "Trump", "Fed rates", "Bitcoin price")'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 5, max: 20)'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'market_get',
    description: 'Get detailed information about a specific prediction market by its ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        market_id: {
          type: 'string',
          description: 'The Polymarket market ID'
        }
      },
      required: ['market_id']
    }
  },
  {
    name: 'intel_search',
    description: 'Search the intel/news database for information about a topic. Returns recent news articles and data.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query for intel'
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 5)'
        },
        from_days: {
          type: 'number',
          description: 'Only search within last N days (default: 14)'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'intel_recent',
    description: 'Get the most recent intel/news items. Use when user asks "what\'s new" or wants latest updates.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Number of items (default: 10)'
        }
      },
      required: []
    }
  },
  {
    name: 'calibration_stats',
    description: 'Get the user\'s prediction calibration statistics. Shows accuracy, Brier score, and track record.',
    input_schema: {
      type: 'object' as const,
      properties: {
        domain: {
          type: 'string',
          description: 'Filter by domain (e.g., "politics", "crypto"). Omit for all domains.'
        }
      },
      required: []
    }
  }
];
```

**Tasks:**
- [x] Create `src/core/tool-schemas.ts`
- [x] Define all 5 tool schemas with proper descriptions
- [x] Export `THUFIR_TOOLS` array

---

### Phase 2: Tool Executor (Complete)

**File:** `src/core/tool-executor.ts` (new)

Create executor that maps tool names to handlers:

```typescript
import type { ThufirConfig } from './config.js';
import type { PolymarketMarketClient, Market } from '../execution/polymarket/markets.js';
import { searchIntel, listRecentIntel, type StoredIntel } from '../intel/store.js';
import { listCalibrationSummaries } from '../memory/calibration.js';

export interface ToolExecutorContext {
  config: ThufirConfig;
  marketClient: PolymarketMarketClient;
}

export type ToolResult =
  | { success: true; data: unknown }
  | { success: false; error: string };

export async function executeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'market_search': {
        const query = String(toolInput.query ?? '');
        const limit = Math.min(Number(toolInput.limit ?? 5), 20);
        const markets = await ctx.marketClient.searchMarkets(query, limit);
        return { success: true, data: formatMarketsForTool(markets) };
      }

      case 'market_get': {
        const marketId = String(toolInput.market_id ?? '');
        const market = await ctx.marketClient.getMarket(marketId);
        return { success: true, data: formatMarketForTool(market) };
      }

      case 'intel_search': {
        const query = String(toolInput.query ?? '');
        const limit = Number(toolInput.limit ?? 5);
        const fromDays = Number(toolInput.from_days ?? 14);
        const items = searchIntel({ query, limit, fromDays });
        return { success: true, data: formatIntelForTool(items) };
      }

      case 'intel_recent': {
        const limit = Number(toolInput.limit ?? 10);
        const items = listRecentIntel(limit);
        return { success: true, data: formatIntelForTool(items) };
      }

      case 'calibration_stats': {
        const domain = toolInput.domain ? String(toolInput.domain) : undefined;
        const summaries = listCalibrationSummaries();
        const filtered = domain
          ? summaries.filter(s => s.domain === domain)
          : summaries;
        return { success: true, data: filtered };
      }

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

function formatMarketsForTool(markets: Market[]): object[] {
  return markets.map(m => ({
    id: m.id,
    question: m.question,
    outcomes: m.outcomes,
    yes_price: m.prices['Yes'] ?? m.prices['YES'] ?? m.prices[0],
    no_price: m.prices['No'] ?? m.prices['NO'] ?? m.prices[1],
    volume: m.volume,
    category: m.category
  }));
}

function formatMarketForTool(market: Market): object {
  return {
    id: market.id,
    question: market.question,
    description: market.description,
    outcomes: market.outcomes,
    yes_price: market.prices['Yes'] ?? market.prices['YES'] ?? market.prices[0],
    no_price: market.prices['No'] ?? market.prices['NO'] ?? market.prices[1],
    volume: market.volume,
    liquidity: market.liquidity,
    category: market.category,
    end_date: market.endDate,
    resolved: market.resolved
  };
}

function formatIntelForTool(items: StoredIntel[]): object[] {
  return items.map(item => ({
    id: item.id,
    title: item.title,
    source: item.source,
    timestamp: item.timestamp,
    url: item.url,
    summary: item.content?.slice(0, 500)
  }));
}
```

**Tasks:**
- [x] Create `src/core/tool-executor.ts`
- [x] Implement all 5 tool handlers
- [x] Add proper error handling
- [x] Format outputs for LLM consumption
- [x] Write unit tests

---

### Phase 3: Agentic LLM Client (Complete)

**File:** `src/core/llm.ts` (modify)

Add new `AgenticAnthropicClient` class:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlock, ToolUseBlock, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { THUFIR_TOOLS } from './tool-schemas.js';
import { executeToolCall, type ToolExecutorContext } from './tool-executor.js';

export interface AgenticLlmOptions {
  maxToolCalls?: number;  // Limit iterations (default: 10)
  temperature?: number;
}

export class AgenticAnthropicClient implements LlmClient {
  private client: Anthropic;
  private model: string;
  private toolContext: ToolExecutorContext;

  constructor(config: ThufirConfig, toolContext: ToolExecutorContext) {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
    this.model = config.agent.model;
    this.toolContext = toolContext;
  }

  async complete(
    messages: ChatMessage[],
    options?: AgenticLlmOptions
  ): Promise<LlmResponse> {
    const maxIterations = options?.maxToolCalls ?? 10;
    const temperature = options?.temperature ?? 0.2;

    // Convert to Anthropic format
    const system = messages.find(m => m.role === 'system')?.content ?? '';
    let anthropicMessages: MessageParam[] = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      // Call API with tools
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        temperature,
        system,
        messages: anthropicMessages,
        tools: THUFIR_TOOLS,
      });

      // Check if response contains tool use
      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use'
      );

      // If no tool calls, we're done - return text
      if (toolUseBlocks.length === 0) {
        const text = response.content
          .filter(block => block.type === 'text')
          .map(block => (block as { type: 'text'; text: string }).text)
          .join('')
          .trim();

        return { content: text, model: this.model };
      }

      // Execute each tool call
      const toolResults: ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        const result = await executeToolCall(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
          this.toolContext
        );

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result.success ? result.data : { error: result.error }),
          is_error: !result.success,
        });
      }

      // Add assistant's response (with tool_use) to messages
      anthropicMessages.push({
        role: 'assistant',
        content: response.content,
      });

      // Add tool results as user message
      anthropicMessages.push({
        role: 'user',
        content: toolResults,
      });
    }

    // Max iterations reached
    return {
      content: 'I was unable to complete the request within the allowed number of steps.',
      model: this.model,
    };
  }
}
```

**Tasks:**
- [x] Add `AgenticAnthropicClient` class to `llm.ts`
- [x] Add `AgenticOpenAiClient` class to `llm.ts`
- [x] Handle `tool_use` blocks in response
- [x] Execute tools and build `tool_result` messages
- [x] Implement iteration loop with max limit

---

### Phase 4: Update Conversation Handler (Complete)

**File:** `src/core/conversation.ts` (modify)

Update to use agentic client:

```typescript
// In ConversationHandler constructor
constructor(
  llm: LlmClient,
  marketClient: PolymarketMarketClient,
  config: ThufirConfig,
  infoLlm?: LlmClient
) {
  // Create agentic client with tool context
  this.agenticLlm = new AgenticAnthropicClient(config, {
    config,
    marketClient,
  });
  // ... rest of constructor
}

// In chat() method
async chat(userId: string, message: string): Promise<string> {
  // ... existing context building ...

  // Use agentic client instead of basic client
  const response = await this.agenticLlm.complete(messages, {
    temperature: 0.7,
    maxToolCalls: 5  // Limit tool iterations for chat
  });

  // ... rest of method
}
```

**Tasks:**
- [x] Update `ConversationHandler` to use `AgenticAnthropicClient`
- [x] Update `ConversationHandler` to use `AgenticOpenAiClient` when configured
- [x] Pass `ToolExecutorContext` to client
- [x] Remove `extractSearchTopics()` auto-search (LLM can now search itself)
- [x] Update system prompt to explain tool usage

---

### Phase 5: Update System Prompt (Complete)

**File:** `src/core/conversation.ts` (modify SYSTEM_PROMPT)

Replace the misleading "Available tools" section:

```typescript
const SYSTEM_PROMPT = `You are Thufir, an AI prediction market companion...

## Tools Available

You have access to the following tools. Use them when helpful:

### market_search
Search for prediction markets by topic. Use when discussing events to find relevant markets.
Example: If user asks "What are the odds Trump wins?", search for "Trump president"

### market_get
Get detailed info about a specific market by ID. Use after search to get more details.

### intel_search
Search news and intel database. Use to find recent information about topics.

### intel_recent
Get latest news items. Use when user asks "what's happening" or wants updates.

### calibration_stats
Get user's prediction track record. Use when discussing accuracy or past performance.

## When to use tools
- Use market_search when discussing any future event to check if there's a market
- Use intel_search before making predictions to get current information
- Use intel_recent for daily briefings or "what's new" requests
- Use calibration_stats when discussing prediction accuracy

## Response format
- Be conversational, not robotic
- Cite specific data from tool results
- If a tool returns no results, acknowledge it
- Don't pretend to have information you don't have
`;
```

**Tasks:**
- [x] Rewrite `SYSTEM_PROMPT` with accurate tool descriptions
- [x] Add guidance on when to use each tool
- [x] Remove references to "automatic" context injection

---

### Phase 6: Agent Integration (Complete)

**File:** `src/core/agent.ts` (modify)

Update `ThufirAgent` to pass context to conversation handler:

```typescript
constructor(private config: ThufirConfig, logger?: Logger) {
  // ... existing setup ...

  // Create tool context
  this.toolContext = {
    config: this.config,
    marketClient: this.marketClient,
  };

  // Update conversation handler initialization
  this.conversation = new ConversationHandler(
    this.llm,
    this.marketClient,
    this.config,
    this.infoLlm,
    this.toolContext  // NEW: pass tool context
  );
}
```

**Tasks:**
- [x] Create and pass `ToolExecutorContext` in agent
- [ ] E2E test with deployed agent

---

### Phase 7: Testing (In Progress)

**File:** `tests/tool-calling.test.ts` (new)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeToolCall } from '../src/core/tool-executor.js';
import { THUFIR_TOOLS } from '../src/core/tool-schemas.js';

describe('Tool Schemas', () => {
  it('should have valid JSON schema for all tools', () => {
    for (const tool of THUFIR_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema.type).toBe('object');
    }
  });
});

describe('Tool Executor', () => {
  const mockContext = {
    config: { /* mock config */ },
    marketClient: {
      searchMarkets: vi.fn().mockResolvedValue([]),
      getMarket: vi.fn().mockResolvedValue({}),
    },
  };

  it('should execute market_search', async () => {
    const result = await executeToolCall(
      'market_search',
      { query: 'bitcoin', limit: 5 },
      mockContext as any
    );
    expect(result.success).toBe(true);
    expect(mockContext.marketClient.searchMarkets).toHaveBeenCalledWith('bitcoin', 5);
  });

  it('should handle unknown tools', async () => {
    const result = await executeToolCall('unknown_tool', {}, mockContext as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });
});

describe('Agentic LLM Client', () => {
  // Integration tests with mock Anthropic API
  it('should handle single tool call cycle', async () => {
    // Test: API returns tool_use → execute → API returns text
  });

  it('should handle multiple tool calls in sequence', async () => {
    // Test: API returns tool_use → execute → API returns another tool_use → execute → text
  });

  it('should respect max iterations', async () => {
    // Test: Stop after maxToolCalls iterations
  });
});
```

**Tasks:**
- [x] Unit tests for tool schemas
- [x] Unit tests for tool executor
- [x] OpenAI agentic tool loop test
- [ ] Integration tests for agentic Anthropic client
- [ ] E2E test with real API (manual)

---

### Phase 8: Logging & Debugging (Optional)

**File:** `src/core/tool-executor.ts` (modify)

Add logging:

```typescript
import { Logger } from './logger.js';

const log = new Logger('tools');

export async function executeToolCall(...) {
  log.debug(`Executing tool: ${toolName}`, { input: toolInput });

  const startTime = Date.now();
  const result = await executeToolCallInternal(...);
  const duration = Date.now() - startTime;

  if (result.success) {
    log.debug(`Tool ${toolName} completed in ${duration}ms`);
  } else {
    log.warn(`Tool ${toolName} failed: ${result.error}`);
  }

  return result;
}
```

**Tasks:**
- [ ] Add debug logging for tool calls
- [ ] Log tool inputs (sanitized)
- [ ] Log tool results (truncated)
- [ ] Add timing information
- [ ] Environment variable to enable verbose logging

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/core/tool-schemas.ts` | CREATE | Anthropic tool definitions |
| `src/core/tool-executor.ts` | CREATE | Tool call execution logic |
| `src/core/llm.ts` | MODIFY | Add agentic Anthropic/OpenAI clients |
| `src/core/conversation.ts` | MODIFY | Use agentic client, update prompt |
| `src/core/agent.ts` | MODIFY | Pass tool context |
| `tests/tool-calling.test.ts` | CREATE | Test suite |

---

## Rollout Plan

### Step 1: Schema + Executor (Done)
- Create tool-schemas.ts
- Create tool-executor.ts
- Unit tests

### Step 2: Agentic Client (Done)
- Add AgenticAnthropicClient
- Handle tool_use/tool_result cycle
- Integration tests

### Step 3: Integration (Done)
- Update ConversationHandler
- Update system prompt
- Update agent.ts

### Step 4: Testing (In Progress)
- E2E testing
- Fix issues
- Performance testing

### Step 5: Deploy (Pending)
- Deploy to staging
- Test with real API
- Monitor logs
- Deploy to production

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Tool calls increase API costs | High | Medium | Set maxToolCalls limit, monitor usage |
| Infinite tool call loops | Medium | High | Max iteration limit, timeout |
| Tool errors crash conversation | Medium | Medium | Try-catch in executor, graceful fallback |
| Model ignores tools | Low | Medium | Update system prompt, test prompting |

---

## Success Criteria

- [x] LLM can successfully call `market_search` and use results (unit tests)
- [ ] LLM can chain multiple tool calls (search → get details)
- [x] Tool errors are handled gracefully (unit tests)
- [ ] No regression in conversation quality
- [ ] API costs increase <30% for typical conversations

---

## Phase 9: Real-Time Twitter Search Tool (Complete)

### Problem

Current intel tools (`intel_search`, `intel_recent`) only search **stored** content from the intel database. Twitter data requires running `/intel` first, which fetches and stores tweets. The LLM cannot search Twitter in real-time.

### Solution

Add a `twitter_search` tool with hybrid approach:
1. **Primary**: Twitter API v2 (free, 7-day range, 450 req/15min)
2. **Fallback**: SerpAPI (100 free/month, unlimited time range)

### Why This Approach

| Factor | Twitter API v2 | SerpAPI |
|--------|---------------|---------|
| Cost | Free | 100/mo free, then $50/mo |
| Time range | 7 days | Unlimited |
| Rate limit | 450/15min | 100/mo (free) |
| Reliability | Medium | High |
| Best for | Recent sentiment | Historical data |

For prediction markets, **7 days is usually sufficient** - recent sentiment drives market prices.

### Implementation

#### 9.1 Add Tool Schema

**File:** `src/core/tool-schemas.ts`

```typescript
{
  name: 'twitter_search',
  description: 'Search Twitter/X for recent tweets about a topic. Use for real-time sentiment and breaking news. Returns tweets from the last 7 days.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (e.g., "polymarket", "Fed rates", "Trump trial")'
      },
      limit: {
        type: 'number',
        description: 'Max tweets to return (default: 10, max: 100)'
      }
    },
    required: ['query']
  }
}
```

#### 9.2 Add Tool Executor

**File:** `src/core/tool-executor.ts`

```typescript
case 'twitter_search': {
  const query = String(toolInput.query ?? '');
  const limit = Math.min(Number(toolInput.limit ?? 10), 100);

  // Try Twitter API v2 first
  const twitterResult = await searchTwitterDirect(query, limit);
  if (twitterResult.success) {
    return twitterResult;
  }

  // Fallback to SerpAPI
  const serpResult = await searchTwitterViaSerpApi(query, limit);
  return serpResult;
}

async function searchTwitterDirect(
  query: string,
  limit: number
): Promise<ToolResult> {
  const bearer = process.env.TWITTER_BEARER;
  if (!bearer) {
    return { success: false, error: 'Twitter API not configured' };
  }

  try {
    const url = new URL('https://api.twitter.com/2/tweets/search/recent');
    url.searchParams.set('query', `${query} -is:retweet lang:en`);
    url.searchParams.set('max_results', String(Math.max(10, limit)));
    url.searchParams.set('tweet.fields', 'created_at,author_id,public_metrics');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'username,name');

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${bearer}` }
    });

    if (!response.ok) {
      return { success: false, error: `Twitter API: ${response.status}` };
    }

    const data = await response.json() as {
      data?: Array<{
        id: string;
        text: string;
        created_at?: string;
        author_id?: string;
        public_metrics?: {
          like_count: number;
          retweet_count: number;
          reply_count: number;
        };
      }>;
      includes?: {
        users?: Array<{ id: string; username: string; name: string }>;
      };
    };

    const users = new Map(
      (data.includes?.users ?? []).map(u => [u.id, u])
    );

    const tweets = (data.data ?? []).map(tweet => ({
      id: tweet.id,
      text: tweet.text,
      created_at: tweet.created_at,
      author: users.get(tweet.author_id ?? '')?.username ?? 'unknown',
      likes: tweet.public_metrics?.like_count ?? 0,
      retweets: tweet.public_metrics?.retweet_count ?? 0,
      url: `https://twitter.com/i/status/${tweet.id}`
    }));

    return { success: true, data: tweets };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

async function searchTwitterViaSerpApi(
  query: string,
  limit: number
): Promise<ToolResult> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return { success: false, error: 'SerpAPI not configured' };
  }

  try {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'twitter');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      return { success: false, error: `SerpAPI: ${response.status}` };
    }

    const data = await response.json() as {
      tweets?: Array<{
        text: string;
        user: { screen_name: string };
        created_at: string;
        likes: number;
        retweets: number;
        link: string;
      }>;
    };

    const tweets = (data.tweets ?? []).slice(0, limit).map(tweet => ({
      text: tweet.text,
      author: tweet.user?.screen_name ?? 'unknown',
      created_at: tweet.created_at,
      likes: tweet.likes ?? 0,
      retweets: tweet.retweets ?? 0,
      url: tweet.link
    }));

    return { success: true, data: tweets };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}
```

#### 9.3 Update System Prompt

Add to `SYSTEM_PROMPT` in `src/core/conversation.ts`:

```
### twitter_search
Search Twitter/X for real-time tweets about a topic. Use for:
- Breaking news and live events
- Current sentiment about markets
- What people are saying right now
Returns tweets from the last 7 days.
```

### Environment Variables Required

```bash
# Already in .env
TWITTER_BEARER=...   # Twitter API v2 Bearer Token
SERPAPI_KEY=...      # SerpAPI key (fallback)
```

### Rate Limits

| API | Limit | Reset |
|-----|-------|-------|
| Twitter API v2 | 450 requests | Per 15 minutes |
| SerpAPI (free) | 100 requests | Per month |

### Usage Examples

The LLM can now:
```
User: "What's the sentiment on Trump's trial?"
LLM: [calls twitter_search with query "Trump trial"]
     → Gets real-time tweets
     → Analyzes sentiment
     → Relates to prediction markets
```

### Deliverables

- [x] Add `twitter_search` to tool schemas
- [x] Implement `searchTwitterDirect()` function
- [x] Implement `searchTwitterViaSerpApi()` fallback
- [x] Update system prompt
- [x] Add tests for Twitter search tool (3 tests)
- [x] Handle rate limit errors gracefully (falls back to SerpAPI)

---

## Next: Web Tools (Phase 10 & 11)

See [WEB_TOOLS_IMPLEMENTATION.md](./WEB_TOOLS_IMPLEMENTATION.md) for:
- **Phase 10:** `web_search` - Search the web via SerpAPI/Brave
- **Phase 11:** `web_fetch` - Fetch and extract web page content
