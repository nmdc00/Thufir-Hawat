export type SignalPrimitiveKind =
  | 'price_vol_regime'
  | 'cross_asset_divergence'
  | 'funding_oi_skew'
  | 'orderflow_imbalance'
  | 'onchain_flow';

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
  entryZone: string;
  invalidation: string;
  expectedMove: string;
  orderType: 'market' | 'limit';
  leverage: number;
  probeSizeUsd: number;
}
