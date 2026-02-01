/**
 * Thufir - Prediction Market AI Companion
 *
 * Main entry point for the Thufir library.
 */

import { loadConfig, type ThufirConfig } from './core/config.js';
import { createLlmClient } from './core/llm.js';
import { ConversationHandler } from './core/conversation.js';
import { PolymarketMarketClient } from './execution/polymarket/markets.js';
import { PaperExecutor } from './execution/modes/paper.js';
import { WebhookExecutor } from './execution/modes/webhook.js';
import { LiveExecutor } from './execution/modes/live.js';
import type { ExecutionAdapter } from './execution/executor.js';
import { DbSpendingLimitEnforcer } from './execution/wallet/limits_db.js';
import { listCalibrationSummaries } from './memory/calibration.js';
import { listOpenPositions } from './memory/predictions.js';
import { listOpenPositionsFromTrades } from './memory/trades.js';
import { getCashBalance } from './memory/portfolio.js';
import { explainPrediction } from './core/explain.js';
import { checkExposureLimits } from './core/exposure.js';

// Re-export types
export * from './types/index.js';

// Re-export wallet security components
export {
  isWhitelisted,
  assertWhitelisted,
  WhitelistError,
  getWhitelistedAddresses,
  POLYMARKET_WHITELIST,
} from './execution/wallet/whitelist.js';

export {
  SpendingLimitEnforcer,
  LimitExceededError,
  type SpendingLimits,
  type SpendingState,
  type LimitCheckResult,
} from './execution/wallet/limits.js';

// Version
export const VERSION = '0.1.0';

/**
 * Thufir client for programmatic access.
 *
 * @example
 * ```typescript
 * import { Thufir } from 'thufir';
 *
 * const thufir = new Thufir({
 *   configPath: '~/.thufir/config.yaml'
 * });
 *
 * await thufir.start();
 *
 * // Analyze a market
 * const analysis = await thufir.analyze('fed-rate-decision');
 *
 * // Execute a trade (with confirmation)
 * const result = await thufir.trade({
 *   marketId: 'abc123',
 *   outcome: 'YES',
 *   amount: 25
 * });
 * ```
 */
export class Thufir {
  private configPath?: string;
  private config!: ThufirConfig;
  private userId: string;
  private llm?: ReturnType<typeof createLlmClient>;
  private marketClient?: PolymarketMarketClient;
  private executor?: ExecutionAdapter;
  private limiter?: DbSpendingLimitEnforcer;
  private conversation?: ConversationHandler;
  private started: boolean = false;

  constructor(options?: { configPath?: string; userId?: string }) {
    this.configPath = options?.configPath;
    this.userId = options?.userId ?? 'programmatic';
  }

  /**
   * Start the Thufir agent.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Thufir already started');
    }

    const config = loadConfig(this.configPath);
    this.config = config;
    if (config.memory?.dbPath) {
      process.env.THUFIR_DB_PATH = config.memory.dbPath;
    }

    this.llm = createLlmClient(config);
    this.marketClient = new PolymarketMarketClient(config);
    this.executor = this.createExecutor(config);
    this.limiter = new DbSpendingLimitEnforcer({
      daily: config.wallet?.limits?.daily ?? 100,
      perTrade: config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
    });
    this.conversation = new ConversationHandler(this.llm, this.marketClient, config);

    this.started = true;
  }

  private createExecutor(config: ThufirConfig): ExecutionAdapter {
    if (config.execution.mode === 'live') {
      const password = process.env.THUFIR_WALLET_PASSWORD;
      if (!password) {
        throw new Error(
          'Live execution mode requires THUFIR_WALLET_PASSWORD environment variable'
        );
      }
      return new LiveExecutor({ config, password });
    }

    if (config.execution.mode === 'webhook' && config.execution.webhookUrl) {
      return new WebhookExecutor(config.execution.webhookUrl);
    }

    return new PaperExecutor();
  }

  /**
   * Stop the Thufir agent.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.conversation = undefined;
    this.limiter = undefined;
    this.executor = undefined;
    this.marketClient = undefined;
    this.llm = undefined;
    this.started = false;
  }

  /**
   * Analyze a market.
   */
  async analyze(_marketId: string): Promise<unknown> {
    this.ensureStarted();
    if (!this.conversation) {
      throw new Error('Conversation handler not initialized');
    }
    return this.conversation.analyzeMarket(this.userId, _marketId);
  }

  /**
   * Analyze a market with structured output.
   */
  async analyzeStructured(_marketId: string): Promise<unknown> {
    this.ensureStarted();
    if (!this.conversation) {
      throw new Error('Conversation handler not initialized');
    }
    return this.conversation.analyzeMarketStructured(this.userId, _marketId);
  }

