import type { ThufirConfig } from '../core/config.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import { PriceService } from '../technical/prices.js';
import type { SignalPrimitive } from './types.js';

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

function pctChange(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return 0;
  return (b - a) / a;
}

function sum(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0);
}

function toNumber(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeHyperliquidSymbol(symbol: string): string {
  if (!symbol) return symbol;
  const [base] = symbol.split('/');
  return base ?? symbol;
}

export async function signalPriceVolRegime(
  config: ThufirConfig,
  symbol: string
): Promise<SignalPrimitive | null> {
  const priceService = new PriceService(config);
  const candles = await priceService.getCandles(symbol, '1h', 80);
  if (candles.length < 30) return null;

  const closes = candles.map((c) => c.close);
  const returns = closes.slice(1).map((c, i) => pctChange(closes[i]!, c));
  const recent = returns.slice(-10);
  const prior = returns.slice(0, -10);
  const recentVol = std(recent);
  const priorVol = std(prior);
  const volZ = priorVol > 0 ? (recentVol - priorVol) / priorVol : 0;
  const trend = pctChange(closes[closes.length - 11]!, closes[closes.length - 1]!);

  const directionalBias = trend > 0.01 ? 'up' : trend < -0.01 ? 'down' : 'neutral';
  const confidence = Math.min(1, Math.max(0, Math.abs(volZ)));
  const timeHorizon = 'hours';

  return {
    id: `price_vol_${symbol}_${Date.now()}`,
    kind: 'price_vol_regime',
    symbol,
    directionalBias,
    confidence,
    timeHorizon,
    metrics: {
      recentVol,
      priorVol,
      volZ,
      trend,
    },
  };
}

export async function signalCrossAssetDivergence(
  config: ThufirConfig,
  symbols: string[]
): Promise<SignalPrimitive[]> {
  if (symbols.length < 2) return [];
  const priceService = new PriceService(config);
  const results: SignalPrimitive[] = [];

  const series = await Promise.all(
    symbols.map(async (symbol) => {
      const candles = await priceService.getCandles(symbol, '1h', 40);
      const closes = candles.map((c) => c.close);
      const trend = pctChange(closes[0]!, closes[closes.length - 1]!);
      return { symbol, trend };
    })
  );

  const avgTrend = mean(series.map((s) => s.trend));
  for (const s of series) {
    const divergence = s.trend - avgTrend;
    if (Math.abs(divergence) < 0.01) continue;
    results.push({
      id: `cross_asset_${s.symbol}_${Date.now()}`,
      kind: 'cross_asset_divergence',
      symbol: s.symbol,
      directionalBias: divergence > 0 ? 'up' : 'down',
      confidence: Math.min(1, Math.abs(divergence) * 10),
      timeHorizon: 'hours',
      metrics: {
        trend: s.trend,
        avgTrend,
        divergence,
      },
    });
  }

  return results;
}

export async function signalHyperliquidFundingOISkew(
  config: ThufirConfig,
  symbol: string
): Promise<SignalPrimitive | null> {
  const coin = normalizeHyperliquidSymbol(symbol);
  if (!coin) return null;

  const client = new HyperliquidClient(config);
  const [meta, assetCtxs] = await client.getMetaAndAssetCtxs();
  const idx = meta.universe.findIndex((item) => item.name === coin);
  if (idx < 0 || idx >= assetCtxs.length) return null;

  const ctx = assetCtxs[idx]!;
  const fundingRate = toNumber(ctx.funding);
  const openInterest = toNumber(ctx.openInterest);
  const openInterests = assetCtxs.map((item) => toNumber(item.openInterest));
  const meanOpenInterest = mean(openInterests);
  const totalOpenInterest = sum(openInterests);
  const oiZ = meanOpenInterest > 0 ? (openInterest - meanOpenInterest) / meanOpenInterest : 0;
  const oiShare = totalOpenInterest > 0 ? openInterest / totalOpenInterest : 0;

  const endTime = Date.now();
  const startTime = endTime - 1000 * 60 * 60 * 24;
  let avgFunding = 0;
  let fundingTrend = 0;
  try {
    const history = await client.getFundingHistory(coin, startTime, endTime);
    const rates = history.map((item) => toNumber(item.fundingRate));
    avgFunding = mean(rates);
    const last = rates[rates.length - 1] ?? 0;
    fundingTrend = last - avgFunding;
  } catch {
    // Best-effort: funding history may be unavailable for thin markets.
  }

  const fundingSign = fundingRate > 0 ? 1 : fundingRate < 0 ? -1 : 0;
  const biasScore = -fundingSign * Math.max(0, oiZ);
  const directionalBias = biasScore > 0 ? 'up' : biasScore < 0 ? 'down' : 'neutral';
  const fundingStrength = Math.min(1, Math.abs(fundingRate) * 100);
  const oiStrength = Math.min(1, Math.abs(oiZ));
  const confidence = Math.min(1, fundingStrength * 0.6 + oiStrength * 0.4);

  return {
    id: `funding_oi_${coin}_${Date.now()}`,
    kind: 'funding_oi_skew',
    symbol,
    directionalBias,
    confidence,
    timeHorizon: 'hours',
    metrics: {
      fundingRate,
      avgFunding,
      fundingTrend,
      openInterest,
      meanOpenInterest,
      oiZ,
      oiShare,
    },
  };
}

export async function signalHyperliquidOrderflowImbalance(
  config: ThufirConfig,
  symbol: string
): Promise<SignalPrimitive | null> {
  const coin = normalizeHyperliquidSymbol(symbol);
  if (!coin) return null;

  const client = new HyperliquidClient(config);
  const trades = await client.getRecentTrades(coin);
  if (trades.length === 0) return null;

  let buyNotional = 0;
  let sellNotional = 0;
  let tradeCount = 0;
  for (const trade of trades) {
    const px = toNumber(trade.px);
    const sz = toNumber(trade.sz);
    const notional = px * sz;
    if (!Number.isFinite(notional) || notional <= 0) {
      continue;
    }
    const side = String(trade.side ?? '').toUpperCase();
    if (side === 'B' || side === 'BUY') {
      buyNotional += notional;
      tradeCount += 1;
    } else if (side === 'A' || side === 'S' || side === 'SELL') {
      sellNotional += notional;
      tradeCount += 1;
    }
  }
  if (tradeCount === 0) return null;
  const total = buyNotional + sellNotional;
  if (total <= 0) return null;
  const imbalance = (buyNotional - sellNotional) / total;
  const directionalBias = imbalance > 0.1 ? 'up' : imbalance < -0.1 ? 'down' : 'neutral';
  const sampleStrength = Math.min(1, tradeCount / 12);
  const confidence = Math.min(1, Math.abs(imbalance) * 2 * sampleStrength);

  return {
    id: `orderflow_${coin}_${Date.now()}`,
    kind: 'orderflow_imbalance',
    symbol,
    directionalBias,
    confidence,
    timeHorizon: 'minutes',
    metrics: {
      buyNotional,
      sellNotional,
      imbalance,
      tradeCount,
    },
  };
}
