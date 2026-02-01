/**
 * Live Execution Adapter
 *
 * Executes real trades on Polymarket via the CLOB API.
 *
 * CRITICAL SECURITY COMPONENT
 *
 * This adapter integrates:
 * - CLOB client for API communication
 * - Order signer for building and signing orders
 * - Spending limits for risk control
 * - Address whitelist for security
 * - Audit logging for compliance
 */

import { ethers } from 'ethers';

import type { ExecutionAdapter, TradeDecision, TradeResult } from '../executor.js';
import type { Market } from '../polymarket/markets.js';
import type { ThufirConfig } from '../../core/config.js';
import type { ApiKeyCredentials } from '../polymarket/clob.js';

import { PolymarketCLOBClient, CLOBError } from '../polymarket/clob.js';
import { PolymarketOrderSigner, usdToShares, EXCHANGE_ADDRESSES } from '../polymarket/signer.js';
import { SpendingLimitEnforcer, LimitExceededError } from '../wallet/limits.js';
import { assertWhitelisted, WhitelistError } from '../wallet/whitelist.js';
import { loadWallet } from '../wallet/manager.js';
import { createPrediction, recordExecution } from '../../memory/predictions.js';
import { recordTrade } from '../../memory/trades.js';
import { logWalletOperation } from '../../memory/audit.js';

// ============================================================================
// Types
// ============================================================================

export interface LiveExecutorOptions {
  config: ThufirConfig;
  password: string;
  credentials?: ApiKeyCredentials;
}

export interface OrderStatus {
  orderId: string;
  status: 'pending' | 'live' | 'matched' | 'partially_matched' | 'cancelled' | 'failed';
  filledSize?: number;
  averagePrice?: number;
  transactionHash?: string;
  error?: string;
}

// ============================================================================
// Live Executor
// ============================================================================

export class LiveExecutor implements ExecutionAdapter {
  private wallet: ethers.Wallet;
  private clobClient: PolymarketCLOBClient;
  private signer: PolymarketOrderSigner;
  private limits: SpendingLimitEnforcer;
  private initialized: boolean = false;
  private tokenIdCache: Map<string, [string, string]> = new Map(); // conditionId -> [yesTokenId, noTokenId]

  constructor(options: LiveExecutorOptions) {
    // Load wallet
    this.wallet = loadWallet(options.config, options.password);

    // Initialize CLOB client
    this.clobClient = new PolymarketCLOBClient(options.config);
    this.clobClient.setWallet(this.wallet);

    // Set credentials if provided
    if (options.credentials) {
      this.clobClient.setCredentials(options.credentials);
    }

    // Initialize signer
    this.signer = new PolymarketOrderSigner(this.wallet);

    // Initialize spending limits
    this.limits = new SpendingLimitEnforcer({
      daily: options.config.wallet?.limits?.daily ?? 100,
      perTrade: options.config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: options.config.wallet?.limits?.confirmationThreshold ?? 10,
    });

    // Set up limit event handlers
    this.limits.on('limit-exceeded', (data) => {
      logWalletOperation({
        operation: 'reject',
        amount: data.attempted,
        status: 'rejected',
        reason: `${data.type} limit exceeded: ${data.attempted} > ${data.limit}`,
      });
    });

    this.limits.on('limit-warning', (data) => {
      console.warn(`[LiveExecutor] Approaching ${data.type} limit: ${data.current}/${data.limit}`);
    });
  }

