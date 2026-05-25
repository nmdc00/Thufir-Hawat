import type { DiscoveryCandidate } from '../discovery/market_selector.js';
import type { TaSnapshot } from './ta_surface.js';

export type OriginatorMarketRegime =
  | 'trending'
  | 'choppy'
  | 'high_vol_expansion'
  | 'low_vol_compression';
export type OriginatorVolatilityBucket = 'low' | 'medium' | 'high';
export type OriginatorExecutionStatus = 'good' | 'mixed' | 'poor' | 'unknown';
export type OriginatorTriggerReason = 'cadence' | 'ta_alert' | 'event' | null;

export type EntryGateMarketContext = {
  markPrice: number | null;
  marketRegime?: OriginatorMarketRegime;
  volatilityBucket?: OriginatorVolatilityBucket;
  stopDistancePct: number | null;
  stopDistanceBps?: number | null;
  liquidationMovePctAtCandidateLeverage: number | null;
  liquidationBufferPct: number | null;
  liquidationBufferMultiple?: number | null;
  mechanicalLeverageCeiling: number | null;
  trendBias: 'up' | 'down' | 'flat' | 'unknown';
  priceVsEma20_1hPct: number | null;
  regimeSource: 'originator_runtime' | 'discovery' | 'fallback';
  liquidityBucket: 'thin' | 'normal' | 'deep' | 'unknown';
  executionStatus?: OriginatorExecutionStatus;
  liquidityScore: number | null;
  executionScore: number | null;
  fundingScore: number | null;
  spreadProxyBps: number | null;
  openInterestUsd: number | null;
  dayVolumeUsd: number | null;
  oiUsd: number | null;
  oiDelta1hPct: number | null;
  oiDelta4hPct: number | null;
  fundingRatePct: number | null;
  volumeVs24hAvgPct: number | null;
  alertReason: string | null;
  triggerReason: OriginatorTriggerReason;
};

