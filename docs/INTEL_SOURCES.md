# Intel Sources Configuration

This document describes how to configure and use intelligence sources in Thufir.

## Overview

Thufir aggregates information from multiple sources to inform predictions. The intel layer is designed to be modular - you can enable/disable sources and add custom ones.

## Built-in Sources

### 1. NewsAPI

General news aggregation from 150,000+ sources.

**Setup:**
```bash
# Get API key from https://newsapi.org
thufir intel add newsapi --key YOUR_API_KEY
```

**Configuration:**
```yaml
intel:
  sources:
    newsapi:
      enabled: true
      apiKey: ${NEWSAPI_KEY}
      categories:
        - politics
        - business
        - technology
        - sports
        - entertainment
      countries:
        - us
        - gb
      queries:
        - "Federal Reserve"
      maxArticlesPerFetch: 100
      language: en
```

**Pricing:**
- Free: 100 requests/day (good for testing)
- Developer: $449/month (production use)

### 2. Twitter/X API

Real-time social sentiment and breaking news.

**Setup:**
```bash
# Get bearer token from https://developer.twitter.com
thufir intel add twitter --bearer YOUR_BEARER_TOKEN
```

**Configuration:**
```yaml
intel:
  sources:
    twitter:
      enabled: true
      bearerToken: ${TWITTER_BEARER}
      keywords:
        - polymarket
        - "prediction market"
        - "#election2028"
      accounts:
        - elonmusk
        - nikitonsky
      maxTweetsPerFetch: 200
```

**Pricing:**
- Free: 500K tweets/month read
- Basic: $100/month (more volume)

### 3. RSS Feeds

Traditional news and niche sources.

**Setup:**
```bash
thufir intel add rss --url "https://fivethirtyeight.com/feed/"
```

**Configuration:**
```yaml
intel:
  sources:
    rss:
      enabled: true
      feeds:
        # Political forecasting
        - url: https://fivethirtyeight.com/feed/
          category: politics

        # Economics
        - url: https://www.federalreserve.gov/feeds/press_all.xml
          category: economics

        # Tech
        - url: https://techcrunch.com/feed/
          category: technology

        # Sports
        - url: https://www.espn.com/espn/rss/news
          category: sports

        # Crypto
        - url: https://cointelegraph.com/rss
          category: crypto
```

**Pricing:** Free

### 4. Google News

Broader news coverage with search capabilities.

**Setup:**
```bash
# Uses SerpAPI for reliable access
thufir intel add googlenews --serpapi-key YOUR_KEY
```

**Configuration:**
```yaml
intel:
  sources:
    googlenews:
      enabled: true
      serpApiKey: ${SERPAPI_KEY}
      queries:
        - "Federal Reserve interest rates"
        - "Tesla deliveries"
        - "UFC fight predictions"
      country: us
      language: en
      maxArticlesPerFetch: 20
```

**Pricing:**
- SerpAPI: $50/month for 5000 searches

### 5. Polymarket Comments

Sentiment from the prediction market community itself.

**Setup:**
```bash
thufir intel add polymarket-comments
```

**Configuration:**
```yaml
intel:
  sources:
    polymarketComments:
      enabled: true
      trackWatchlist: true
      watchlistLimit: 50
      trackTopMarkets: 20
      maxCommentsPerMarket: 20
```

**Pricing:** Free (public API)

## Embeddings (Semantic Search)

Thufir can optionally embed intel items for semantic search. This improves retrieval
quality for long-running conversations.

**Configuration:**
```yaml
intel:
  embeddings:
    enabled: true
    provider: openai   # or google
    model: text-embedding-3-small
    apiBaseUrl: https://api.openai.com
```

**Keys:** set `OPENAI_API_KEY` (or `GEMINI_API_KEY` for Google).

## Custom Sources

### Webhook Source

Receive intel from any external system.

**Setup:**
```bash
thufir intel add webhook --name "my-scraper" --secret YOUR_SECRET
```

**Configuration:**
```yaml
intel:
  webhooks:
    - name: my-scraper
      secret: ${WEBHOOK_SECRET}
      # Thufir will listen on /intel/webhook/my-scraper
```

**Webhook Format:**
```bash
curl -X POST https://your-thufir-host/intel/webhook/my-scraper \
  -H "Authorization: Bearer YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Breaking: Fed signals rate cut",
    "content": "Federal Reserve Chair indicated...",
    "source": "custom-scraper",
    "category": "economics",
    "timestamp": "2026-01-26T10:00:00Z",
    "url": "https://example.com/article",
    "metadata": {
      "author": "Jane Doe",
      "credibility": 0.9
    }
  }'
```

### Custom Source Plugin

For programmatic sources, implement the `IntelSource` interface:

```typescript
// src/intel/sources/custom/my-source.ts

import { IntelSource, IntelItem, IntelConfig } from '../types';

export class MyCustomSource implements IntelSource {
  name = 'my-custom-source';
  type = 'custom' as const;

  constructor(private config: IntelConfig) {}

  async fetch(): Promise<IntelItem[]> {
    // Your custom logic here
    const data = await fetchFromSomewhere();

    return data.map(item => ({
      id: generateId(),
      title: item.title,
      content: item.body,
      source: this.name,
      category: this.categorize(item),
      timestamp: new Date(item.date),
      url: item.link,
      metadata: {
        // Custom fields
      }
    }));
  }

  relevance(item: IntelItem, market: Market): number {
    // Return 0-1 relevance score
    // Used to filter intel for specific markets
    return calculateRelevance(item, market);
  }
}
```

