import { resolveAdaptiveEdge } from '../core/adaptive_edge.js';
import { listPerpTradeJournals } from '../memory/perp_trade_journal.js';
import type { ThufirConfig } from '../core/config.js';
import type {
  ExpressionContextPack,
  ExpressionPlan,
  Hypothesis,
  SignalCluster,
} from './types.js';

type ContextPackValue<T> = T | null | undefined | Promise<T | null | undefined>;

export interface ContextPackProviders {
  regime?: (input: {
    expression: ExpressionPlan;
    cluster: SignalCluster;
    hypothesis: Hypothesis;
  }) => ContextPackValue<Partial<ExpressionContextPack['regime']>>;
  executionQuality?: (input: {
    expression: ExpressionPlan;
    cluster: SignalCluster;
    hypothesis: Hypothesis;
  }) => ContextPackValue<Partial<ExpressionContextPack['executionQuality']>>;
  event?: (input: {
    expression: ExpressionPlan;
    cluster: SignalCluster;
    hypothesis: Hypothesis;
  }) => ContextPackValue<Partial<ExpressionContextPack['event']>>;
  portfolioState?: (input: {
    expression: ExpressionPlan;
    cluster: SignalCluster;
    hypothesis: Hypothesis;
  }) => ContextPackValue<Partial<ExpressionContextPack['portfolioState']>>;
}

export function mapExpressionPlan(
  config: ThufirConfig,
  cluster: SignalCluster,
  hypothesis: Hypothesis
): ExpressionPlan {
  // The LLM entry gate decides final leverage per trade. 1x is the floor until the gate sets it.
  const leverage = 1;
  const dailyLimit = config.wallet?.limits?.daily ?? 100;
  const probeFraction = config.autonomy?.probeRiskFraction ?? 0.005;
  const probeBudget = Math.max(1, dailyLimit * probeFraction);
  const side = hypothesis.expectedExpression.includes('down') ? 'sell' : 'buy';
  const confidence = Math.min(1, Math.max(0, cluster.confidence));
  const reflex = cluster.signals.find((s) => s.kind === 'reflexivity_fragility');
  const priceVol = cluster.signals.find((s) => s.kind === 'price_vol_regime');
  const orderflow = cluster.signals.find((s) => s.kind === 'orderflow_imbalance');

  // Signal class must be derived before edge so segment lookup is correct.
  // Bug fix: _reflex → 'liquidation_cascade' (was incorrectly 'news_event')
  const signalClass: ExpressionPlan['signalClass'] = hypothesis.id.includes('_revert')
    ? 'mean_reversion'
    : hypothesis.id.includes('_reflex')
      ? 'liquidation_cascade'
      : hypothesis.id.includes('_trend')
        ? 'momentum_breakout'
        : 'unknown';

  const trend = Number(priceVol?.metrics?.trend ?? 0);
  const volZ = Number(priceVol?.metrics?.volZ ?? 0);
  const marketRegime: ExpressionPlan['marketRegime'] =
    volZ >= 1 ? 'high_vol_expansion' : volZ <= -0.5 ? 'low_vol_compression' : Math.abs(trend) >= 0.015 ? 'trending' : 'choppy';
  const volatilityBucket: ExpressionPlan['volatilityBucket'] =
    Math.abs(volZ) >= 1.2 ? 'high' : Math.abs(volZ) <= 0.4 ? 'low' : 'medium';
  const tradeCount = Number(orderflow?.metrics?.tradeCount ?? 0);
  const liquidityBucket: ExpressionPlan['liquidityBucket'] =
    tradeCount >= 18 ? 'deep' : tradeCount <= 4 ? 'thin' : 'normal';

  // Adaptive edge: momentum_breakout in neutral bias gets a 0.4x penalty (requires
  // directional conviction, but hard-zero was too aggressive — most market time is
  // spent in neutral regime). Mean reversion and liquidation_cascade are non-directional.
  const momentumNeutralPenalty =
    signalClass === 'momentum_breakout' && cluster.directionalBias === 'neutral' ? 0.4 : 1.0;
  const journalEntries = (() => {
    try {
      return listPerpTradeJournals({ limit: 500 });
    } catch {
      return [];
    }
  })();

  let expectedEdge: number;
  if ((config.autonomy as any)?.adaptiveEdge?.enabled !== false) {
    const edgeResult = resolveAdaptiveEdge(
      config,
      journalEntries,
      { signalClass, marketRegime, volatilityBucket, liquidityBucket },
      confidence
    );
    expectedEdge = edgeResult.edge * momentumNeutralPenalty;
  } else {
    // Legacy path (adaptiveEdge.enabled: false)
    expectedEdge =
      cluster.directionalBias === 'neutral' ? 0 : Math.min(1, confidence * 0.1);
    if (reflex) {
      const setupScore =
        typeof reflex.metrics.setupScore === 'number' ? reflex.metrics.setupScore : confidence;
      const edgeScale = Number((config as any)?.reflexivity?.edgeScale ?? 0.2);
      expectedEdge = Math.min(1, clamp01(setupScore) * edgeScale);
    }
  }

  // Carry-cost penalty for liquidation_cascade (reflex) hypotheses: paying funding
  // reduces expected edge since carry works against the position.
  if (reflex && signalClass === 'liquidation_cascade') {
    const fundingRate =
      typeof reflex.metrics.fundingRate === 'number' ? reflex.metrics.fundingRate : 0;
    const paying =
      (side === 'buy' && fundingRate > 0) || (side === 'sell' && fundingRate < 0);
    if (paying) {
      const carryPenalty = Math.min(0.05, Math.abs(fundingRate) * 100);
      expectedEdge = Math.max(0, expectedEdge - carryPenalty);
    }
  }

  const newsTtlMinutes = Number((config.autonomy as any)?.newsEntry?.thesisTtlMinutes ?? 120);
  const noveltyScore =
    typeof reflex?.metrics?.setupScore === 'number' ? clamp01(Number(reflex.metrics.setupScore)) : confidence;
  const marketConfirmationScore = clamp01(Math.abs(Number(orderflow?.metrics?.imbalance ?? 0)) * 2);
  const liquidityScore = clamp01(tradeCount / 20);
  const volatilityScore = clamp01(Math.abs(volZ));
  // After the _reflex bug fix, no signal class produced here is 'news_event'.
  const isNewsEvent = false;

  return {
    id: `expr_${hypothesis.id}`,
    hypothesisId: hypothesis.id,
    symbol: cluster.symbol,
    side,
    signalClass,
    marketRegime,
    volatilityBucket,
    liquidityBucket,
    confidence,
    expectedEdge,
    entryZone: 'market',
    invalidation: hypothesis.invalidation,
    expectedMove: hypothesis.expectedExpression,
    orderType: 'market',
    leverage,
    probeSizeUsd: probeBudget,
    newsTrigger: isNewsEvent
      ? {
          enabled: true,
          subtype: 'catalyst_reflexivity',
          sources: [
            {
              source: 'discovery_reflexivity',
              ref: hypothesis.id,
              confidence: confidence,
            },
          ],
          noveltyScore,
          marketConfirmationScore,
          liquidityScore,
          volatilityScore,
          expiresAtMs: Date.now() + Math.max(10, newsTtlMinutes) * 60_000,
        }
      : null,
  };
}

