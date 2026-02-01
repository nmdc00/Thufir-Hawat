# Trading Tools Implementation Plan

## Status: Planned
**Created:** 2026-01-27
**Priority:** Critical - Enables autonomous trading

---

## Overview

Add tools to transform Thufir from a research assistant into an autonomous trader:

| Tool | Purpose | Risk Level |
|------|---------|------------|
| `current_time` | Temporal awareness | None |
| `place_bet` | Execute trades | High |
| `get_portfolio` | View positions & balance | None |
| `get_predictions` | View past predictions | None |
| `get_order_book` | Market depth/liquidity | None |
| `price_history` | Historical odds movement | None |

---

## Phase 12: Current Time Tool

### Problem

The LLM has no awareness of the current date/time. It cannot:
- Calculate days until market resolution
- Know if news is "breaking" or stale
- Make time-sensitive decisions

### Implementation

#### 12.1 Tool Schema

**File:** `src/core/tool-schemas.ts`

```typescript
{
  name: 'current_time',
  description: 'Get the current date and time. Use to understand temporal context for markets and news.',
  input_schema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'Timezone (default: UTC). Examples: "America/New_York", "Europe/London"'
      }
    },
    required: []
  }
}
```

#### 12.2 Tool Executor

**File:** `src/core/tool-executor.ts`

```typescript
case 'current_time': {
  const tz = String(toolInput.timezone ?? 'UTC');
  const now = new Date();

  let formatted: string;
  try {
    formatted = now.toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' });
  } catch {
    formatted = now.toUTCString();
  }

  return {
    success: true,
    data: {
      iso: now.toISOString(),
      unix: Math.floor(now.getTime() / 1000),
      formatted,
      timezone: tz,
      day_of_week: now.toLocaleDateString('en-US', { weekday: 'long' }),
    },
  };
}
```

#### 12.3 Deliverables

- [ ] Add `current_time` tool schema
- [ ] Add executor handler
- [ ] Update system prompt
- [ ] Add test

---

## Phase 13: Place Bet Tool

### Problem

The LLM can analyze markets but cannot execute trades. It must suggest trades for users to execute manually via `/trade`.

### Design Philosophy

**No artificial caps.** The LLM should learn to manage risk through:
- Its own reasoning about bankroll management
- Feedback from wins/losses via `get_predictions`
- Existing system limits (daily limits, exposure limits) as guardrails

The LLM will make mistakes. That's how it learns calibration.

### Implementation

#### 13.1 Tool Schema

**File:** `src/core/tool-schemas.ts`

```typescript
{
  name: 'place_bet',
  description: 'Place a bet on a Polymarket prediction market. Executes a real trade with real money. Use carefully - consider position sizing, bankroll management, and edge confidence before betting.',
  input_schema: {
    type: 'object',
    properties: {
      market_id: {
        type: 'string',
        description: 'The Polymarket market ID'
      },
      outcome: {
        type: 'string',
        enum: ['YES', 'NO'],
        description: 'The outcome to bet on'
      },
      amount: {
        type: 'number',
        description: 'Amount in USDC to bet'
      },
      max_price: {
        type: 'number',
        description: 'Maximum price willing to pay (0.01-0.99). Order will not fill above this price.'
      },
      reasoning: {
        type: 'string',
        description: 'Brief explanation of why this bet has edge (stored for calibration)'
      }
    },
    required: ['market_id', 'outcome', 'amount', 'reasoning']
  }
}
```

#### 13.2 Tool Executor

**File:** `src/core/tool-executor.ts`

