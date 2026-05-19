import type { ThufirConfig } from './config.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import { PriceService } from '../technical/prices.js';

export interface TaSnapshot {
  symbol: string;
  price: number;
  priceVs24hHigh: number;
  priceVs24hLow: number;
  oiUsd: number;
  oiDelta1hPct: number;
  oiDelta4hPct: number;
  fundingRatePct: number;
  volumeVs24hAvgPct: number;
  priceVsEma20_1h: number;
  trendBias: 'up' | 'down' | 'flat';
  triggerReasons: string[];
  rawFeatures: TaRawFeatures;
  alertReason?: string;
}

export interface TaRawFeatures {
  priceVs24hHighPct: number;
  priceVs24hLowPct: number;
  oiUsd: number;
  oiDelta1hPct: number;
  oiDelta4hPct: number;
  fundingRateAnnualPct: number;
  volumeVs24hAvgPct: number;
  priceVsEma20_1hPct: number;
  trendBias: 'up' | 'down' | 'flat';
}

const EMA_PERIOD = 20;
const EMA_MULTIPLIER = 2 / (EMA_PERIOD + 1);
// Funding comes from Hyperliquid as an 8h rate; annualise: * (24/8) * 365 * 100
const FUNDING_ANNUALISE = (24 / 8) * 365 * 100;

function computeEma20(closes: number[]): number[] {
  if (closes.length === 0) return [];
  const emas: number[] = [closes[0]!];
  for (let i = 1; i < closes.length; i++) {
    emas.push(closes[i]! * EMA_MULTIPLIER + emas[i - 1]! * (1 - EMA_MULTIPLIER));
  }
  return emas;
}