function isExecutionStatus(value: unknown): value is ExpressionContextPack['executionQuality']['status'] {
  return value === 'good' || value === 'mixed' || value === 'poor' || value === 'unknown';
}

function isEventKind(value: unknown): value is ExpressionContextPack['event']['kind'] {
  return value === 'news_event' || value === 'technical' || value === 'none';
}

function isPosture(value: unknown): value is ExpressionContextPack['portfolioState']['posture'] {
  return value === 'risk_on' || value === 'risk_off' || value === 'neutral' || value === 'unknown';
}

function toOptionalNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function safeProviderResult<T>(
  provider: (() => ContextPackValue<T>) | undefined
): Promise<T | null> {
  if (!provider) return null;
  try {
    const result = await provider();
    return result ?? null;
  } catch {
    return null;
  }
}

function defaultContextPack(input: {
  expression: ExpressionPlan;
  cluster: SignalCluster;
  hypothesis: Hypothesis;
}): ExpressionContextPack {
  const { expression, cluster, hypothesis } = input;
  const hasNewsTrigger = expression.newsTrigger?.enabled === true;
  return {
    regime: {
      marketRegime: expression.marketRegime ?? 'choppy',
      volatilityBucket: expression.volatilityBucket ?? 'medium',
      liquidityBucket: expression.liquidityBucket ?? 'normal',
      confidence: toOptionalNumber(cluster.confidence),
      source: 'derived',
    },
    executionQuality: {
      status: 'unknown',
      score: null,
      recentWinRate: null,
      slippageBps: null,
      notes: ['execution quality provider missing'],
      source: 'default',
    },
    event: {
      kind: hasNewsTrigger ? 'news_event' : 'technical',
      subtype: expression.newsTrigger?.subtype ?? null,
      catalyst: hypothesis.pressureSource ?? null,
      confidence: toOptionalNumber(expression.newsTrigger?.noveltyScore),
      expiresAtMs: toOptionalNumber(expression.newsTrigger?.expiresAtMs),
      source: hasNewsTrigger ? 'derived' : 'default',
    },
    portfolioState: {
      posture: 'unknown',
      availableBalanceUsd: null,
      netExposureUsd: null,
      openPositions: null,
      source: 'default',
    },
    missing: [],
  };
}