```typescript
case 'place_bet': {
  const marketId = String(toolInput.market_id ?? '');
  const outcome = String(toolInput.outcome ?? '').toUpperCase();
  const amount = Number(toolInput.amount ?? 0);
  const maxPrice = toolInput.max_price ? Number(toolInput.max_price) : undefined;
  const reasoning = String(toolInput.reasoning ?? '');

  // Validate inputs
  if (!marketId) {
    return { success: false, error: 'Missing market_id' };
  }
  if (outcome !== 'YES' && outcome !== 'NO') {
    return { success: false, error: 'outcome must be YES or NO' };
  }
  if (amount <= 0) {
    return { success: false, error: 'amount must be positive' };
  }
  if (!reasoning) {
    return { success: false, error: 'reasoning is required for calibration tracking' };
  }

  return executeBet(ctx, {
    marketId,
    outcome: outcome as 'YES' | 'NO',
    amount,
    maxPrice,
    reasoning,
  });
}

async function executeBet(
  ctx: ToolExecutorContext,
  params: {
    marketId: string;
    outcome: 'YES' | 'NO';
    amount: number;
    maxPrice?: number;
    reasoning: string;
  }
): Promise<ToolResult> {
  const { marketId, outcome, amount, maxPrice, reasoning } = params;

  try {
    // 1. Fetch market data
    const market = await ctx.marketClient.getMarket(marketId);

    // 2. Check exposure limits (existing system)
    const exposureCheck = checkExposureLimits({
      config: ctx.config,
      market,
      outcome,
      amount,
      side: 'buy',
    });
    if (!exposureCheck.allowed) {
      return {
        success: false,
        error: `Exposure limit: ${exposureCheck.reason}`,
      };
    }

    // 3. Check spending limits (existing system)
    const limiter = new DbSpendingLimitEnforcer({
      daily: ctx.config.wallet?.limits?.daily ?? 100,
      perTrade: ctx.config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: ctx.config.wallet?.limits?.confirmationThreshold ?? 10,
    });

    const limitCheck = await limiter.checkAndReserve(amount);
    if (!limitCheck.allowed) {
      return {
        success: false,
        error: `Spending limit: ${limitCheck.reason}`,
      };
    }

    // 4. Get executor (paper/webhook/live based on config)
    const executor = ctx.executor;
    if (!executor) {
      limiter.release(amount);
      return { success: false, error: 'No executor configured' };
    }

    // 5. Execute the trade
    const decision: TradeDecision = {
      action: 'buy',
      outcome,
      amount,
      confidence: 'medium',
      reasoning,
    };

    const result = await executor.execute(market, decision);

    // 6. Confirm or release the reserved amount
    if (result.executed) {
      limiter.confirm(amount);

      // 7. Record prediction for calibration tracking
      recordPrediction({
        marketId,
        marketQuestion: market.question,
        outcome,
        amount,
        entryPrice: market.prices[outcome] ?? 0,
        reasoning,
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        data: {
          executed: true,
          market: market.question,
          outcome,
          amount,
          price: market.prices[outcome],
          message: result.message,
        },
      };
    } else {
      limiter.release(amount);
      return {
        success: false,
        error: result.message,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}
```

#### 13.3 System Guardrails (Already Exist)

The system already has limits that will constrain the LLM:

| Guardrail | Config Location | Default |
|-----------|-----------------|---------|
| Daily spending limit | `wallet.limits.daily` | $100 |
| Per-trade limit | `wallet.limits.perTrade` | $25 |
| Max exposure per market | `wallet.limits.maxExposurePerMarket` | $50 |
| Max total exposure | `wallet.limits.maxTotalExposure` | $500 |

These are **system limits**, not LLM-imposed caps. The LLM can try to bet $1000, but the system will reject it.

#### 13.4 Executor Context Update

**File:** `src/core/tool-executor.ts`

Update `ToolExecutorContext` to include executor:

```typescript
export interface ToolExecutorContext {
  config: ThufirConfig;
  marketClient: PolymarketMarketClient;
  executor?: ExecutionAdapter;  // Add this
}
```

**File:** `src/core/agent.ts`

Pass executor to tool context:

```typescript
this.toolContext = {
  config: this.config,
  marketClient: this.marketClient,
  executor: this.executor,  // Add this
};
```

#### 13.5 Deliverables

- [ ] Add `place_bet` tool schema
- [ ] Add executor handler with limit checks
- [ ] Update `ToolExecutorContext` interface
- [ ] Pass executor to context in agent.ts
- [ ] Record predictions for calibration
- [ ] Update system prompt with betting guidance
- [ ] Add tests (mock executor)

---

## Phase 14: Get Portfolio Tool

### Problem

The LLM cannot see:
- Current positions
- Available balance
- Unrealized P&L
- Open orders

### Implementation

#### 14.1 Tool Schema

**File:** `src/core/tool-schemas.ts`

```typescript
{
  name: 'get_portfolio',
  description: 'Get current portfolio: positions, balances, and P&L. Use before betting to understand available capital and exposure.',
  input_schema: {
    type: 'object',
    properties: {},
    required: []
  }
}
```

#### 14.2 Tool Executor

**File:** `src/core/tool-executor.ts`

