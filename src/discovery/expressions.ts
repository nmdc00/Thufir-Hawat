import type { ThufirConfig } from '../core/config.js';
import type { ExpressionPlan, Hypothesis, SignalCluster } from './types.js';

export function mapExpressionPlan(
  config: ThufirConfig,
  cluster: SignalCluster,
  hypothesis: Hypothesis
): ExpressionPlan {
  const leverage = Math.min(config.hyperliquid?.maxLeverage ?? 5, 5);
  const dailyLimit = config.wallet?.limits?.daily ?? 100;
  const probeFraction = config.autonomy?.probeRiskFraction ?? 0.005;
  const probeBudget = Math.max(1, dailyLimit * probeFraction);
  const side = hypothesis.expectedExpression.includes('down') ? 'sell' : 'buy';
  const confidence = Math.min(1, Math.max(0, cluster.confidence));
  const reflex = cluster.signals.find((s) => s.kind === 'reflexivity_fragility');

  let expectedEdge =
    cluster.directionalBias === 'neutral' ? 0 : Math.min(1, confidence * 0.1);

  if (reflex) {
    const setupScore = typeof reflex.metrics.setupScore === 'number' ? reflex.metrics.setupScore : confidence;
    const edgeScale = Number((config as any)?.reflexivity?.edgeScale ?? 0.2);
    expectedEdge = Math.min(1, clamp01(setupScore) * edgeScale);

    // Rough carry-cost penalty: when you are on the paying side of funding, reduce edge.
    const fundingRate = typeof reflex.metrics.fundingRate === 'number' ? reflex.metrics.fundingRate : 0;
    const paying =
      (side === 'buy' && fundingRate > 0) || (side === 'sell' && fundingRate < 0);
    if (paying) {
      const carryPenalty = Math.min(0.05, Math.abs(fundingRate) * 100); // heuristically cap at 5%
      expectedEdge = Math.max(0, expectedEdge - carryPenalty);
    }
  }

  const tm = (config as any)?.tradeManagement ?? {};
  const defaults = tm.defaults ?? {};
  const bounds = tm.bounds ?? {};
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

  const stopLossPct = clamp(
    Number(defaults.stopLossPct ?? 3.0),
    Number(bounds.stopLossPct?.min ?? 1.0),
    Number(bounds.stopLossPct?.max ?? 8.0)
  );
  const takeProfitPct = clamp(
    Number(defaults.takeProfitPct ?? 5.0),
    Number(bounds.takeProfitPct?.min ?? 2.0),
    Number(bounds.takeProfitPct?.max ?? 15.0)
  );
  const maxHoldHours = clamp(
    Number(defaults.maxHoldHours ?? 72),
    Number(bounds.maxHoldHours?.min ?? 1),
    Number(bounds.maxHoldHours?.max ?? 168)
  );
  const trailingStopPct = clamp(
    Number(defaults.trailingStopPct ?? 2.0),
    Number(bounds.trailingStopPct?.min ?? 0.5),
    Number(bounds.trailingStopPct?.max ?? 5.0)
  );
  const trailingActivationPct = clamp(
    Number(defaults.trailingActivationPct ?? 1.0),
    Number(bounds.trailingActivationPct?.min ?? 0.0),
    Number(bounds.trailingActivationPct?.max ?? 5.0)
  );

  const agreeingSignalKinds = cluster.signals
    .filter((s) => s.directionalBias !== 'neutral')
    .filter((s) => (side === 'buy' ? s.directionalBias === 'up' : s.directionalBias === 'down'))
    .map((s) => s.kind);

  return {
    id: `expr_${hypothesis.id}`,
    hypothesisId: hypothesis.id,
    symbol: cluster.symbol,
    side,
    confidence,
    expectedEdge,
    entryZone: 'market',
    invalidation: hypothesis.invalidation,
    expectedMove: hypothesis.expectedExpression,
    orderType: 'market',
    leverage,
    probeSizeUsd: probeBudget,

    stopLossPct,
    takeProfitPct,
    maxHoldSeconds: Math.round(maxHoldHours * 3600),
    trailingStopPct: trailingStopPct || null,
    trailingActivationPct,

    thesis: `${hypothesis.pressureSource}: ${hypothesis.expectedExpression}`,
    signalKinds: agreeingSignalKinds,
    catalystId: null,
    narrativeSnapshot: '',
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
