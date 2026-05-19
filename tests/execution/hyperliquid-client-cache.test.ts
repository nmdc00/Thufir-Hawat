import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockPerpDexs,
  mockMetaAndAssetCtxs,
  mockAllMids,
  mockRecentTrades,
  mockCandleSnapshot,
  mockInfoClientCtor,
  mockTransportCtor,
  mockExchangeCtor,
} = vi.hoisted(() => ({
  mockPerpDexs: vi.fn(async () => [{ name: 'dexA' }]),
  mockMetaAndAssetCtxs: vi.fn(async ({ dex }: { dex?: string } = {}) =>
    dex
      ? [{ universe: [{ name: `${dex}:ALT` }] }, [{ markPx: '2', openInterest: '20' }]]
      : [{ universe: [{ name: 'BTC' }] }, [{ markPx: '1', openInterest: '10' }]]
  ),
  mockAllMids: vi.fn(async () => ({ BTC: '1' })),
  mockRecentTrades: vi.fn(async () => []),
  mockCandleSnapshot: vi.fn(async () => []),
  mockInfoClientCtor: vi.fn(),
  mockTransportCtor: vi.fn(),
  mockExchangeCtor: vi.fn(),
}));

vi.mock('@nktkas/hyperliquid', () => ({
  HttpTransport: class {
    constructor(args: unknown) {
      mockTransportCtor(args);
    }
  },
  InfoClient: class {
    perpDexs = mockPerpDexs;
    metaAndAssetCtxs = mockMetaAndAssetCtxs;
    allMids = mockAllMids;
    recentTrades = mockRecentTrades;
    candleSnapshot = mockCandleSnapshot;

    constructor(args: unknown) {
      mockInfoClientCtor(args);
    }
  },
  ExchangeClient: class {
    constructor(args: unknown) {
      mockExchangeCtor(args);
    }
  },
}));

describe('HyperliquidClient shared request cache', () => {
  beforeEach(() => {
    vi.resetModules();
    mockPerpDexs.mockClear();
    mockMetaAndAssetCtxs.mockClear();
    mockAllMids.mockClear();
    mockRecentTrades.mockClear();
    mockCandleSnapshot.mockClear();
    mockInfoClientCtor.mockClear();
    mockTransportCtor.mockClear();
    mockExchangeCtor.mockClear();
  });

  it('coalesces merged meta requests across separate client instances', async () => {
    const { HyperliquidClient } = await import('../../src/execution/hyperliquid/client.js');
    const config = { hyperliquid: { enabled: true } } as any;

    const clientA = new HyperliquidClient(config);
    const clientB = new HyperliquidClient(config);

    const [first, second] = await Promise.all([
      clientA.getMergedMetaAndAssetCtxs(),
      clientB.getMergedMetaAndAssetCtxs(),
    ]);

    expect(first).toEqual(second);
    expect(mockPerpDexs).toHaveBeenCalledTimes(1);
    expect(mockMetaAndAssetCtxs).toHaveBeenCalledTimes(2);

    await clientA.getMergedMetaAndAssetCtxs();
    await clientB.getMergedMetaAndAssetCtxs();

    expect(mockPerpDexs).toHaveBeenCalledTimes(1);
    expect(mockMetaAndAssetCtxs).toHaveBeenCalledTimes(2);
  });

  it('coalesces perpDexs requests across separate client instances', async () => {
    const { HyperliquidClient } = await import('../../src/execution/hyperliquid/client.js');
    const config = { hyperliquid: { enabled: true } } as any;

    const clientA = new HyperliquidClient(config);
    const clientB = new HyperliquidClient(config);

    const [first, second] = await Promise.all([clientA.listPerpDexs(), clientB.listPerpDexs()]);

    expect(first).toEqual(['dexA']);
    expect(second).toEqual(['dexA']);
    expect(mockPerpDexs).toHaveBeenCalledTimes(1);
  });

  it('coalesces getAllMids requests across separate client instances', async () => {
    const { HyperliquidClient } = await import('../../src/execution/hyperliquid/client.js');
    const config = { hyperliquid: { enabled: true } } as any;

    const clientA = new HyperliquidClient(config);
    const clientB = new HyperliquidClient(config);

    const [first, second] = await Promise.all([clientA.getAllMids(), clientB.getAllMids()]);

    expect(first).toEqual({ BTC: 1, 'dexA:ALT': 2 });
    expect(second).toEqual({ BTC: 1, 'dexA:ALT': 2 });
    expect(mockAllMids).toHaveBeenCalledTimes(1);
    expect(mockPerpDexs).toHaveBeenCalledTimes(1);
    expect(mockMetaAndAssetCtxs).toHaveBeenCalledTimes(1);
  });

  it('limits concurrent info requests per base URL', async () => {
    const { HyperliquidClient } = await import('../../src/execution/hyperliquid/client.js');
    const config = {
      hyperliquid: { enabled: true, maxConcurrentInfoRequests: 1 },
    } as any;

    let active = 0;
    let peak = 0;
    mockRecentTrades.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return [];
    });

    const client = new HyperliquidClient(config);
    await Promise.all([
      client.getRecentTrades('BTC'),
      client.getRecentTrades('ETH'),
      client.getRecentTrades('SOL'),
    ]);

    expect(peak).toBe(1);
    expect(mockRecentTrades).toHaveBeenCalledTimes(3);
  });

  it('applies a short shared cooldown after transient HL failures', async () => {
    vi.useFakeTimers();
    try {
      const { HyperliquidClient } = await import('../../src/execution/hyperliquid/client.js');
      const config = {
        hyperliquid: { enabled: true, rateLimitCooldownMs: 50 },
      } as any;
      const client = new HyperliquidClient(config);

      mockRecentTrades
        .mockRejectedValueOnce(
          Object.assign(new Error('500 Internal Server Error - null'), { response: { status: 500 } })
        )
        .mockResolvedValueOnce([]);

      await expect(client.getRecentTrades('BTC')).rejects.toThrow('500 Internal Server Error');
      expect(mockRecentTrades).toHaveBeenCalledTimes(1);

      const pending = client.getRecentTrades('ETH');
      await vi.advanceTimersByTimeAsync(49);
      expect(mockRecentTrades).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(mockRecentTrades).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns stale mids when a refresh hits a transient failure after cache warmup', async () => {
    vi.useFakeTimers();
    try {
      const { HyperliquidClient } = await import('../../src/execution/hyperliquid/client.js');
      const config = {
        hyperliquid: { enabled: true, midsCacheTtlMs: 10 },
      } as any;
      const client = new HyperliquidClient(config);

      mockAllMids.mockResolvedValueOnce({ BTC: '101' });
      const first = await client.getAllMids();
      expect(first).toEqual({ BTC: 101, 'dexA:ALT': 2 });

      await vi.advanceTimersByTimeAsync(11);
      mockAllMids.mockRejectedValueOnce(
        Object.assign(new Error('429 Too Many Requests - null'), { response: { status: 429 } })
      );

      const second = await client.getAllMids();
      expect(second).toEqual(first);
      expect(mockAllMids).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
