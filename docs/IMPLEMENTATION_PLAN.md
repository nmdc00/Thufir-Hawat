# Implementation Plan

This document outlines the implementation phases for Thufir, designed for handoff to developers.

---

## Current Progress

**Last Updated:** 2026-02-01

### Completed Phases
- [x] Phase 1: Foundation - Project setup, structure, wallet security
- [x] Phase 2: Polymarket Integration - Market data, order execution
- [x] Phase 3: Memory & Predictions - Prediction storage, calibration
- [x] Phase 4: Intelligence Layer - RSS, NewsAPI, vector storage
- [x] Phase 5: Agent Reasoning - LLM integration, tool calling, orchestration
- [x] Phase 5.5: Tool Calling - Implemented and live

### In Progress
- [ ] **Phase 6: Channel Integration** - Telegram working, other channels pending
- [ ] **Agentic Orchestration UX** - plan/tool trace visibility (config) + E2E verification
- [ ] **Mentat / Black Swan Integration** - wire reports into agentic flows (config; chat + daily report + autonomous P&L) + monitoring alerts

### Blocked
- [ ] None

### Known Issues
1. **`apiBaseUrl` ignored for Anthropic provider**
   - Cause: `AnthropicClient` uses SDK directly, not custom base URL
   - This is expected behavior for Anthropic

---

## Overview

Thufir is built by combining:
1. **Clawdbot** - Multi-channel gateway and session management
2. **Polymarket Agents** - Market data and trade execution
3. **Custom layers** - Memory, calibration, and intel aggregation

## Phase 1: Foundation (Weeks 1-2)

### 1.1 Project Setup

```bash
# Fork Clawdbot
gh repo fork clawdbot/clawdbot --clone thufir
cd thufir

# Rename and rebrand
# Update package.json, README, etc.

# Add Polymarket dependencies
pnpm add @polymarket/sdk @polymarket/order-utils ethers@5

# Add vector DB
pnpm add chromadb

# Add NLP libraries
pnpm add @xenova/transformers  # For embeddings

# Dev dependencies
pnpm add -D @types/node vitest
```

### 1.2 Core Structure

Create the layer structure:

```
src/
├── core/                    # Agent brain
│   ├── agent.ts             # Main agent class
│   ├── reasoning.ts         # LLM reasoning engine
│   ├── prediction.ts        # Prediction engine
│   └── calibration.ts       # Calibration engine
│
├── intel/                   # Intelligence layer
│   ├── sources/             # Source implementations
│   │   ├── newsapi.ts
│   │   ├── twitter.ts
│   │   ├── rss.ts
│   │   └── polymarket-comments.ts
│   ├── pipeline.ts          # Processing pipeline
│   ├── vectorstore.ts       # ChromaDB wrapper
│   └── retrieval.ts         # Context retrieval
│
├── memory/                  # Persistence layer
│   ├── predictions.ts       # Prediction storage
│   ├── calibration.ts       # Calibration data
│   ├── context.ts           # User context
│   └── schema.sql           # Database schema
│
├── execution/               # Trading layer
│   ├── polymarket/          # Polymarket integration
│   │   ├── client.ts        # API client
│   │   ├── markets.ts       # Market data
│   │   └── orders.ts        # Order execution
│   ├── wallet/              # Wallet management
│   │   ├── keystore.ts      # Encrypted key storage
│   │   ├── signer.ts        # Transaction signing
│   │   ├── limits.ts        # Spending limits
│   │   └── whitelist.ts     # Address whitelist
│   └── portfolio.ts         # Portfolio tracking
│
├── interface/               # User interface
│   ├── commands/            # Chat commands
│   │   ├── predict.ts
│   │   ├── portfolio.ts
│   │   ├── calibration.ts
│   │   └── trade.ts
│   └── formatters/          # Message formatting
│       ├── market.ts
│       └── portfolio.ts
│
└── skills/                  # Thufir-specific skills
    ├── market-analysis.ts
    ├── daily-briefing.ts
    └── trade-execution.ts
```

### 1.3 Database Schema

Implement in `src/memory/schema.sql`:

