import type { ExpressionPlan, SignalCluster } from '../discovery/types.js';
import type { ThufirConfig } from './config.js';
import type { PerpTradeJournalEntry } from '../memory/perp_trade_journal.js';
import { listPerpTradeJournals } from '../memory/perp_trade_journal.js';
import { openDatabase } from '../memory/db.js';
import { listActiveTradePolicyAdjustments } from '../memory/trade_policy_adjustments.js';
import { getAutonomyPolicyState, upsertAutonomyPolicyState } from '../memory/autonomy_policy_state.js';
import { summarizeSignalPerformance } from './signal_performance.js';
import { getDailyPnLRollup } from './daily_pnl.js';

export type MarketRegime = 'trending' | 'choppy' | 'high_vol_expansion' | 'low_vol_compression';
export type SignalClass =
  | 'momentum_breakout'
  | 'mean_reversion'
  | 'news_event'
  | 'liquidation_cascade'
  | 'unknown';

export type NewsGateResult = { allowed: boolean; reason?: string };
export type VolatilityBucket = 'low' | 'medium' | 'high';
export type LiquidityBucket = 'thin' | 'normal' | 'deep';
export type CalibrationPolicyReasonCode =
  | 'calibration.segment.block'
  | 'calibration.segment.downweight'
  | 'calibration.segment.fallback_insufficient_samples'
  | 'calibration.segment.pass'
  | 'calibration.segment.disabled';
export type DecisionQualityReasonCode =
  | 'quality.segment.block'
  | 'quality.segment.downweight'
  | 'quality.segment.fallback_insufficient_samples'
  | 'quality.segment.pass'
  | 'quality.segment.disabled';