  /**
   * Initialize the executor by deriving API credentials if not provided.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.clobClient.isAuthenticated()) {
      try {
        // Try to derive existing API key first
        await this.clobClient.deriveApiKey();
      } catch {
        // If derivation fails, create a new API key
        await this.clobClient.createApiKey();
      }
    }

    this.initialized = true;
  }

  /**
   * Get the wallet address.
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Execute a trade decision.
   */
  async execute(market: Market, decision: TradeDecision): Promise<TradeResult> {
    // Ensure initialized
    await this.initialize();

    // Handle hold decisions
    if (decision.action === 'hold') {
      return { executed: false, message: 'Hold decision; no trade executed.' };
    }

    // Validate decision
    if (!decision.amount || !decision.outcome) {
      return { executed: false, message: 'Invalid decision: missing amount or outcome.' };
    }

    // Get token ID for the outcome - first try local, then fetch from CLOB
    let tokenId = this.getTokenId(market, decision.outcome);
    if (!tokenId) {
      // Fetch from CLOB API (authoritative source)
      const tokenIds = await this.fetchAndCacheTokenIds(market);
      if (!tokenIds) {
        return {
          executed: false,
          message: `Cannot find token IDs for market ${market.id} (condition: ${market.conditionId}). ` +
            `Market may not be available on CLOB.`,
        };
      }
      tokenId = decision.outcome === 'YES' ? tokenIds[0] : tokenIds[1];
    }

    // Get current price
    const price = market.prices?.[decision.outcome];
    if (!price || price <= 0 || price >= 1) {
      return {
        executed: false,
        message: `Invalid price ${price} for outcome ${decision.outcome}`,
      };
    }

    // Calculate shares from USD amount
    const shares = usdToShares(decision.amount, price);

    // Create prediction record
    const predictionId = createPrediction({
      marketId: market.id,
      marketTitle: market.question,
      predictedOutcome: decision.outcome,
      predictedProbability: price,
      confidenceLevel: decision.confidence,
      reasoning: decision.reasoning,
    });

    try {
      // Step 1: Check spending limits
      const limitCheck = await this.limits.checkAndReserve(decision.amount);
      if (!limitCheck.allowed) {
        logWalletOperation({
          operation: 'reject',
          amount: decision.amount,
          status: 'rejected',
          reason: limitCheck.reason,
          metadata: { marketId: market.id, predictionId },
        });

        return {
          executed: false,
          message: limitCheck.reason ?? 'Spending limit exceeded',
        };
      }

      // Step 2: Check if negative risk market and get exchange address
      const negRisk = await this.checkNegRiskMarket(market);
      const exchangeAddress = this.getExchangeAddress(negRisk);

      // Step 3: Verify exchange address is whitelisted
      try {
        assertWhitelisted(exchangeAddress, 'order execution');
      } catch (e) {
        this.limits.release(decision.amount);
        if (e instanceof WhitelistError) {
          logWalletOperation({
            operation: 'reject',
            toAddress: exchangeAddress,
            amount: decision.amount,
            status: 'rejected',
            reason: e.message,
            metadata: { marketId: market.id, predictionId },
          });
          return { executed: false, message: e.message };
        }
        throw e;
      }

      // Step 4: Build and sign order
      const clobOrder = await this.signer.buildCLOBOrder(
        {
          tokenId,
          price,
          size: shares,
          side: decision.action === 'buy' ? 'BUY' : 'SELL',
          negRisk,
        },
        'GTC' // Good til cancelled
      );

      // Log the signing operation
      logWalletOperation({
        operation: 'sign',
        toAddress: exchangeAddress,
        amount: decision.amount,
        status: 'pending',
        metadata: {
          marketId: market.id,
          predictionId,
          tokenId,
          price,
          shares,
          side: decision.action,
          negRisk,
        },
      });

      // Step 5: Submit order to CLOB
      const response = await this.clobClient.postOrder(clobOrder);

      if (!response.success || !response.orderID) {
        this.limits.release(decision.amount);

        logWalletOperation({
          operation: 'submit',
          toAddress: exchangeAddress,
          amount: decision.amount,
          status: 'failed',
          reason: response.errorMsg ?? 'Order submission failed',
          metadata: { marketId: market.id, predictionId },
        });

        return {
          executed: false,
          message: response.errorMsg ?? 'Order submission failed',
        };
      }

      // Step 6: Confirm the spend
      this.limits.confirm(decision.amount);

      // Step 7: Record execution
      recordExecution({
        id: predictionId,
        executionPrice: price,
        positionSize: decision.amount,
        cashDelta: decision.action === 'sell' ? decision.amount : -decision.amount,
      });

      const sharesTraded = price > 0 ? decision.amount / price : null;
      recordTrade({
        predictionId,
        marketId: market.id,
        marketTitle: market.question,
        outcome: decision.outcome,
        side: decision.action,
        price,
        amount: decision.amount,
        shares: sharesTraded,
      });

      // Log success
      logWalletOperation({
        operation: 'submit',
        toAddress: exchangeAddress,
        amount: decision.amount,
        status: 'confirmed',
        metadata: {
          marketId: market.id,
          predictionId,
          orderId: response.orderID,
          transactionHashes: response.transactionsHashes,
        },
      });

      return {
        executed: true,
        message:
          `Order submitted: ${decision.action.toUpperCase()} ${shares.toFixed(2)} shares ` +
          `of ${decision.outcome} @ ${price.toFixed(4)} (Order ID: ${response.orderID})`,
      };
    } catch (error) {
      // Release reserved amount on any error
      this.limits.release(decision.amount);

      const errorMessage = error instanceof Error ? error.message : String(error);

      logWalletOperation({
        operation: 'submit',
        amount: decision.amount,
        status: 'failed',
        reason: errorMessage,
        metadata: { marketId: market.id, predictionId },
      });

      if (error instanceof CLOBError) {
        return {
          executed: false,
          message: `CLOB error: ${error.message}`,
        };
      }

      if (error instanceof LimitExceededError) {
        return {
          executed: false,
          message: `Limit exceeded: ${error.message}`,
        };
      }

      throw error;
    }
  }

