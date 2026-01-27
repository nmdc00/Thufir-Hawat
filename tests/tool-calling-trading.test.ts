import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { executeToolCall } from '../src/core/tool-executor.js';

vi.mock('../src/memory/predictions.js', () => ({
  listPredictions: () => [
    {
      id: 'p1',
      marketId: 'm1',
      marketTitle: 'Market 1',
      predictedOutcome: 'YES',
      executionPrice: 0.4,
      positionSize: 20,
      outcome: 'YES',
      createdAt: '2026-01-01T00:00:00Z',
      reasoning: 'win',
    },
    {
      id: 'p2',
      marketId: 'm2',
      marketTitle: 'Market 2',
      predictedOutcome: 'NO',
      executionPrice: 0.6,
      positionSize: 15,
      outcome: 'YES',
      createdAt: '2026-01-02T00:00:00Z',
      reasoning: 'loss',
    },
    {
      id: 'p3',
      marketId: 'm3',
      marketTitle: 'Market 3',
      predictedOutcome: 'YES',
      executionPrice: null,
      positionSize: null,
      outcome: null,
      createdAt: '2026-01-03T00:00:00Z',
      reasoning: 'pending',
    },
  ],
  listOpenPositions: () => [
    {
      id: 'op1',
      marketId: 'm1',
      marketTitle: 'Market 1',
      predictedOutcome: 'YES',
      executionPrice: 0.4,
      positionSize: 20,
      createdAt: '2026-01-01T00:00:00Z',
      currentPrices: { YES: 0.6 },
    },
  ],
}));

vi.mock('../src/memory/portfolio.js', () => ({
  getCashBalance: () => 100,
}));

vi.mock('../src/execution/wallet/balances.js', () => ({
  getWalletBalances: async () => ({ usdc: 250, matic: 1 }),
}));

vi.mock('../src/execution/wallet/manager.js', () => ({
  loadWallet: () => ({}),
}));

vi.mock('../src/execution/wallet/keystore.js', () => ({
  loadKeystore: () => ({ address: '0x1234567890abcdef1234567890abcdef12345678' }),
}));

describe('trading tools (excluding place_bet)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns current_time data', async () => {
    const result = await executeToolCall(
      'current_time',
      { timezone: 'UTC' },
      { config: { polymarket: { api: { gamma: '', clob: '' } }, execution: { mode: 'paper' } } as any, marketClient: {} as any }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { iso: string; timezone: string };
      expect(data.iso).toContain('T');
      expect(data.timezone).toBe('UTC');
    }
  });

  it('filters get_predictions by status', async () => {
    const result = await executeToolCall(
      'get_predictions',
      { status: 'won', limit: 10 },
      { config: { polymarket: { api: { gamma: '', clob: '' } } } as any, marketClient: {} as any }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { predictions: Array<{ id: string }> };
      expect(data.predictions).toHaveLength(1);
      expect(data.predictions[0].id).toBe('p1');
    }
  });

  it('returns get_portfolio with positions and balances', async () => {
    const result = await executeToolCall(
      'get_portfolio',
      {},
      { config: { execution: { mode: 'paper' }, polymarket: { api: { gamma: '', clob: '' } } } as any, marketClient: {} as any }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { balances: { usdc: number }; positions: Array<{ outcome: string }> };
      expect(data.balances.usdc).toBe(100);
      expect(data.positions[0].outcome).toBe('YES');
    }
  });

  it('returns get_wallet_info with address', async () => {
    const result = await executeToolCall(
      'get_wallet_info',
      {},
      { config: { polymarket: { api: { gamma: '', clob: '' } } } as any, marketClient: {} as any }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { address: string; chain: string; token: string };
      expect(data.address).toBe('0x1234567890abcdef1234567890abcdef12345678');
      expect(data.chain).toBe('polygon');
      expect(data.token).toBe('USDC');
    }
  });

  it('returns get_order_book depth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        bids: [{ price: 0.4, size: 50 }],
        asks: [{ price: 0.45, size: 60 }],
      }),
    });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;

    const result = await executeToolCall(
      'get_order_book',
      { market_id: 'm1', depth: 1 },
      {
        config: { polymarket: { api: { gamma: '', clob: 'https://clob.polymarket.com' } } } as any,
        marketClient: {
          getMarket: async () => ({ id: 'm1', question: 'Market 1', clobTokenIds: ['yes', 'no'] }),
        } as any,
      }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { yes: { best_bid: number } };
      expect(data.yes.best_bid).toBe(0.4);
    }
  });

  it('returns price_history series', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        prices: [{ t: 1, price: 0.5 }],
      }),
    });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;

    const result = await executeToolCall(
      'price_history',
      { market_id: 'm1', interval: '1d', limit: 1 },
      { config: { polymarket: { api: { gamma: 'https://gamma' } } } as any, marketClient: {} as any }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { series: Array<{ price: number }> };
      expect(data.series[0].price).toBe(0.5);
    }
  });
});
