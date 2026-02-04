import type { ExecutionAdapter, TradeDecision, TradeResult, Order } from '../executor.js';
import type { Market } from '../markets.js';
import { logWalletOperation } from '../../memory/audit.js';
import { createPrediction, recordExecution } from '../../memory/predictions.js';
import { recordTrade } from '../../memory/trades.js';
import { recordPerpTrade } from '../../memory/perp_trades.js';

export class PaperExecutor implements ExecutionAdapter {
  async execute(market: Market, decision: TradeDecision): Promise<TradeResult> {
    if (decision.action === 'hold') {
      return { executed: false, message: 'Hold decision; no trade executed.' };
    }

    if (market.kind === 'perp' || decision.symbol) {
      const symbol = decision.symbol ?? market.symbol ?? market.id;
      const side = decision.side ?? decision.action;
      const size = decision.size ?? decision.amount;
      if (!symbol || !side || !size) {
        return { executed: false, message: 'Invalid decision: missing symbol/side/size.' };
      }
      recordPerpTrade({
        symbol,
        side,
        size,
        price: decision.price ?? null,
        leverage: decision.leverage ?? null,
        orderType: decision.orderType ?? 'market',
        status: 'paper',
      });
      logWalletOperation({
        operation: 'paper',
        amount: size,
        status: 'confirmed',
        metadata: {
          symbol,
          side,
          leverage: decision.leverage,
        },
      });
      return {
        executed: true,
        message: `Paper perp trade executed for ${symbol} (${side})`,
      };
    }

    if (!decision.amount || !decision.outcome) {
      return { executed: false, message: 'Invalid decision: missing amount/outcome.' };
    }

    const predictionId = createPrediction({
      marketId: market.id,
      marketTitle: market.question,
      predictedOutcome: decision.outcome,
      predictedProbability: market.prices?.[decision.outcome] ?? undefined,
      confidenceLevel: decision.confidence,
      reasoning: decision.reasoning,
    });

    recordExecution({
      id: predictionId,
      executionPrice: market.prices?.[decision.outcome] ?? null,
      positionSize: decision.amount,
      cashDelta: decision.action === 'sell' ? decision.amount : -decision.amount,
    });

    const price = market.prices?.[decision.outcome] ?? null;
    const shares = price && price > 0 ? decision.amount / price : null;
    recordTrade({
      predictionId,
      marketId: market.id,
      marketTitle: market.question,
      outcome: decision.outcome,
      side: decision.action,
      price,
      amount: decision.amount,
      shares,
    });

    logWalletOperation({
      operation: 'paper',
      amount: decision.amount,
      status: 'confirmed',
      metadata: {
        marketId: market.id,
        outcome: decision.outcome,
        confidence: decision.confidence,
      },
    });

    return {
      executed: true,
      message: `Paper trade executed for ${market.id} (${decision.outcome})`,
    };
  }

  async getOpenOrders(): Promise<Order[]> {
    return [];
  }

  async cancelOrder(_id: string, _options?: { symbol?: string }): Promise<void> {
    // Paper mode has no live orders to cancel.
  }
}