```sql
-- See ARCHITECTURE.md for full schema
-- Priority tables for Phase 1:

CREATE TABLE predictions (
    id TEXT PRIMARY KEY,
    market_id TEXT NOT NULL,
    market_title TEXT NOT NULL,
    predicted_outcome TEXT,
    predicted_probability REAL,
    confidence_level TEXT,
    executed INTEGER DEFAULT 0,
    execution_price REAL,
    position_size REAL,
    reasoning TEXT,
    domain TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    outcome TEXT,
    outcome_timestamp TEXT,
    pnl REAL
);

CREATE TABLE user_context (
    user_id TEXT PRIMARY KEY,
    preferences TEXT,  -- JSON
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_predictions_domain ON predictions(domain);
CREATE INDEX idx_predictions_outcome ON predictions(outcome);
```

### 1.4 Wallet Security Layer

**CRITICAL PATH** - Must be secure from day one.

Implement in order:
1. `src/execution/wallet/whitelist.ts` - Hardcoded address whitelist
2. `src/execution/wallet/keystore.ts` - Encrypted key storage
3. `src/execution/wallet/limits.ts` - Spending limit enforcement
4. `src/execution/wallet/signer.ts` - Transaction signing

**Test cases (mandatory):**
- [ ] Cannot sign transaction to non-whitelisted address
- [ ] Cannot exceed daily spending limit
- [ ] Cannot exceed per-trade limit
- [ ] Key is never logged or exposed
- [ ] Encrypted keystore cannot be decrypted without password

### 1.5 Deliverables

- [ ] Forked and rebranded repository
- [ ] Layer structure created
- [ ] Database schema implemented
- [ ] Wallet security layer with full test coverage
- [ ] Basic CLI: `thufir wallet create`, `thufir wallet status`

---

## Phase 2: Polymarket Integration (Weeks 3-4)

### 2.1 Market Data

Implement `src/execution/polymarket/`:

```typescript
// client.ts
export class PolymarketClient {
  async getMarkets(filter?: MarketFilter): Promise<Market[]>;
  async getMarket(marketId: string): Promise<Market>;
  async getOrderBook(marketId: string): Promise<OrderBook>;
  subscribeToUpdates(marketId: string, callback: (update) => void): void;
}

// markets.ts
export interface Market {
  id: string;
  question: string;
  outcomes: string[];
  prices: { [outcome: string]: number };
  volume: number;
  liquidity: number;
  endDate: Date;
  category: string;
  resolved: boolean;
  resolution?: string;
}
```

### 2.2 Order Execution

```typescript
// orders.ts
export class OrderExecutor {
  constructor(
    private polymarket: PolymarketClient,
    private wallet: WalletManager,
    private limits: SpendingLimitEnforcer
  ) {}

  async execute(params: OrderParams): Promise<OrderResult> {
    // 1. Check spending limits
    const limitCheck = await this.limits.check(params.amount);
    if (!limitCheck.allowed) {
      throw new LimitExceededError(limitCheck.reason);
    }

    // 2. Build order
    const order = await this.polymarket.buildOrder(params);

    // 3. Verify destination is whitelisted
    if (!isWhitelisted(order.to)) {
      throw new SecurityError('Destination not whitelisted');
    }

    // 4. Sign with wallet
    const signed = await this.wallet.sign(order);

    // 5. Submit
    const result = await this.polymarket.submit(signed);

    // 6. Record spend
    await this.limits.record(params.amount);

    return result;
  }
}
```

### 2.3 Portfolio Tracking

```typescript
// portfolio.ts
export class PortfolioManager {
  async getPositions(): Promise<Position[]>;
  async getBalance(): Promise<Balance>;
  async getPnL(period: 'day' | 'week' | 'month' | 'all'): Promise<PnL>;
  async getExposure(): Promise<Exposure>;  // By domain, by market
}
```

### 2.4 Deliverables

- [ ] Polymarket API integration (read)
- [ ] Order execution with all security checks
- [ ] Portfolio tracking
- [ ] CLI: `thufir markets list`, `thufir markets show <id>`
- [ ] CLI: `thufir trade buy/sell` (with confirmation)
- [ ] CLI: `thufir portfolio`

---

## Phase 3: Memory & Predictions (Weeks 5-6)

### 3.1 Prediction Recording

```typescript
// src/memory/predictions.ts
export class PredictionStore {
  async record(prediction: Prediction): Promise<string>;
  async recordOutcome(id: string, outcome: Outcome): Promise<void>;
  async get(id: string): Promise<Prediction>;
  async list(filter?: PredictionFilter): Promise<Prediction[]>;
  async getByMarket(marketId: string): Promise<Prediction[]>;
}
```