```typescript
case 'get_portfolio': {
  return getPortfolio(ctx);
}

async function getPortfolio(ctx: ToolExecutorContext): Promise<ToolResult> {
  try {
    // Get wallet balances
    const balances = await getWalletBalances(ctx.config);

    // Get open positions from CLOB API or local tracking
    const positions = await getOpenPositions(ctx.config);

    // Get today's spending
    const limiter = new DbSpendingLimitEnforcer({
      daily: ctx.config.wallet?.limits?.daily ?? 100,
      perTrade: ctx.config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: 10,
    });
    const remainingDaily = limiter.getRemainingDaily();

    // Calculate totals
    const totalValue = positions.reduce((sum, p) => sum + (p.shares * p.currentPrice), 0);
    const totalCost = positions.reduce((sum, p) => sum + p.costBasis, 0);
    const unrealizedPnl = totalValue - totalCost;

    return {
      success: true,
      data: {
        balances: {
          usdc: balances.usdc ?? 0,
          matic: balances.matic ?? 0,
        },
        positions: positions.map(p => ({
          market_id: p.marketId,
          market_question: p.question,
          outcome: p.outcome,
          shares: p.shares,
          avg_price: p.avgPrice,
          current_price: p.currentPrice,
          cost_basis: p.costBasis,
          current_value: p.shares * p.currentPrice,
          unrealized_pnl: (p.shares * p.currentPrice) - p.costBasis,
          pnl_percent: ((p.currentPrice - p.avgPrice) / p.avgPrice * 100).toFixed(1) + '%',
        })),
        summary: {
          total_positions: positions.length,
          total_value: totalValue,
          total_cost: totalCost,
          unrealized_pnl: unrealizedPnl,
          available_balance: balances.usdc ?? 0,
          remaining_daily_limit: remainingDaily,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}
```

#### 14.3 Dependencies

Need to implement or use existing:
- `getWalletBalances()` - exists in `src/execution/wallet/balances.ts`
- `getOpenPositions()` - may need to implement via CLOB API or local DB

#### 14.4 Deliverables

- [ ] Add `get_portfolio` tool schema
- [ ] Implement executor handler
- [ ] Integrate with wallet balances
- [ ] Add position tracking (if not exists)
- [ ] Add test

---

## Phase 15: Get Predictions Tool

### Problem

The LLM cannot see its own betting history for calibration and learning.

### Implementation

#### 15.1 Tool Schema

**File:** `src/core/tool-schemas.ts`

```typescript
{
  name: 'get_predictions',
  description: 'Get past predictions and their outcomes. Use to review betting history, learn from mistakes, and improve calibration.',
  input_schema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum predictions to return (default: 20)'
      },
      status: {
        type: 'string',
        enum: ['all', 'pending', 'resolved', 'won', 'lost'],
        description: 'Filter by status (default: all)'
      }
    },
    required: []
  }
}
```

#### 15.2 Tool Executor

**File:** `src/core/tool-executor.ts`

```typescript
case 'get_predictions': {
  const limit = Number(toolInput.limit ?? 20);
  const status = String(toolInput.status ?? 'all');

  const predictions = listPredictions({ limit, status });

  // Calculate stats
  const resolved = predictions.filter(p => p.resolved);
  const wins = resolved.filter(p => p.correct);
  const losses = resolved.filter(p => !p.correct);

  const totalBet = predictions.reduce((sum, p) => sum + (p.amount ?? 0), 0);
  const totalReturn = resolved.reduce((sum, p) => {
    if (p.correct) return sum + (p.amount ?? 0) / (p.entryPrice ?? 1);
    return sum;
  }, 0);

  return {
    success: true,
    data: {
      predictions: predictions.map(p => ({
        id: p.id,
        market: p.marketQuestion,
        outcome: p.outcome,
        amount: p.amount,
        entry_price: p.entryPrice,
        reasoning: p.reasoning,
        timestamp: p.timestamp,
        resolved: p.resolved,
        correct: p.correct,
        resolution: p.resolution,
      })),
      stats: {
        total: predictions.length,
        pending: predictions.length - resolved.length,
        resolved: resolved.length,
        wins: wins.length,
        losses: losses.length,
        win_rate: resolved.length > 0 ? (wins.length / resolved.length * 100).toFixed(1) + '%' : 'N/A',
        total_bet: totalBet,
        total_return: totalReturn,
        roi: totalBet > 0 ? ((totalReturn - totalBet) / totalBet * 100).toFixed(1) + '%' : 'N/A',
      },
    },
  };
}
```

#### 15.3 Deliverables

