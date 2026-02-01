# Thufir Architecture

This document describes the technical architecture of Thufir, a prediction market AI companion.

## System Overview

Thufir is built as a layered system with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           USER INTERFACES                               │
│  ┌──────────┐ ┌──────────┐ ┌─────────┐ ┌───────┐ ┌─────┐ ┌───────────┐  │
│  │ WhatsApp │ │ Telegram │ │ Discord │ │ Slack │ │ CLI │ │  WebChat  │  │
│  └────┬─────┘ └────┬─────┘ └────┬────┘ └───┬───┘ └──┬──┘ └─────┬─────┘  │
│       └────────────┴────────────┴──────────┴────────┴──────────┘        │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
┌─────────────────────────────────────▼───────────────────────────────────┐
│                        GATEWAY LAYER (from Clawdbot)                    │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    WebSocket Control Plane                       │    │
│  │  • Session Management    • Message Routing    • Authentication   │    │
│  │  • Channel Adapters      • Cron Scheduler     • Event Bus        │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
┌─────────────────────────────────────▼───────────────────────────────────┐
│                           AGENT CORE                                    │
│  ┌───────────────────┐  ┌───────────────────┐  ┌─────────────────────┐  │
│  │   LLM Reasoning   │  │ Prediction Engine │  │ Calibration Engine  │  │
│  │   ─────────────   │  │ ───────────────── │  │ ─────────────────── │  │
│  │ • Claude/GPT API  │  │ • Market Analysis │  │ • Brier Scores      │  │
│  │ • Prompt Mgmt     │  │ • Confidence Est. │  │ • Domain Accuracy   │  │
│  │ • Context Window  │  │ • Position Sizing │  │ • Overconfidence    │  │
│  │ • Tool Calling    │  │ • Risk Assessment │  │   Detection         │  │
│  └───────────────────┘  └───────────────────┘  └─────────────────────┘  │
└───────────┬─────────────────────┬─────────────────────┬─────────────────┘
            │                     │                     │
┌───────────▼───────────┐ ┌───────▼───────────┐ ┌───────▼───────────────┐
│     INTEL LAYER       │ │   MEMORY LAYER    │ │   EXECUTION LAYER     │
│  ───────────────────  │ │ ───────────────── │ │ ───────────────────── │
│                       │ │                   │ │                       │
│  Data Sources:        │ │  Prediction DB:   │ │  Polymarket:          │
│  • NewsAPI            │ │  • Predictions    │ │  • Market Data API    │
│  • Twitter/X API      │ │  • Outcomes       │ │  • Order Execution    │
│  • RSS Aggregator     │ │  • Reasoning Logs │ │  • Position Mgmt      │
│  • Google News        │ │                   │ │                       │
│  • Custom Webhooks    │ │  Calibration DB:  │ │  Wallet:              │
│                       │ │  • Accuracy Stats │ │  • Key Management     │
│  Processing:          │ │  • Domain Scores  │ │  • Transaction Sign   │
│  • NLP Pipeline       │ │  • Confidence Adj │ │  • Balance Tracking   │
│  • Entity Extraction  │ │                   │ │                       │
│  • Sentiment Analysis │ │  Context Store:   │ │  Risk Controls:       │
│  • Vector Embeddings  │ │  • Conversations  │ │  • Position Limits    │
│                       │ │  • User Prefs     │ │  • Daily Loss Limits  │
│  Storage:             │ │  • Domain Expert. │ │  • Exposure Limits    │
│  • SQLite embeddings  │ │                   │ │                       │
│  • Event Stream       │ │  Storage:         │ │  Storage:             │
│  • Cache Layer        │ │  • SQLite/Postgres│ │  • Encrypted Keystore │
│                       │ │  • File Archive   │ │  • Transaction Log    │
└───────────────────────┘ └───────────────────┘ └───────────────────────┘
```

## Layer Specifications

### 1. Interface Layer

Inherited from Clawdbot with minimal modifications.

**Channels Supported:**
- WhatsApp (via Baileys)
- Telegram (via grammY)
- Discord (via discord.js)
- Slack (via Bolt)
- CLI (native)
- WebChat (embedded)

**Thufir-Specific Additions:**
- Prediction-specific slash commands (`/predict`, `/portfolio`, `/calibration`)
- Rich message formatting for market data
- Interactive confirmation dialogs for trades

### 2. Gateway Layer

Direct fork of Clawdbot gateway with extensions.

**Core Components (from Clawdbot):**
- WebSocket control plane on `ws://127.0.0.1:18789`
- Session management with context persistence
- Multi-agent routing
- Cron scheduler for automated tasks

