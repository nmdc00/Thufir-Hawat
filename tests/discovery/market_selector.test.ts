import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMergedMetaAndAssetCtxs = vi.fn();

vi.mock('../../src/execution/hyperliquid/client.js', () => ({
  HyperliquidClient: class {
    async getMergedMetaAndAssetCtxs() {
      return getMergedMetaAndAssetCtxs();
    }
  },
}));

describe('selectDiscoveryMarkets', () => {
  beforeEach(() => {
    getMergedMetaAndAssetCtxs.mockReset();
    getMergedMetaAndAssetCtxs.mockResolvedValue([
      {
        universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'DOGE' }, { name: 'SOL' }],
      },
      [
        { markPx: 70000, oraclePx: 70010, openInterest: 25_000, dayNtlVlm: 2_000_000_000, funding: 0.0001 },
        { markPx: 3500, oraclePx: 3501, openInterest: 80_000, dayNtlVlm: 1_600_000_000, funding: 0.00005 },
        { markPx: 0.2, oraclePx: 0.2, openInterest: 3_000_000, dayNtlVlm: 50_000_000, funding: 0.0008 },
        { markPx: 130, oraclePx: 130.5, openInterest: 200_000, dayNtlVlm: 500_000_000, funding: 0.0002 },
      ],
    ]);
  });

  it('returns configured symbols directly when an allowlist exists', async () => {
    const { selectDiscoveryMarkets } = await import('../../src/discovery/market_selector.js');
    const result = await selectDiscoveryMarkets({
      hyperliquid: { symbols: ['BTC', 'ETH'] },
      autonomy: { discoverySelection: { fullUniverseWhenSymbolsEmpty: true } },
    } as any);

    expect(result.source).toBe('configured');
    expect(result.candidates.map((c) => c.symbol)).toEqual(['BTC', 'ETH']);
    expect(getMergedMetaAndAssetCtxs).not.toHaveBeenCalled();
  });

  it('ranks full universe when symbols are empty and full-universe mode is enabled', async () => {
    const { selectDiscoveryMarkets } = await import('../../src/discovery/market_selector.js');
    const result = await selectDiscoveryMarkets({
      hyperliquid: { symbols: [] },
      autonomy: {
        discoverySelection: {
          fullUniverseWhenSymbolsEmpty: true,
          preselectLimit: 3,
          minOpenInterestUsd: 1_000_000,
          minDayVolumeUsd: 10_000_000,
        },
      },
    } as any);

    expect(result.source).toBe('full_universe');
    expect(result.candidates.length).toBe(3);
    expect(result.candidates[0]?.symbol).toBe('BTC');
    expect(result.candidates.some((c) => c.symbol === 'DOGE')).toBe(false);
    expect(getMergedMetaAndAssetCtxs).toHaveBeenCalledTimes(1);
  });

  it('falls back to configured default symbols when Hyperliquid API is degraded', async () => {
    getMergedMetaAndAssetCtxs.mockRejectedValueOnce(new Error('503'));
    const { selectDiscoveryMarkets } = await import('../../src/discovery/market_selector.js');
    const result = await selectDiscoveryMarkets({
      hyperliquid: { symbols: [] },
      autonomy: {
        discoverySelection: {
          fullUniverseWhenSymbolsEmpty: true,
          preselectLimit: 3,
        },
      },
    } as any);

    expect(result.source).toBe('configured');
    expect(result.candidates.map((c) => c.symbol)).toEqual(['BTC', 'ETH']);
  });

  it('uses deterministic tie-break ordering when scores are equal', async () => {
    getMergedMetaAndAssetCtxs.mockResolvedValueOnce([
      {
        universe: [{ name: 'XRP' }, { name: 'ADA' }, { name: 'DOGE' }],
      },
      [
        { markPx: 1, oraclePx: 1, openInterest: 1_000_000, dayNtlVlm: 10_000_000, funding: 0 },
        { markPx: 1, oraclePx: 1, openInterest: 1_000_000, dayNtlVlm: 10_000_000, funding: 0 },
        { markPx: 1, oraclePx: 1, openInterest: 1_000_000, dayNtlVlm: 10_000_000, funding: 0 },
      ],
    ]);
    const { selectDiscoveryMarkets } = await import('../../src/discovery/market_selector.js');
    const result = await selectDiscoveryMarkets({
      hyperliquid: { symbols: [] },
      autonomy: {
        discoverySelection: {
          fullUniverseWhenSymbolsEmpty: true,
          preselectLimit: 3,
          minOpenInterestUsd: 1,
          minDayVolumeUsd: 1,
        },
      },
    } as any);

    expect(result.source).toBe('full_universe');
    expect(result.candidates.map((c) => c.symbol)).toEqual(['ADA', 'DOGE', 'XRP']);
  });

  it('enforces minimum-quality cutoff in fallback mode before returning candidates', async () => {
    getMergedMetaAndAssetCtxs.mockResolvedValueOnce([
      {
        universe: [{ name: 'LOW1' }, { name: 'LOW2' }, { name: 'GOOD' }],
      },
      [
        { markPx: 1, oraclePx: 1, openInterest: 200_000, dayNtlVlm: 900_000, funding: 0 },
        { markPx: 1, oraclePx: 1, openInterest: 80_000, dayNtlVlm: 500_000, funding: 0 },
        { markPx: 1, oraclePx: 1, openInterest: 120_000, dayNtlVlm: 1_200_000, funding: 0 },
      ],
    ]);
    const { selectDiscoveryMarkets } = await import('../../src/discovery/market_selector.js');
    const result = await selectDiscoveryMarkets({
      hyperliquid: { symbols: [] },
      autonomy: {
        discoverySelection: {
          fullUniverseWhenSymbolsEmpty: true,
          preselectLimit: 5,
          minOpenInterestUsd: 1_000_000,
          minDayVolumeUsd: 10_000_000,
        },
      },
    } as any);

    expect(result.source).toBe('full_universe');
    expect(result.candidates.map((c) => c.symbol)).toEqual(['GOOD']);
  });

  it('includes HIP-3 dex markets in full-universe ranking', async () => {
    getMergedMetaAndAssetCtxs.mockResolvedValueOnce([
      {
        universe: [{ name: 'BTC' }, { name: 'xyz:TSLA' }, { name: 'ETH' }],
      },
      [
        { markPx: 70000, oraclePx: 70010, openInterest: 25_000, dayNtlVlm: 2_000_000_000, funding: 0.0001 },
        { markPx: 280, oraclePx: 279.8, openInterest: 2_000_000, dayNtlVlm: 3_000_000_000, funding: 0.0002 },
        { markPx: 3500, oraclePx: 3501, openInterest: 80_000, dayNtlVlm: 1_600_000_000, funding: 0.00005 },
      ],
    ]);
    const { selectDiscoveryMarkets } = await import('../../src/discovery/market_selector.js');
    const result = await selectDiscoveryMarkets({
      hyperliquid: { symbols: [] },
      autonomy: {
        discoverySelection: {
          fullUniverseWhenSymbolsEmpty: true,
          preselectLimit: 3,
          minOpenInterestUsd: 1,
          minDayVolumeUsd: 1,
        },
      },
    } as any);

    expect(result.source).toBe('full_universe');
    expect(result.candidates.some((c) => c.symbol === 'xyz:TSLA')).toBe(true);
  });
});
