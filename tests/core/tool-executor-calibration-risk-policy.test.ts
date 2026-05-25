import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/autonomy_policy.js', () => ({
  evaluateGlobalTradeGate: () => ({
    allowed: true,
    reasonCode: 'calibration.segment.downweight',
    reason: 'calibration.segment.downweight: segment downweighted',
    sizeMultiplier: 0.5,
    policyState: {
      minEdgeOverride: null,
      maxTradesPerScanOverride: null,
      leverageCapOverride: null,
      observationOnlyUntilMs: null,
      reason: null,
      updatedAt: new Date().toISOString(),
    },
  }),
}));

describe('tool-executor calibration risk policy hook', () => {
  it('downweights perp_place_order size and returns policy trace metadata', async () => {
    const { executeToolCall } = await import('../../src/core/tool-executor.js');

    let executedSize = 0;
    let reservedUsd = 0;

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
      execute: async (_market: unknown, decision: { size: number }) => {
        executedSize = decision.size;
        return { executed: true, message: 'ok' };
      },
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async (amountUsd: number) => {
        reservedUsd = amountUsd;
        return { allowed: true };
      },
      confirm: () => {},
      release: () => {},
    };

    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 1, signal_class: 'mean_reversion', trade_archetype: 'intraday' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );

    expect(res.success).toBe(true);
    expect(executedSize).toBe(0.5);
    expect(reservedUsd).toBe(25000);
    expect((res.data as any).policy?.size_multiplier).toBe(0.5);
    expect((res.data as any).policy?.requested_size).toBe(1);
    expect((res.data as any).policy?.effective_size).toBe(0.5);
  });
});
