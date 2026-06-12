import type { ThufirConfig } from './config.js';

export type ForecastTargetKind =
  | 'positive_net_pnl_before_ttl_or_invalidation'
  | 'price_reaches_directional_threshold_before_horizon';

export type PriceClimatologyTarget = {
  kind: 'price_reaches_directional_threshold_before_horizon';
  symbol: string;
  direction: 'up' | 'down';
  thresholdPct: number;
  horizonMinutes: number;
  referencePrice: number;
};

export type PriceClimatologyCandle = {
  timestamp: string | number | Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
};

export type PriceClimatologyMarketData = {
  symbol?: string | null;
  candles: PriceClimatologyCandle[];
};

export type ExogenousComparatorResult = {
  probability: number | null;
  comparable: boolean;
  comparatorKind: 'exogenous_price_climatology';
  source: 'price_climatology' | 'missing';
  sampleCount: number;
  wins: number;
  lookbackDays: number;
  thresholdPct: number;
  horizonMinutes: number;
  referencePrice: number;
  frozenAt: string;
  exclusionReason:
    | null
    | 'missing_market_data'
    | 'insufficient_samples'
    | 'target_mismatch'
    | 'invalid_target';
};

type PriceClimatologyConfig = {
  enabled: boolean;
  lookbackDays: number;
  minComparableSamples: number;
  defaultThresholdPct: number;
  defaultHorizonMinutes: number;
};

const DEFAULT_CONFIG: PriceClimatologyConfig = {
  enabled: true,
  lookbackDays: 730,
  minComparableSamples: 100,
  defaultThresholdPct: 0.015,
  defaultHorizonMinutes: 1440,
};

function readConfig(config: ThufirConfig): PriceClimatologyConfig {
  const raw = (config as unknown as {
    autonomy?: {
      exogenousComparators?: {
        priceClimatology?: Partial<PriceClimatologyConfig>;
      };
    };
  }).autonomy?.exogenousComparators?.priceClimatology;
  return {
    enabled: raw?.enabled ?? DEFAULT_CONFIG.enabled,
    lookbackDays:
      typeof raw?.lookbackDays === 'number' && Number.isFinite(raw.lookbackDays) && raw.lookbackDays > 0
        ? raw.lookbackDays
        : DEFAULT_CONFIG.lookbackDays,
    minComparableSamples:
      typeof raw?.minComparableSamples === 'number' &&
      Number.isFinite(raw.minComparableSamples) &&
      raw.minComparableSamples > 0
        ? Math.floor(raw.minComparableSamples)
        : DEFAULT_CONFIG.minComparableSamples,
    defaultThresholdPct:
      typeof raw?.defaultThresholdPct === 'number' &&
      Number.isFinite(raw.defaultThresholdPct) &&
      raw.defaultThresholdPct > 0
        ? raw.defaultThresholdPct
        : DEFAULT_CONFIG.defaultThresholdPct,
    defaultHorizonMinutes:
      typeof raw?.defaultHorizonMinutes === 'number' &&
      Number.isFinite(raw.defaultHorizonMinutes) &&
      raw.defaultHorizonMinutes > 0
        ? Math.floor(raw.defaultHorizonMinutes)
        : DEFAULT_CONFIG.defaultHorizonMinutes,
  };
}

function toMs(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(value);
}

function toFinitePositive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function clampProbability(value: number): number {
  return Math.max(0.01, Math.min(0.99, value));
}

function emptyResult(
  config: PriceClimatologyConfig,
  target: Partial<PriceClimatologyTarget> | null,
  now: Date,
  exclusionReason: ExogenousComparatorResult['exclusionReason']
): ExogenousComparatorResult {
  return {
    probability: null,
    comparable: false,
    comparatorKind: 'exogenous_price_climatology',
    source: 'missing',
    sampleCount: 0,
    wins: 0,
    lookbackDays: config.lookbackDays,
    thresholdPct: Number(target?.thresholdPct ?? config.defaultThresholdPct),
    horizonMinutes: Number(target?.horizonMinutes ?? config.defaultHorizonMinutes),
    referencePrice: Number(target?.referencePrice ?? 0),
    frozenAt: now.toISOString(),
    exclusionReason,
  };
}

