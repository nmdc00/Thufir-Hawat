import { describe, it, expect, vi } from 'vitest';

const mockState = vi.hoisted(() => {
  return {
    fees: {
      userCrossRate: '0.00045',
      userAddRate: '0.00015',
    },
    fills: [] as Array<Record<string, unknown>>,
  };
});

vi.mock('../../src/execution/hyperliquid/client.js', () => {
  class HyperliquidClient {
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(_config: any) {}

    getAccountAddress() {
      return '0x0000000000000000000000000000000000000000';
    }

    async getUserFees() {
      return mockState.fees as any;
    }

    async getUserFillsByTime(params: { startTime: number }) {
      return mockState.fills.filter((fill) => Number(fill.time ?? 0) >= params.startTime);
    }
  }

  return { HyperliquidClient };
});

describe('tool-executor perp fee visibility', () => {
  it('returns estimated and realized fees for a successful market order', async () => {
    mockState.fills = [
      {
        coin: 'BTC',
        side: 'B',
        fee: '0.009',
        feeToken: 'USDC',
        oid: 123,
        time: Date.now(),
      },
    ];
    const { executeToolCall } = await import('../../src/core/tool-executor.js');
    const marketClient = {
      getMarket: async (symbol: string) => ({
        id: symbol,
        question: `Perp: ${symbol}`,
        outcomes: ['LONG', 'SHORT'],
        prices: {},
        platform: 'hyperliquid',
        kind: 'perp',
        symbol,
        markPrice: 50000,
        metadata: { maxLeverage: 10 },
      }),
      listMarkets: async () => [],
      searchMarkets: async () => [],
    };
    const executor = {
      execute: async () => ({ executed: true, message: 'Hyperliquid order filled (oid=123).' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };

    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.01, order_type: 'market', trade_archetype: 'intraday' },
      {
        config: { execution: { provider: 'hyperliquid' } } as any,
        marketClient,
        executor,
        limiter,
      }
    );

    expect(res.success, JSON.stringify(res)).toBe(true);
    const fees = (res as any).data.fees;
    expect(fees.estimated_notional_usd).toBeCloseTo(500, 6);
    expect(fees.estimated_fee_rate).toBeCloseTo(0.00045, 8);
    expect(fees.estimated_fee_usd).toBeCloseTo(0.225, 6);
    expect(fees.realized_fee_usd).toBeCloseTo(0.009, 6);
    expect(fees.realized_fee_token).toBe('USDC');
    expect(fees.realized_order_id).toBe(123);
  });

  it('keeps realized fee fields null when no matching fills are found', async () => {
    mockState.fills = [];
    const { executeToolCall } = await import('../../src/core/tool-executor.js');
    const marketClient = {
      getMarket: async (symbol: string) => ({
        id: symbol,
        question: `Perp: ${symbol}`,
        outcomes: ['LONG', 'SHORT'],
        prices: {},
        platform: 'hyperliquid',
        kind: 'perp',
        symbol,
        markPrice: 50000,
        metadata: { maxLeverage: 10 },
      }),
      listMarkets: async () => [],
      searchMarkets: async () => [],
    };
    const executor = {
      execute: async () => ({ executed: true, message: 'Hyperliquid order filled (oid=999).' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };

    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.01, order_type: 'market', trade_archetype: 'intraday' },
      {
        config: { execution: { provider: 'hyperliquid' } } as any,
        marketClient,
        executor,
        limiter,
      }
    );

    expect(res.success, JSON.stringify(res)).toBe(true);
    const fees = (res as any).data.fees;
    expect(fees.realized_fee_usd).toBeNull();
    expect(fees.realized_fill_count).toBe(0);
    expect(fees.realized_order_id).toBe(999);
  });
});
