import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/memory/db.js', () => ({
  openDatabase: () => ({
    prepare: () => ({
      all: () => [
        { marketId: 'm1', marketTitle: 'Test', outcome: 'YES', side: 'buy', amount: 50, shares: 100, price: 0.5 },
        { marketId: 'm1', marketTitle: 'Test', outcome: 'YES', side: 'sell', amount: 70, shares: 100, price: 0.7 },
      ],
    }),
  }),
}));

vi.mock('../src/memory/trades.js', () => ({
  listOpenPositionsFromTrades: () => [
    {
      marketId: 'm1',
      marketTitle: 'Test',
      predictedOutcome: 'YES',
      executionPrice: 0.5,
      positionSize: 50,
      netShares: 100,
      currentPrices: { YES: 0.6 },
    },
  ],
}));

vi.mock('../src/memory/market_cache.js', () => ({
  getMarketCache: () => ({ category: 'politics' }),
}));

import { getDailyPnLRollup } from '../src/core/daily_pnl.js';

describe('daily PnL rollup', () => {
  it('computes totals and domain breakdown', () => {
    const rollup = getDailyPnLRollup('2026-01-26');
    expect(rollup.realizedPnl).toBe(20);
    expect(rollup.unrealizedPnl).toBeCloseTo(10, 6);
    expect(rollup.byDomain[0]?.domain).toBe('politics');
  });
});
