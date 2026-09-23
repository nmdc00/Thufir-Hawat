export type SignalPrimitiveKind =
  | 'price_vol_regime'
  | 'cross_asset_divergence'
  | 'funding_oi_skew'
  | 'orderflow_imbalance'
  | 'onchain_flow'
  | 'reflexivity_fragility';

export interface SignalPrimitive {
  id: string;
  kind: SignalPrimitiveKind;
  symbol: string;
  directionalBias: 'up' | 'down' | 'neutral';
  confidence: number;
  timeHorizon: 'minutes' | 'hours' | 'days';
  metrics: Record<string, number>;
}

export interface SignalCluster {
  id: string;
  symbol: string;
  signals: SignalPrimitive[];
  directionalBias: 'up' | 'down' | 'neutral';
  confidence: number;
  timeHorizon: 'minutes' | 'hours' | 'days';
}

export interface Hypothesis {
  id: string;
  clusterId: string;
  pressureSource: string;
  expectedExpression: string;
  timeHorizon: 'minutes' | 'hours' | 'days';
  invalidation: string;
  tradeMap: string;
  riskNotes: string[];
}

export interface ExpressionPlan {
  id: string;
  hypothesisId: string;
  symbol: string;
  side: 'buy' | 'sell';
  signalClass?: 'momentum_breakout' | 'mean_reversion' | 'news_event' | 'liquidation_cascade' | 'unknown';
  marketRegime?: 'trending' | 'choppy' | 'high_vol_expansion' | 'low_vol_compression';
  volatilityBucket?: 'low' | 'medium' | 'high';
  liquidityBucket?: 'thin' | 'normal' | 'deep';
  confidence: number;
  expectedEdge: number;
  entryZone: string;
  invalidation: string;
  expectedMove: string;
  orderType: 'market' | 'limit';
  leverage: number;
  probeSizeUsd: number;
  /** Only explicit strategy evidence may populate an executable plan. */
  tradePlan?: {
    invalidationPrice: number;
    targetPrice: number;
    expectedRMultiple: number;
    suggestedTtlMinutes: number;
    provenance: 'strategy';
  } | null;
  newsTrigger?: {
    enabled: boolean;
    subtype?: string;
    sources?: Array<{
      source: string;
      ref?: string;
      publishedAtMs?: number;
      confidence?: number;
    }>;
    noveltyScore?: number;
    marketConfirmationScore?: number;
    liquidityScore?: number;
    volatilityScore?: number;
    expiresAtMs?: number;
  } | null;
  contextPack?: ExpressionContextPack;
}

export interface ExpressionContextPack {
  regime: {
    marketRegime: 'trending' | 'choppy' | 'high_vol_expansion' | 'low_vol_compression';
    volatilityBucket: 'low' | 'medium' | 'high';
    liquidityBucket: 'thin' | 'normal' | 'deep';
    confidence: number | null;
    source: 'derived' | 'provider' | 'default';
  };
  executionQuality: {
    status: 'good' | 'mixed' | 'poor' | 'unknown';
    score: number | null;
    recentWinRate: number | null;
    slippageBps: number | null;
    notes: string[];
    source: 'provider' | 'default';
  };
  event: {
    kind: 'news_event' | 'technical' | 'none';
    subtype: string | null;
    catalyst: string | null;
    confidence: number | null;
    expiresAtMs: number | null;
    source: 'derived' | 'provider' | 'default';
  };
  portfolioState: {
    posture: 'risk_on' | 'risk_off' | 'neutral' | 'unknown';
    availableBalanceUsd: number | null;
    netExposureUsd: number | null;
    openPositions: number | null;
    source: 'provider' | 'default';
  };
  missing: string[];
}