export async function enrichExpressionContextPack(input: {
  expression: ExpressionPlan;
  cluster: SignalCluster;
  hypothesis: Hypothesis;
  providers?: ContextPackProviders;
}): Promise<ExpressionPlan> {
  const defaults = defaultContextPack(input);
  const { providers, expression, cluster, hypothesis } = input;
  const providerInput = { expression, cluster, hypothesis };

  const [regimeRaw, executionRaw, eventRaw, portfolioRaw] = await Promise.all([
    safeProviderResult(() => providers?.regime?.(providerInput)),
    safeProviderResult(() => providers?.executionQuality?.(providerInput)),
    safeProviderResult(() => providers?.event?.(providerInput)),
    safeProviderResult(() => providers?.portfolioState?.(providerInput)),
  ]);

  const regime: ExpressionContextPack['regime'] = {
    marketRegime:
      regimeRaw?.marketRegime === 'trending' ||
      regimeRaw?.marketRegime === 'choppy' ||
      regimeRaw?.marketRegime === 'high_vol_expansion' ||
      regimeRaw?.marketRegime === 'low_vol_compression'
        ? regimeRaw.marketRegime
        : defaults.regime.marketRegime,
    volatilityBucket:
      regimeRaw?.volatilityBucket === 'low' ||
      regimeRaw?.volatilityBucket === 'medium' ||
      regimeRaw?.volatilityBucket === 'high'
        ? regimeRaw.volatilityBucket
        : defaults.regime.volatilityBucket,
    liquidityBucket:
      regimeRaw?.liquidityBucket === 'thin' ||
      regimeRaw?.liquidityBucket === 'normal' ||
      regimeRaw?.liquidityBucket === 'deep'
        ? regimeRaw.liquidityBucket
        : defaults.regime.liquidityBucket,
    confidence: toOptionalNumber(regimeRaw?.confidence) ?? defaults.regime.confidence,
    source: regimeRaw ? 'provider' : defaults.regime.source,
  };

  const executionQuality: ExpressionContextPack['executionQuality'] = {
    status: isExecutionStatus(executionRaw?.status) ? executionRaw.status : defaults.executionQuality.status,
    score: toOptionalNumber(executionRaw?.score),
    recentWinRate: toOptionalNumber(executionRaw?.recentWinRate),
    slippageBps: toOptionalNumber(executionRaw?.slippageBps),
    notes:
      Array.isArray(executionRaw?.notes) && executionRaw.notes.length > 0
        ? executionRaw.notes.map((note) => String(note))
        : defaults.executionQuality.notes,
    source: executionRaw ? 'provider' : defaults.executionQuality.source,
  };

  const event: ExpressionContextPack['event'] = {
    kind: isEventKind(eventRaw?.kind) ? eventRaw.kind : defaults.event.kind,
    subtype: typeof eventRaw?.subtype === 'string' ? eventRaw.subtype : defaults.event.subtype,
    catalyst: typeof eventRaw?.catalyst === 'string' ? eventRaw.catalyst : defaults.event.catalyst,
    confidence: toOptionalNumber(eventRaw?.confidence) ?? defaults.event.confidence,
    expiresAtMs: toOptionalNumber(eventRaw?.expiresAtMs) ?? defaults.event.expiresAtMs,
    source: eventRaw ? 'provider' : defaults.event.source,
  };

  const portfolioState: ExpressionContextPack['portfolioState'] = {
    posture: isPosture(portfolioRaw?.posture) ? portfolioRaw.posture : defaults.portfolioState.posture,
    availableBalanceUsd:
      toOptionalNumber(portfolioRaw?.availableBalanceUsd) ?? defaults.portfolioState.availableBalanceUsd,
    netExposureUsd:
      toOptionalNumber(portfolioRaw?.netExposureUsd) ?? defaults.portfolioState.netExposureUsd,
    openPositions: toOptionalNumber(portfolioRaw?.openPositions) ?? defaults.portfolioState.openPositions,
    source: portfolioRaw ? 'provider' : defaults.portfolioState.source,
  };

  const missing: string[] = [];
  if (!regimeRaw) missing.push('regime.provider');
  if (!executionRaw) missing.push('executionQuality.provider');
  if (!eventRaw && defaults.event.source === 'default') missing.push('event.provider');
  if (!portfolioRaw) missing.push('portfolioState.provider');

  return {
    ...expression,
    contextPack: {
      regime,
      executionQuality,
      event,
      portfolioState,
      missing,
    },
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
