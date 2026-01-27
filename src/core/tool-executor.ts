import type { BijazConfig } from './config.js';
import type { Market, PolymarketMarketClient } from '../execution/polymarket/markets.js';
import type { ExecutionAdapter, TradeDecision } from '../execution/executor.js';
import type { LimitCheckResult } from '../execution/wallet/limits.js';
import { listCalibrationSummaries } from '../memory/calibration.js';
import { listRecentIntel, searchIntel, type StoredIntel } from '../intel/store.js';
import { listOpenPositions, listPredictions, createPrediction } from '../memory/predictions.js';
import { checkExposureLimits } from './exposure.js';

/** Minimal interface for spending limit enforcement used in tool execution */
export interface ToolSpendingLimiter {
  checkAndReserve(amount: number): Promise<LimitCheckResult>;
  confirm(amount: number): void;
  release(amount: number): void;
  getState?(): { todaySpent: number; reserved: number } & Record<string, unknown>;
}
import { getCashBalance } from '../memory/portfolio.js';
import { getWalletBalances } from '../execution/wallet/balances.js';
import { loadWallet } from '../execution/wallet/manager.js';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { isIP } from 'node:net';

export interface ToolExecutorContext {
  config: BijazConfig;
  marketClient: PolymarketMarketClient;
  executor?: ExecutionAdapter;
  limiter?: ToolSpendingLimiter;
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
          ? summaries.filter((summary) => summary.domain === domain)
          : summaries;
        return { success: true, data: filtered };
      }

      case 'current_time': {
        const timezone = String(toolInput.timezone ?? 'UTC');
        const now = new Date();
        let formatted: string;
        try {
          formatted = now.toLocaleString('en-US', {
            timeZone: timezone,
            dateStyle: 'full',
            timeStyle: 'long',
          });
        } catch {
          formatted = now.toUTCString();
        }

        return {
          success: true,
          data: {
            iso: now.toISOString(),
            unix: Math.floor(now.getTime() / 1000),
            formatted,
            timezone,
            day_of_week: now.toLocaleDateString('en-US', { weekday: 'long' }),
          },
        };
      }

      case 'twitter_search': {
        const query = String(toolInput.query ?? '').trim();
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 10), 1), 50);
        if (!query) {
          return { success: false, error: 'Missing query' };
        }

        // Try Twitter API v2 first
        const twitterResult = await searchTwitterDirect(query, limit, ctx);
        if (twitterResult.success) {
          return twitterResult;
        }

        // Fallback to SerpAPI
        const serpResult = await searchTwitterViaSerpApi(query, limit);
        if (serpResult.success) {
          return serpResult;
        }

        // Both failed
        return {
          success: false,
          error: `Twitter search failed: ${twitterResult.error}. SerpAPI fallback: ${serpResult.error}`,
        };
      }

      case 'web_search': {
        const query = String(toolInput.query ?? '').trim();
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 5), 1), 10);
        if (!query) {
          return { success: false, error: 'Missing query' };
        }

        const serpResult = await searchWebViaSerpApi(query, limit);
        if (serpResult.success) {
          return serpResult;
        }

        const braveResult = await searchWebViaBrave(query, limit);
        if (braveResult.success) {
          return braveResult;
        }

        return {
          success: false,
          error: `Web search failed: SerpAPI: ${serpResult.error}. Brave: ${braveResult.error}`,
        };
      }

      case 'get_portfolio': {
        return getPortfolio(ctx);
      }

      case 'get_predictions': {
        const limit = Math.max(Number(toolInput.limit ?? 20), 1);
        const status = String(toolInput.status ?? 'all');
        return getPredictions(limit, status);
      }

      case 'get_order_book': {
        const marketId = String(toolInput.market_id ?? '').trim();
        const depth = Math.min(Math.max(Number(toolInput.depth ?? 5), 1), 20);
        if (!marketId) {
          return { success: false, error: 'Missing market_id' };
        }
        return getOrderBook(ctx, marketId, depth);
      }

      case 'price_history': {
        const marketId = String(toolInput.market_id ?? '').trim();
        const interval = String(toolInput.interval ?? '1d');
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 30), 1), 365);
        if (!marketId) {
          return { success: false, error: 'Missing market_id' };
        }
        return getPriceHistory(ctx, marketId, interval, limit);
      }

      case 'web_fetch': {
        const url = String(toolInput.url ?? '').trim();
        const maxChars = Math.min(Math.max(Number(toolInput.max_chars ?? 10000), 100), 50000);
        if (!url) {
          return { success: false, error: 'Missing URL' };
        }
        if (!isSafeUrl(url)) {
          return { success: false, error: 'URL is not allowed' };
        }
        return fetchAndExtract(url, maxChars);
      }

      case 'place_bet': {
        const marketId = String(toolInput.market_id ?? '').trim();
        const outcome = String(toolInput.outcome ?? '').toUpperCase() as 'YES' | 'NO';
        const amount = Number(toolInput.amount ?? 0);
        const reasoning = String(toolInput.reasoning ?? '');

        if (!marketId) {
          return { success: false, error: 'Missing market_id' };
        }
        if (outcome !== 'YES' && outcome !== 'NO') {
          return { success: false, error: 'Outcome must be YES or NO' };
        }
        if (amount <= 0) {
          return { success: false, error: 'Amount must be positive' };
        }
        if (!ctx.executor) {
          return { success: false, error: 'Trading is not enabled (no executor configured)' };
        }
        if (!ctx.limiter) {
          return { success: false, error: 'Trading is not enabled (no spending limiter configured)' };
        }

        // Fetch market details
        let market: Market;
        try {
          market = await ctx.marketClient.getMarket(marketId);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: `Failed to fetch market: ${message}` };
        }

        // Check exposure limits
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
            error: `Trade blocked: ${exposureCheck.reason ?? 'exposure limit exceeded'}`,
          };
        }

        // Check spending limits
        const limitCheck = await ctx.limiter.checkAndReserve(amount);
        if (!limitCheck.allowed) {
          return {
            success: false,
            error: `Trade blocked: ${limitCheck.reason ?? 'spending limit exceeded'}`,
          };
        }

        // Build trade decision
        const decision: TradeDecision = {
          action: 'buy',
          outcome,
          amount,
          confidence: 'medium',
          reasoning: reasoning || 'Placed via place_bet tool',
        };

        // Execute the trade
        const result = await ctx.executor.execute(market, decision);

        if (result.executed) {
          // Confirm the spending
          ctx.limiter.confirm(amount);

          // Record prediction for calibration tracking
          const yesPrice =
            market.prices?.['Yes'] ??
            market.prices?.['YES'] ??
            (Array.isArray(market.prices) ? market.prices[0] : null) ??
            0.5;
          const price = outcome === 'YES' ? yesPrice : 1 - yesPrice;

          createPrediction({
            marketId: market.id,
            marketTitle: market.question ?? marketId,
            predictedOutcome: outcome,
            predictedProbability: typeof price === 'number' ? price : 0.5,
            confidenceLevel: 'medium',
            reasoning: reasoning || 'Placed via place_bet tool',
            domain: market.category ?? undefined,
            executed: true,
            executionPrice: typeof price === 'number' ? price : 0.5,
            positionSize: amount,
          });

          return {
            success: true,
            data: {
              executed: true,
              market_id: market.id,
              market_title: market.question,
              outcome,
              amount,
              message: result.message,
            },
          };
        } else {
          // Release the reserved amount
          ctx.limiter.release(amount);
          return {
            success: false,
            error: result.message || 'Trade execution failed',
          };
        }
      }

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