export type OriginatorEntryGateContext = {
  marketContext: EntryGateMarketContext;
  gateExpectedEdge: number;
  gateRegime: string;
  gateEntryReasoning: string;
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function toFiniteNumberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function floorWithTolerance(value: number): number {
  return Math.floor(value + 1e-9);
}

function formatPct(value: number | null | undefined, decimals = 2): string {
  if (value == null) return 'n/a';
  return `${(value * 100).toFixed(decimals)}%`;
}

function formatSignedPctFromPercent(value: number | null | undefined, decimals = 1): string {
  if (value == null) return 'n/a';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

function formatMultiple(value: number | null | undefined, decimals = 2): string {
  if (value == null) return 'n/a';
  return `${value.toFixed(decimals)}x`;
}

export function deriveOriginatorRegime(
  ta: TaSnapshot | null | undefined,
): OriginatorMarketRegime {
  if (!ta) return 'choppy';
  const emaDist = Math.abs(Number(ta.priceVsEma20_1h ?? 0));
  const oiImpulse = Math.max(
    Math.abs(Number(ta.oiDelta1hPct ?? 0)),
    Math.abs(Number(ta.oiDelta4hPct ?? 0)),
  );
  const volumeVsAvg = Number(ta.volumeVs24hAvgPct ?? 0);
  if (ta.trendBias !== 'flat' && emaDist >= 1 && (volumeVsAvg >= 120 || oiImpulse >= 10)) {
    return 'high_vol_expansion';
  }
  if (ta.trendBias !== 'flat' && emaDist >= 0.75) return 'trending';
  if (volumeVsAvg <= -20 && oiImpulse <= 3 && emaDist <= 0.4) return 'low_vol_compression';
  return 'choppy';
}

export function deriveOriginatorVolatilityBucket(
  ta: TaSnapshot | null | undefined,
): OriginatorVolatilityBucket {
  if (!ta) return 'medium';
  const emaDist = Math.abs(Number(ta.priceVsEma20_1h ?? 0));
  const oiImpulse = Math.max(
    Math.abs(Number(ta.oiDelta1hPct ?? 0)),
    Math.abs(Number(ta.oiDelta4hPct ?? 0)),
  );
  const volumeVsAvg = Math.abs(Number(ta.volumeVs24hAvgPct ?? 0));
  const fundingAbs = Math.abs(Number(ta.fundingRatePct ?? 0));
  if (volumeVsAvg >= 150 || oiImpulse >= 10 || fundingAbs >= 60) return 'high';
  if (volumeVsAvg <= 25 && oiImpulse <= 3 && emaDist <= 0.4) return 'low';
  return 'medium';
}

export function deriveOriginatorLiquidityBucket(
  input: {
    liquidityScore?: number | null;
    spreadProxyBps?: number | null;
    openInterestUsd?: number | null;
    dayVolumeUsd?: number | null;
    oiUsd?: number | null;
    volumeVs24hAvgPct?: number | null;
  }
): EntryGateMarketContext['liquidityBucket'] {
  const liquidityScore = toFiniteNumberOrNull(input.liquidityScore);
  const spreadProxyBps = toFiniteNumberOrNull(input.spreadProxyBps);
  const openInterestUsd =
    toFiniteNumberOrNull(input.openInterestUsd) ?? toFiniteNumberOrNull(input.oiUsd);
  const dayVolumeUsd = toFiniteNumberOrNull(input.dayVolumeUsd);
  const volumeVs24hAvgPct = toFiniteNumberOrNull(input.volumeVs24hAvgPct);
  if (
    liquidityScore != null &&
    liquidityScore >= 0.8 &&
    (spreadProxyBps == null || spreadProxyBps <= 10) &&
    ((openInterestUsd ?? 0) >= 100_000_000 || (dayVolumeUsd ?? 0) >= 50_000_000)
  ) {
    return 'deep';
  }
  if (
    (liquidityScore != null && liquidityScore <= 0.35) ||
    (spreadProxyBps != null && spreadProxyBps >= 18) ||
    (openInterestUsd != null && openInterestUsd <= 25_000_000) ||
    (dayVolumeUsd != null && dayVolumeUsd <= 10_000_000)
  ) {
    return 'thin';
  }
  if (openInterestUsd != null && openInterestUsd >= 100_000_000 && (volumeVs24hAvgPct ?? 0) >= 50) {
    return 'deep';
  }
  return 'normal';
}

export function deriveOriginatorExecutionStatus(
  selector: DiscoveryCandidate | null | undefined,
): OriginatorExecutionStatus {
  const executionScore = toFiniteNumberOrNull(selector?.executionScore);
  const spreadProxyBps = toFiniteNumberOrNull(selector?.spreadProxyBps);
  if (executionScore == null && spreadProxyBps == null) return 'unknown';
  if (executionScore != null && executionScore >= 0.8 && (spreadProxyBps == null || spreadProxyBps <= 10)) {
    return 'good';
  }
  if ((executionScore != null && executionScore <= 0.45) || (spreadProxyBps != null && spreadProxyBps >= 18)) {
    return 'poor';
  }
  return 'mixed';
}

export function estimateOriginatorEdge(input: {
  confidence: number;
  expectedRMultiple: number;
  selector?: DiscoveryCandidate | null;
  ta?: TaSnapshot | null;
  stopDistancePct?: number | null;
  markPrice?: number | null;
  invalidationPrice?: number | null;
}): number {
  const confidence = clamp01(Number(input.confidence ?? 0));
  const expectedRMultiple = Math.max(0, Number(input.expectedRMultiple ?? 0));
  const stopDistancePct =
    input.stopDistancePct != null
      ? input.stopDistancePct
      : (() => {
          const markPrice = toFiniteNumberOrNull(input.markPrice);
          const invalidationPrice = toFiniteNumberOrNull(input.invalidationPrice);
          if (markPrice == null || markPrice <= 0 || invalidationPrice == null || invalidationPrice <= 0) {
            return null;
          }
          return Math.abs(markPrice - invalidationPrice) / markPrice;
        })();
  const selectorScore = clamp01(
    Number(input.selector?.score ?? 0.55) * 0.5 +
    Number(input.selector?.liquidityScore ?? 0.55) * 0.2 +
    Number(input.selector?.executionScore ?? 0.55) * 0.2 +
    Number(input.selector?.fundingScore ?? 0.55) * 0.1
  );
  const regime = deriveOriginatorRegime(input.ta);
  const executionStatus = deriveOriginatorExecutionStatus(input.selector);
  const taImpulse =
    (input.ta != null
      ? clamp01(Math.abs(Number(input.ta.priceVsEma20_1h ?? 0)) / 4) * 0.01 +
        clamp01(Math.abs(Number(input.ta.oiDelta1hPct ?? 0)) / 20) * 0.01
      : 0);
  const geometryEdge =
    stopDistancePct != null && stopDistancePct > 0
      ? stopDistancePct * Math.max(0, confidence * expectedRMultiple - (1 - confidence))
      : confidence * Math.max(0, expectedRMultiple - 1) * 0.03;
  const regimeMultiplier =
    regime === 'high_vol_expansion' ? 1.1 :
    regime === 'trending' ? 1.0 :
    regime === 'low_vol_compression' ? 0.75 :
    0.85;
  const executionMultiplier =
    executionStatus === 'good' ? 1.0 :
    executionStatus === 'mixed' ? 0.9 :
    executionStatus === 'poor' ? 0.75 :
    0.85;
  return clamp01(
    roundTo((geometryEdge + taImpulse) * (0.75 + selectorScore * 0.5) * regimeMultiplier * executionMultiplier, 4)
  );
}

export function buildOriginatorEntryGateMarketContext(input: {
  selector?: DiscoveryCandidate | null;
  ta?: TaSnapshot | null;
  markPrice: number | null;
  invalidationPrice?: number | null;
  leverage: number;
  leverageMax: number;
  triggerReason?: OriginatorTriggerReason;
}): EntryGateMarketContext {
  const markPrice = toFiniteNumberOrNull(input.markPrice) ?? toFiniteNumberOrNull(input.ta?.price);
  const invalidationPrice = toFiniteNumberOrNull(input.invalidationPrice);
  const leverage = Math.max(1, Number(input.leverage ?? 1));
  const leverageMax = Math.max(1, Number(input.leverageMax ?? leverage));
  const stopDistancePct =
    markPrice != null && markPrice > 0 && invalidationPrice != null
      ? Math.abs(markPrice - invalidationPrice) / markPrice
      : null;
  const stopDistanceBps = stopDistancePct != null ? roundTo(stopDistancePct * 10_000, 1) : null;
  const liquidationMovePctAtCandidateLeverage =
    leverage > 0 ? 1 / leverage : null;
  const liquidationBufferPct =
    stopDistancePct != null && liquidationMovePctAtCandidateLeverage != null
      ? liquidationMovePctAtCandidateLeverage - stopDistancePct
      : null;
  const liquidationBufferMultiple =
    stopDistancePct != null &&
    stopDistancePct > 0 &&
    liquidationMovePctAtCandidateLeverage != null
      ? roundTo(liquidationMovePctAtCandidateLeverage / stopDistancePct, 2)
      : null;
  const mechanicalLeverageCeiling =
    stopDistancePct != null && stopDistancePct > 0
      ? Math.max(1, floorWithTolerance(Math.min(leverageMax, 0.7 / stopDistancePct)))
      : null;
  const marketRegime = deriveOriginatorRegime(input.ta);
  const volatilityBucket = deriveOriginatorVolatilityBucket(input.ta);
  const liquidityBucket = deriveOriginatorLiquidityBucket({
    liquidityScore: input.selector?.liquidityScore ?? null,
    spreadProxyBps: input.selector?.spreadProxyBps ?? null,
    openInterestUsd: input.selector?.openInterestUsd ?? null,
    dayVolumeUsd: input.selector?.dayVolumeUsd ?? null,
    oiUsd: input.ta?.oiUsd ?? null,
    volumeVs24hAvgPct: input.ta?.volumeVs24hAvgPct ?? null,
  });
  const executionStatus = deriveOriginatorExecutionStatus(input.selector);
  return {
    markPrice,
    marketRegime,
    volatilityBucket,
    stopDistancePct,
    stopDistanceBps,
    liquidationMovePctAtCandidateLeverage,
    liquidationBufferPct,
    liquidationBufferMultiple,
    mechanicalLeverageCeiling,
    trendBias: input.ta?.trendBias ?? 'unknown',
    priceVsEma20_1hPct: toFiniteNumberOrNull(input.ta?.priceVsEma20_1h),
    regimeSource: input.ta ? 'originator_runtime' : 'fallback',
    liquidityBucket,
    executionStatus,
    liquidityScore: toFiniteNumberOrNull(input.selector?.liquidityScore),
    executionScore: toFiniteNumberOrNull(input.selector?.executionScore),
    fundingScore: toFiniteNumberOrNull(input.selector?.fundingScore),
    spreadProxyBps: toFiniteNumberOrNull(input.selector?.spreadProxyBps),
    openInterestUsd: toFiniteNumberOrNull(input.selector?.openInterestUsd),
    dayVolumeUsd: toFiniteNumberOrNull(input.selector?.dayVolumeUsd),
    oiUsd: toFiniteNumberOrNull(input.ta?.oiUsd),
    oiDelta1hPct: toFiniteNumberOrNull(input.ta?.oiDelta1hPct),
    oiDelta4hPct: toFiniteNumberOrNull(input.ta?.oiDelta4hPct),
    fundingRatePct: toFiniteNumberOrNull(input.ta?.fundingRatePct),
    volumeVs24hAvgPct: toFiniteNumberOrNull(input.ta?.volumeVs24hAvgPct),
    alertReason: input.ta?.alertReason ?? null,
    triggerReason: input.triggerReason ?? null,
  };
}

export function formatOriginatorGateRegime(context: EntryGateMarketContext): string {
  return `${context.marketRegime} | vol=${context.volatilityBucket} | liq=${context.liquidityBucket} | exec=${context.executionStatus}`;
}

export function formatOriginatorEntryReasoning(input: {
  thesisText: string;
  selector?: DiscoveryCandidate | null;
  marketContext: EntryGateMarketContext;
}): string {
  const selectorScore = toFiniteNumberOrNull(input.selector?.score);
  const spreadProxyBps = input.marketContext.spreadProxyBps;
  const alertSuffix =
    input.marketContext.alertReason != null && input.marketContext.alertReason.length > 0
      ? ` alert=${input.marketContext.alertReason}`
      : '';
  return (
    `${input.thesisText} | gate_ctx{` +
    `selector=${selectorScore != null ? selectorScore.toFixed(2) : 'n/a'}` +
    ` liq=${input.marketContext.liquidityBucket}` +
    ` spread=${spreadProxyBps != null ? `${spreadProxyBps.toFixed(1)}bps` : 'n/a'}` +
    ` trend=${input.marketContext.trendBias}` +
    ` ema20=${formatSignedPctFromPercent(input.marketContext.priceVsEma20_1hPct)}` +
    ` vol=${formatSignedPctFromPercent(input.marketContext.volumeVs24hAvgPct)}` +
    ` oi1h=${formatSignedPctFromPercent(input.marketContext.oiDelta1hPct)}` +
    ` stop=${formatPct(input.marketContext.stopDistancePct)}` +
    ` liq_buffer=${formatMultiple(input.marketContext.liquidationBufferMultiple)}` +
    ` max_lev=${input.marketContext.mechanicalLeverageCeiling ?? 'n/a'}` +
    ` trigger=${input.marketContext.triggerReason ?? 'n/a'}` +
    `${alertSuffix}` +
    `}`
  );
}

export function buildOriginatorEntryGateContext(input: {
  thesisText: string;
  confidence: number;
  expectedRMultiple: number;
  selector?: DiscoveryCandidate | null;
  ta?: TaSnapshot | null;
  markPrice: number | null;
  invalidationPrice?: number | null;
  leverage: number;
  leverageMax: number;
  triggerReason?: OriginatorTriggerReason;
}): OriginatorEntryGateContext {
  const marketContext = buildOriginatorEntryGateMarketContext({
    selector: input.selector,
    ta: input.ta,
    markPrice: input.markPrice,
    invalidationPrice: input.invalidationPrice,
    leverage: input.leverage,
    leverageMax: input.leverageMax,
    triggerReason: input.triggerReason,
  });
  return {
    marketContext,
    gateExpectedEdge: estimateOriginatorEdge({
      confidence: input.confidence,
      expectedRMultiple: input.expectedRMultiple,
      selector: input.selector,
      ta: input.ta,
      stopDistancePct: marketContext.stopDistancePct,
    }),
    gateRegime: formatOriginatorGateRegime(marketContext),
    gateEntryReasoning: formatOriginatorEntryReasoning({
      thesisText: input.thesisText,
      selector: input.selector,
      marketContext,
    }),
  };
}
