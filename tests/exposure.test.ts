import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/memory/trades.js', () => ({
  listOpenPositionsFromTrades: () => [
    {
      marketId: 'm1',
      marketTitle: 'Test market',
      predictedOutcome: 'YES',
      executionPrice: 0.5,
      positionSize: 50,
      netShares: 100,
      createdAt: new Date().toISOString(),
      currentPrices: { YES: 0.5 },
    },
  ],
}));

vi.mock('../src/memory/predictions.js', () => ({
  listOpenPositions: () => [],
}));

vi.mock('../src/memory/portfolio.js', () => ({
  getCashBalance: () => 50,
}));

vi.mock('../src/memory/market_cache.js', () => ({
  getMarketCache: () => ({ category: 'politics' }),
}));

import { checkExposureLimits } from '../src/core/exposure.js';

describe('exposure limits', () => {
  it('blocks when market exposure exceeds limit', () => {
    const result = checkExposureLimits({
      config: {
        wallet: { exposure: { maxPositionPercent: 40, maxDomainPercent: 80 } },
      } as any,
      market: { id: 'm1', question: 'Test', category: 'politics' } as any,
      outcome: 'YES',
      amount: 10,
      side: 'buy',
    });
    expect(result.allowed).toBe(false);
  });

  it('allows when within exposure limits', () => {
    const result = checkExposureLimits({
      config: {
        wallet: { exposure: { maxPositionPercent: 70, maxDomainPercent: 80 } },
      } as any,
      market: { id: 'm1', question: 'Test', category: 'politics' } as any,
      outcome: 'YES',
      amount: 5,
      side: 'buy',
    });
    expect(result.allowed).toBe(true);
  });
});