function normalizePrice(market: Market, outcome: 'Yes' | 'No'): number | null {
  const fromMap =
    market.prices?.[outcome] ??
    market.prices?.[outcome.toUpperCase()] ??
    undefined;
  if (typeof fromMap === 'number') {
    return fromMap;
  }
  if (Array.isArray(market.prices)) {
    const index = outcome === 'Yes' ? 0 : 1;
    const value = market.prices[index];
    return typeof value === 'number' ? value : null;
  }
  return null;
}

function formatMarketsForTool(markets: Market[]): object[] {
  return markets.map((market) => ({
    id: market.id,
    question: market.question,
    outcomes: market.outcomes,
    yes_price: normalizePrice(market, 'Yes'),
    no_price: normalizePrice(market, 'No'),
    volume: market.volume ?? null,
    category: market.category ?? null,
  }));
}

function formatMarketForTool(market: Market): object {
  return {
    id: market.id,
    question: market.question,
    outcomes: market.outcomes,
    yes_price: normalizePrice(market, 'Yes'),
    no_price: normalizePrice(market, 'No'),
    volume: market.volume ?? null,
    liquidity: market.liquidity ?? null,
    category: market.category ?? null,
    end_date: market.endDate ?? null,
    resolved: market.resolved ?? false,
  };
}