Register in config:
```yaml
intel:
  custom:
    - name: my-custom-source
      module: ./src/intel/sources/custom/my-source.ts
      config:
        apiUrl: https://api.example.com
        apiKey: ${MY_API_KEY}
```

## Processing Pipeline

All intel flows through a standard pipeline:

```
┌─────────────┐
│   Source    │
│  (raw data) │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────┐
│           DEDUPLICATION                 │
│  • URL-based dedup                      │
│  • Content hash dedup                   │
│  • Similar title detection              │
└──────────────────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│           TEXT PROCESSING               │
│  • Clean HTML/formatting                │
│  • Extract main content                 │
│  • Language detection                   │
└──────────────────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│           NLP ENRICHMENT                │
│  • Named entity extraction              │
│  • Sentiment analysis                   │
│  • Topic classification                 │
│  • Event detection (new vs old news)    │
└──────────────────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│           EMBEDDING                     │
│  • Generate vector embedding            │
│  • Store in ChromaDB                    │
└──────────────────┬──────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│           MARKET MATCHING               │
│  • Score relevance to active markets    │
│  • Generate alerts for high-relevance   │
└─────────────────────────────────────────┘
```

## Retrieval

When analyzing a market, Thufir retrieves relevant intel:

```typescript
// Example: Get intel for a market
const intel = await intelLayer.retrieve({
  market: fedRateDecisionMarket,
  limit: 20,
  minRelevance: 0.5,
  timeRange: {
    from: daysAgo(7),
    to: now()
  },
  categories: ['economics', 'politics']
});
```

**Retrieval Methods:**

1. **Vector similarity** - Semantic search using embeddings
2. **Keyword matching** - Direct entity/keyword matching
3. **Recency weighting** - More recent intel ranked higher
4. **Source credibility** - Higher credibility sources ranked higher

## Configuration Example

Full intel configuration:

```yaml
# config/intel.yaml

intel:
  # Global settings
  vectorDb:
    type: chroma
    path: ~/.thufir/chroma
    embeddingModel: text-embedding-3-small

  # Deduplication
  dedup:
    enabled: true
    windowHours: 72
    similarityThreshold: 0.9

  # NLP processing
  nlp:
    sentimentModel: distilbert-sentiment
    nerModel: en_core_web_sm
    language: en

  # Sources
  sources:
    newsapi:
      enabled: true
      apiKey: ${NEWSAPI_KEY}
      categories: [politics, business, technology]

    twitter:
      enabled: true
      bearerToken: ${TWITTER_BEARER}
      keywords: [polymarket, "prediction market"]

    rss:
      enabled: true
      feeds:
        - url: https://fivethirtyeight.com/feed/
          category: politics

    polymarketComments:
      enabled: true
      trackWatchlist: true

  # Roaming controls (used by proactive search)
  roaming:
    enabled: true
    allowSources: []     # optional allowlist of source names
    allowTypes: []       # optional allowlist of types: news|social|market
    minTrust: medium
    socialOptIn: false   # must be true to include social sources

notifications:
  intelAlerts:
    enabled: true
    channels:
      - telegram
      - cli
    watchlistOnly: true
    maxItems: 10
    includeSources: []
    excludeSources: []
    includeKeywords: []
    excludeKeywords: []
    minKeywordOverlap: 1
    minTitleLength: 8
    minSentiment:
    maxSentiment:
    sentimentPreset: any
    includeEntities: []
    excludeEntities: []
    minEntityOverlap: 1
    useContent: true
    minScore: 0
    keywordWeight: 1
    entityWeight: 1
    sentimentWeight: 1
    positiveSentimentThreshold: 0.05
    negativeSentimentThreshold: -0.05
    showScore: false
    showReasons: false
    entityAliases: {}
```

## Monitoring

View intel status:

```bash
# Show source status
thufir intel status

# Output:
# Source              Status    Last Fetch    Items (24h)
# ─────────────────────────────────────────────────────────
# newsapi             ✓ OK      2 min ago     342
# twitter             ✓ OK      30 sec ago    1,204
# rss                 ✓ OK      5 min ago     89
# polymarket-comments ✓ OK      3 min ago     156
# my-webhook          ⚠ STALE   2 hours ago   12

# View recent intel
thufir intel recent --limit 20

# Search intel
thufir intel search "Federal Reserve" --from 7d

# Preview alerts
thufir intel alerts --limit 50
thufir intel alerts --show-score --min-score 1.5
thufir intel alerts --show-reasons
thufir intel alerts --sentiment negative
```

## Conversational Alert Setup

If you chat with Thufir and alerts aren’t configured yet, it will ask whether you want to define alerts.
Answer "yes" to configure watchlist-only alerts, then provide keywords and sources when prompted.

## Alert Scoring

Alerts can be ranked and filtered by a weighted score:
- **keywordWeight**: overlap with keywords/watchlist titles
- **entityWeight**: overlap with extracted entities (simple capitalized tokens)
- **sentimentWeight**: positive/negative signal from headline/content

You can require a minimum score with `minScore` and show scores in the preview with `showScore: true`.

## Cost Optimization

To minimize API costs:

1. **Start with free sources** (RSS, Polymarket comments)
2. **Use caching** - Intel is cached and deduplicated
3. **Filter aggressively** - Only fetch categories you care about
4. **Batch requests** - Sources batch API calls where possible
5. **Monitor usage** - `thufir intel usage` shows API call counts

Estimated monthly costs for moderate use:
- NewsAPI Developer: $449 (or free tier for testing)
- Twitter Basic: $100
- SerpAPI: $50
- **Total: ~$600/month** (or nearly free for testing)