- [ ] Add `get_predictions` tool schema
- [ ] Implement executor handler
- [ ] Add filtering logic
- [ ] Add stats calculation
- [ ] Add test

---

## Phase 16: Get Order Book Tool

### Problem

The LLM cannot see market depth/liquidity before placing bets. This leads to:
- Slippage on large orders
- Betting into thin markets
- Poor execution

### Implementation

#### 16.1 Tool Schema

**File:** `src/core/tool-schemas.ts`

```typescript
{
  name: 'get_order_book',
  description: 'Get order book depth for a market. Shows bid/ask prices and liquidity at each level. Use to understand slippage before large bets.',
  input_schema: {
    type: 'object',
    properties: {
      market_id: {
        type: 'string',
        description: 'The Polymarket market ID'
      },
      depth: {
        type: 'number',
        description: 'Number of price levels to return (default: 5)'
      }
    },
    required: ['market_id']
  }
}
```

#### 16.2 Tool Executor

**File:** `src/core/tool-executor.ts`

```typescript
case 'get_order_book': {
  const marketId = String(toolInput.market_id ?? '');
  const depth = Math.min(Number(toolInput.depth ?? 5), 20);

  if (!marketId) {
    return { success: false, error: 'Missing market_id' };
  }

  return getOrderBook(ctx, marketId, depth);
}

async function getOrderBook(
  ctx: ToolExecutorContext,
  marketId: string,
  depth: number
): Promise<ToolResult> {
  try {
    // Fetch from CLOB API
    const clobUrl = ctx.config.polymarket.api.clob;

    // Get market to find token IDs
    const market = await ctx.marketClient.getMarket(marketId);
    const tokenIds = market.clobTokenIds;

    if (!tokenIds || tokenIds.length < 2) {
      return { success: false, error: 'Could not find token IDs for market' };
    }

    // Fetch order book for YES token
    const yesBookUrl = `${clobUrl}/book?token_id=${tokenIds[0]}`;
    const yesResponse = await fetch(yesBookUrl);
    const yesBook = await yesResponse.json() as OrderBookResponse;

    // Fetch order book for NO token
    const noBookUrl = `${clobUrl}/book?token_id=${tokenIds[1]}`;
    const noResponse = await fetch(noBookUrl);
    const noBook = await noResponse.json() as OrderBookResponse;

    return {
      success: true,
      data: {
        market_id: marketId,
        question: market.question,
        yes: {
          best_bid: yesBook.bids?.[0]?.price ?? null,
          best_ask: yesBook.asks?.[0]?.price ?? null,
          spread: calculateSpread(yesBook),
          bids: (yesBook.bids ?? []).slice(0, depth).map(formatLevel),
          asks: (yesBook.asks ?? []).slice(0, depth).map(formatLevel),
        },
        no: {
          best_bid: noBook.bids?.[0]?.price ?? null,
          best_ask: noBook.asks?.[0]?.price ?? null,
          spread: calculateSpread(noBook),
          bids: (noBook.bids ?? []).slice(0, depth).map(formatLevel),
          asks: (noBook.asks ?? []).slice(0, depth).map(formatLevel),
        },
        liquidity_warning: assessLiquidity(yesBook, noBook),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

interface OrderBookResponse {
  bids?: Array<{ price: number; size: number }>;
  asks?: Array<{ price: number; size: number }>;
}

function formatLevel(level: { price: number; size: number }) {
  return { price: level.price, size: level.size };
}

function calculateSpread(book: OrderBookResponse): number | null {
  const bestBid = book.bids?.[0]?.price;
  const bestAsk = book.asks?.[0]?.price;
  if (bestBid == null || bestAsk == null) return null;
  return bestAsk - bestBid;
}

function assessLiquidity(yesBook: OrderBookResponse, noBook: OrderBookResponse): string | null {
  const yesDepth = (yesBook.bids ?? []).reduce((sum, l) => sum + l.size, 0) +
                   (yesBook.asks ?? []).reduce((sum, l) => sum + l.size, 0);
  const noDepth = (noBook.bids ?? []).reduce((sum, l) => sum + l.size, 0) +
                  (noBook.asks ?? []).reduce((sum, l) => sum + l.size, 0);

  if (yesDepth < 100 || noDepth < 100) {
    return 'LOW LIQUIDITY - Large orders may experience significant slippage';
  }
  if (yesDepth < 500 || noDepth < 500) {
    return 'MODERATE LIQUIDITY - Consider splitting large orders';
  }
  return null;
}
```

