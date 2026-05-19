export type OpportunitySymbolClass = 'crypto' | 'xyz' | 'unknown';

export type OpportunitySignalClass =
  | 'momentum_breakout'
  | 'trend_continuation'
  | 'mean_reversion'
  | 'liquidation_cascade'
  | 'news_event'
  | 'funding_revert'
  | 'unknown'
  | (string & {});

export type OpportunityMarketRegime =
  | 'trend'
  | 'chop'
  | 'breakout'
  | 'reversion'
  | 'volatile'
  | 'quiet'
  | 'unknown';

export interface OpportunityAttentionFeatures {
  volumeAbnormalityPct: number;
  oiAbnormalityPct: number;
  fundingRatePct: number | null;
  realizedMovePct: number;
  eventIntensity: number;
  cadenceWeight: number;
}

export interface OpportunityStructuralFeatures {
  expectedEdge: number;
  setupQuality: number;
  relativeStrength: number;
  signalAgreement: number;
  catalystFreshness: number;
  invalidationClarity: number;
  expectedR: number;
}

export interface OpportunityCrowdingFeatures {
  priceExtension: number;
  oiConfirmation: number;
  fundingSkew: number;
  participationQuality: number;
  exhaustionRisk: number;
}

export interface OpportunityRegimeFeatures {
  marketRegime: OpportunityMarketRegime;
  regimeCompatibility: number;
  volatilityState: number;
  expansionBias: number;
  trendPersistence: number;
}

export interface OpportunityExecutionFeatures {
  liquidityUsd: number;
  spreadBps: number;
  stopDistancePct: number;
  invalidationClarity: number;
  expectedR: number;
  portfolioConflict: boolean;
  sameSymbolConflict: boolean;
  stackingOverride: boolean;
}

export interface OpportunityNormalizedFeatures {
  volumeAbnormality: number;
  oiAbnormality: number;
  fundingAbnormality: number;
  realizedMoveAbnormality: number;
  liquidityQuality: number;
  spreadQuality: number;
  stopDistanceQuality: number;
  expectedRQuality: number;
}

export interface OpportunityComponentScores {
  attentionScore: number;
  structuralEdgeScore: number;
  crowdingQualityScore: number;
  regimeFitScore: number;
  executionQualityScore: number;
}

export type OpportunityFloorFailure =
  | 'minimum_liquidity'
  | 'minimum_execution_quality'
  | 'minimum_structural_edge'
  | 'minimum_invalidation_clarity'
  | 'minimum_expected_r'
  | 'portfolio_conflict'
  | 'same_symbol_stacking';

export interface OpportunityHardFloorVerdict {
  eligible: boolean;
  failedFloors: OpportunityFloorFailure[];
}

export interface OpportunityCandidate {
  symbol: string;
  symbolClass: OpportunitySymbolClass;
  signalClass: OpportunitySignalClass;
  triggerReasons: string[];
  attentionFeatures: OpportunityAttentionFeatures;
  structuralFeatures: OpportunityStructuralFeatures;
  crowdingFeatures: OpportunityCrowdingFeatures;
  regimeFeatures: OpportunityRegimeFeatures;
  executionFeatures: OpportunityExecutionFeatures;
  normalizedFeatures: OpportunityNormalizedFeatures;
  componentScores: OpportunityComponentScores;
  hardFloorVerdict: OpportunityHardFloorVerdict;
  opportunityScore: number;
}

export interface OpportunityRankRecord {
  scanId: string;
  symbol: string;
  symbolClass: OpportunitySymbolClass;
  rank: number;
  opportunityScore: number;
  componentScores: OpportunityComponentScores;
  triggerReasons: string[];
  failedFloors: OpportunityFloorFailure[];
  selectedForShortlist: boolean;
  createdAt: string;
}

export interface OpportunityCandidateInput {
  symbol: string;
  symbolClass?: OpportunitySymbolClass;
  signalClass?: OpportunitySignalClass;
  triggerReasons?: string[];
  attentionFeatures: OpportunityAttentionFeatures;
  structuralFeatures: OpportunityStructuralFeatures;
  crowdingFeatures: OpportunityCrowdingFeatures;
  regimeFeatures: OpportunityRegimeFeatures;
  executionFeatures: OpportunityExecutionFeatures;
}
