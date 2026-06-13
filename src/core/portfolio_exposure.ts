import type { BookEntry } from './position_book.js';

export type ExposureReasonCode =
  | 'exposure_gross_cap'
  | 'exposure_net_cap'
  | 'exposure_cluster_cap'
  | 'exposure_duplicate_underlying';

export interface PortfolioExposureCandidate {
  symbol: string;
  side: 'buy' | 'sell' | 'long' | 'short';
  notionalUsd: number;
}

export type ExposureClusterConfig = Record<string, string[] | Record<string, string[]>>;

export interface PortfolioExposureConfig {
  enabled?: boolean;
  maxGrossLeverage?: number;
  maxNetLeverage?: number;
  maxClusterPercent?: number;
  clusters?: ExposureClusterConfig;
}

export interface ExposureSymbolMapping {
  cluster: string;
  underlying: string;
  mapped: boolean;
}

export interface ExposureBookTotals {
  grossUsd: number;
  longUsd: number;
  shortUsd: number;
  netUsd: number;
  absNetUsd: number;
  clusterUsd: Record<string, number>;
}

export interface ExposureVerdictDetail {
  equityUsd: number;
  candidate: PortfolioExposureCandidate & ExposureSymbolMapping;
  before: ExposureBookTotals;
  after: ExposureBookTotals;
  caps: {
    maxGrossUsd: number;
    maxNetUsd: number;
    maxClusterUsd: number;
    maxGrossLeverage: number;
    maxNetLeverage: number;
    maxClusterPercent: number;
  };
  existingBookOverCap: boolean;
  netExposureImproves: boolean;
  duplicateUnderlying?: {
    symbol: string;
    side: 'long' | 'short';
    cluster: string;
    underlying: string;
  };
}

export interface ExposureVerdict {
  allowed: boolean;
  reason?: ExposureReasonCode;
  detail: ExposureVerdictDetail;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\/USDT$/u, '').replace(/-USD$/u, '');
}

function normalizeSide(side: PortfolioExposureCandidate['side']): 'long' | 'short' {
  const normalized = side.trim().toLowerCase();
  return normalized === 'sell' || normalized === 'short' ? 'short' : 'long';
}

function notionalUsd(entry: BookEntry): number {
  const mark = entry.currentMarkPrice ?? entry.entryPrice;
  const notional = Math.abs(Number(entry.size) * Number(mark));
  return Number.isFinite(notional) ? notional : 0;
}

function buildSymbolMap(clusters: ExposureClusterConfig | undefined): Map<string, ExposureSymbolMapping> {
  const map = new Map<string, ExposureSymbolMapping>();
  for (const [cluster, definition] of Object.entries(clusters ?? {})) {
    if (Array.isArray(definition)) {
      for (const symbol of definition) {
        map.set(normalizeSymbol(symbol), { cluster, underlying: normalizeSymbol(symbol), mapped: true });
      }
      continue;
    }
    for (const [underlying, symbols] of Object.entries(definition)) {
      for (const symbol of symbols) {
        map.set(normalizeSymbol(symbol), { cluster, underlying: normalizeSymbol(underlying), mapped: true });
      }
    }
  }
  return map;
}

function resolveMapping(symbol: string, symbolMap: Map<string, ExposureSymbolMapping>): ExposureSymbolMapping {
  const normalized = normalizeSymbol(symbol);
  return symbolMap.get(normalized) ?? {
    cluster: `unclustered:${normalized}`,
    underlying: normalized,
    mapped: false,
  };
}

function emptyTotals(): ExposureBookTotals {
  return { grossUsd: 0, longUsd: 0, shortUsd: 0, netUsd: 0, absNetUsd: 0, clusterUsd: {} };
}

function addExposure(
  totals: ExposureBookTotals,
  mapping: ExposureSymbolMapping,
  side: 'long' | 'short',
  notional: number,
): ExposureBookTotals {
  const amount = Number.isFinite(notional) ? Math.max(0, notional) : 0;
  const next = {
    grossUsd: totals.grossUsd + amount,
    longUsd: totals.longUsd + (side === 'long' ? amount : 0),
    shortUsd: totals.shortUsd + (side === 'short' ? amount : 0),
    netUsd: 0,
    absNetUsd: 0,
    clusterUsd: { ...totals.clusterUsd },
  };
  next.netUsd = next.longUsd - next.shortUsd;
  next.absNetUsd = Math.abs(next.netUsd);
  next.clusterUsd[mapping.cluster] = (next.clusterUsd[mapping.cluster] ?? 0) + amount;
  return next;
}