#### 16.3 Deliverables

- [ ] Add `get_order_book` tool schema
- [ ] Implement CLOB API integration
- [ ] Add spread calculation
- [ ] Add liquidity assessment
- [ ] Add test

---

## Phase 17: Price History Tool

### Problem

The LLM cannot see historical price movement. This prevents:
- Momentum analysis
- Identifying support/resistance
- Understanding how market reacted to past news

### Implementation

#### 17.1 Tool Schema

**File:** `src/core/tool-schemas.ts`

```typescript
{
  name: 'price_history',
  description: 'Get historical price data for a market. Shows how odds have changed over time.',
  input_schema: {
    type: 'object',
    properties: {
      market_id: {
        type: 'string',
        description: 'The Polymarket market ID'
      },
      interval: {
        type: 'string',
        enum: ['1h', '4h', '1d', '1w'],
        description: 'Time interval between data points (default: 1d)'
      },
      limit: {
        type: 'number',
        description: 'Number of data points (default: 30)'
      }
    },
    required: ['market_id']
  }
}
```

#### 17.2 Implementation Options

**Option A: Polymarket Gamma API (if available)**
```typescript
const url = `${gammaUrl}/markets/${marketId}/prices?interval=${interval}&limit=${limit}`;
```

**Option B: Store prices locally**
- Cron job fetches prices every hour
- Store in SQLite
- Query local DB for history

**Option C: Third-party API**
- Polymarket doesn't expose historical prices easily
- May need to use Dune Analytics or similar

#### 17.3 Deliverables

- [ ] Research Polymarket price history API availability
- [ ] Implement storage if needed
- [ ] Add tool schema
- [ ] Add executor handler
- [ ] Add test

---

## System Prompt Updates

**File:** `src/core/conversation.ts`

Add to SYSTEM_PROMPT:

```
### current_time
Get current date/time. Always check time when analyzing time-sensitive markets or news.

### place_bet
Execute a real trade on Polymarket. Before betting:
- Check portfolio balance and exposure
- Consider position sizing (Kelly criterion, max 2-5% of bankroll per bet)
- Verify you have genuine edge, not just an opinion
- Document your reasoning for calibration

### get_portfolio
View current positions, balances, and P&L. Check before betting to understand available capital.

### get_predictions
Review past predictions and outcomes. Use to learn from mistakes and improve calibration.

### get_order_book
View market depth and liquidity. Check before large bets to avoid slippage.

### price_history
View historical odds. Use to understand momentum and market reactions to events.

## Betting Philosophy

You have access to real money. Treat it with respect:
- Only bet when you have genuine edge (information + probability advantage)
- Size positions based on edge confidence (bigger edge = bigger bet, but never all-in)
- Track your predictions to improve calibration over time
- Learn from losses - they are tuition, not tragedy
- The goal is long-term profitability, not individual wins
```

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/core/tool-schemas.ts` | MODIFY | Add 6 new tool schemas |
| `src/core/tool-executor.ts` | MODIFY | Add 6 handlers + helpers |
| `src/core/conversation.ts` | MODIFY | Update system prompt |
| `src/core/agent.ts` | MODIFY | Pass executor to tool context |
| `tests/tool-calling-trading.test.ts` | CREATE | Test suite |

---

## Implementation Order

| Phase | Tool | Effort | Dependencies |
|-------|------|--------|--------------|
| 12 | `current_time` | 15 min | None |
| 13 | `place_bet` | 2 hr | Executor integration |
| 14 | `get_portfolio` | 2 hr | Wallet balances, position tracking |
| 15 | `get_predictions` | 1 hr | Existing predictions DB |
| 16 | `get_order_book` | 1 hr | CLOB API |
| 17 | `price_history` | 2+ hr | Research needed |

**Total: ~8-10 hours**

---

## After Implementation

Thufir will have **14 tools**:

| Category | Tools |
|----------|-------|
| **Markets** | `market_search`, `market_get`, `get_order_book`, `price_history` |
| **Intel** | `intel_search`, `intel_recent`, `twitter_search`, `web_search`, `web_fetch` |
| **Trading** | `place_bet`, `get_portfolio`, `get_predictions` |
| **Utility** | `current_time`, `calibration_stats` |

The LLM will be a fully autonomous trader that can:
1. Research markets and news
2. Analyze odds and liquidity
3. Execute trades
4. Track performance
5. Learn from outcomes
