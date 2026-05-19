import fetch from 'node-fetch';

import type { ExecutionAdapter, TradeDecision, TradeResult, Order } from '../executor.js';
import type { Market } from '../markets.js';
import { createLearningCase } from '../../memory/learning_cases.js';
import { createPrediction, recordExecution } from '../../memory/predictions.js';
import { recordTrade } from '../../memory/trades.js';
import { logWalletOperation } from '../../memory/audit.js';

export class WebhookExecutor implements ExecutionAdapter {
  constructor(private webhookUrl: string) {}

  async execute(market: Market, decision: TradeDecision): Promise<TradeResult> {
    if (decision.action === 'hold') {
      return { executed: false, message: 'Hold decision; no trade executed.' };
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
      modelProbability: decision.modelProbability ?? undefined,
      marketProbability: getComparableMarketProbability(market, decision),
      learningComparable: isComparablePredictionTrade(market, decision),
    });
    createLearningCase({
      caseType: 'comparable_forecast',
      domain: market.platform || 'prediction_market',
      entityType: 'market',
      entityId: market.id,
      comparable: isComparablePredictionTrade(market, decision),
      comparatorKind: isComparablePredictionTrade(market, decision) ? 'market_price' : null,
      exclusionReason: isComparablePredictionTrade(market, decision)
        ? null
        : 'missing_model_probability',
      sourcePredictionId: predictionId,
      belief: {
        modelProbability: decision.modelProbability ?? null,
        predictedOutcome: decision.outcome,
      },
      baseline: {
        marketProbability: getComparableMarketProbability(market, decision) ?? null,
      },
      action: {
        action: decision.action,
        amount: decision.amount,
        executed: true,
        executionPrice: market.prices?.[decision.outcome] ?? null,
      },
    });

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        market,
        decision,
        predictionId,
      }),
    });

    if (!response.ok) {
      const reason = `Webhook executor failed: ${response.status}`;
      logWalletOperation({
        operation: 'reject',
        amount: decision.amount,
        status: 'failed',
        reason,
        metadata: { marketId: market.id },
      });
      return { executed: false, message: reason };
    }

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
      operation: 'submit',
      amount: decision.amount,
      status: 'pending',
      metadata: { marketId: market.id, outcome: decision.outcome },
    });

    return { executed: true, message: 'Trade forwarded to webhook executor.' };
  }

  async getOpenOrders(): Promise<Order[]> {
    return [];
  }

  async cancelOrder(_id: string, _options?: { symbol?: string }): Promise<void> {
    throw new Error('Order cancellation is not supported for webhook execution.');
  }
}

function isComparablePredictionTrade(market: Market, decision: TradeDecision): boolean {
  return (
    market.kind !== 'perp' &&
    decision.outcome != null &&
    Number.isFinite(Number(decision.modelProbability)) &&
    Number.isFinite(Number(market.prices?.[decision.outcome]))
  );
}

function getComparableMarketProbability(market: Market, decision: TradeDecision): number | undefined {
  if (!isComparablePredictionTrade(market, decision)) {
    return undefined;
  }
  return Number(market.prices[decision.outcome!]);
}
