/**
 * Thufir - Autonomous Market Discovery Companion
 *
 * Main entry point for the Thufir library.
 */

import { loadConfig, type ThufirConfig } from './core/config.js';
import { createLlmClient, createTrivialTaskClient } from './core/llm.js';
import { ConversationHandler } from './core/conversation.js';
import { createMarketClient, type MarketClient } from './execution/market-client.js';
import { PaperExecutor } from './execution/modes/paper.js';
import { WebhookExecutor } from './execution/modes/webhook.js';
import { UnsupportedLiveExecutor } from './execution/modes/unsupported-live.js';
import { HyperliquidLiveExecutor } from './execution/modes/hyperliquid-live.js';
import type { ExecutionAdapter } from './execution/executor.js';
import { DbSpendingLimitEnforcer } from './execution/wallet/limits_db.js';
import { listCalibrationSummaries } from './memory/calibration.js';
import { checkPerpRiskLimits } from './execution/perp-risk.js';
import { executeToolCall } from './core/tool-executor.js';
import { TradeManagementService } from './trade-management/service.js';
import type { ExpressionPlan } from './discovery/types.js';
import { buildTradeEnvelopeFromExpression } from './trade-management/envelope.js';
import { recordTradeEnvelope, recordTradeSignals } from './trade-management/db.js';
import { placeExchangeSideTpsl } from './trade-management/hyperliquid-stops.js';
import { reconcileEntryFill } from './trade-management/reconcile.js';
import { createHyperliquidCloid } from './execution/hyperliquid/cloid.js';
import { randomUUID } from 'node:crypto';