  /**
   * Execute a trade.
   */
  async trade(_params: {
    marketId: string;
    outcome: 'YES' | 'NO';
    amount: number;
  }): Promise<unknown> {
    this.ensureStarted();
    if (!this.marketClient || !this.executor || !this.limiter) {
      throw new Error('Trading components not initialized');
    }

    const market = await this.marketClient.getMarket(_params.marketId);
    const exposureCheck = checkExposureLimits({
      config: this.config,
      market,
      outcome: _params.outcome,
      amount: _params.amount,
      side: 'buy',
    });
    if (!exposureCheck.allowed) {
      return {
        executed: false,
        message: exposureCheck.reason ?? 'Trade blocked by exposure limits',
      };
    }
    const limitCheck = await this.limiter.checkAndReserve(_params.amount);
    if (!limitCheck.allowed) {
      return {
        executed: false,
        message: limitCheck.reason ?? 'Trade blocked by limits',
      };
    }

    const result = await this.executor.execute(market, {
      action: 'buy',
      outcome: _params.outcome,
      amount: _params.amount,
      confidence: 'medium',
      reasoning: `Programmatic trade for ${this.userId}`,
    });

    if (result.executed) {
      this.limiter.confirm(_params.amount);
    } else {
      this.limiter.release(_params.amount);
    }

    return result;
  }

  /**
   * Get portfolio.
   */
  async getPortfolio(): Promise<unknown> {
    this.ensureStarted();
    const positions = (() => {
      const fromTrades = listOpenPositionsFromTrades(200);
      return fromTrades.length > 0 ? fromTrades : listOpenPositions(200);
    })();
    const cashBalance = getCashBalance();

    const formatted = positions.map((position) => {
      const outcome = position.predictedOutcome ?? 'YES';
      const prices = position.currentPrices ?? null;
      let currentPrice: number | null = null;
      if (Array.isArray(prices)) {
        currentPrice = outcome === 'YES' ? prices[0] ?? null : prices[1] ?? null;
      } else if (prices) {
        currentPrice =
          prices[outcome] ??
          prices[outcome.toUpperCase()] ??
          prices[outcome.toLowerCase()] ??
          prices[outcome === 'YES' ? 'Yes' : 'No'] ??
          prices[outcome === 'YES' ? 'yes' : 'no'] ??
          null;
      }

      const averagePrice = position.executionPrice ?? currentPrice ?? 0;
      const positionSize = position.positionSize ?? 0;
      const netShares =
        typeof (position as { netShares?: number | null }).netShares === 'number'
          ? Number((position as { netShares?: number | null }).netShares)
          : null;
      const shares =
        netShares !== null ? netShares : averagePrice > 0 ? positionSize / averagePrice : 0;
      const price = currentPrice ?? averagePrice;
      const value = shares * price;
      const unrealizedPnl = value - positionSize;
      const unrealizedPnlPercent =
        positionSize > 0 ? (unrealizedPnl / positionSize) * 100 : 0;
      const realizedPnl =
        typeof (position as { realizedPnl?: number | null }).realizedPnl === 'number'
          ? Number((position as { realizedPnl?: number | null }).realizedPnl)
          : undefined;

      return {
        marketId: position.marketId,
        marketTitle: position.marketTitle,
        outcome,
        shares,
        averagePrice,
        currentPrice: price,
        value,
        unrealizedPnl,
        unrealizedPnlPercent,
        realizedPnl,
      };
    });

    const totalValue = formatted.reduce((sum, p) => sum + p.value, 0);
    const totalCost = formatted.reduce((sum, p) => sum + p.shares * p.averagePrice, 0);
    const totalPnl = totalValue - totalCost;
    const totalPnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

    const totalEquity = cashBalance + totalValue;

    return {
      positions: formatted,
      totalValue,
      totalCost,
      totalPnl,
      totalPnlPercent,
      cashBalance,
      totalEquity,
    };
  }

  /**
   * Get calibration stats.
   */
  async getCalibration(_domain?: string): Promise<unknown> {
    this.ensureStarted();
    const summaries = listCalibrationSummaries();
    if (_domain) {
      return summaries.filter((summary) => summary.domain === _domain);
    }
    return summaries;
  }

  /**
   * Explain a prediction decision.
   */
  async explainPrediction(predictionId: string): Promise<string> {
    this.ensureStarted();
    return explainPrediction({ predictionId, config: this.config, llm: this.llm });
  }

  /**
   * Chat with the agent.
   */
  async chat(_message: string): Promise<string> {
    this.ensureStarted();
    if (!this.conversation) {
      throw new Error('Conversation handler not initialized');
    }
    return this.conversation.chat(this.userId, _message);
  }

  private ensureStarted(): void {
    if (!this.started) {
      throw new Error('Thufir not started. Call start() first.');
    }
  }
}