export type CalibrationSegmentScope = {
  signalClass?: string | null;
  marketRegime?: MarketRegime | null;
  volatilityBucket?: VolatilityBucket | null;
  liquidityBucket?: LiquidityBucket | null;
};
export type CalibrationSegmentPolicyResult = {
  action: 'none' | 'downweight' | 'block';
  sizeMultiplier: number;
  sampleCount: number;
  successRate: number | null;
  segmentKey: string;
  reasonCode: CalibrationPolicyReasonCode;
  reason: string;
};
export type DecisionQualityPolicyResult = {
  action: 'none' | 'downweight' | 'block';
  sizeMultiplier: number;
  sampleCount: number;
  score: number | null;
  segmentKey: string;
  reasonCode: DecisionQualityReasonCode;
  reason: string;
};
export type GlobalTradeGateResult = {
  allowed: boolean;
  reason?: string;
  reasonCode?: string;
  sizeMultiplier: number;
  leverageCap: number | null;
  activeAdjustmentIds: string[];
  activePolicies: string[];
  sizeHaircuts: Array<{ adjustmentId: string; multiplier: number }>;
  leverageCaps: Array<{ adjustmentId: string; leverageCap: number }>;
  confirmationRequirements: Array<{ adjustmentId: string; rationale: string | null }>;
  triggeredCooldowns: Array<{ adjustmentId: string; expiresAt: string | null }>;
  adaptationChangedOutcome: boolean;
  policyState: ReturnType<typeof getAutonomyPolicyState>;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function classifyMarketRegime(cluster: SignalCluster): MarketRegime {
  const pv = cluster.signals.find((signal) => signal.kind === 'price_vol_regime');
  const trend = typeof pv?.metrics?.trend === 'number' ? pv.metrics.trend : 0;
  const volZ = typeof pv?.metrics?.volZ === 'number' ? pv.metrics.volZ : 0;

  if (volZ >= 1.0) return 'high_vol_expansion';
  if (volZ <= -0.5) return 'low_vol_compression';
  if (Math.abs(trend) >= 0.015) return 'trending';
  return 'choppy';
}

const KNOWN_SIGNAL_CLASSES = new Set<string>([
  'momentum_breakout',
  'mean_reversion',
  'news_event',
  'liquidation_cascade',
  'unknown',
]);

function isSignalClass(value: string | null | undefined): value is SignalClass {
  return typeof value === 'string' && KNOWN_SIGNAL_CLASSES.has(value);
}

export function classifySignalClass(expression: ExpressionPlan): SignalClass {
  if (isSignalClass(expression.signalClass)) return expression.signalClass;
  if (expression.newsTrigger?.enabled) return 'news_event';
  if (expression.hypothesisId.includes('_revert')) return 'mean_reversion';
  if (expression.hypothesisId.includes('_reflex')) return 'liquidation_cascade';
  if (expression.hypothesisId.includes('_trend')) return 'momentum_breakout';
  return 'unknown';
}

export function resolveVolatilityBucket(cluster: SignalCluster): 'low' | 'medium' | 'high' {
  const pv = cluster.signals.find((signal) => signal.kind === 'price_vol_regime');
  const volZ = typeof pv?.metrics?.volZ === 'number' ? Math.abs(pv.metrics.volZ) : 0;
  if (volZ >= 1.2) return 'high';
  if (volZ <= 0.4) return 'low';
  return 'medium';
}

export function resolveLiquidityBucket(cluster: SignalCluster): 'thin' | 'normal' | 'deep' {
  const orderflow = cluster.signals.find((signal) => signal.kind === 'orderflow_imbalance');
  const count = typeof orderflow?.metrics?.tradeCount === 'number' ? orderflow.metrics.tradeCount : 0;
  if (count >= 18) return 'deep';
  if (count <= 4) return 'thin';
  return 'normal';
}

function normalizeSegmentValue(value: string | null | undefined): string {
  if (typeof value !== 'string') return 'any';
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : 'any';
}

function formatSegmentKey(scope: CalibrationSegmentScope): string {
  return [
    `signalClass=${normalizeSegmentValue(scope.signalClass ?? null)}`,
    `marketRegime=${normalizeSegmentValue(scope.marketRegime ?? null)}`,
    `volatilityBucket=${normalizeSegmentValue(scope.volatilityBucket ?? null)}`,
    `liquidityBucket=${normalizeSegmentValue(scope.liquidityBucket ?? null)}`,
  ].join('|');
}

function entryMatchesScope(entry: PerpTradeJournalEntry, scope: CalibrationSegmentScope): boolean {
  if (scope.signalClass && entry.signalClass !== scope.signalClass) return false;
  if (scope.marketRegime && entry.marketRegime !== scope.marketRegime) return false;
  if (scope.volatilityBucket && entry.volatilityBucket !== scope.volatilityBucket) return false;
  if (scope.liquidityBucket && entry.liquidityBucket !== scope.liquidityBucket) return false;
  return true;
}

function extractDecisionQuality(entry: PerpTradeJournalEntry): number | null {
  const values: number[] = [];
  const pushIfFinite = (value: unknown) => {
    const n = Number(value);
    if (Number.isFinite(n)) {
      values.push(Math.max(0, Math.min(1, n)));
    }
  };
  pushIfFinite(entry.directionScore ?? entry.direction_score ?? null);
  pushIfFinite(entry.timingScore ?? entry.timing_score ?? null);
  pushIfFinite(entry.sizingScore ?? entry.sizing_score ?? null);
  pushIfFinite(entry.exitScore ?? entry.exit_score ?? null);
  if (values.length === 0) return null;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

export function evaluateDecisionQualitySegmentPolicy(
  config: ThufirConfig,
  entries: PerpTradeJournalEntry[],
  scope: CalibrationSegmentScope
): DecisionQualityPolicyResult {
  const gate = (config.autonomy as any)?.tradeQuality ?? {};
  const enabled = gate.enabled === true;
  const segmentKey = formatSegmentKey(scope);
  if (!enabled) {
    return {
      action: 'none',
      sizeMultiplier: 1,
      sampleCount: 0,
      score: null,
      segmentKey,
      reasonCode: 'quality.segment.disabled',
      reason: `decision quality policy disabled for segment ${segmentKey}`,
    };
  }

  const minSamplesRaw = Number(gate.minSamples);
  const minSamples = Number.isFinite(minSamplesRaw) ? Math.max(1, Math.floor(minSamplesRaw)) : 12;
  const blockBelowScoreRaw = Number(gate.blockBelowScore);
  const blockBelowScore = Number.isFinite(blockBelowScoreRaw) ? clamp(blockBelowScoreRaw, 0, 1) : 0.45;
  const downweightBelowScoreRaw = Number(gate.downweightBelowScore);
  const downweightBelowScore = Number.isFinite(downweightBelowScoreRaw)
    ? clamp(downweightBelowScoreRaw, blockBelowScore, 1)
    : 0.6;
  const downweightMultiplierRaw = Number(gate.downweightMultiplier);
  const downweightMultiplier = Number.isFinite(downweightMultiplierRaw)
    ? clamp(downweightMultiplierRaw, 0.05, 1)
    : 0.6;

  const scoped = entries
    .filter((entry) => entry.outcome === 'executed' && entry.reduceOnly === true)
    .filter((entry) => entryMatchesScope(entry, scope));
  const scored = scoped
    .map((entry) => extractDecisionQuality(entry))
    .filter((score): score is number => score != null);
  const sampleCount = scored.length;
  if (sampleCount < minSamples) {
    return {
      action: 'none',
      sizeMultiplier: 1,
      sampleCount,
      score: null,
      segmentKey,
      reasonCode: 'quality.segment.fallback_insufficient_samples',
      reason: `insufficient decision-quality samples for segment ${segmentKey}: ${sampleCount}/${minSamples}`,
    };
  }

  const score = scored.reduce((acc, value) => acc + value, 0) / sampleCount;
  if (score <= blockBelowScore) {
    return {
      action: 'block',
      sizeMultiplier: 0,
      sampleCount,
      score,
      segmentKey,
      reasonCode: 'quality.segment.block',
      reason:
        `segment ${segmentKey} blocked by decision-quality policy: score=${score.toFixed(2)} ` +
        `<= block_threshold=${blockBelowScore.toFixed(2)} over ${sampleCount} samples`,
    };
  }
  if (score < downweightBelowScore) {
    return {
      action: 'downweight',
      sizeMultiplier: downweightMultiplier,
      sampleCount,
      score,
      segmentKey,
      reasonCode: 'quality.segment.downweight',
      reason:
        `segment ${segmentKey} downweighted by decision-quality policy: score=${score.toFixed(2)} ` +
        `< downweight_threshold=${downweightBelowScore.toFixed(2)} over ${sampleCount} samples`,
    };
  }
  return {
    action: 'none',
    sizeMultiplier: 1,
    sampleCount,
    score,
    segmentKey,
    reasonCode: 'quality.segment.pass',
    reason:
      `segment ${segmentKey} passed decision-quality policy: score=${score.toFixed(2)} ` +
      `over ${sampleCount} samples`,
  };
}

export function evaluateCalibrationSegmentPolicy(
  config: ThufirConfig,
  entries: PerpTradeJournalEntry[],
  scope: CalibrationSegmentScope
): CalibrationSegmentPolicyResult {
  const gate = (config.autonomy as any)?.calibrationRisk ?? {};
  const enabled = gate.enabled !== false;
  const segmentKey = formatSegmentKey(scope);

  if (!enabled) {
    return {
      action: 'none',
      sizeMultiplier: 1,
      sampleCount: 0,
      successRate: null,
      segmentKey,
      reasonCode: 'calibration.segment.disabled',
      reason: `calibration policy disabled for segment ${segmentKey}`,
    };
  }

  const minSamplesRaw = Number(gate.minSamples);
  const minSamples = Number.isFinite(minSamplesRaw) ? Math.max(1, Math.floor(minSamplesRaw)) : 12;
  const downweightBelowAccuracyRaw = Number(gate.downweightBelowAccuracy);
  const downweightBelowAccuracy = Number.isFinite(downweightBelowAccuracyRaw)
    ? clamp(downweightBelowAccuracyRaw, 0, 1)
    : 0.5;
  const blockBelowAccuracyRaw = Number(gate.blockBelowAccuracy);
  const blockBelowAccuracy = Number.isFinite(blockBelowAccuracyRaw)
    ? clamp(blockBelowAccuracyRaw, 0, downweightBelowAccuracy)
    : 0.35;
  const downweightMultiplierRaw = Number(gate.downweightMultiplier);
  const downweightMultiplier = Number.isFinite(downweightMultiplierRaw)
    ? clamp(downweightMultiplierRaw, 0.05, 1)
    : 0.5;
  const blockEnabled = gate.blockEnabled !== false;

  const scoped = entries.filter((entry) => entryMatchesScope(entry, scope));
  const resolved = scoped.filter((entry) => typeof entry.thesisCorrect === 'boolean');
  const sampleCount = resolved.length;
  if (sampleCount < minSamples) {
    return {
      action: 'none',
      sizeMultiplier: 1,
      sampleCount,
      successRate: null,
      segmentKey,
      reasonCode: 'calibration.segment.fallback_insufficient_samples',
      reason: `insufficient calibration samples for segment ${segmentKey}: ${sampleCount}/${minSamples}`,
    };
  }

  const wins = resolved.filter((entry) => entry.thesisCorrect === true).length;
  const successRate = wins / sampleCount;

  if (blockEnabled && successRate <= blockBelowAccuracy) {
    return {
      action: 'block',
      sizeMultiplier: 0,
      sampleCount,
      successRate,
      segmentKey,
      reasonCode: 'calibration.segment.block',
      reason:
        `segment ${segmentKey} blocked by calibration policy: success_rate=${successRate.toFixed(2)} ` +
        `<= block_threshold=${blockBelowAccuracy.toFixed(2)} over ${sampleCount} samples`,
    };
  }

  if (successRate < downweightBelowAccuracy) {
    return {
      action: 'downweight',
      sizeMultiplier: downweightMultiplier,
      sampleCount,
      successRate,
      segmentKey,
      reasonCode: 'calibration.segment.downweight',
      reason:
        `segment ${segmentKey} downweighted by calibration policy: success_rate=${successRate.toFixed(2)} ` +
        `< downweight_threshold=${downweightBelowAccuracy.toFixed(2)} over ${sampleCount} samples`,
    };
  }

  return {
    action: 'none',
    sizeMultiplier: 1,
    sampleCount,
    successRate,
    segmentKey,
    reasonCode: 'calibration.segment.pass',
    reason:
      `segment ${segmentKey} passed calibration policy: success_rate=${successRate.toFixed(2)} ` +
      `over ${sampleCount} samples`,
  };
}

export function isSignalClassAllowedForRegime(
  signalClass: SignalClass,
  regime: MarketRegime
): boolean {
  // All signal classes are permitted in all regimes. Regime fit is already
  // accounted for in the adaptive-edge segment expectancy (same regime is part
  // of the segment key). Hard-blocking by regime was causing near-total
  // suppression of trades in low-vol / choppy conditions.
  void regime;
  return signalClass !== 'unknown';
}

export function evaluateNewsEntryGate(
  config: ThufirConfig,
  expression: ExpressionPlan,
  nowMs = Date.now()
): NewsGateResult {
  const trigger = expression.newsTrigger;
  if (!trigger?.enabled) {
    return { allowed: true };
  }

  const gate = (config.autonomy as any)?.newsEntry ?? {};
  const minNovelty = Number.isFinite(gate.minNoveltyScore) ? Number(gate.minNoveltyScore) : 0.6;
  const minConfirm = Number.isFinite(gate.minMarketConfirmationScore)
    ? Number(gate.minMarketConfirmationScore)
    : 0.55;
  const minLiquidity = Number.isFinite(gate.minLiquidityScore) ? Number(gate.minLiquidityScore) : 0.4;
  const minVolatility = Number.isFinite(gate.minVolatilityScore) ? Number(gate.minVolatilityScore) : 0.25;
  const minSourceCount = Number.isFinite(gate.minSourceCount) ? Number(gate.minSourceCount) : 1;
  const sourceCount = Array.isArray(trigger.sources) ? trigger.sources.filter(Boolean).length : 0;

  if (trigger.expiresAtMs != null && trigger.expiresAtMs <= nowMs) {
    return { allowed: false, reason: 'news trigger expired' };
  }
  if ((trigger.noveltyScore ?? 0) < minNovelty) {
    return { allowed: false, reason: 'news novelty below threshold' };
  }
  if ((trigger.marketConfirmationScore ?? 0) < minConfirm) {
    return { allowed: false, reason: 'news market confirmation below threshold' };
  }
  if ((trigger.liquidityScore ?? 0) < minLiquidity) {
    return { allowed: false, reason: 'news liquidity guard failed' };
  }
  if ((trigger.volatilityScore ?? 0) < minVolatility) {
    return { allowed: false, reason: 'news volatility guard failed' };
  }
  if (sourceCount < Math.max(0, minSourceCount)) {
    return { allowed: false, reason: 'news source provenance below threshold' };
  }

  return { allowed: true };
}

export function computeFractionalKellyFraction(params: {
  expectedEdge: number;
  signalExpectancy: number;
  signalVariance: number;
  sampleCount: number;
  maxFraction?: number;
}): number {
  const maxFraction = Number.isFinite(params.maxFraction) ? Number(params.maxFraction) : 0.25;
  const edge = Math.max(0, params.expectedEdge * Math.max(0, params.signalExpectancy));
  const variance = Math.max(params.signalVariance, 0.1);
  const rawKelly = edge / variance;
  const sampleConfidence = clamp(params.sampleCount / 20, 0.2, 1);
  const fractional = rawKelly * 0.25 * sampleConfidence;
  return clamp(fractional, 0.01, maxFraction);
}

export function countTodayExecutedPerpTrades(): number {
  const db = openDatabase();
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS c
      FROM perp_trades
      WHERE status = 'executed'
        AND date(created_at) = date('now')
    `
    )
    .get() as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

export function evaluateDailyTradeCap(params: {
  maxTradesPerDayRaw: unknown;
  todayCount: number;
  expectedEdge?: number | null;
  bypassMinEdgeRaw?: unknown;
}): { blocked: boolean; reason?: string } {
  const raw = Number(params.maxTradesPerDayRaw);
  if (!Number.isFinite(raw) || raw <= 0) {
    return { blocked: false };
  }

  const maxTradesPerDay = Math.max(1, Math.floor(raw));
  if (params.todayCount < maxTradesPerDay) {
    return { blocked: false };
  }

  const bypassMinEdge = Number.isFinite(Number(params.bypassMinEdgeRaw))
    ? Number(params.bypassMinEdgeRaw)
    : 0.12;
  const expectedEdge = Number(params.expectedEdge);
  if (Number.isFinite(expectedEdge) && expectedEdge >= Math.max(0, bypassMinEdge)) {
    return { blocked: false };
  }

  return {
    blocked: true,
    reason: `maxTradesPerDay reached (${params.todayCount}/${maxTradesPerDay})`,
  };
}

export function evaluateDailyDrawdownCap(params: {
  dailyDrawdownCapUsdRaw: unknown;
  totalPnl: number;
}): { blocked: boolean; reason?: string } {
  const raw = Number(params.dailyDrawdownCapUsdRaw);
  if (!Number.isFinite(raw) || raw <= 0) {
    return { blocked: false };
  }

  const cap = Math.max(0, raw);
  if (params.totalPnl > -cap) {
    return { blocked: false };
  }

  return {
    blocked: true,
    reason: `daily drawdown cap reached (total=${params.totalPnl.toFixed(2)}, cap=${cap.toFixed(2)})`,
  };
}

export function shouldForceObservationMode(
  entries: PerpTradeJournalEntry[],
  params?: { window?: number; minFalse?: number }
): { active: boolean; falseCount: number; window: number } {
  const window = Math.max(1, params?.window ?? 5);
  const minFalse = Math.max(1, params?.minFalse ?? 3);
  const recent = entries
    .filter((entry) => typeof entry.thesisCorrect === 'boolean')
    .slice(0, window);
  const falseCount = recent.filter((entry) => entry.thesisCorrect === false).length;
  return { active: recent.length >= window && falseCount >= minFalse, falseCount, window };
}

export function evaluateGlobalTradeGate(config: ThufirConfig, input?: {
  symbol?: string | null;
  direction?: string | null;
  strategySource?: string | null;
  triggerReason?: string | null;
  symbolClass?: string | null;
  session?: string | null;
  signalClass?: string | null;
  marketRegime?: MarketRegime | null;
  volatilityBucket?: VolatilityBucket | null;
  liquidityBucket?: LiquidityBucket | null;
  expectedEdge?: number | null;
  requestedLeverage?: number | null;
  confirmationSatisfied?: boolean | null;
}): GlobalTradeGateResult {
  const autonomyEnabled = Boolean((config.autonomy as any)?.enabled);
  const fullAutoEnabled = Boolean((config.autonomy as any)?.fullAuto);
  if (!autonomyEnabled && !fullAutoEnabled) {
    return {
      allowed: true,
      sizeMultiplier: 1,
      leverageCap: null,
      activeAdjustmentIds: [],
      activePolicies: [],
      sizeHaircuts: [],
      leverageCaps: [],
      confirmationRequirements: [],
      triggeredCooldowns: [],
      adaptationChangedOutcome: false,
      policyState: {
        minEdgeOverride: null,
        maxTradesPerScanOverride: null,
        leverageCapOverride: null,
        observationOnlyUntilMs: null,
        reason: null,
        updatedAt: new Date(0).toISOString(),
      },
    };
  }

  const policyState = getAutonomyPolicyState();
  const nowMs = Date.now();
  if (policyState.observationOnlyUntilMs != null && policyState.observationOnlyUntilMs > nowMs) {
    return {
      allowed: false,
      reasonCode: 'policy.observation_only',
      reason: `observation-only mode active until ${new Date(policyState.observationOnlyUntilMs).toISOString()}`,
      sizeMultiplier: 1,
      leverageCap: null,
      activeAdjustmentIds: [],
      activePolicies: [],
      sizeHaircuts: [],
      leverageCaps: [],
      confirmationRequirements: [],
      triggeredCooldowns: [],
      adaptationChangedOutcome: false,
      policyState,
    };
  }

  const rollup = getDailyPnLRollup();
  const drawdownCap = evaluateDailyDrawdownCap({
    dailyDrawdownCapUsdRaw: (config.autonomy as any)?.dailyDrawdownCapUsd,
    totalPnl: Number(rollup.totalPnl ?? 0),
  });
  if (drawdownCap.blocked) {
    return {
      allowed: false,
      reasonCode: 'policy.daily_drawdown_cap',
      reason: drawdownCap.reason ?? 'daily drawdown cap reached',
      sizeMultiplier: 1,
      leverageCap: null,
      activeAdjustmentIds: [],
      activePolicies: [],
      sizeHaircuts: [],
      leverageCaps: [],
      confirmationRequirements: [],
      triggeredCooldowns: [],
      adaptationChangedOutcome: false,
      policyState,
    };
  }

  const todayCount = countTodayExecutedPerpTrades();
  const dailyCap = evaluateDailyTradeCap({
    maxTradesPerDayRaw: (config.autonomy as any)?.maxTradesPerDay,
    todayCount,
    expectedEdge: input?.expectedEdge ?? null,
    bypassMinEdgeRaw: (config.autonomy as any)?.tradeCapBypassMinEdge,
  });
  if (dailyCap.blocked) {
    return {
      allowed: false,
      reasonCode: 'policy.daily_trade_cap',
      reason: dailyCap.reason ?? 'maxTradesPerDay reached',
      sizeMultiplier: 1,
      leverageCap: null,
      activeAdjustmentIds: [],
      activePolicies: [],
      sizeHaircuts: [],
      leverageCaps: [],
      confirmationRequirements: [],
      triggeredCooldowns: [],
      adaptationChangedOutcome: false,
      policyState,
    };
  }

  if (input?.signalClass) {
    let accumulatedSizeMultiplier = 1;
    let policyReasonCode: string | undefined;
    let policyReason: string | undefined;
    // Only resolved entries (thesisCorrect set) are valid for Sharpe computation.
    // Unresolved/failed entries (blocked orders) have no outcome data and would skew the metric.
    const resolvedEntries = listPerpTradeJournals({ limit: 200 }).filter(
      (e) => typeof e.thesisCorrect === 'boolean'
    );
    const perf = summarizeSignalPerformance(resolvedEntries, input.signalClass);
    const minSharpe = Number((config.autonomy as any)?.signalPerformance?.minSharpe ?? 0.8);
    const minSamples = Number((config.autonomy as any)?.signalPerformance?.minSamples ?? 8);
    if (perf.sampleCount >= minSamples && perf.sharpeLike < minSharpe) {
      return {
        allowed: false,
        reasonCode: 'policy.signal_sharpe',
        reason: `signal_class ${input.signalClass} sharpeLike ${perf.sharpeLike.toFixed(2)} below ${minSharpe.toFixed(2)}`,
        sizeMultiplier: 1,
        leverageCap: null,
        activeAdjustmentIds: [],
        activePolicies: [],
        sizeHaircuts: [],
        leverageCaps: [],
        confirmationRequirements: [],
        triggeredCooldowns: [],
        adaptationChangedOutcome: false,
        policyState,
      };
    }

    if (input.marketRegime && isSignalClass(input.signalClass) && !isSignalClassAllowedForRegime(input.signalClass, input.marketRegime)) {
      return {
        allowed: false,
        reasonCode: 'policy.signal_regime_matrix',
        reason: `signal_class ${input.signalClass} disallowed in regime ${input.marketRegime}`,
        sizeMultiplier: 1,
        leverageCap: null,
        activeAdjustmentIds: [],
        activePolicies: [],
        sizeHaircuts: [],
        leverageCaps: [],
        confirmationRequirements: [],
        triggeredCooldowns: [],
        adaptationChangedOutcome: false,
        policyState,
      };
    }

    const calibrationPolicy = evaluateCalibrationSegmentPolicy(config, listPerpTradeJournals({ limit: 500 }), {
      signalClass: input.signalClass,
      marketRegime: input.marketRegime ?? null,
      volatilityBucket: input.volatilityBucket ?? null,
      liquidityBucket: input.liquidityBucket ?? null,
    });
    if (calibrationPolicy.action === 'block') {
      return {
        allowed: false,
        reasonCode: calibrationPolicy.reasonCode,
        reason: `${calibrationPolicy.reasonCode}: ${calibrationPolicy.reason}`,
        sizeMultiplier: 1,
        leverageCap: null,
        activeAdjustmentIds: [],
        activePolicies: [],
        sizeHaircuts: [],
        leverageCaps: [],
        confirmationRequirements: [],
        triggeredCooldowns: [],
        adaptationChangedOutcome: false,
        policyState,
      };
    }
    if (calibrationPolicy.action === 'downweight') {
      accumulatedSizeMultiplier *= calibrationPolicy.sizeMultiplier;
      policyReasonCode = calibrationPolicy.reasonCode;
      policyReason = `${calibrationPolicy.reasonCode}: ${calibrationPolicy.reason}`;
    }

    const qualityPolicy = evaluateDecisionQualitySegmentPolicy(
      config,
      listPerpTradeJournals({ limit: 500 }),
      {
        signalClass: input.signalClass,
        marketRegime: input.marketRegime ?? null,
        volatilityBucket: input.volatilityBucket ?? null,
        liquidityBucket: input.liquidityBucket ?? null,
      }
    );
    if (qualityPolicy.action === 'block') {
      return {
        allowed: false,
        reasonCode: 'policy.decision_quality',
        reason: `${qualityPolicy.reasonCode}: ${qualityPolicy.reason}`,
        sizeMultiplier: 1,
        leverageCap: null,
        activeAdjustmentIds: [],
        activePolicies: [],
        sizeHaircuts: [],
        leverageCaps: [],
        confirmationRequirements: [],
        triggeredCooldowns: [],
        adaptationChangedOutcome: false,
        policyState,
      };
    }
    if (qualityPolicy.action === 'downweight') {
      accumulatedSizeMultiplier *= qualityPolicy.sizeMultiplier;
      policyReasonCode = 'policy.decision_quality';
      policyReason = `${qualityPolicy.reasonCode}: ${qualityPolicy.reason}`;
    }

    const persistedAdjustments = listActiveTradePolicyAdjustments({
      domain: 'perp',
      symbol: input.symbol ?? null,
      direction: input.direction ?? null,
      strategySource: input.strategySource ?? null,
      triggerReason: input.triggerReason ?? null,
      signalClass: input.signalClass,
      symbolClass: input.symbolClass ?? null,
      session: input.session ?? null,
      marketRegime: input.marketRegime ?? null,
      volatilityBucket: input.volatilityBucket ?? null,
      liquidityBucket: input.liquidityBucket ?? null,
    });
    const activeAdjustmentIds: string[] = [];
    const activePolicies: string[] = [];
    const sizeHaircuts: Array<{ adjustmentId: string; multiplier: number }> = [];
    const leverageCaps: Array<{ adjustmentId: string; leverageCap: number }> = [];
    const confirmationRequirements: Array<{ adjustmentId: string; rationale: string | null }> = [];
    const triggeredCooldowns: Array<{ adjustmentId: string; expiresAt: string | null }> = [];
    let effectiveLeverageCap: number | null = null;
    for (const adjustment of persistedAdjustments) {
      activeAdjustmentIds.push(adjustment.id);
      activePolicies.push(`${adjustment.policyKey}:${adjustment.action}`);
      if (adjustment.policyKey === 'size') {
        if (adjustment.action === 'block') {
          return {
            allowed: false,
            reasonCode: 'policy:size:block',
            reason: `policy:size:block: ${adjustment.rationale ?? adjustment.scopeKey}`,
            sizeMultiplier: 1,
            leverageCap: null,
            activeAdjustmentIds,
            activePolicies,
            sizeHaircuts,
            leverageCaps,
            confirmationRequirements,
            triggeredCooldowns,
            adaptationChangedOutcome: true,
            policyState,
          };
        }
        if (adjustment.action === 'downweight') {
          const multiplier = Math.max(0.05, Math.min(1, adjustment.sizeMultiplier));
          accumulatedSizeMultiplier *= multiplier;
          sizeHaircuts.push({ adjustmentId: adjustment.id, multiplier });
          policyReasonCode = 'policy:size:downweight';
          policyReason = `policy:size:downweight: ${adjustment.rationale ?? adjustment.scopeKey}`;
        }
      }
      if (adjustment.policyKey === 'leverage' && adjustment.action === 'cap_leverage' && adjustment.leverageCap != null) {
        effectiveLeverageCap =
          effectiveLeverageCap == null
            ? adjustment.leverageCap
            : Math.min(effectiveLeverageCap, adjustment.leverageCap);
        leverageCaps.push({ adjustmentId: adjustment.id, leverageCap: adjustment.leverageCap });
        if (
          input.requestedLeverage != null &&
          Number.isFinite(Number(input.requestedLeverage)) &&
          Number(input.requestedLeverage) > adjustment.leverageCap
        ) {
          policyReasonCode = 'policy:leverage:cap';
          policyReason = `policy:leverage:cap: ${adjustment.rationale ?? adjustment.scopeKey}`;
        }
      }
      if (adjustment.policyKey === 'confirmation' && adjustment.action === 'require_confirmation') {
        confirmationRequirements.push({ adjustmentId: adjustment.id, rationale: adjustment.rationale ?? null });
        if (input.confirmationSatisfied === false) {
          return {
            allowed: false,
            reasonCode: 'policy:confirmation:required',
            reason: `policy:confirmation:required: ${adjustment.rationale ?? adjustment.scopeKey}`,
            sizeMultiplier: clamp(accumulatedSizeMultiplier, 0.05, 1),
            leverageCap: effectiveLeverageCap,
            activeAdjustmentIds,
            activePolicies,
            sizeHaircuts,
            leverageCaps,
            confirmationRequirements,
            triggeredCooldowns,
            adaptationChangedOutcome: true,
            policyState,
          };
        }
        if (policyReasonCode == null) {
          policyReasonCode = 'policy:confirmation:required';
          policyReason = `policy:confirmation:required: ${adjustment.rationale ?? adjustment.scopeKey}`;
        }
      }
      if (adjustment.policyKey === 'cooldown' && adjustment.action === 'cooldown') {
        triggeredCooldowns.push({ adjustmentId: adjustment.id, expiresAt: adjustment.expiresAt ?? null });
        return {
          allowed: false,
          reasonCode: 'policy:cooldown:active',
          reason: `policy:cooldown:active: ${adjustment.rationale ?? adjustment.scopeKey}`,
          sizeMultiplier: clamp(accumulatedSizeMultiplier, 0.05, 1),
          leverageCap: effectiveLeverageCap,
          activeAdjustmentIds,
          activePolicies,
          sizeHaircuts,
          leverageCaps,
          confirmationRequirements,
          triggeredCooldowns,
          adaptationChangedOutcome: true,
          policyState,
        };
      }
    }

    return {
      allowed: true,
      reasonCode: policyReasonCode,
      reason: policyReason,
      sizeMultiplier: clamp(accumulatedSizeMultiplier, 0.05, 1),
      leverageCap: effectiveLeverageCap,
      activeAdjustmentIds,
      activePolicies,
      sizeHaircuts,
      leverageCaps,
      confirmationRequirements,
      triggeredCooldowns,
      adaptationChangedOutcome:
        activeAdjustmentIds.length > 0 &&
        (sizeHaircuts.length > 0 ||
          leverageCaps.length > 0 ||
          confirmationRequirements.length > 0 ||
          triggeredCooldowns.length > 0),
      policyState,
    };
  }

  return {
    allowed: true,
    sizeMultiplier: 1,
    leverageCap: null,
    activeAdjustmentIds: [],
    activePolicies: [],
    sizeHaircuts: [],
    leverageCaps: [],
    confirmationRequirements: [],
    triggeredCooldowns: [],
    adaptationChangedOutcome: false,
    policyState,
  };
}

export function applyReflectionMutation(config: ThufirConfig, entries: PerpTradeJournalEntry[]): {
  mutated: boolean;
  reason?: string;
  state: ReturnType<typeof getAutonomyPolicyState>;
} {
  const observation = shouldForceObservationMode(entries, { window: 5, minFalse: 3 });
  if (observation.active) {
    const intervalSeconds = Number(config.autonomy?.scanIntervalSeconds ?? 900);
    const ttlMs = Math.max(60_000, intervalSeconds * 1000);
    const state = upsertAutonomyPolicyState({
      observationOnlyUntilMs: Date.now() + ttlMs,
      reason: `thesisCorrect=false on ${observation.falseCount}/${observation.window}`,
    });
    return { mutated: true, reason: state.reason ?? undefined, state };
  }

  const recent = entries.slice(0, 10);
  const failedRatio =
    recent.length > 0 ? recent.filter((entry) => entry.outcome === 'failed').length / recent.length : 0;
  if (recent.length >= 6 && failedRatio >= 0.5) {
    const current = getAutonomyPolicyState();
    const configuredLeverageCap =
      typeof current.leverageCapOverride === 'number' && Number.isFinite(current.leverageCapOverride)
        ? current.leverageCapOverride
        : typeof (config.hyperliquid as any)?.maxLeverage === 'number' &&
            Number.isFinite((config.hyperliquid as any)?.maxLeverage)
          ? Number((config.hyperliquid as any)?.maxLeverage)
          : typeof (config.wallet?.perps as { maxLeverage?: unknown } | undefined)?.maxLeverage === 'number' &&
              Number.isFinite((config.wallet?.perps as { maxLeverage?: unknown }).maxLeverage)
            ? Number((config.wallet?.perps as { maxLeverage?: unknown }).maxLeverage)
            : null;
    const state = upsertAutonomyPolicyState({
      minEdgeOverride: clamp((current.minEdgeOverride ?? Number(config.autonomy?.minEdge ?? 0.05)) + 0.01, 0.03, 0.2),
      maxTradesPerScanOverride: Math.max(1, (current.maxTradesPerScanOverride ?? Number(config.autonomy?.maxTradesPerScan ?? 3)) - 1),
      leverageCapOverride: configuredLeverageCap != null ? Math.max(1, configuredLeverageCap - 1) : null,
      reason: `recent failed ratio ${(failedRatio * 100).toFixed(0)}% triggered adaptive tightening`,
    });
    return { mutated: true, reason: state.reason ?? undefined, state };
  }

  return { mutated: false, state: getAutonomyPolicyState() };
}
