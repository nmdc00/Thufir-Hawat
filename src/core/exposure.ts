import type { ThufirConfig } from './config.js';
import type { Market } from '../execution/markets.js';
import { listOpenPositionsFromTrades } from '../memory/trades.js';
import { listOpenPositions } from '../memory/predictions.js';
import { getCashBalance } from '../memory/portfolio.js';
import { getMarketCache } from '../memory/market_cache.js';

type ExposureTotals = {
  totalValue: number;
  totalEquity: number;
  byMarket: Map<string, number>;
  byDomain: Map<string, number>;
};

function resolveDomain(marketId: string, fallback?: string): string {
  const cached = getMarketCache(marketId);
  const category = cached?.category ?? fallback ?? 'unknown';
  return category || 'unknown';
}

function resolveCurrentPrice(params: {
  outcome: 'YES' | 'NO';
  currentPrices?: Record<string, number> | number[] | null;
  executionPrice?: number | null;
}): number {
  const { outcome, currentPrices, executionPrice } = params;
  let currentPrice: number | null = null;
  if (Array.isArray(currentPrices)) {
    currentPrice = outcome === 'YES' ? currentPrices[0] ?? null : currentPrices[1] ?? null;
  } else if (currentPrices) {
    currentPrice =
      currentPrices[outcome] ??
      currentPrices[outcome.toUpperCase()] ??
      currentPrices[outcome.toLowerCase()] ??
      currentPrices[outcome === 'YES' ? 'Yes' : 'No'] ??
      currentPrices[outcome === 'YES' ? 'yes' : 'no'] ??
      null;
  }
  return currentPrice ?? executionPrice ?? 0;
}

function computeExposureTotals(): ExposureTotals {
  const fromTrades = listOpenPositionsFromTrades(500);
  const positions = fromTrades.length > 0 ? fromTrades : listOpenPositions(500);

  const byMarket = new Map<string, number>();
  const byDomain = new Map<string, number>();
  let totalValue = 0;

  for (const position of positions) {
    const outcome = position.predictedOutcome ?? 'YES';
    const price = resolveCurrentPrice({
      outcome,
      currentPrices: position.currentPrices ?? null,
      executionPrice: position.executionPrice ?? null,
    });
    const netShares =
      typeof (position as { netShares?: number | null }).netShares === 'number'
        ? Math.abs(Number((position as { netShares?: number | null }).netShares))
        : null;
    const positionValue =
      netShares !== null ? netShares * price : (position.positionSize ?? 0);

    if (positionValue <= 0) {
      continue;
    }

    totalValue += positionValue;
    byMarket.set(
      position.marketId,
      (byMarket.get(position.marketId) ?? 0) + positionValue
    );

    const domain = resolveDomain(position.marketId);
    byDomain.set(domain, (byDomain.get(domain) ?? 0) + positionValue);
  }

  const cash = getCashBalance();
  const totalEquity = cash + totalValue;

  return { totalValue, totalEquity, byMarket, byDomain };
}

export function checkExposureLimits(params: {
  config: ThufirConfig;
  market: Market;
  outcome: 'YES' | 'NO';
  amount: number;
  side: 'buy' | 'sell';
}): { allowed: boolean; reason?: string } {
  const exposureConfig = params.config.wallet?.exposure;
  if (!exposureConfig) {
    return { allowed: true };
  }

  const totals = computeExposureTotals();
  if (totals.totalEquity <= 0) {
    return { allowed: true };
  }

  const currentMarketValue = totals.byMarket.get(params.market.id) ?? 0;
  const domain = resolveDomain(params.market.id, params.market.category);
  const currentDomainValue = totals.byDomain.get(domain) ?? 0;

  const delta = params.side === 'buy' ? params.amount : -params.amount;
  const nextMarketValue = Math.max(0, currentMarketValue + delta);
  const nextDomainValue = Math.max(0, currentDomainValue + delta);

  const maxPositionPct = exposureConfig.maxPositionPercent ?? 100;
  const maxDomainPct = exposureConfig.maxDomainPercent ?? 100;

  const nextMarketPct = (nextMarketValue / totals.totalEquity) * 100;
  if (nextMarketPct > maxPositionPct) {
    return {
      allowed: false,
      reason: `Position exposure ${nextMarketPct.toFixed(1)}% exceeds limit ${maxPositionPct}%`,
    };
  }

  const nextDomainPct = (nextDomainValue / totals.totalEquity) * 100;
  if (nextDomainPct > maxDomainPct) {
    return {
      allowed: false,
      reason: `Domain exposure ${nextDomainPct.toFixed(1)}% exceeds limit ${maxDomainPct}%`,
    };
  }

  return { allowed: true };
}