**Thufir Extensions:**
- `PredictionSession` class extending base session
- Market data WebSocket subscriptions
- Portfolio state synchronization
- Alert/notification triggers

### 3. Agent Core

The brain of Thufir. Three main subsystems:

#### 3.1 LLM Reasoning Engine

```typescript
interface ReasoningEngine {
  // Generate analysis for a market
  analyzeMarket(market: Market, context: IntelContext): Promise<Analysis>;

  // Explain a prediction decision
  explainDecision(prediction: Prediction): Promise<Explanation>;

  // Generate daily briefing
  generateBriefing(portfolio: Portfolio, markets: Market[]): Promise<Briefing>;

  // Interactive conversation
  chat(message: string, session: Session): Promise<Response>;
}
```

**Model Selection:**
- Primary: Claude Sonnet 4.5 (best reasoning, long context)
- Fallback: GPT-4o (faster, cheaper)
- Fast tasks: Claude Haiku (summaries, simple queries)

**Prompt Architecture:**
- System prompt with prediction market expertise
- Dynamic context injection (recent intel, portfolio state)
- Tool definitions for market actions
- Calibration data injection for confidence adjustment

#### 3.2 Prediction Engine

```typescript
interface PredictionEngine {
  // Estimate probability for a market outcome
  estimate(market: Market, intel: Intel[]): Promise<Estimate>;

  // Calculate recommended position size
  positionSize(estimate: Estimate, calibration: Calibration): Promise<PositionSize>;

  // Score a market for opportunity
  scoreOpportunity(market: Market, estimate: Estimate): Promise<Score>;

  // Scan markets for opportunities
  scanMarkets(criteria: ScanCriteria): Promise<Opportunity[]>;
}

interface Estimate {
  probability: number;        // 0-1
  confidence: ConfidenceLevel; // low/medium/high
  reasoning: string;
  keyFactors: Factor[];
  uncertainties: string[];
}

interface PositionSize {
  recommended: number;        // USD amount
  kelly: number;              // Kelly criterion optimal
  adjusted: number;           // After calibration adjustment
  maxAllowed: number;         // Risk limit cap
}
```

#### 3.3 Calibration Engine

```typescript
interface CalibrationEngine {
  // Record a prediction
  recordPrediction(prediction: Prediction): Promise<void>;

  // Record outcome when market resolves
  recordOutcome(predictionId: string, outcome: Outcome): Promise<void>;

  // Get calibration stats for a domain
  getCalibration(domain: Domain): Promise<CalibrationStats>;

  // Adjust confidence based on historical accuracy
  adjustConfidence(rawConfidence: number, domain: Domain): Promise<number>;
}

interface CalibrationStats {
  domain: Domain;
  totalPredictions: number;
  brierScore: number;           // Lower is better (0-1)
  accuracy: {
    overall: number;
    byConfidenceLevel: {
      low: number;
      medium: number;
      high: number;
    };
  };
  calibrationCurve: {
    predictedProbability: number;
    actualFrequency: number;
  }[];
  recentTrend: 'improving' | 'stable' | 'declining';
}
```

**Calibration Algorithm:**

```
adjustedConfidence = rawConfidence * calibrationFactor(domain)

where calibrationFactor = actualAccuracy / predictedAccuracy

Example:
- Raw confidence: 0.80 (80%)
- Historical: When you predicted 80%, you were right 65% of the time
- Calibration factor: 0.65 / 0.80 = 0.8125
- Adjusted confidence: 0.80 * 0.8125 = 0.65 (65%)
```

### 4. Intel Layer

Aggregates and processes information from multiple sources.

#### 4.1 Data Sources

```typescript
interface IntelSource {
  name: string;
  type: 'news' | 'social' | 'data' | 'custom';
  fetch(): Promise<IntelItem[]>;
  relevance(item: IntelItem, market: Market): number;
}

// Implementations
class NewsAPISource implements IntelSource { }
class TwitterSource implements IntelSource { }
class RSSSource implements IntelSource { }
class PolymarketCommentsSource implements IntelSource { }
class CustomWebhookSource implements IntelSource { }
```

**Source Configuration:**

```yaml
intel:
  sources:
    newsapi:
      enabled: true
      apiKey: ${NEWSAPI_KEY}
      categories: [politics, business, technology, sports]
      refreshInterval: 300  # seconds

    twitter:
      enabled: true
      bearerToken: ${TWITTER_BEARER}
      lists:
        - politics-pundits
        - crypto-analysts
      keywords:
        - polymarket
        - prediction market
      refreshInterval: 60

    rss:
      enabled: true
      feeds:
        - https://fivethirtyeight.com/feed/
        - https://www.predictit.org/api/rss

    custom:
      enabled: false
      webhookUrl: ${CUSTOM_WEBHOOK}
```