### 3.2 Calibration Engine

```typescript
// src/core/calibration.ts
export class CalibrationEngine {
  async getStats(domain?: string): Promise<CalibrationStats>;
  async getCalibrationCurve(domain?: string): Promise<CalibrationCurve>;
  async adjustProbability(raw: number, domain: string): Promise<number>;
  async getBrierScore(domain?: string): Promise<number>;
}
```

### 3.3 Outcome Resolution

Set up a cron job to check for resolved markets:

```typescript
// src/core/resolution.ts
export class ResolutionChecker {
  // Run every hour
  async checkResolutions(): Promise<void> {
    const openPredictions = await this.predictions.list({ resolved: false });

    for (const pred of openPredictions) {
      const market = await this.polymarket.getMarket(pred.marketId);

      if (market.resolved) {
        await this.predictions.recordOutcome(pred.id, {
          outcome: market.resolution,
          timestamp: new Date(),
          pnl: this.calculatePnL(pred, market.resolution)
        });
      }
    }
  }
}
```

### 3.4 Deliverables

- [ ] Prediction storage and retrieval
- [ ] Calibration calculation and storage
- [ ] Automatic outcome resolution
- [ ] CLI: `thufir calibration show`
- [ ] CLI: `thufir predictions list`

---

## Phase 4: Intelligence Layer (Weeks 7-8)

### 4.1 Source Implementations

Implement one source at a time:

1. **RSS** (easiest, free) - `src/intel/sources/rss.ts`
2. **Polymarket comments** - `src/intel/sources/polymarket-comments.ts`
3. **NewsAPI** - `src/intel/sources/newsapi.ts`
4. **Twitter** - `src/intel/sources/twitter.ts`

### 4.2 Processing Pipeline

```typescript
// src/intel/pipeline.ts
export class IntelPipeline {
  async process(raw: RawIntel): Promise<ProcessedIntel> {
    // 1. Deduplicate
    if (await this.isDuplicate(raw)) return null;

    // 2. Clean text
    const cleaned = this.cleanText(raw.content);

    // 3. Extract entities
    const entities = await this.extractEntities(cleaned);

    // 4. Analyze sentiment
    const sentiment = await this.analyzeSentiment(cleaned);

    // 5. Generate embedding
    const embedding = await this.embed(cleaned);

    // 6. Store in vector DB
    await this.vectorStore.add({
      id: raw.id,
      content: cleaned,
      embedding,
      metadata: { entities, sentiment, source: raw.source }
    });

    return { ...raw, entities, sentiment };
  }
}
```

### 4.3 Retrieval

```typescript
// src/intel/retrieval.ts
export class IntelRetriever {
  async retrieve(query: RetrievalQuery): Promise<IntelItem[]> {
    // 1. Embed query
    const queryEmbedding = await this.embed(query.text);

    // 2. Vector search
    const results = await this.vectorStore.query({
      embedding: queryEmbedding,
      limit: query.limit,
      filter: {
        timestamp: { $gte: query.from },
        category: { $in: query.categories }
      }
    });

    // 3. Re-rank by recency and credibility
    return this.rerank(results);
  }
}
```

### 4.4 Deliverables

- [ ] RSS source implementation
- [ ] Polymarket comments source
- [ ] NewsAPI source (requires API key)
- [ ] Vector storage with ChromaDB
- [ ] Retrieval for market context
- [ ] CLI: `thufir intel status`, `thufir intel search`

---

## Phase 5: Agent Reasoning (Weeks 9-10)

### 5.1 LLM Integration

```typescript
// src/core/reasoning.ts
export class ReasoningEngine {
  constructor(
    private llm: LLMClient,  // Claude or GPT
    private intel: IntelRetriever,
    private calibration: CalibrationEngine,
    private memory: PredictionStore
  ) {}

  async analyzeMarket(market: Market): Promise<Analysis> {
    // 1. Retrieve relevant intel
    const context = await this.intel.retrieve({
      text: market.question,
      limit: 20,
      from: daysAgo(7)
    });

    // 2. Get calibration data for this domain
    const calibrationData = await this.calibration.getStats(market.category);

    // 3. Get past predictions on similar markets
    const history = await this.memory.list({
      domain: market.category,
      limit: 10
    });

    // 4. Build prompt
    const prompt = this.buildAnalysisPrompt(market, context, calibrationData, history);

    // 5. Call LLM
    const response = await this.llm.complete(prompt);

    // 6. Parse structured output
    return this.parseAnalysis(response);
  }
}
```