function isPriceClimatologyTarget(target: unknown): target is PriceClimatologyTarget {
  if (!target || typeof target !== 'object') return false;
  const candidate = target as PriceClimatologyTarget;
  return (
    candidate.kind === 'price_reaches_directional_threshold_before_horizon' &&
    (candidate.direction === 'up' || candidate.direction === 'down') &&
    typeof candidate.symbol === 'string' &&
    candidate.symbol.trim().length > 0 &&
    toFinitePositive(Number(candidate.thresholdPct)) != null &&
    toFinitePositive(Number(candidate.horizonMinutes)) != null &&
    toFinitePositive(Number(candidate.referencePrice)) != null
  );
}

export function resolvePriceClimatologyComparator(
  config: ThufirConfig,
  target: PriceClimatologyTarget | { kind: ForecastTargetKind } | null,
  marketData: PriceClimatologyMarketData,
  now: Date = new Date()
): ExogenousComparatorResult {
  const comparatorConfig = readConfig(config);
  if (!comparatorConfig.enabled) {
    return emptyResult(comparatorConfig, target as Partial<PriceClimatologyTarget> | null, now, 'missing_market_data');
  }
  if (target?.kind !== 'price_reaches_directional_threshold_before_horizon') {
    return emptyResult(comparatorConfig, target as Partial<PriceClimatologyTarget> | null, now, 'invalid_target');
  }
  if (!isPriceClimatologyTarget(target)) {
    return emptyResult(comparatorConfig, target as Partial<PriceClimatologyTarget> | null, now, 'invalid_target');
  }
  if (
    typeof marketData.symbol === 'string' &&
    marketData.symbol.trim().length > 0 &&
    marketData.symbol.trim().toUpperCase() !== target.symbol.trim().toUpperCase()
  ) {
    return emptyResult(comparatorConfig, target, now, 'target_mismatch');
  }

  const nowMs = now.getTime();
  const lookbackStartMs = nowMs - comparatorConfig.lookbackDays * 24 * 60 * 60 * 1000;
  const candles = (marketData.candles ?? [])
    .map((candle) => ({
      timestampMs: toMs(candle.timestamp),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    }))
    .filter(
      (candle) =>
        Number.isFinite(candle.timestampMs) &&
        candle.timestampMs <= nowMs &&
        candle.timestampMs >= lookbackStartMs &&
        [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0)
    )
    .sort((a, b) => a.timestampMs - b.timestampMs);

  if (candles.length === 0) {
    return emptyResult(comparatorConfig, target, now, 'missing_market_data');
  }

  const horizonMs = target.horizonMinutes * 60 * 1000;
  let sampleCount = 0;
  let wins = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const start = candles[index]!;
    const horizonEnd = start.timestampMs + horizonMs;
    if (horizonEnd > nowMs) {
      continue;
    }
    const window = candles.filter(
      (candidate) => candidate.timestampMs > start.timestampMs && candidate.timestampMs <= horizonEnd
    );
    if (window.length === 0) {
      continue;
    }
    sampleCount += 1;
    const thresholdPrice =
      target.direction === 'up'
        ? start.open * (1 + target.thresholdPct)
        : start.open * (1 - target.thresholdPct);
    const hit =
      target.direction === 'up'
        ? window.some((candidate) => candidate.high >= thresholdPrice)
        : window.some((candidate) => candidate.low <= thresholdPrice);
    if (hit) {
      wins += 1;
    }
  }

  if (sampleCount === 0) {
    return emptyResult(comparatorConfig, target, now, 'missing_market_data');
  }

  const probability = clampProbability(wins / sampleCount);
  const comparable = sampleCount >= comparatorConfig.minComparableSamples;
  if (!comparable) {
    return {
      probability: null,
      comparable: false,
      comparatorKind: 'exogenous_price_climatology',
      source: 'missing',
      sampleCount,
      wins,
      lookbackDays: comparatorConfig.lookbackDays,
      thresholdPct: target.thresholdPct,
      horizonMinutes: target.horizonMinutes,
      referencePrice: target.referencePrice,
      frozenAt: now.toISOString(),
      exclusionReason: 'insufficient_samples',
    };
  }
  return {
    probability,
    comparable: true,
    comparatorKind: 'exogenous_price_climatology',
    source: 'price_climatology',
    sampleCount,
    wins,
    lookbackDays: comparatorConfig.lookbackDays,
    thresholdPct: target.thresholdPct,
    horizonMinutes: target.horizonMinutes,
    referencePrice: target.referencePrice,
    frozenAt: now.toISOString(),
    exclusionReason: comparable ? null : 'insufficient_samples',
  };
}
