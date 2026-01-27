import { openDatabase } from '../memory/db.js';
import { listOpenPositionsFromTrades } from '../memory/trades.js';
import { getMarketCache } from '../memory/market_cache.js';

export interface DailyPnLRollup {
  date: string;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  byDomain: Array<{ domain: string; realizedPnl: number; unrealizedPnl: number; totalPnl: number }>;
}

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

export function getDailyPnLRollup(date = new Date().toISOString().slice(0, 10)): DailyPnLRollup {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT market_id as marketId,
               market_title as marketTitle,
               outcome,
               side,
               amount,
               shares,
               price
        FROM trades
        WHERE date(created_at) = ?
      `
    )
    .all(date) as Array<{
    marketId: string;
    marketTitle: string;
    outcome: 'YES' | 'NO';
    side: 'buy' | 'sell';
    amount: number | null;
    shares: number | null;
    price: number | null;
  }>;

  const byDomainMap = new Map<string, { realizedPnl: number; unrealizedPnl: number }>();
  let realizedTotal = 0;

  for (const row of rows) {
    const amount = row.amount ?? 0;
    const domain = resolveDomain(row.marketId);
    const current = byDomainMap.get(domain) ?? { realizedPnl: 0, unrealizedPnl: 0 };
    current.realizedPnl += row.side === 'sell' ? amount : -amount;
    byDomainMap.set(domain, current);
    realizedTotal += row.side === 'sell' ? amount : -amount;
  }

  let unrealizedTotal = 0;
  const openPositions = listOpenPositionsFromTrades(500);
  for (const position of openPositions) {
    const price = resolveCurrentPrice({
      outcome: position.predictedOutcome ?? 'YES',
      currentPrices: position.currentPrices ?? null,
      executionPrice: position.executionPrice ?? null,
    });
    const netShares = Math.abs(position.netShares ?? 0);
    if (netShares <= 0 || price <= 0) {
      continue;
    }
    const marketValue = netShares * price;
    const unrealized = marketValue - (position.positionSize ?? 0);
    unrealizedTotal += unrealized;

    const domain = resolveDomain(position.marketId);
    const current = byDomainMap.get(domain) ?? { realizedPnl: 0, unrealizedPnl: 0 };
    current.unrealizedPnl += unrealized;
    byDomainMap.set(domain, current);
  }

  const byDomain = Array.from(byDomainMap.entries()).map(([domain, values]) => ({
    domain,
    realizedPnl: values.realizedPnl,
    unrealizedPnl: values.unrealizedPnl,
    totalPnl: values.realizedPnl + values.unrealizedPnl,
  }));

  return {
    date,
    realizedPnl: realizedTotal,
    unrealizedPnl: unrealizedTotal,
    totalPnl: realizedTotal + unrealizedTotal,
    byDomain,
  };
}
