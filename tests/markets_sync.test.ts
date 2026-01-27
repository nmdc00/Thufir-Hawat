import { describe, expect, it, vi } from 'vitest';

import { refreshMarketPrices, syncMarketCache } from '../src/core/markets_sync.js';

const storedBatches: Array<Array<{ id: string }>> = [];

vi.mock('../src/memory/market_cache.js', () => ({
  upsertMarketCacheBatch: (records: Array<{ id: string }>) => {
    storedBatches.push(records);
  },
}));

vi.mock('../src/execution/polymarket/markets.js', () => ({
  PolymarketMarketClient: class {
    constructor() {}
    async fetchMarketsPage({ offset }: { offset?: number }) {
      if (!offset || offset === 0) {
        return {
          markets: [
            { id: 'm1', question: 'Q1', outcomes: [], prices: {}, description: null },
          ],
          nextOffset: 1,
        };
      }
      if (offset === 1) {
        return {
          markets: [
            { id: 'm2', question: 'Q2', outcomes: [], prices: {}, description: null },
          ],
        };
      }
      return { markets: [] };
    }
    normalizeRawMarket(raw: any) {
      return raw;
    }
  },
}));

vi.mock('node-fetch', () => {
  return {
    default: vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 'm3', question: 'Q3', outcomes: [], prices: {}, description: null },
      ],
    }),
  };
});

describe('markets_sync', () => {
  it('paginates and stores all pages', async () => {
    storedBatches.length = 0;
    const result = await syncMarketCache(
      { polymarket: { api: { gamma: '', clob: '' } } } as any,
      1,
      5
    );
    expect(result.stored).toBe(2);
    expect(storedBatches.length).toBe(2);
  });

  it('refreshes market prices from gamma', async () => {
    storedBatches.length = 0;
    const result = await refreshMarketPrices(
      { polymarket: { api: { gamma: 'https://gamma', clob: '' } } } as any,
      100
    );
    expect(result.stored).toBe(1);
    expect(storedBatches.length).toBe(1);
    expect(storedBatches[0][0].id).toBe('m3');
  });
});
