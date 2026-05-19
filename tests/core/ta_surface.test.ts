/**
 * Tests for TaSurface — TA data surface layer.
 *
 * Validates:
 * 1. computeAll returns snapshot with EMA20, trendBias, priceVs24h fields from mock candles
 * 2. Alert fires when |oiDelta1hPct| > oiSpikePct threshold
 * 3. Alert fires when |fundingRatePct| > fundingExtremeAnnual threshold
 * 4. Alert fires when volumeVs24hAvgPct > volumeSpikePct threshold
 * 5. Partial fetch failure omits that symbol without blocking others
 * 6. EMA20 not computed when fewer than 20 candles → trendBias = 'flat'
 * 7. hasAlert returns false when no threshold crossed
 * 8. OI delta is 0 on first call (no prior state)
 * 9. OI delta computed correctly on second call with updated OI value
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetCandles = vi.fn();
const mockGetAllMids = vi.fn();
const mockGetMergedMetaAndAssetCtxs = vi.fn();

vi.mock('../../src/technical/prices.js', () => ({
  PriceService: vi.fn(() => ({
    getCandles: mockGetCandles,
  })),
}));

vi.mock('../../src/execution/hyperliquid/client.js', () => ({
  HyperliquidClient: vi.fn(() => ({
    getAllMids: mockGetAllMids,
    getMergedMetaAndAssetCtxs: mockGetMergedMetaAndAssetCtxs,
  })),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { TaSurface } from '../../src/core/ta_surface.js';
import type { TaSnapshot } from '../../src/core/ta_surface.js';
import type { ThufirConfig } from '../../src/core/config.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(ta?: Partial<{
  oiSpikePct: number;
  fundingExtremeAnnual: number;
  volumeSpikePct: number;
}>): ThufirConfig {
  return {
    autonomy: {
      ta: {
        oiSpikePct: ta?.oiSpikePct ?? 8,
        fundingExtremeAnnual: ta?.fundingExtremeAnnual ?? 50,
        volumeSpikePct: ta?.volumeSpikePct ?? 150,
      },
    },
  } as unknown as ThufirConfig;
}

function makeCandles(opts: {
  close?: number;
  lastVolume?: number;
  avgVolume?: number;
  high?: number;
  low?: number;
  count?: number;
} = {}) {
  const close = opts.close ?? 100;
  const high = opts.high ?? close * 1.02;
  const low = opts.low ?? close * 0.98;
  const avgVolume = opts.avgVolume ?? 1000;
  const lastVolume = opts.lastVolume ?? avgVolume;
  const count = opts.count ?? 24;

  return Array.from({ length: count }, (_, i) => ({
    timestamp: Date.now() - (count - 1 - i) * 3_600_000,
    open: close,
    high: i === count - 1 ? high : close * 1.02,
    low: i === count - 1 ? low : close * 0.98,
    close,
    volume: i === count - 1 ? lastVolume : avgVolume,
  }));
}

function makeMergedMeta(
  symbols: string[],
  ctxs: Array<Record<string, unknown>>
) {
  return [{ universe: symbols.map((s) => ({ name: s })) }, ctxs];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TaSurface', () => {
  let surface: TaSurface;

  beforeEach(() => {
    vi.clearAllMocks();
    surface = new TaSurface(makeConfig());
  });

  describe('computeAll — basic snapshot', () => {
    it('returns snapshot with EMA20, trendBias, and priceVs24h fields', async () => {
      const symbol = 'BTC';
      const candles = makeCandles({ close: 100, high: 105, low: 95 });
      mockGetCandles.mockResolvedValue(candles);
      mockGetAllMids.mockResolvedValue({ [symbol]: 100 });
      mockGetMergedMetaAndAssetCtxs.mockResolvedValue(
        makeMergedMeta([symbol], [{ openInterest: '500', funding: '0.0001', markPx: '100' }])
      );

      const result = await surface.computeAll([symbol]);

      expect(result).toHaveLength(1);
      const snap = result[0]!;
      expect(snap.symbol).toBe(symbol);
      expect(snap.price).toBe(100);
      // priceVs24hHigh: (100 - 105) / 105 * 100 ≈ -4.76%
      expect(snap.priceVs24hHigh).toBeCloseTo(-4.76, 1);
      // priceVs24hLow: (100 - 95) / 95 * 100 ≈ 5.26%
      expect(snap.priceVs24hLow).toBeCloseTo(5.26, 1);
      // EMA20 computed (24 candles), all closes equal → EMA = close, slope = 0 → flat
      expect(snap.priceVsEma20_1h).toBeDefined();
      expect(snap.trendBias).toBe('flat');
      // oiUsd = 500 * 100 = 50000
      expect(snap.oiUsd).toBe(50000);
      expect(snap.triggerReasons).toEqual([]);
      expect(snap.rawFeatures).toMatchObject({
        oiUsd: 50000,
        fundingRateAnnualPct: snap.fundingRatePct,
        trendBias: 'flat',
      });
    });
  });

  describe('alert: OI spike', () => {
    it('fires alert when |oiDelta1hPct| > oiSpikePct on second call', async () => {
      const symbol = 'ETH';
      const candles = makeCandles({ close: 200 });
      mockGetCandles.mockResolvedValue(candles);
      mockGetAllMids.mockResolvedValue({ [symbol]: 200 });

      // Build a surface with oiSpikePct=5, seed initial OI via first call
      const surface2 = new TaSurface(makeConfig({ oiSpikePct: 5 }));
      mockGetMergedMetaAndAssetCtxs.mockResolvedValue(
        makeMergedMeta([symbol], [{ openInterest: '1000', funding: '0.0001', markPx: '200' }])
      );
      await surface2.computeAll([symbol]);

      // Manually seed the stored OI for the current 1h bucket to a known value
      const nowMs = Date.now();
      const bucket1h = Math.floor(nowMs / (1 * 3600 * 1000));
      (surface2 as any).oiStore.set(`${symbol}:${bucket1h}`, 1000);

      // Second call with OI = 1200 → delta = 20% > 5% threshold
      vi.clearAllMocks();
      mockGetCandles.mockResolvedValue(candles);
      mockGetAllMids.mockResolvedValue({ [symbol]: 200 });
      mockGetMergedMetaAndAssetCtxs.mockResolvedValue(
        makeMergedMeta([symbol], [{ openInterest: '1200', funding: '0.0001', markPx: '200' }])
      );
      const result = await surface2.computeAll([symbol]);

      expect(result).toHaveLength(1);
      expect(result[0]!.oiDelta1hPct).toBeCloseTo(20, 0);
      expect(result[0]!.triggerReasons).toContain('oi_spike_1h:20.0%');
      expect(result[0]!.alertReason).toContain('oi_spike_1h');
    });
  });

  describe('alert: funding extreme', () => {
    it('fires alert when |fundingRatePct| > fundingExtremeAnnual', async () => {
      const symbol = 'BTC';
      const candles = makeCandles({ close: 100 });
      mockGetCandles.mockResolvedValue(candles);
      mockGetAllMids.mockResolvedValue({ [symbol]: 100 });
      // 0.002 per 8h → annualised = 0.002 * 3 * 365 * 100 ≈ 219% > 50%
      mockGetMergedMetaAndAssetCtxs.mockResolvedValue(
        makeMergedMeta([symbol], [{ openInterest: '100', funding: '0.002', markPx: '100' }])
      );

      const result = await surface.computeAll([symbol]);
      expect(result[0]!.triggerReasons).toContain('funding_extreme:219.0%_ann');
      expect(result[0]!.alertReason).toContain('funding_extreme');
    });

    it('does not fire when funding is below threshold', async () => {
      const symbol = 'BTC';
      const candles = makeCandles({ close: 100 });
      mockGetCandles.mockResolvedValue(candles);
      mockGetAllMids.mockResolvedValue({ [symbol]: 100 });
      // 0.0001 per 8h → annualised ≈ 10.95% < 50%
      mockGetMergedMetaAndAssetCtxs.mockResolvedValue(
        makeMergedMeta([symbol], [{ openInterest: '100', funding: '0.0001', markPx: '100' }])
      );

      const result = await surface.computeAll([symbol]);
      expect(result[0]!.triggerReasons).toEqual([]);
      expect(result[0]!.alertReason).toBeUndefined();
    });
  });

  describe('alert: volume spike', () => {
    it('fires alert when volumeVs24hAvgPct > volumeSpikePct', async () => {
      const symbol = 'SOL';
      // 23 candles at volume=1000, last candle at 4000
      // avg = (23*1000 + 4000)/24 ≈ 1125; lastVolume/avg*100-100 ≈ 255% > 150%
      const candles = Array.from({ length: 24 }, (_, i) => ({
        timestamp: Date.now() - (23 - i) * 3_600_000,
        open: 100,
        high: 102,
        low: 98,
        close: 100,
        volume: i === 23 ? 4000 : 1000,
      }));
      mockGetCandles.mockResolvedValue(candles);
      mockGetAllMids.mockResolvedValue({ [symbol]: 100 });
      mockGetMergedMetaAndAssetCtxs.mockResolvedValue(
        makeMergedMeta([symbol], [{ openInterest: '100', funding: '0.0001', markPx: '100' }])
      );

      const result = await surface.computeAll([symbol]);
      expect(result).toHaveLength(1);
      expect(result[0]!.triggerReasons).toContain('volume_spike:255.6%');
      expect(result[0]!.alertReason).toContain('volume_spike');
    });
  });

  describe('partial failure', () => {
    it('omits symbol that throws without blocking others', async () => {
      const goodSymbol = 'BTC';
      const badSymbol = 'FAIL';
      const candles = makeCandles({ close: 100 });

      mockGetCandles.mockImplementation((sym: string) => {
        if (sym === badSymbol) return Promise.reject(new Error('fetch failed'));
        return Promise.resolve(candles);
      });
      mockGetAllMids.mockResolvedValue({ [goodSymbol]: 100, [badSymbol]: 50 });
      mockGetMergedMetaAndAssetCtxs.mockResolvedValue(
        makeMergedMeta(
          [goodSymbol, badSymbol],
          [
            { openInterest: '100', funding: '0.0001', markPx: '100' },
            { openInterest: '200', funding: '0.0001', markPx: '50' },
          ]
        )
      );

      const result = await surface.computeAll([goodSymbol, badSymbol]);
      expect(result).toHaveLength(1);
      expect(result[0]!.symbol).toBe(goodSymbol);
    });
  });

  describe('EMA20 — fewer than 20 candles', () => {
    it('sets trendBias=flat and priceVsEma20_1h=0 when fewer than 20 candles', async () => {
      const symbol = 'BTC';
      const shortCandles = makeCandles({ close: 100, count: 10 });
      mockGetCandles.mockResolvedValue(shortCandles);
      mockGetAllMids.mockResolvedValue({ [symbol]: 100 });
      mockGetMergedMetaAndAssetCtxs.mockResolvedValue(
        makeMergedMeta([symbol], [{ openInterest: '100', funding: '0.0001', markPx: '100' }])
      );

      const result = await surface.computeAll([symbol]);
      expect(result).toHaveLength(1);
      expect(result[0]!.trendBias).toBe('flat');
      expect(result[0]!.priceVsEma20_1h).toBe(0);
    });
  });

  describe('hasAlert', () => {
    it('returns false when no threshold crossed', async () => {
      const symbol = 'BTC';
      const candles = makeCandles({ close: 100 });
      mockGetCandles.mockResolvedValue(candles);
      mockGetAllMids.mockResolvedValue({ [symbol]: 100 });
      mockGetMergedMetaAndAssetCtxs.mockResolvedValue(
        makeMergedMeta([symbol], [{ openInterest: '100', funding: '0.0001', markPx: '100' }])
      );

      const result = await surface.computeAll([symbol]);
      expect(result).toHaveLength(1);
      expect(surface.hasAlert(result[0]!)).toBe(false);
    });

    it('returns true when triggerReasons are present', () => {
      const snap: TaSnapshot = {
        symbol: 'BTC',
        price: 100,
        priceVs24hHigh: -5,
        priceVs24hLow: 5,
        oiUsd: 50000,
        oiDelta1hPct: 20,
        oiDelta4hPct: 0,
        fundingRatePct: 10,
        volumeVs24hAvgPct: 50,
        priceVsEma20_1h: 1,
        trendBias: 'up',
        triggerReasons: ['oi_spike_1h:20.0%'],
        rawFeatures: {
          priceVs24hHighPct: -5,
          priceVs24hLowPct: 5,
          oiUsd: 50000,
          oiDelta1hPct: 20,
          oiDelta4hPct: 0,
          fundingRateAnnualPct: 10,
          volumeVs24hAvgPct: 50,
          priceVsEma20_1hPct: 1,
          trendBias: 'up',
        },
        alertReason: 'oi_spike_1h:20.0%',
      };
      expect(surface.hasAlert(snap)).toBe(true);
    });
  });

  describe('OI delta tracking', () => {
    it('sets oiDelta1hPct=0 on first call (no prior state)', async () => {
      const symbol = 'BTC';
      const candles = makeCandles({ close: 100 });
      mockGetCandles.mockResolvedValue(candles);
      mockGetAllMids.mockResolvedValue({ [symbol]: 100 });
      mockGetMergedMetaAndAssetCtxs.mockResolvedValue(
        makeMergedMeta([symbol], [{ openInterest: '500', funding: '0.0001', markPx: '100' }])
      );

      const result = await surface.computeAll([symbol]);
      expect(result[0]!.oiDelta1hPct).toBe(0);
      expect(result[0]!.oiDelta4hPct).toBe(0);
    });

    it('computes oiDelta correctly on second call with updated OI', async () => {
      const symbol = 'BTC';
      const candles = makeCandles({ close: 100 });
      mockGetCandles.mockResolvedValue(candles);
      mockGetAllMids.mockResolvedValue({ [symbol]: 100 });

      // First call — seeds the store with OI = 1000
      mockGetMergedMetaAndAssetCtxs.mockResolvedValue(
        makeMergedMeta([symbol], [{ openInterest: '1000', funding: '0.0001', markPx: '100' }])
      );
      await surface.computeAll([symbol]);

      // Force the stored value so the delta computation is deterministic
      const nowMs = Date.now();
      const bucket1h = Math.floor(nowMs / (1 * 3600 * 1000));
      (surface as any).oiStore.set(`${symbol}:${bucket1h}`, 1000);

      // Second call with OI = 1100 → delta = (1100-1000)/1000 * 100 = 10%
      vi.clearAllMocks();
      mockGetCandles.mockResolvedValue(candles);
      mockGetAllMids.mockResolvedValue({ [symbol]: 100 });
      mockGetMergedMetaAndAssetCtxs.mockResolvedValue(
        makeMergedMeta([symbol], [{ openInterest: '1100', funding: '0.0001', markPx: '100' }])
      );
      const second = await surface.computeAll([symbol]);
      expect(second[0]!.oiDelta1hPct).toBeCloseTo(10, 1);
    });
  });

  describe('summarizeCoverage', () => {
    it('reports missing markets and coverage ratio for collapsed TA fetches', () => {
      const summary = surface.summarizeCoverage(
        ['BTC', 'ETH', 'SOL'],
        [{ symbol: 'BTC' } as TaSnapshot]
      );

      expect(summary.requestedCount).toBe(3);
      expect(summary.snapshotCount).toBe(1);
      expect(summary.coverageRatio).toBeCloseTo(1 / 3, 5);
      expect(summary.missingMarkets).toEqual(['ETH', 'SOL']);
    });
  });
});