### 5.2 Prompt Engineering

Key prompts to develop:
- Market analysis prompt
- Daily briefing prompt
- Trade explanation prompt
- Conversation prompt

### 5.3 Tool Integration

Define tools the agent can call:
- `get_market_data(market_id)` - Fetch current market info
- `get_intel(query, limit)` - Retrieve relevant intel
- `get_calibration(domain)` - Get calibration stats
- `execute_trade(market, outcome, amount)` - Execute a trade
- `record_prediction(market, probability, reasoning)` - Record a prediction

### 5.4 Deliverables

- [ ] LLM integration (Claude primary, GPT fallback)
- [ ] Market analysis prompts
- [ ] Tool definitions
- [ ] Agent conversation loop
- [ ] CLI: `thufir chat`

---

## Phase 5.5: Tool Calling Implementation (CRITICAL)

> **Full details:** [TOOL_CALLING_IMPLEMENTATION.md](./TOOL_CALLING_IMPLEMENTATION.md)

This phase was added after discovering that the LLM cannot actually invoke tools.

### 5.5.1 Problem

The current implementation tells the LLM it has tools but doesn't implement Anthropic's tool calling API:

```typescript
// Current (broken)
const response = await this.client.messages.create({
  model, max_tokens, system, messages
  // ❌ No 'tools' parameter
});
```

### 5.5.2 Solution

Implement native Anthropic tool calling with agentic loop:

```typescript
// Fixed
const response = await this.client.messages.create({
  model, max_tokens, system, messages,
  tools: THUFIR_TOOLS,  // ✅ Pass tool definitions
});

// Handle tool_use blocks
if (response.stop_reason === 'tool_use') {
  // Execute tools, send results back, loop
}
```

### 5.5.3 New Files

| File | Purpose |
|------|---------|
| `src/core/tool-schemas.ts` | Anthropic tool definitions |
| `src/core/tool-executor.ts` | Tool execution logic |

### 5.5.4 Modified Files

| File | Changes |
|------|---------|
| `src/core/llm.ts` | Add `AgenticAnthropicClient` class |
| `src/core/conversation.ts` | Use agentic client, update system prompt |
| `src/core/agent.ts` | Pass tool context to conversation handler |

### 5.5.5 Tools to Implement

| Tool Name | Description |
|-----------|-------------|
| `market_search` | Search Polymarket for markets by query |
| `market_get` | Get detailed market info by ID |
| `intel_search` | Search news/intel database |
| `intel_recent` | Get latest news items |
| `calibration_stats` | Get user's prediction track record |

### 5.5.6 Deliverables

- [ ] Tool schema definitions
- [ ] Tool executor with error handling
- [ ] Agentic LLM client with tool loop
- [ ] Updated system prompt
- [ ] Unit and integration tests
- [ ] Debug logging for tool calls

---

## Phase 6: Channel Integration (Weeks 11-12)

### 6.1 Adapt Clawdbot Channels

Clawdbot already supports:
- Telegram
- WhatsApp
- Discord
- Slack

Thufir-specific additions:
- Prediction-specific commands
- Rich market data formatting
- Trade confirmation dialogs

### 6.2 Commands

```typescript
// src/interface/commands/predict.ts
export const predictCommand = {
  name: 'predict',
  aliases: ['/predict', '/p'],
  description: 'Make or view predictions',

  async execute(ctx: CommandContext, args: string[]): Promise<void> {
    if (args[0] === 'list') {
      // List recent predictions
    } else if (args[0] === 'show') {
      // Show specific prediction
    } else {
      // Analyze a market
      const market = await findMarket(args.join(' '));
      const analysis = await ctx.agent.analyzeMarket(market);
      await ctx.reply(formatAnalysis(analysis));
    }
  }
};
```

### 6.3 Alerts & Briefings

```typescript
// Cron job for daily briefing
schedule('0 8 * * *', async () => {
  const briefing = await agent.generateBriefing();
  await channels.broadcast(briefing, { channels: ['telegram', 'discord'] });
});

// Alert on high-relevance intel
intelPipeline.on('high-relevance', async (intel, markets) => {
  const alert = formatAlert(intel, markets);
  await channels.broadcast(alert);
});
```