#### 4.2 Processing Pipeline

```
Raw Data → NLP → Entity Extraction → Relevance Scoring → Embedding → Vector DB
                                                              ↓
                              Market Context ← Retrieval ← Query
```

**NLP Pipeline:**
1. Text cleaning and normalization
2. Named entity recognition (people, orgs, events)
3. Sentiment analysis
4. Event detection (new information vs. old)
5. Credibility scoring (source reliability)

**Vector Storage (SQLite embeddings; ChromaDB optional):**
```python
collection.add(
    documents=[intel_text],
    metadatas=[{
        "source": "newsapi",
        "timestamp": "2026-01-26T10:00:00Z",
        "entities": ["Trump", "Election"],
        "sentiment": 0.2,
        "relevance_markets": ["election-2028"]
    }],
    ids=[intel_id]
)
```

### 5. Memory Layer

Persistent storage for predictions, outcomes, and user context, plus durable chat memory.

**Chat memory persistence:**
- JSONL transcripts per user session (append-only, compaction summaries)
- `chat_messages` table for structured retrieval
- `chat_embeddings` for semantic recall

#### 5.1 Schema Design

```sql
-- Predictions table
CREATE TABLE predictions (
    id UUID PRIMARY KEY,
    market_id VARCHAR(255) NOT NULL,
    market_title TEXT NOT NULL,

    -- Prediction details
    predicted_outcome VARCHAR(50),  -- 'YES' or 'NO'
    predicted_probability DECIMAL(5,4),
    confidence_level VARCHAR(20),
    confidence_raw DECIMAL(5,4),
    confidence_adjusted DECIMAL(5,4),

    -- Execution details
    executed BOOLEAN DEFAULT FALSE,
    execution_price DECIMAL(10,4),
    position_size DECIMAL(15,2),

    -- Reasoning
    reasoning TEXT,
    key_factors JSONB,
    intel_ids UUID[],

    -- Metadata
    domain VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW(),

    -- Outcome (filled when market resolves)
    outcome VARCHAR(50),
    outcome_timestamp TIMESTAMP,
    pnl DECIMAL(15,2),
    brier_contribution DECIMAL(5,4)
);

-- Calibration stats (materialized view, refreshed daily)
CREATE MATERIALIZED VIEW calibration_stats AS
SELECT
    domain,
    COUNT(*) as total_predictions,
    AVG(CASE WHEN predicted_outcome = outcome THEN 1.0 ELSE 0.0 END) as accuracy,
    AVG(POWER(predicted_probability - CASE WHEN outcome = 'YES' THEN 1 ELSE 0 END, 2)) as brier_score,
    -- Bucketed calibration
    CASE
        WHEN predicted_probability < 0.2 THEN '0-20%'
        WHEN predicted_probability < 0.4 THEN '20-40%'
        WHEN predicted_probability < 0.6 THEN '40-60%'
        WHEN predicted_probability < 0.8 THEN '60-80%'
        ELSE '80-100%'
    END as probability_bucket
FROM predictions
WHERE outcome IS NOT NULL
GROUP BY domain, probability_bucket;

-- User context
CREATE TABLE user_context (
    user_id VARCHAR(255) PRIMARY KEY,
    preferences JSONB,
    domains_of_interest VARCHAR(50)[],
    risk_tolerance VARCHAR(20),
    notification_settings JSONB,
    conversation_summary TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
);
```

#### 5.2 Reasoning Archive

Every prediction stores its full reasoning chain:

```json
{
  "prediction_id": "abc123",
  "reasoning": {
    "summary": "Tesla likely to beat Q1 delivery estimates based on supply chain data",
    "key_factors": [
      {
        "factor": "Shanghai factory utilization at 95%",
        "weight": 0.4,
        "source": "Reuters report 2026-01-20"
      },
      {
        "factor": "Model refresh driving demand in China",
        "weight": 0.3,
        "source": "Twitter sentiment analysis"
      },
      {
        "factor": "Historical Q1 typically weak but 2025 Q1 beat estimates",
        "weight": 0.2,
        "source": "Historical data"
      }
    ],
    "uncertainties": [
      "Tariff situation unclear",
      "Elon distraction factor"
    ],
    "intel_used": ["intel_001", "intel_002", "intel_003"]
  }
}
```

### 6. Execution Layer

Handles all interactions with Polymarket and wallet management.

