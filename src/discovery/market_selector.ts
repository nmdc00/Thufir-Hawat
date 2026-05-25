import type { ThufirConfig } from '../core/config.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';

type MarketRow = {
  symbol: string;
  openInterestUsd: number;
  dayVolumeUsd: number;
  fundingRate: number;
  markPx: number;
  oraclePx: number;
  spreadProxyBps: number;
};

export interface DiscoveryCandidate {
  symbol: string;
  score: number;
  liquidityScore: number;
  executionScore: number;
  fundingScore: number;
  openInterestUsd: number;
  dayVolumeUsd: number;
  fundingRate: number;
  spreadProxyBps: number;
}

function toNumber(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeSymbol).filter(Boolean)));
}

export function getConfiguredDiscoveryUniverse(config: ThufirConfig): string[] {
  return uniq(config.hyperliquid?.symbols ?? []);
}

function scoreRows(rows: MarketRow[]): DiscoveryCandidate[] {
  if (rows.length === 0) return [];

  const maxOi = Math.max(...rows.map((r) => r.openInterestUsd), 1);
  const maxVol = Math.max(...rows.map((r) => r.dayVolumeUsd), 1);

  return rows
    .map((row) => {
      const oiNorm = clamp01(row.openInterestUsd / maxOi);
      const volNorm = clamp01(row.dayVolumeUsd / maxVol);
      const liquidityScore = clamp01(oiNorm * 0.45 + volNorm * 0.55);
      const executionScore = clamp01(1 - row.spreadProxyBps / 25);
      const fundingPenalty = clamp01(Math.abs(row.fundingRate) / 0.0025);
      const fundingScore = clamp01(1 - fundingPenalty * 0.35);
      const score = clamp01(liquidityScore * 0.65 + executionScore * 0.25 + fundingScore * 0.1);
      return {
        symbol: row.symbol,
        score,
        liquidityScore,
        executionScore,
        fundingScore,
        openInterestUsd: row.openInterestUsd,
        dayVolumeUsd: row.dayVolumeUsd,
        fundingRate: row.fundingRate,
        spreadProxyBps: row.spreadProxyBps,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.dayVolumeUsd !== a.dayVolumeUsd) return b.dayVolumeUsd - a.dayVolumeUsd;
      if (b.openInterestUsd !== a.openInterestUsd) return b.openInterestUsd - a.openInterestUsd;
      return a.symbol.localeCompare(b.symbol);
    });
}

export async function selectDiscoveryMarkets(
  config: ThufirConfig,
  options?: {
    limit?: number;
    minOpenInterestUsd?: number;
    minDayVolumeUsd?: number;
  }
): Promise<{ source: 'configured' | 'full_universe'; candidates: DiscoveryCandidate[] }> {
  const configuredFallback = (() => {
    const configured = getConfiguredDiscoveryUniverse(config);
    const base = configured.length > 0 ? configured : ['BTC', 'ETH'];
    return base.map((symbol) => ({
      symbol,
      score: 1,
      liquidityScore: 1,
      executionScore: 1,
      fundingScore: 1,
      openInterestUsd: 0,
      dayVolumeUsd: 0,
      fundingRate: 0,
      spreadProxyBps: 0,
    }));
  })();

  const configured = getConfiguredDiscoveryUniverse(config);
  const fullUniverseWhenSymbolsEmpty =
    config.autonomy?.discoverySelection?.fullUniverseWhenSymbolsEmpty ?? true;

  if (configured.length > 0 || !fullUniverseWhenSymbolsEmpty) {
    return {
      source: 'configured',
      candidates: configuredFallback.slice(0, options?.limit ?? configuredFallback.length),
    };
  }

  const minOpenInterestUsd =
    options?.minOpenInterestUsd ??
    config.autonomy?.discoverySelection?.minOpenInterestUsd ??
    5_000_000;
  const minDayVolumeUsd =
    options?.minDayVolumeUsd ??
    config.autonomy?.discoverySelection?.minDayVolumeUsd ??
    20_000_000;
  const limit = Math.max(1, options?.limit ?? config.autonomy?.discoverySelection?.preselectLimit ?? 24);

  const fallbackMinOpenInterestUsd = Math.max(50_000, minOpenInterestUsd * 0.1);
  const fallbackMinDayVolumeUsd = Math.max(1_000_000, minDayVolumeUsd * 0.1);

  let meta: { universe: Array<{ name: string }> };
  let assetCtxs: unknown[];
  try {
    const client = new HyperliquidClient(config);
    [meta, assetCtxs] = await client.getMergedMetaAndAssetCtxs();
  } catch {
    return {
      source: 'configured',
      candidates: configuredFallback.slice(0, options?.limit ?? configuredFallback.length),
    };
  }

  const rows: MarketRow[] = [];
  for (let i = 0; i < meta.universe.length; i += 1) {
    const market = meta.universe[i];
    const ctx = assetCtxs[i] as Record<string, unknown> | undefined;
    if (!market || !ctx) continue;

    const markPx = toNumber(ctx.markPx);
    const oraclePx = toNumber(ctx.oraclePx);
    if (markPx <= 0 && oraclePx <= 0) continue;

    const safePx = markPx > 0 ? markPx : oraclePx;
    const spreadProxyBps = safePx > 0 ? (Math.abs(markPx - oraclePx) / safePx) * 10_000 : 0;
    const openInterestUsd = toNumber(ctx.openInterest) * safePx;
    const dayVolumeUsd = toNumber(ctx.dayNtlVlm);
    const fundingRate = toNumber(ctx.funding);

    if (openInterestUsd < minOpenInterestUsd || dayVolumeUsd < minDayVolumeUsd) {
      continue;
    }

    rows.push({
      symbol: normalizeSymbol(market.name),
      openInterestUsd,
      dayVolumeUsd,
      fundingRate,
      markPx,
      oraclePx,
      spreadProxyBps,
    });
  }

  let ranked = scoreRows(rows);
  if (ranked.length === 0) {
    const fallbackRows: MarketRow[] = [];
    for (let i = 0; i < meta.universe.length; i += 1) {
      const market = meta.universe[i];
      const ctx = assetCtxs[i] as Record<string, unknown> | undefined;
      if (!market || !ctx) continue;
      const markPx = toNumber(ctx.markPx);
      const oraclePx = toNumber(ctx.oraclePx);
      const safePx = markPx > 0 ? markPx : oraclePx;
      if (safePx <= 0) continue;
      fallbackRows.push({
        symbol: normalizeSymbol(market.name),
        openInterestUsd: toNumber(ctx.openInterest) * safePx,
        dayVolumeUsd: toNumber(ctx.dayNtlVlm),
        fundingRate: toNumber(ctx.funding),
        markPx,
        oraclePx,
        spreadProxyBps: (Math.abs(markPx - oraclePx) / safePx) * 10_000,
      });
    }
    ranked = scoreRows(
      fallbackRows.filter(
        (row) =>
          row.openInterestUsd >= fallbackMinOpenInterestUsd &&
          row.dayVolumeUsd >= fallbackMinDayVolumeUsd
      )
    );
  }

  if (ranked.length === 0) {
    return {
      source: 'configured',
      candidates: configuredFallback.slice(0, options?.limit ?? configuredFallback.length),
    };
  }

  return { source: 'full_universe', candidates: ranked.slice(0, limit) };
}