  /**
   * Cancel an order by ID.
   */
  async cancelOrder(orderId: string): Promise<{ success: boolean; message: string }> {
    await this.initialize();

    try {
      const result = await this.clobClient.cancelOrder(orderId);

      logWalletOperation({
        operation: 'submit',
        status: result.success ? 'confirmed' : 'failed',
        metadata: { orderId, action: 'cancel' },
      });

      return {
        success: result.success,
        message: result.success ? `Order ${orderId} cancelled` : 'Cancel failed',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message };
    }
  }

  /**
   * Get order status.
   */
  async getOrderStatus(orderId: string): Promise<OrderStatus> {
    await this.initialize();

    try {
      const order = await this.clobClient.getOrder(orderId);

      let status: OrderStatus['status'];
      switch (order.status) {
        case 'LIVE':
          status = 'live';
          break;
        case 'MATCHED':
          status = 'matched';
          break;
        case 'CANCELLED':
          status = 'cancelled';
          break;
        default:
          status = 'pending';
      }

      const filledSize = parseFloat(order.size_matched);
      const originalSize = parseFloat(order.original_size);
      if (filledSize > 0 && filledSize < originalSize) {
        status = 'partially_matched';
      }

      return {
        orderId: order.id,
        status,
        filledSize,
        averagePrice: parseFloat(order.price),
      };
    } catch (error) {
      return {
        orderId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get open orders.
   */
  async getOpenOrders(market?: string): Promise<Array<{ id: string; side: string; price: string; size: string }>> {
    await this.initialize();

    const orders = await this.clobClient.getOpenOrders(market);
    return orders.map((o) => ({
      id: o.id,
      side: o.side,
      price: o.price,
      size: o.original_size,
    }));
  }

  /**
   * Get recent trades.
   */
  async getRecentTrades(limit = 10): Promise<Array<{ id: string; side: string; price: string; size: string; time: number }>> {
    await this.initialize();

    const trades = await this.clobClient.getTrades({ limit });
    return trades.map((t) => ({
      id: t.id,
      side: t.side,
      price: t.price,
      size: t.size,
      time: t.match_time,
    }));
  }

  /**
   * Get remaining daily spending allowance.
   */
  getRemainingDailyAllowance(): number {
    return this.limits.getRemainingDaily();
  }

  /**
   * Get spending state.
   */
  getSpendingState(): {
    todaySpent: number;
    reserved: number;
    remaining: number;
    limits: { daily: number; perTrade: number };
  } {
    const state = this.limits.getState();
    const limitsConfig = this.limits.getLimits();

    return {
      todaySpent: state.todaySpent,
      reserved: state.reserved,
      remaining: this.limits.getRemainingDaily(),
      limits: {
        daily: limitsConfig.daily,
        perTrade: limitsConfig.perTrade,
      },
    };
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Get the token ID for a market outcome.
   *
   * Priority order:
   * 1. Market's tokens array (from normalized market data)
   * 2. Market's clobTokenIds array
   * 3. Cached token IDs from previous CLOB API fetch
   * 4. Fetch from CLOB API (authoritative source)
   *
   * NEVER falls back to market ID - that doesn't work.
   */
  private getTokenId(market: Market, outcome: 'YES' | 'NO'): string | null {
    const outcomeLower = outcome.toLowerCase();

    // 1. Try tokens array from market data
    if (market.tokens && market.tokens.length > 0) {
      const token = market.tokens.find(
        (t) => t.outcome.toLowerCase() === outcomeLower
      );
      if (token?.token_id) return token.token_id;
    }

    // 2. Try clobTokenIds array (index 0 = YES, index 1 = NO)
    if (market.clobTokenIds && market.clobTokenIds.length >= 2) {
      return outcome === 'YES' ? market.clobTokenIds[0] : market.clobTokenIds[1];
    }

    // 3. Check cache
    const conditionId = market.conditionId || market.id;
    const cached = this.tokenIdCache.get(conditionId);
    if (cached) {
      return outcome === 'YES' ? cached[0] : cached[1];
    }

    // Token ID not available - caller should use fetchAndCacheTokenIds first
    return null;
  }

  /**
   * Fetch token IDs from CLOB API and cache them.
   * Returns [yesTokenId, noTokenId] or null if fetch fails.
   */
  private async fetchAndCacheTokenIds(market: Market): Promise<[string, string] | null> {
    const conditionId = market.conditionId || market.id;

    // Check cache first
    const cached = this.tokenIdCache.get(conditionId);
    if (cached) return cached;

    try {
      const tokenIds = await this.clobClient.getTokenIds(conditionId);
      if (tokenIds) {
        this.tokenIdCache.set(conditionId, tokenIds);
        console.log(`[LiveExecutor] Cached token IDs for ${conditionId}: YES=${tokenIds[0]}, NO=${tokenIds[1]}`);
        return tokenIds;
      }
    } catch (error) {
      console.error(`[LiveExecutor] Failed to fetch token IDs for ${conditionId}:`, error);
    }

    return null;
  }

  /**
   * Determine if a market uses the negative risk exchange.
   * Checks market data first, falls back to CLOB API if needed.
   */
  private async checkNegRiskMarket(market: Market): Promise<boolean> {
    // Check market data first
    if (market.negRisk !== undefined) {
      return market.negRisk;
    }

    // Fetch from CLOB API
    const conditionId = market.conditionId || market.id;
    try {
      return await this.clobClient.isNegRiskMarket(conditionId);
    } catch {
      // Default to non-neg-risk (safer, uses standard exchange)
      return false;
    }
  }

  /**
   * Get the exchange address for a market.
   */
  private getExchangeAddress(negRisk: boolean): string {
    return negRisk
      ? EXCHANGE_ADDRESSES.NEG_RISK_CTF_EXCHANGE
      : EXCHANGE_ADDRESSES.CTF_EXCHANGE;
  }
}