#### 6.1 Polymarket Integration

```typescript
interface PolymarketClient {
  // Market data
  getMarkets(filter?: MarketFilter): Promise<Market[]>;
  getMarket(marketId: string): Promise<Market>;
  getOrderBook(marketId: string): Promise<OrderBook>;
  subscribeToMarket(marketId: string, callback: (update: MarketUpdate) => void): void;

  // Trading
  buildOrder(params: OrderParams): Promise<Order>;
  signOrder(order: Order, wallet: Wallet): Promise<SignedOrder>;
  submitOrder(signedOrder: SignedOrder): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;

  // Portfolio
  getPositions(): Promise<Position[]>;
  getTradeHistory(): Promise<Trade[]>;
}

interface OrderParams {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  price: number;       // 0-1
  amount: number;      // USD
  orderType: 'LIMIT' | 'MARKET';
}
```

#### 6.2 Wallet Management

**CRITICAL SECURITY COMPONENT**

```typescript
interface WalletManager {
  // Setup
  createWallet(): Promise<WalletInfo>;
  importWallet(encryptedKey: string, password: string): Promise<WalletInfo>;

  // Operations
  getBalance(): Promise<Balance>;
  signTransaction(tx: Transaction): Promise<SignedTransaction>;

  // Security
  setSpendingLimit(daily: number, perTrade: number): void;
  requireConfirmation(threshold: number): void;
  lockWallet(): void;
  unlockWallet(password: string): Promise<void>;
}

interface WalletInfo {
  address: string;
  // Private key NEVER exposed, only used internally for signing
}
```

**Security Architecture:**

```
┌─────────────────────────────────────────────────────────┐
│                    APPLICATION LAYER                    │
│   (Can request signatures, cannot access private key)   │
└───────────────────────────┬─────────────────────────────┘
                            │ Sign Request
                            ▼
┌─────────────────────────────────────────────────────────┐
│                   WALLET SECURITY LAYER                 │
│  ┌─────────────────────────────────────────────────┐    │
│  │              Spending Limit Check               │    │
│  │  • Daily limit: $X                              │    │
│  │  • Per-trade limit: $Y                          │    │
│  │  • Confirmation required above: $Z              │    │
│  └─────────────────────────────────────────────────┘    │
│                          │                              │
│                          ▼                              │
│  ┌─────────────────────────────────────────────────┐    │
│  │              Address Whitelist                  │    │
│  │  • Only Polymarket contracts allowed            │    │
│  │  • NO external withdrawals permitted            │    │
│  └─────────────────────────────────────────────────┘    │
│                          │                              │
│                          ▼                              │
│  ┌─────────────────────────────────────────────────┐    │
│  │              Encrypted Keystore                 │    │
│  │  • AES-256 encryption                           │    │
│  │  • Key derived from user password               │    │
│  │  • Never written to disk unencrypted            │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

**Risk Controls:**

```yaml
wallet:
  limits:
    dailySpend: 500           # Max USD per day
    perTrade: 100             # Max USD per trade
    confirmationThreshold: 50  # Require user confirmation above this

  exposure:
    maxPositionPercent: 20    # Max 20% of portfolio in one market
    maxDomainPercent: 40      # Max 40% in one domain (e.g., politics)

  safety:
    cooldownAfterLoss: 3600   # 1 hour cooldown after significant loss
    lossThresholdPercent: 10  # Trigger cooldown at 10% daily loss

  addresses:
    whitelist:
      - "0x..."  # Polymarket CTF Exchange
      - "0x..."  # Polymarket Neg Risk Exchange
    # NO other addresses allowed
```

## Data Flow Examples

### Example 1: User Asks for Market Analysis

```
User: "What do you think about the Fed rate decision market?"
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ 1. Gateway receives message, routes to agent       │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ 2. Agent Core: Intent Classification               │
│    → Identified as MARKET_ANALYSIS request          │
└─────────────────────────────────────────────────────┘
         │
         ├──────────────────────────────────┐
         ▼                                  ▼
┌─────────────────────┐      ┌─────────────────────────┐
│ 3a. Fetch Market    │      │ 3b. Retrieve Intel      │
│     Data            │      │     (parallel)          │
│  • Current price    │      │  • Recent news          │
│  • Volume           │      │  • Fed statements       │
│  • Order book       │      │  • Economic data        │
└─────────────────────┘      └─────────────────────────┘
         │                              │
         └──────────────┬───────────────┘
                        ▼