// Re-export types
export * from './types/index.js';

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
 * // Execute a perp trade (with confirmation)
 * const result = await thufir.trade({
 *   symbol: 'BTC',
 *   side: 'buy',
 *   sizeUsd: 25,
 *   leverage: 3
 * });
 * ```
 */
export class Thufir {
  private configPath?: string;
  private config!: ThufirConfig;
  private userId: string;
  private llm?: ReturnType<typeof createLlmClient>;
  private marketClient?: MarketClient;
  private executor?: ExecutionAdapter;
  private limiter?: DbSpendingLimitEnforcer;
  private conversation?: ConversationHandler;
  private tradeManagement?: TradeManagementService;
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
    this.marketClient = createMarketClient(config);
    this.executor = this.createExecutor(config);
    this.limiter = new DbSpendingLimitEnforcer({
      daily: config.wallet?.limits?.daily ?? 100,
      perTrade: config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
    });
    const infoLlm = createTrivialTaskClient(config) ?? undefined;
    this.conversation = new ConversationHandler(this.llm, this.marketClient, config, infoLlm);
    this.tradeManagement = new TradeManagementService({
      config,
      marketClient: this.marketClient,
      executor: this.executor,
      llm: this.llm,
    });
    this.tradeManagement.start();

    this.started = true;
  }

  private createExecutor(config: ThufirConfig): ExecutionAdapter {
    if (config.execution.mode === 'live') {
      if (config.execution.provider === 'hyperliquid') {
        return new HyperliquidLiveExecutor({ config });
      }
      return new UnsupportedLiveExecutor();
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

    this.tradeManagement?.stop();
    this.tradeManagement = undefined;
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
    symbol: string;
    side: 'buy' | 'sell';
    sizeUsd: number;
    leverage?: number;
    orderType?: 'market' | 'limit';
    price?: number;
    reduceOnly?: boolean;
  }): Promise<unknown> {
    this.ensureStarted();
    if (!this.marketClient || !this.executor || !this.limiter) {
      throw new Error('Trading components not initialized');
    }

    const symbol = _params.symbol;
    const side = _params.side;
    const sizeUsd = _params.sizeUsd;
    const market = await this.marketClient.getMarket(symbol);
    const markPrice = market.markPrice ?? _params.price ?? null;
    if (!markPrice || markPrice <= 0) {
      return { executed: false, message: 'Missing or invalid mark price for sizing.' };
    }
    const size = sizeUsd / markPrice;

    const riskCheck = await checkPerpRiskLimits({
      config: this.config,
      symbol,
      side,
      size,
      leverage: _params.leverage,
      reduceOnly: _params.reduceOnly ?? false,
      markPrice,
      notionalUsd: sizeUsd,
      marketMaxLeverage:
        typeof market.metadata?.maxLeverage === 'number'
          ? (market.metadata.maxLeverage as number)
          : null,
    });
    if (!riskCheck.allowed) {
      return {
        executed: false,
        message: riskCheck.reason ?? 'Trade blocked by perp risk limits',
      };
    }
    const limitCheck = await this.limiter.checkAndReserve(sizeUsd);
    if (!limitCheck.allowed) {
      return {
        executed: false,
        message: limitCheck.reason ?? 'Trade blocked by limits',
      };
    }

    const entryCloid = createHyperliquidCloid();
    const decisionStartMs = Date.now();
    const result = await this.executor.execute(market, {
      action: side,
      side,
      symbol,
      size,
      orderType: _params.orderType ?? 'market',
      price: _params.price,
      leverage: _params.leverage,
      reduceOnly: _params.reduceOnly,
      clientOrderId: entryCloid,
      confidence: 'medium',
      reasoning: `Programmatic trade for ${this.userId}`,
    });

    if (result.executed) {
      this.limiter.confirm(sizeUsd);
    } else {
      this.limiter.release(sizeUsd);
    }

    // Best-effort: record envelope + place bracket TP/SL for programmatic entries (non-reduce-only).
    try {
      if (result.executed && !_params.reduceOnly && typeof markPrice === 'number' && markPrice > 0) {
        let entryPrice = markPrice;
        let entryFeesUsd: number | null = null;
        if (this.config.execution?.mode === 'live') {
          const rec = await reconcileEntryFill({
            config: this.config,
            symbol,
            entryCloid,
            startTimeMs: decisionStartMs,
          });
          if (rec.avgPx != null) entryPrice = rec.avgPx;
          entryFeesUsd = rec.feesUsd;
        }

        const expr: ExpressionPlan = {
          id: `program_${Date.now()}_${randomUUID()}`,
          hypothesisId: `program_${Date.now()}_${randomUUID()}`,
          symbol,
          side,
          confidence: 0.5,
          expectedEdge: 0,
          entryZone: 'market',
          invalidation: '',
          expectedMove: '',
          orderType: (_params.orderType ?? 'market') as 'market' | 'limit',
          leverage: _params.leverage ?? this.config.hyperliquid?.maxLeverage ?? 1,
          probeSizeUsd: sizeUsd,
          thesis: `Programmatic trade for ${this.userId}`,
          signalKinds: [],
        };

        const envelope = buildTradeEnvelopeFromExpression({
          config: this.config,
          tradeId: `perp_program_${Date.now()}_${randomUUID()}`,
          expr,
          entryPrice,
          size,
          notionalUsd: sizeUsd,
          entryCloid,
          entryFeesUsd,
        });
        recordTradeEnvelope(envelope);
        recordTradeSignals({ tradeId: envelope.tradeId, symbol: envelope.symbol, signals: [] });

        const stops = await placeExchangeSideTpsl({ config: this.config, envelope });
        if (stops.tpOid || stops.slOid) {
          envelope.tpOid = stops.tpOid;
          envelope.slOid = stops.slOid;
          recordTradeEnvelope(envelope);
        }
      }
    } catch {
      // never fail the programmatic trade call due to journaling issues
    }

    return result;
  }

  /**
   * Get portfolio.
   */
  async getPortfolio(): Promise<unknown> {
    this.ensureStarted();
    if (!this.marketClient || !this.executor || !this.limiter) {
      throw new Error('Trading components not initialized');
    }
    const toolContext = {
      config: this.config,
      marketClient: this.marketClient,
      executor: this.executor,
      limiter: this.limiter,
    };
    return executeToolCall('get_portfolio', {}, toolContext);
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