### 6.4 Deliverables

- [ ] Thufir commands in Clawdbot gateway
- [ ] Rich message formatting
- [ ] Trade confirmation flow
- [ ] Daily briefing cron
- [ ] High-relevance alerts

---

## Phase 7: Polish & Testing (Weeks 13-14)

### 7.1 Testing

```
tests/
├── unit/
│   ├── wallet/
│   │   ├── whitelist.test.ts    # CRITICAL
│   │   ├── limits.test.ts       # CRITICAL
│   │   └── keystore.test.ts     # CRITICAL
│   ├── calibration/
│   │   └── calibration.test.ts
│   └── execution/
│       └── orders.test.ts       # CRITICAL
│
├── integration/
│   ├── polymarket.test.ts
│   └── intel-pipeline.test.ts
│
└── e2e/
    ├── trade-flow.test.ts
    └── prediction-flow.test.ts
```

### 7.2 Documentation

- [ ] API documentation
- [ ] Configuration reference
- [ ] Troubleshooting guide
- [ ] Security audit checklist

### 7.3 Deliverables

- [ ] >90% test coverage on security-critical code
- [ ] Integration tests passing
- [ ] Documentation complete
- [ ] Security review completed

---

## Development Environment

### Required Services (for development)

```yaml
# docker-compose.yml
version: '3.8'
services:
  chromadb:
    image: chromadb/chroma:latest
    ports:
      - "8000:8000"
    volumes:
      - chroma_data:/chroma/chroma

volumes:
  chroma_data:
```

### Environment Variables

```bash
# .env.example

# LLM
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Polymarket (testnet for development)
POLYGON_RPC_URL=https://polygon-rpc.com
POLYMARKET_API_KEY=...

# Intel sources (optional for dev)
NEWSAPI_KEY=...
TWITTER_BEARER=...

# Wallet (NEVER commit real keys)
# Use testnet wallet for development
WALLET_PASSWORD=dev-only-password
```

### Running Locally

```bash
# Start dependencies
docker-compose up -d

# Install
pnpm install

# Build
pnpm build

# Run gateway
pnpm thufir gateway --verbose

# In another terminal, chat
pnpm thufir chat
```

---

## Risk Mitigation

### Technical Risks

| Risk | Mitigation |
|------|------------|
| Polymarket API changes | Pin SDK version, monitor changelog |
| LLM hallucinations | Validate all numeric outputs, require reasoning |
| Vector DB performance | Start with ChromaDB, plan migration path to Pinecone |
| Wallet security breach | Defense in depth, limited hot wallet funds |

### Operational Risks

| Risk | Mitigation |
|------|------------|
| API cost overrun | Implement cost tracking, set alerts |
| Bad predictions | Calibration system, position limits |
| Regulatory issues | Clear disclaimers, geographic restrictions |

---

## Team Requirements

### Ideal Team

- **1 Senior Backend Engineer** - Gateway, execution layer, wallet security
- **1 ML/NLP Engineer** - Intel pipeline, embeddings, prompt engineering
- **1 Full-stack Engineer** - Channels, UI, CLI
- **Part-time Security Reviewer** - Wallet and key management audit

### Solo Developer Path

If building solo, prioritize:
1. Wallet security (MUST be solid)
2. Basic prediction recording
3. CLI interface
4. One channel (Telegram recommended)
5. One intel source (RSS)
6. Calibration
7. Additional channels/sources

---

## Success Metrics

### Phase 1-2 (Foundation)
- [ ] Can create wallet and view balance
- [ ] Can fetch Polymarket data
- [ ] Can execute a trade with all security checks

### Phase 3-4 (Memory & Intel)
- [ ] Predictions are recorded and outcomes tracked
- [ ] Calibration scores calculated
- [ ] At least 2 intel sources working

### Phase 5-6 (Agent & Channels)
- [ ] Can have natural conversation about markets
- [ ] At least 1 channel working (Telegram)
- [ ] Daily briefings generated

### Phase 7 (Launch)
- [ ] Security review passed
- [ ] 100+ test predictions recorded
- [ ] Documentation complete
- [ ] At least 1 beta user (yourself)
