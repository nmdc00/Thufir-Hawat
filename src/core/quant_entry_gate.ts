import type { ExpressionPlan, SignalCluster } from '../discovery/types.js';
import type { EntryGateCandidate } from './llm_entry_gate.js';

/** Transport discovery evidence, without converting edge/horizon into a target or TTL. */
const MAX_SOURCE_CONTEXT_CHARS = 6_000;

function boundedSourceContext(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_SOURCE_CONTEXT_CHARS) return serialized;
  return `${serialized.slice(0, MAX_SOURCE_CONTEXT_CHARS - 18)}...[truncated]`;
}

function sourceEvidence(
  expression: ExpressionPlan,
  cluster: SignalCluster | undefined,
  pack: ExpressionPlan['contextPack'],
  expiry: number | undefined,
): unknown {
  const signals = cluster?.signals ?? [];
  const signalEvidence = signals.slice(0, 12).map(signal => ({
    kind: signal.kind,
    directionalBias: signal.directionalBias,
    metrics: Object.fromEntries(Object.entries(signal.metrics).slice(0, 12)),
  }));
  const newsTrigger = expression.newsTrigger;
  return {
    source: 'discovery',
    expressionId: expression.id,
    invalidation: expression.invalidation,
    regimeSource: pack?.regime.source ?? (expression.liquidityBucket ? 'expression' : 'unavailable'),
    liquidityBucket: pack?.regime.liquidityBucket ?? expression.liquidityBucket ?? 'unknown',
    executionQuality: pack?.executionQuality ? {
      ...pack.executionQuality,
      notes: Array.isArray(pack.executionQuality.notes) ? pack.executionQuality.notes.slice(0, 8) : [],
    } : null,
    event: pack?.event ?? null,
    newsTrigger: newsTrigger ? {
      ...newsTrigger,
      sources: newsTrigger.sources?.slice(0, 8),
    } : null,
    eventExpiryMs: finiteNumber(expiry),
    missingProviders: pack?.missing ?? ['contextPack'],
    cluster: cluster ? {
      directionalBias: cluster.directionalBias,
      timeHorizon: cluster.timeHorizon,
      signals: signalEvidence,
      omittedSignalCount: Math.max(0, signals.length - signalEvidence.length),
    } : null,
  };
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function enrichQuantEntryGateCandidate(
  candidate: EntryGateCandidate,
  expression: ExpressionPlan,
  cluster: SignalCluster | undefined,
  nowMs: number,
): EntryGateCandidate {
  const pack = expression.contextPack;
  const priceVol = cluster?.signals.find(s => s.kind === 'price_vol_regime');
  const expiry = expression.newsTrigger?.enabled ? expression.newsTrigger.expiresAtMs : undefined;
  const published = expression.newsTrigger?.enabled
    ? expression.newsTrigger.sources?.map(s => s.publishedAtMs)
      .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= nowMs) ?? []
    : [];
  const finite = (n: number | null | undefined) => typeof n === 'number' && Number.isFinite(n) ? n : null;
  return {
    ...candidate,
    // An event expiry is not a thesis TTL. Keep it in evidence rather than guessing.
    catalystTimestamp: published.length ? new Date(Math.max(...published)).toISOString() : undefined,
    sourceContext: boundedSourceContext(sourceEvidence(expression, cluster, pack, expiry)),
    marketContext: {
      markPrice: null, stopDistancePct: null, liquidationMovePctAtCandidateLeverage: null,
      liquidationBufferPct: null, mechanicalLeverageCeiling: null,
      trendBias: priceVol?.directionalBias === 'neutral' ? 'flat' : priceVol?.directionalBias ?? 'unknown',
      priceVsEma20_1hPct: null, regimeSource: 'discovery',
      liquidityBucket: pack?.regime.source === 'provider'
        ? pack.regime.liquidityBucket : expression.liquidityBucket ?? 'unknown',
      liquidityScore: finite(expression.newsTrigger?.liquidityScore),
      executionScore: finite(pack?.executionQuality.score), fundingScore: null,
      spreadProxyBps: null, openInterestUsd: null, dayVolumeUsd: null, oiUsd: null,
      oiDelta1hPct: null, oiDelta4hPct: null, fundingRatePct: null, volumeVs24hAvgPct: null,
      alertReason: pack?.event.catalyst ?? null,
      triggerReason: expression.newsTrigger?.enabled ? 'event' : null,
    },
  };
}