┌─────────────────────────────────────────────────────┐
│ 4. LLM Reasoning: Generate Analysis                │
│    • Synthesize intel                               │
│    • Form probability estimate                      │
│    • Assess confidence                              │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ 5. Calibration: Adjust Confidence                  │
│    • Check historical Fed prediction accuracy       │
│    • Apply calibration factor                       │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ 6. Format and Send Response                        │
│    "Fed Rate Decision (Mar 2026)                   │
│     Current: 0.72 YES (hold)                       │
│     My estimate: 0.68                              │
│     Confidence: Medium (your accuracy: 71%)        │
│     Key factors: [...]                             │
│     Consider: slight SHORT opportunity"            │
└─────────────────────────────────────────────────────┘
```

### Example 2: Executing a Trade

```
User: "Buy $50 on Tesla deliveries YES"
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ 1. Parse Trade Intent                              │
│    Market: Tesla Q1 Deliveries > 500k              │
│    Side: BUY                                       │
│    Outcome: YES                                    │
│    Amount: $50                                     │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ 2. Risk Checks                                     │
│    ✓ Under daily limit ($50 < $500)                │
│    ✓ Under per-trade limit ($50 < $100)            │
│    ✓ Under confirmation threshold (no confirm)     │
│    ✓ Position would be 8% of portfolio (< 20%)     │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ 3. Generate Reasoning (for memory)                 │
│    • Why this trade makes sense                    │
│    • Key factors considered                        │
│    • Risk assessment                               │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ 4. Build Order                                     │
│    • Fetch current best price                      │
│    • Calculate shares: $50 / 0.38 = 131.6 shares   │
│    • Build order object                            │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ 5. Sign Transaction                                │
│    • Wallet manager signs with private key         │
│    • Key never leaves secure enclave               │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ 6. Submit to Polymarket                            │
│    • Send signed order to DEX                      │
│    • Wait for confirmation                         │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ 7. Record Prediction                               │
│    • Store in predictions table                    │
│    • Link to reasoning                             │
│    • Link to intel used                            │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│ 8. Confirm to User                                 │
│    "✓ Bought 131 YES shares @ 0.38                 │
│     Total: $49.78                                  │
│     Potential payout: $131 if YES resolves         │
│     Position added to portfolio"                   │
└─────────────────────────────────────────────────────┘
```

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     YOUR MACHINE                            │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                 Thufir Gateway                       │    │
│  │                 (Node.js process)                   │    │
│  │                                                     │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌────────────┐   │    │
│  │  │   Agent     │  │   Intel     │  │  Execution │   │    │
│  │  │   Core      │  │   Worker    │  │  Worker    │   │    │
│  │  └─────────────┘  └─────────────┘  └────────────┘   │    │
│  └─────────────────────────┬───────────────────────────┘    │
│                            │                                │
│  ┌─────────────────────────┼───────────────────────────┐    │
│  │         Local Storage   │                           │    │
│  │  ┌──────────┐  ┌────────┴────┐  ┌────────────────┐  │    │
│  │  │ SQLite   │  │ Embeddings  │  │ Encrypted      │  │    │
│  │  │ (memory) │  │ (SQLite)    │  │ Keystore       │  │    │
│  │  └──────────┘  └─────────────┘  └────────────────┘  │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         │ Channels           │ Intel APIs         │ Polymarket
         ▼                    ▼                    ▼
    ┌─────────┐          ┌─────────┐          ┌─────────┐
    │WhatsApp │          │ NewsAPI │          │Polymarket│
    │Telegram │          │Twitter  │          │   API    │
    │ etc.    │          │ etc.    │          │          │
    └─────────┘          └─────────┘          └─────────┘
```

## Technology Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Runtime | Node.js 22+ | Clawdbot compatibility, async I/O |
| Language | TypeScript | Type safety, better tooling |
| Gateway | Clawdbot fork | Proven multi-channel architecture |
| LLM | Claude API (primary) | Best reasoning, long context |
| Vector DB | SQLite embeddings (current) | Simple, embedded, good for RAG |
| Vector DB (optional) | ChromaDB | Advanced search at scale |
| Database | SQLite (dev) / Postgres (prod) | Simple start, scale later |
| Wallet | ethers.js | Standard Ethereum library |
| Polymarket | @polymarket/sdk | Official SDK |

## Future Considerations

### Scaling
- Move to Postgres for production
- Redis for caching hot market data
- Separate intel worker process

### Advanced Features
- Multi-market correlation analysis
- Social graph analysis (who predicts well?)
- Custom model fine-tuning on prediction data
- Automated market discovery

### Security Hardening
- Hardware wallet support (Ledger/Trezor)
- Multi-sig for large trades
- Audit logging
- Anomaly detection
