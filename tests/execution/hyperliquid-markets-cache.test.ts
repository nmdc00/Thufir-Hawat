import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listPerpMarketsMock = vi.fn();
const getAllMidsMock = vi.fn();

vi.mock('../../src/execution/hyperliquid/client.js', () => ({
  HyperliquidClient: class {
    listPerpMarkets = listPerpMarketsMock;
    getAllMids = getAllMidsMock;
  },
}));

describe('HyperliquidMarketClient cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T00:00:00.000Z'));
    listPerpMarketsMock.mockReset();
    getAllMidsMock.mockReset();
    listPerpMarketsMock.mockResolvedValue([
      { symbol: 'BTC', assetId: 0, maxLeverage: 10, szDecimals: 3 },
      { symbol: 'ETH', assetId: 1, maxLeverage: 10, szDecimals: 3 },
    ]);
    getAllMidsMock.mockResolvedValue({ BTC: 100000, ETH: 3000 });
    process.env.THUFIR_MARKET_META_CACHE_TTL_MS = '600000';
    process.env.THUFIR_MARKET_MIDS_CACHE_TTL_MS = '30000';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.THUFIR_MARKET_META_CACHE_TTL_MS;
    delete process.env.THUFIR_MARKET_MIDS_CACHE_TTL_MS;
  });

  it('reuses cached market metadata and mids across repeated getMarket calls', async () => {
    const { HyperliquidMarketClient } = await import('../../src/execution/hyperliquid/markets.js');
    const client = new HyperliquidMarketClient({ hyperliquid: { enabled: true } } as any);

    await client.getMarket('BTC');
    await client.getMarket('ETH');

    expect(listPerpMarketsMock).toHaveBeenCalledTimes(1);
    expect(getAllMidsMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes cache after TTL expiry', async () => {
    process.env.THUFIR_MARKET_META_CACHE_TTL_MS = '1000';
    process.env.THUFIR_MARKET_MIDS_CACHE_TTL_MS = '1000';
    const { HyperliquidMarketClient } = await import('../../src/execution/hyperliquid/markets.js');
    const client = new HyperliquidMarketClient({ hyperliquid: { enabled: true } } as any);

    await client.getMarket('BTC');
    vi.setSystemTime(new Date('2026-02-17T00:00:02.000Z'));
    await client.getMarket('BTC');

    expect(listPerpMarketsMock).toHaveBeenCalledTimes(2);
    expect(getAllMidsMock).toHaveBeenCalledTimes(2);
  });

  it('matches base symbols against quoted market symbols', async () => {
    listPerpMarketsMock.mockResolvedValue([
      { symbol: 'xyz:CL', assetId: 12, maxLeverage: 5, szDecimals: 2 },
    ]);
    getAllMidsMock.mockResolvedValue({ 'xyz:CL': 72.15 });
    const { HyperliquidMarketClient } = await import('../../src/execution/hyperliquid/markets.js');
    const client = new HyperliquidMarketClient({ hyperliquid: { enabled: true } } as any);

    await expect(client.getMarket('CL')).resolves.toMatchObject({
      symbol: 'xyz:CL',
      markPrice: 72.15,
    });
    await expect(client.getMarket('xyz:CL')).resolves.toMatchObject({
      symbol: 'xyz:CL',
      markPrice: 72.15,
    });
  });

  it('resolves an exact main symbol when a DEX market shares its base', async () => {
    listPerpMarketsMock.mockResolvedValue([
      { symbol: 'ZEC', assetId: 0, maxLeverage: 10, szDecimals: 2, dex: null },
      { symbol: 'hyna:ZEC', assetId: 1, maxLeverage: 10, szDecimals: 2, dex: 'hyna' },
    ]);
    getAllMidsMock.mockResolvedValue({ ZEC: 1258.3, 'hyna:ZEC': 856.99 });
    const { HyperliquidMarketClient } = await import('../../src/execution/hyperliquid/markets.js');
    const client = new HyperliquidMarketClient({ hyperliquid: { enabled: true } } as any);

    await expect(client.getMarket('ZEC')).resolves.toMatchObject({ symbol: 'ZEC', markPrice: 1258.3 });
    await expect(client.getMarket('hyna:ZEC')).resolves.toMatchObject({
      symbol: 'hyna:ZEC',
      markPrice: 856.99,
    });
  });

  it('fails closed when only multiple qualified markets share a base', async () => {
    listPerpMarketsMock.mockResolvedValue([
      { symbol: 'hyna:ZEC', assetId: 1, maxLeverage: 10, szDecimals: 2, dex: 'hyna' },
      { symbol: 'flx:ZEC', assetId: 2, maxLeverage: 10, szDecimals: 2, dex: 'flx' },
    ]);
    getAllMidsMock.mockResolvedValue({ 'hyna:ZEC': 856, 'flx:ZEC': 857 });
    const { HyperliquidMarketClient } = await import('../../src/execution/hyperliquid/markets.js');
    const client = new HyperliquidMarketClient({ hyperliquid: { enabled: true } } as any);
    await expect(client.getMarket('ZEC')).rejects.toThrow(/hyna:ZEC, flx:ZEC/);
    await expect(client.getMarket('other:ZEC')).rejects.toThrow(/not found/);
  });

  it('treats configured symbols as canonical market IDs', async () => {
    listPerpMarketsMock.mockResolvedValue([
      { symbol: 'ETH', assetId: 1, maxLeverage: 10, szDecimals: 2, dex: null },
      { symbol: 'hyna:ETH', assetId: 2, maxLeverage: 10, szDecimals: 2, dex: 'hyna' },
    ]);
    getAllMidsMock.mockResolvedValue({ ETH: 3000, 'hyna:ETH': 3001 });
    const { HyperliquidMarketClient } = await import('../../src/execution/hyperliquid/markets.js');
    const main = new HyperliquidMarketClient({ hyperliquid: { enabled: true, symbols: ['ETH'] } } as any);
    const hyna = new HyperliquidMarketClient({ hyperliquid: { enabled: true, symbols: ['hyna:ETH'] } } as any);
    await expect(main.listMarkets()).resolves.toMatchObject([{ symbol: 'ETH' }]);
    await expect(hyna.listMarkets()).resolves.toMatchObject([{ symbol: 'hyna:ETH' }]);
    await expect(hyna.getMarket('ETH')).rejects.toThrow(/not found/);
  });

  it('returns stale data when refresh fails (stale-if-error)', async () => {
    process.env.THUFIR_MARKET_MIDS_CACHE_TTL_MS = '1000';
    process.env.THUFIR_MARKET_META_CACHE_TTL_MS = '1000';
    const { HyperliquidMarketClient } = await import('../../src/execution/hyperliquid/markets.js');
    const client = new HyperliquidMarketClient({ hyperliquid: { enabled: true } } as any);

    // Warm the cache successfully
    await client.getMarket('BTC');
    expect(getAllMidsMock).toHaveBeenCalledTimes(1);

    // Advance past TTL and simulate a rate-limit error
    vi.setSystemTime(new Date('2026-02-17T00:00:02.000Z'));
    getAllMidsMock.mockRejectedValue(new Error('429 Too Many Requests'));
    listPerpMarketsMock.mockRejectedValue(new Error('429 Too Many Requests'));

    // Should still resolve using stale cache, not throw
    const market = await client.getMarket('BTC');
    expect(market.symbol).toBe('BTC');
    expect(market.markPrice).toBe(100000);
  });

  it('blends main and HIP-3 dex markets into low-limit listings', async () => {
    listPerpMarketsMock.mockResolvedValue([
      { symbol: 'BTC', assetId: 0, maxLeverage: 10, szDecimals: 3, dex: null },
      { symbol: 'ETH', assetId: 1, maxLeverage: 10, szDecimals: 3, dex: null },
      { symbol: 'SOL', assetId: 2, maxLeverage: 10, szDecimals: 3, dex: null },
      { symbol: 'xyz:CL', assetId: 3, maxLeverage: 5, szDecimals: 2, dex: 'xyz' },
      { symbol: 'xyz:TSLA', assetId: 4, maxLeverage: 5, szDecimals: 2, dex: 'xyz' },
    ]);
    getAllMidsMock.mockResolvedValue({ BTC: 100000, ETH: 3000, SOL: 150, 'xyz:CL': 72.15, 'xyz:TSLA': 280 });
    const { HyperliquidMarketClient } = await import('../../src/execution/hyperliquid/markets.js');
    const client = new HyperliquidMarketClient({ hyperliquid: { enabled: true } } as any);

    await expect(client.listMarkets(4)).resolves.toMatchObject([
      { symbol: 'BTC', metadata: { dex: null } },
      { symbol: 'xyz:CL', metadata: { dex: 'xyz' } },
      { symbol: 'ETH', metadata: { dex: null } },
      { symbol: 'xyz:TSLA', metadata: { dex: 'xyz' } },
    ]);
  });
});