function computeTotals(book: BookEntry[], symbolMap: Map<string, ExposureSymbolMapping>): ExposureBookTotals {
  return book.reduce((totals, entry) => {
    return addExposure(totals, resolveMapping(entry.symbol, symbolMap), entry.side, notionalUsd(entry));
  }, emptyTotals());
}

function exceeds(value: number, cap: number): boolean {
  return value > cap + 0.000001;
}

export function evaluateExposure(
  book: BookEntry[],
  candidate: PortfolioExposureCandidate,
  equityUsd: number,
  cfg: PortfolioExposureConfig,
): ExposureVerdict {
  const equity = Number.isFinite(equityUsd) && equityUsd > 0 ? equityUsd : 0;
  const maxGrossLeverage = cfg.maxGrossLeverage ?? 3.0;
  const maxNetLeverage = cfg.maxNetLeverage ?? 2.0;
  const maxClusterPercent = cfg.maxClusterPercent ?? 75;
  const maxGrossUsd = equity * maxGrossLeverage;
  const maxNetUsd = equity * maxNetLeverage;
  const maxClusterUsd = equity * (maxClusterPercent / 100);
  const symbolMap = buildSymbolMap(cfg.clusters);
  const candidateMapping = resolveMapping(candidate.symbol, symbolMap);
  const candidateSide = normalizeSide(candidate.side);
  const candidateNotional = Number.isFinite(candidate.notionalUsd) ? Math.max(0, candidate.notionalUsd) : 0;
  const before = computeTotals(book, symbolMap);
  const after = addExposure(before, candidateMapping, candidateSide, candidateNotional);
  const duplicateUnderlying = book.find((entry) => {
    const entryMapping = resolveMapping(entry.symbol, symbolMap);
    return entry.side === candidateSide &&
      entryMapping.cluster === candidateMapping.cluster &&
      entryMapping.underlying === candidateMapping.underlying;
  });
  const duplicateMapping = duplicateUnderlying ? resolveMapping(duplicateUnderlying.symbol, symbolMap) : null;
  const detail: ExposureVerdictDetail = {
    equityUsd: equity,
    candidate: { ...candidate, ...candidateMapping, notionalUsd: candidateNotional },
    before,
    after,
    caps: {
      maxGrossUsd,
      maxNetUsd,
      maxClusterUsd,
      maxGrossLeverage,
      maxNetLeverage,
      maxClusterPercent,
    },
    existingBookOverCap:
      exceeds(before.grossUsd, maxGrossUsd) ||
      exceeds(before.absNetUsd, maxNetUsd) ||
      Object.values(before.clusterUsd).some((value) => exceeds(value, maxClusterUsd)),
    netExposureImproves: after.absNetUsd < before.absNetUsd,
    duplicateUnderlying: duplicateUnderlying && duplicateMapping ? {
      symbol: duplicateUnderlying.symbol,
      side: duplicateUnderlying.side,
      cluster: duplicateMapping.cluster,
      underlying: duplicateMapping.underlying,
    } : undefined,
  };

  if (duplicateUnderlying) {
    return { allowed: false, reason: 'exposure_duplicate_underlying', detail };
  }

  if (detail.existingBookOverCap && detail.netExposureImproves) {
    return { allowed: true, detail };
  }

  if (exceeds(after.grossUsd, maxGrossUsd)) {
    return { allowed: false, reason: 'exposure_gross_cap', detail };
  }
  if (exceeds(after.absNetUsd, maxNetUsd)) {
    return { allowed: false, reason: 'exposure_net_cap', detail };
  }
  if (exceeds(after.clusterUsd[candidateMapping.cluster] ?? 0, maxClusterUsd)) {
    return { allowed: false, reason: 'exposure_cluster_cap', detail };
  }

  return { allowed: true, detail };
}