function formatIntelForTool(items: StoredIntel[]): object[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    source: item.source,
    timestamp: item.timestamp,
    url: item.url,
    summary: item.content?.slice(0, 500) ?? null,
  }));
}

async function getPortfolio(ctx: ToolExecutorContext): Promise<ToolResult> {
  try {
    const positions = listOpenPositions(50);
    const positionRows = await Promise.all(
      positions.map(async (position) => {
        const outcome = (position.predictedOutcome ?? 'YES').toUpperCase();
        let currentPrice = resolveCurrentPrice(position);

        if (currentPrice == null) {
          try {
            const market = await ctx.marketClient.getMarket(position.marketId);
            currentPrice =
              market.prices?.[outcome] ??
              market.prices?.[outcome.toUpperCase()] ??
              (Array.isArray(market.prices)
                ? outcome === 'YES'
                  ? market.prices[0]
                  : market.prices[1]
                : null) ??
              null;
          } catch {
            currentPrice = null;
          }
        }

        const executionPrice = position.executionPrice ?? null;
        const positionSize = position.positionSize ?? 0;
        const shares =
          executionPrice && executionPrice > 0 ? positionSize / executionPrice : null;
        const currentValue =
          shares != null && currentPrice != null ? shares * currentPrice : null;
        const costBasis = positionSize;
        const unrealizedPnl =
          currentValue != null ? currentValue - costBasis : null;

        return {
          market_id: position.marketId,
          market_question: position.marketTitle,
          outcome,
          shares,
          avg_price: executionPrice,
          current_price: currentPrice,
          cost_basis: costBasis,
          current_value: currentValue,
          unrealized_pnl: unrealizedPnl,
          pnl_percent:
            executionPrice && currentPrice != null
              ? `${(((currentPrice - executionPrice) / executionPrice) * 100).toFixed(1)}%`
              : null,
        };
      })
    );

    const totals = positionRows.reduce(
      (acc, position) => {
        acc.totalCost += position.cost_basis ?? 0;
        if (position.current_value != null) {
          acc.totalValue += position.current_value;
        }
        return acc;
      },
      { totalCost: 0, totalValue: 0 }
    );

    const balances = await getBalances(ctx);
    const limiterState = ctx.limiter?.getState?.();
    const dailyLimit = ctx.config.wallet?.limits?.daily ?? 100;
    const remainingDaily =
      limiterState != null
        ? Math.max(0, dailyLimit - limiterState.todaySpent - limiterState.reserved)
        : null;

    return {
      success: true,
      data: {
        balances,
        positions: positionRows,
        summary: {
          total_positions: positionRows.length,
          total_value: totals.totalValue,
          total_cost: totals.totalCost,
          unrealized_pnl: totals.totalValue - totals.totalCost,
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

function resolveCurrentPrice(position: {
  currentPrices?: Record<string, unknown> | null;
  predictedOutcome?: string;
}): number | null {
  const currentPrices = position.currentPrices ?? undefined;
  if (!currentPrices) return null;
  const outcome = (position.predictedOutcome ?? 'YES').toUpperCase();
  const direct = currentPrices[outcome] ?? currentPrices[outcome.toLowerCase()];
  if (typeof direct === 'number') {
    return direct;
  }
  if (Array.isArray(currentPrices)) {
    const index = outcome === 'YES' ? 0 : 1;
    const value = currentPrices[index];
    return typeof value === 'number' ? value : null;
  }
  return null;
}

async function getBalances(ctx: ToolExecutorContext): Promise<{
  usdc?: number;
  matic?: number;
  source: string;
}> {
  if (ctx.config.execution?.mode !== 'live') {
    return { usdc: getCashBalance(), matic: 0, source: 'paper' };
  }

  const password = process.env.BIJAZ_WALLET_PASSWORD;
  if (!password) {
    return { usdc: getCashBalance(), matic: 0, source: 'memory' };
  }

  try {
    const wallet = loadWallet(ctx.config, password);
    const balances = await getWalletBalances(wallet);
    if (!balances) {
      return { usdc: getCashBalance(), matic: 0, source: 'memory' };
    }
    return { usdc: balances.usdc ?? 0, matic: balances.matic ?? 0, source: 'chain' };
  } catch {
    return { usdc: getCashBalance(), matic: 0, source: 'memory' };
  }
}

function getPredictions(limit: number, status: string): ToolResult {
  const fetchLimit = Math.max(limit, 50);
  const predictions = listPredictions({ limit: fetchLimit });

  const normalizedStatus = status.toLowerCase();
  const filtered = predictions.filter((prediction) => {
    const resolved = prediction.outcome != null;
    const correct =
      resolved &&
      prediction.predictedOutcome != null &&
      prediction.predictedOutcome.toUpperCase() === prediction.outcome?.toUpperCase();

    switch (normalizedStatus) {
      case 'pending':
        return !resolved;
      case 'resolved':
        return resolved;
      case 'won':
        return Boolean(correct);
      case 'lost':
        return resolved && !correct;
      case 'all':
      default:
        return true;
    }
  });

  const sliced = filtered.slice(0, limit);
  const resolved = sliced.filter((prediction) => prediction.outcome != null);
  const wins = resolved.filter(
    (prediction) =>
      prediction.predictedOutcome != null &&
      prediction.outcome != null &&
      prediction.predictedOutcome.toUpperCase() === prediction.outcome.toUpperCase()
  );
  const losses = resolved.filter(
    (prediction) =>
      prediction.predictedOutcome != null &&
      prediction.outcome != null &&
      prediction.predictedOutcome.toUpperCase() !== prediction.outcome.toUpperCase()
  );

  const totalBet = sliced.reduce((sum, prediction) => {
    return sum + (prediction.positionSize ?? 0);
  }, 0);
  const totalReturn = resolved.reduce((sum, prediction) => {
    if (
      prediction.positionSize &&
      prediction.executionPrice &&
      prediction.executionPrice > 0 &&
      prediction.predictedOutcome &&
      prediction.outcome &&
      prediction.predictedOutcome.toUpperCase() === prediction.outcome.toUpperCase()
    ) {
      return sum + prediction.positionSize / prediction.executionPrice;
    }
    return sum;
  }, 0);

  return {
    success: true,
    data: {
      predictions: sliced.map((prediction) => ({
        id: prediction.id,
        market: prediction.marketTitle,
        outcome: prediction.predictedOutcome ?? null,
        amount: prediction.positionSize ?? null,
        entry_price: prediction.executionPrice ?? null,
        reasoning: prediction.reasoning ?? null,
        timestamp: prediction.createdAt,
        resolved: prediction.outcome != null,
        correct:
          prediction.outcome != null &&
          prediction.predictedOutcome != null &&
          prediction.predictedOutcome.toUpperCase() === prediction.outcome.toUpperCase(),
        resolution: prediction.outcome ?? null,
      })),
      stats: {
        total: sliced.length,
        pending: sliced.length - resolved.length,
        resolved: resolved.length,
        wins: wins.length,
        losses: losses.length,
        win_rate:
          resolved.length > 0
            ? `${((wins.length / resolved.length) * 100).toFixed(1)}%`
            : 'N/A',
        total_bet: totalBet,
        total_return: totalReturn,
        roi:
          totalBet > 0 ? `${(((totalReturn - totalBet) / totalBet) * 100).toFixed(1)}%` : 'N/A',
      },
    },
  };
}

async function getOrderBook(
  ctx: ToolExecutorContext,
  marketId: string,
  depth: number
): Promise<ToolResult> {
  try {
    const market = await ctx.marketClient.getMarket(marketId);
    const clobUrl = ctx.config.polymarket.api.clob.replace(/\/$/, '');
    const yesToken = resolveTokenId(market, 'YES');
    const noToken = resolveTokenId(market, 'NO');

    if (!yesToken || !noToken) {
      return { success: false, error: 'Could not find token IDs for market' };
    }

    const yesBook = await fetchOrderBook(clobUrl, yesToken);
    const noBook = await fetchOrderBook(clobUrl, noToken);

    return {
      success: true,
      data: {
        market_id: marketId,
        question: market.question,
        yes: formatOrderBook(yesBook, depth),
        no: formatOrderBook(noBook, depth),
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

function resolveTokenId(market: Market, outcome: 'YES' | 'NO'): string | null {
  if (market.clobTokenIds && market.clobTokenIds.length >= 2) {
    return outcome === 'YES' ? market.clobTokenIds[0] : market.clobTokenIds[1];
  }
  if (market.tokens && market.tokens.length > 0) {
    const match = market.tokens.find((token) => {
      const tokenOutcome = (token.outcome ?? '').toUpperCase();
      return tokenOutcome === outcome || tokenOutcome.includes(outcome);
    });
    if (match?.token_id) return match.token_id;
  }
  return null;
}

async function fetchOrderBook(clobUrl: string, tokenId: string): Promise<OrderBookResponse> {
  const url = `${clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Order book fetch failed: ${response.status}`);
  }
  return (await response.json()) as OrderBookResponse;
}

function formatOrderBook(book: OrderBookResponse, depth: number) {
  const bids = (book.bids ?? []).slice(0, depth).map((level) => ({
    price: level.price,
    size: level.size,
  }));
  const asks = (book.asks ?? []).slice(0, depth).map((level) => ({
    price: level.price,
    size: level.size,
  }));
  return {
    best_bid: bids[0]?.price ?? null,
    best_ask: asks[0]?.price ?? null,
    spread: calculateSpread(book),
    bids,
    asks,
  };
}

function calculateSpread(book: OrderBookResponse): number | null {
  const bestBid = book.bids?.[0]?.price;
  const bestAsk = book.asks?.[0]?.price;
  if (bestBid == null || bestAsk == null) return null;
  return bestAsk - bestBid;
}

function assessLiquidity(yesBook: OrderBookResponse, noBook: OrderBookResponse): string | null {
  const yesDepth =
    (yesBook.bids ?? []).reduce((sum, level) => sum + level.size, 0) +
    (yesBook.asks ?? []).reduce((sum, level) => sum + level.size, 0);
  const noDepth =
    (noBook.bids ?? []).reduce((sum, level) => sum + level.size, 0) +
    (noBook.asks ?? []).reduce((sum, level) => sum + level.size, 0);

  if (yesDepth < 100 || noDepth < 100) {
    return 'LOW LIQUIDITY - Large orders may experience significant slippage';
  }
  if (yesDepth < 500 || noDepth < 500) {
    return 'MODERATE LIQUIDITY - Consider splitting large orders';
  }
  return null;
}

async function getPriceHistory(
  ctx: ToolExecutorContext,
  marketId: string,
  interval: string,
  limit: number
): Promise<ToolResult> {
  try {
    const gammaUrl = ctx.config.polymarket.api.gamma.replace(/\/$/, '');
    const url = new URL(`${gammaUrl}/markets/${marketId}/prices`);
    url.searchParams.set('interval', interval);
    url.searchParams.set('limit', String(limit));
    const response = await fetch(url.toString());
    if (!response.ok) {
      return { success: false, error: `Price history fetch failed: ${response.status}` };
    }
    const data = (await response.json()) as {
      prices?: Array<Record<string, unknown>>;
    };
    const series = Array.isArray(data) ? data : data.prices ?? data;
    return {
      success: true,
      data: {
        market_id: marketId,
        interval,
        limit,
        series,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Search Twitter directly via Twitter API v2
 */
async function searchTwitterDirect(
  query: string,
  limit: number,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const bearer =
    ctx.config.intel?.sources?.twitter?.bearerToken ?? process.env.TWITTER_BEARER;
  if (!bearer) {
    return { success: false, error: 'Twitter bearer token not configured' };
  }

  try {
    const baseUrl =
      ctx.config.intel?.sources?.twitter?.baseUrl ?? 'https://api.twitter.com/2';
    const url = new URL(`${baseUrl}/tweets/search/recent`);
    url.searchParams.set('query', `${query} -is:retweet lang:en`);
    url.searchParams.set('max_results', String(Math.max(10, limit)));
    url.searchParams.set('tweet.fields', 'created_at,author_id,public_metrics');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'username,name');

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${bearer}` },
    });

    if (!response.ok) {
      return { success: false, error: `Twitter API: ${response.status}` };
    }

    const data = (await response.json()) as {
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
      (data.includes?.users ?? []).map((u) => [u.id, u])
    );

    const tweets = (data.data ?? []).map((tweet) => {
      const text = (tweet.text ?? '').replace(/\s+/g, ' ').trim();
      return {
        id: tweet.id,
        text,
        author: users.get(tweet.author_id ?? '')?.username ?? 'unknown',
        likes: tweet.public_metrics?.like_count ?? 0,
        retweets: tweet.public_metrics?.retweet_count ?? 0,
        url: `https://twitter.com/i/status/${tweet.id}`,
        timestamp: tweet.created_at ?? null,
      };
    });

    return { success: true, data: tweets };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Search Twitter via SerpAPI (fallback)
 */
async function searchTwitterViaSerpApi(
  query: string,
  limit: number
): Promise<ToolResult> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return { success: false, error: 'SerpAPI key not configured' };
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

    const data = (await response.json()) as {
      tweets?: Array<{
        text?: string;
        user?: { screen_name?: string };
        created_at?: string;
        likes?: number;
        retweets?: number;
        link?: string;
      }>;
    };

    const tweets = (data.tweets ?? []).slice(0, limit).map((tweet) => ({
      text: (tweet.text ?? '').replace(/\s+/g, ' ').trim(),
      author: tweet.user?.screen_name ?? 'unknown',
      likes: tweet.likes ?? 0,
      retweets: tweet.retweets ?? 0,
      url: tweet.link ?? null,
      timestamp: tweet.created_at ?? null,
    }));

    return { success: true, data: tweets };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
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

    const results = (data.organic_results ?? []).slice(0, limit).map((item) => ({
      title: item.title ?? '',
      url: item.link ?? '',
      snippet: item.snippet ?? '',
      date: item.date ?? null,
      source: item.source ?? null,
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
        Accept: 'application/json',
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

    const results = (data.web?.results ?? []).slice(0, limit).map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.description ?? '',
      date: item.age ?? null,
    }));

    return { success: true, data: { query, provider: 'brave', results } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

function isSafeUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return false;
  }
  if (hostname === 'metadata.google.internal') {
    return false;
  }

  const ipType = isIP(hostname);
  if (ipType === 0) {
    return true;
  }

  if (ipType === 4) {
    const parts = hostname.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
      return false;
    }
    const [a, b] = parts;
    if (a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && typeof b === 'number' && b >= 16 && b <= 31) return false;
    return true;
  }

  if (ipType === 6) {
    const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '');
    if (normalized === '::1') return false;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
    if (normalized.startsWith('fe80')) return false;
  }

  return true;
}

async function fetchAndExtract(url: string, maxChars: number): Promise<ToolResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Bijaz/1.0; +https://github.com/bijaz)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      return { success: false, error: `Fetch failed: ${response.status}` };
    }

    const maxBytes = 2_000_000;
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
      return { success: false, error: 'Response too large' };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      return { success: false, error: 'Response too large' };
    }

    const body = new TextDecoder().decode(buffer);

    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      const truncated = body.length > maxChars;
      return {
        success: true,
        data: {
          url,
          title: null,
          content: body.slice(0, maxChars),
          truncated,
        },
      };
    }

    const dom = new JSDOM(body, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) {
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
  } finally {
    clearTimeout(timeout);
  }
}