function hourBucket(now: number, bucketHours: number): number {
  return Math.floor(now / (bucketHours * 3600 * 1000));
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export class TaSurface {
  private priceService: PriceService;
  private hlClient: HyperliquidClient;
  // keyed by `${symbol}:${bucket}` → raw OI (lots)
  private oiStore = new Map<string, number>();

  constructor(private config: ThufirConfig) {
    this.priceService = new PriceService(config);
    this.hlClient = new HyperliquidClient(config);
  }

  async computeAll(markets: string[]): Promise<TaSnapshot[]> {
    if (markets.length === 0) return [];

    // Fetch mids and asset contexts in parallel with candle fetches
    const [mids, mergedMeta] = await Promise.all([
      this.hlClient.getAllMids(),
      this.hlClient.getMergedMetaAndAssetCtxs(),
    ]);

    const [metaObj, assetCtxs] = mergedMeta;
    const universe = metaObj.universe;
    const ctxBySymbol = new Map<string, Record<string, unknown>>();
    for (const [idx, item] of universe.entries()) {
      const ctx = assetCtxs[idx];
      if (ctx && typeof ctx === 'object') {
        ctxBySymbol.set(item.name, ctx as Record<string, unknown>);
      }
    }

    const now = Date.now();
    const bucket1h = hourBucket(now, 1);
    const bucket4h = hourBucket(now, 4);

    const results = await Promise.allSettled(
      markets.map((symbol) => this.computeOne(symbol, mids, ctxBySymbol, bucket1h, bucket4h))
    );

    const snapshots: TaSnapshot[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        snapshots.push(result.value);
      }
    }
    return snapshots;
  }

  private async computeOne(
    symbol: string,
    mids: Record<string, number>,
    ctxBySymbol: Map<string, Record<string, unknown>>,
    bucket1h: number,
    bucket4h: number
  ): Promise<TaSnapshot | null> {
    const candles = await this.priceService.getCandles(symbol, '1h', 24);
    if (candles.length === 0) return null;

    // Price — use mid from Hyperliquid if available; fall back to last candle close
    const price = mids[symbol] ?? candles[candles.length - 1]!.close;

    // 24h high/low/volume from candles
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);
    const max24hHigh = Math.max(...highs);
    const min24hLow = Math.min(...lows);
    const sumVolume = volumes.reduce((a, b) => a + b, 0);
    const avgHourlyVolume = sumVolume / candles.length;
    const lastVolume = candles[candles.length - 1]!.volume;

    const priceVs24hHigh = max24hHigh > 0 ? ((price - max24hHigh) / max24hHigh) * 100 : 0;
    const priceVs24hLow = min24hLow > 0 ? ((price - min24hLow) / min24hLow) * 100 : 0;
    const volumeVs24hAvgPct =
      avgHourlyVolume > 0 ? (lastVolume / avgHourlyVolume) * 100 - 100 : 0;

    // EMA20 (requires ≥20 candles)
    let priceVsEma20_1h = 0;
    let trendBias: 'up' | 'down' | 'flat' = 'flat';
    if (candles.length >= EMA_PERIOD) {
      const closes = candles.map((c) => c.close);
      const emas = computeEma20(closes);
      const lastEma = emas[emas.length - 1]!;
      const prevEma = emas.length >= 3 ? emas[emas.length - 3]! : emas[0]!;
      priceVsEma20_1h = lastEma > 0 ? ((price - lastEma) / lastEma) * 100 : 0;
      const slopePct = prevEma > 0 ? ((lastEma - prevEma) / prevEma) * 100 : 0;
      if (slopePct > 0.1) trendBias = 'up';
      else if (slopePct < -0.1) trendBias = 'down';
      else trendBias = 'flat';
    }

    // OI and funding from asset context
    const ctx = ctxBySymbol.get(symbol) ?? {};
    const rawOi = toNumber(ctx.openInterest);
    const safePx = price > 0 ? price : toNumber(ctx.markPx);
    const oiUsd = rawOi * safePx;

    // Funding rate: raw 8h rate → annualised %
    const rawFunding = toNumber(ctx.funding);
    const fundingRatePct = rawFunding * FUNDING_ANNUALISE;

    // OI delta — compare against stored bucket values
    const key1h = `${symbol}:${bucket1h}`;
    const key4h = `${symbol}:${bucket4h}`;
    const prevOi1h = this.oiStore.get(key1h);
    const prevOi4h = this.oiStore.get(key4h);

    const oiDelta1hPct =
      prevOi1h !== undefined && prevOi1h > 0 ? ((rawOi - prevOi1h) / prevOi1h) * 100 : 0;
    const oiDelta4hPct =
      prevOi4h !== undefined && prevOi4h > 0 ? ((rawOi - prevOi4h) / prevOi4h) * 100 : 0;

    // Store current OI for future delta computation
    if (prevOi1h === undefined) this.oiStore.set(key1h, rawOi);
    if (prevOi4h === undefined) this.oiStore.set(key4h, rawOi);

    // Alert thresholds (with safe defaults)
    const oiSpikePct = this.config.autonomy?.ta?.oiSpikePct ?? 8;
    const fundingExtremeAnnual = this.config.autonomy?.ta?.fundingExtremeAnnual ?? 50;
    const volumeSpikePct = this.config.autonomy?.ta?.volumeSpikePct ?? 150;

    const triggerReasons: string[] = [];
    if (Math.abs(oiDelta1hPct) > oiSpikePct) {
      triggerReasons.push(`oi_spike_1h:${oiDelta1hPct.toFixed(1)}%`);
    }
    if (Math.abs(fundingRatePct) > fundingExtremeAnnual) {
      triggerReasons.push(`funding_extreme:${fundingRatePct.toFixed(1)}%_ann`);
    }
    if (volumeVs24hAvgPct > volumeSpikePct) {
      triggerReasons.push(`volume_spike:${volumeVs24hAvgPct.toFixed(1)}%`);
    }

    const snapshot: TaSnapshot = {
      symbol,
      price,
      priceVs24hHigh,
      priceVs24hLow,
      oiUsd,
      oiDelta1hPct,
      oiDelta4hPct,
      fundingRatePct,
      volumeVs24hAvgPct,
      priceVsEma20_1h,
      trendBias,
      triggerReasons,
      rawFeatures: {
        priceVs24hHighPct: priceVs24hHigh,
        priceVs24hLowPct: priceVs24hLow,
        oiUsd,
        oiDelta1hPct,
        oiDelta4hPct,
        fundingRateAnnualPct: fundingRatePct,
        volumeVs24hAvgPct,
        priceVsEma20_1hPct: priceVsEma20_1h,
        trendBias,
      },
    };

    if (triggerReasons.length > 0) {
      // Compatibility shim for modules still reading the old single-string field.
      snapshot.alertReason = triggerReasons.join('; ');
    }

    return snapshot;
  }

  hasAlert(snapshot: TaSnapshot): boolean {
    return (snapshot.triggerReasons ?? []).length > 0;
  }
}
