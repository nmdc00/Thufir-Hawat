import { clamp01 } from './opportunity_normalization.js';
import type {
  OpportunityCandidate,
  OpportunityComponentScores,
  OpportunityFloorFailure,
  OpportunityHardFloorVerdict,
} from './opportunity_types.js';

export interface OpportunityHardFloorThresholds {
  minLiquidityUsd: number;
  minExecutionQuality: number;
  minStructuralEdge: number;
  minInvalidationClarity: number;
  minExpectedR: number;
}

export const DEFAULT_OPPORTUNITY_FLOOR_THRESHOLDS = {
  crypto: {
    minLiquidityUsd: 2_500_000,
    minExecutionQuality: 0.35,
    minStructuralEdge: 0.4,
    minInvalidationClarity: 0.45,
    minExpectedR: 1.5,
  },
  xyz: {
    minLiquidityUsd: 250_000,
    minExecutionQuality: 0.35,
    minStructuralEdge: 0.4,
    minInvalidationClarity: 0.45,
    minExpectedR: 1.5,
  },
  unknown: {
    minLiquidityUsd: 1_000_000,
    minExecutionQuality: 0.35,
    minStructuralEdge: 0.4,
    minInvalidationClarity: 0.45,
    minExpectedR: 1.5,
  },
} as const satisfies Record<string, OpportunityHardFloorThresholds>;

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeSignedQuality(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp01((value + 1) / 2);
}

export function computeOpportunityComponentScores(
  candidate: Pick<
    OpportunityCandidate,
    | 'attentionFeatures'
    | 'structuralFeatures'
    | 'crowdingFeatures'
    | 'regimeFeatures'
    | 'executionFeatures'
    | 'normalizedFeatures'
  >
): OpportunityComponentScores {
  const attentionScore = clamp01(
    average([
      candidate.normalizedFeatures.volumeAbnormality,
      candidate.normalizedFeatures.oiAbnormality,
      candidate.normalizedFeatures.fundingAbnormality,
      candidate.normalizedFeatures.realizedMoveAbnormality,
      clamp01(candidate.attentionFeatures.eventIntensity),
      clamp01(candidate.attentionFeatures.cadenceWeight),
    ])
  );

  const structuralEdgeScore = clamp01(
    average([
      clamp01(candidate.structuralFeatures.expectedEdge),
      clamp01(candidate.structuralFeatures.setupQuality),
      clamp01(candidate.structuralFeatures.relativeStrength),
      clamp01(candidate.structuralFeatures.signalAgreement),
      clamp01(candidate.structuralFeatures.catalystFreshness),
      clamp01(candidate.structuralFeatures.invalidationClarity),
      candidate.normalizedFeatures.expectedRQuality,
    ])
  );

  const crowdingQualityScore = clamp01(
    average([
      1 - clamp01(candidate.crowdingFeatures.priceExtension),
      clamp01(candidate.crowdingFeatures.oiConfirmation),
      1 - clamp01(candidate.crowdingFeatures.fundingSkew),
      clamp01(candidate.crowdingFeatures.participationQuality),
      1 - clamp01(candidate.crowdingFeatures.exhaustionRisk),
    ])
  );

  const regimeFitScore = clamp01(
    average([
      clamp01(candidate.regimeFeatures.regimeCompatibility),
      clamp01(candidate.regimeFeatures.volatilityState),
      clamp01(candidate.regimeFeatures.expansionBias),
      clamp01(candidate.regimeFeatures.trendPersistence),
    ])
  );

  const executionBaseScore = clamp01(
    average([
      candidate.normalizedFeatures.liquidityQuality,
      candidate.normalizedFeatures.spreadQuality,
      candidate.normalizedFeatures.stopDistanceQuality,
      candidate.normalizedFeatures.expectedRQuality,
      clamp01(candidate.executionFeatures.invalidationClarity),
      normalizeSignedQuality(1 - candidate.executionFeatures.stopDistancePct / 10),
    ])
  );
  const conflictPenalty = candidate.executionFeatures.portfolioConflict ? 0 : 1;
  const stackingPenalty =
    candidate.executionFeatures.sameSymbolConflict && !candidate.executionFeatures.stackingOverride
      ? 0
      : 1;
  const executionQualityScore = clamp01(
    executionBaseScore * conflictPenalty * stackingPenalty
  );

  return {
    attentionScore,
    structuralEdgeScore,
    crowdingQualityScore,
    regimeFitScore,
    executionQualityScore,
  };
}

export function computeOpportunityScore(componentScores: OpportunityComponentScores): number {
  return clamp01(
    componentScores.attentionScore * 0.2 +
      componentScores.structuralEdgeScore * 0.3 +
      componentScores.crowdingQualityScore * 0.2 +
      componentScores.regimeFitScore * 0.15 +
      componentScores.executionQualityScore * 0.15
  );
}

export function evaluateOpportunityHardFloors(
  candidate: Pick<
    OpportunityCandidate,
    'symbolClass' | 'structuralFeatures' | 'executionFeatures' | 'componentScores'
  >,
  thresholds?: Partial<OpportunityHardFloorThresholds>
): OpportunityHardFloorVerdict {
  const resolvedThresholds = {
    ...DEFAULT_OPPORTUNITY_FLOOR_THRESHOLDS[candidate.symbolClass],
    ...thresholds,
  };
  const failedFloors: OpportunityFloorFailure[] = [];

  if (candidate.executionFeatures.liquidityUsd < resolvedThresholds.minLiquidityUsd) {
    failedFloors.push('minimum_liquidity');
  }
  if (candidate.componentScores.executionQualityScore < resolvedThresholds.minExecutionQuality) {
    failedFloors.push('minimum_execution_quality');
  }
  if (candidate.componentScores.structuralEdgeScore < resolvedThresholds.minStructuralEdge) {
    failedFloors.push('minimum_structural_edge');
  }
  if (
    Math.min(
      candidate.structuralFeatures.invalidationClarity,
      candidate.executionFeatures.invalidationClarity
    ) < resolvedThresholds.minInvalidationClarity
  ) {
    failedFloors.push('minimum_invalidation_clarity');
  }
  if (candidate.executionFeatures.expectedR < resolvedThresholds.minExpectedR) {
    failedFloors.push('minimum_expected_r');
  }
  if (candidate.executionFeatures.portfolioConflict) {
    failedFloors.push('portfolio_conflict');
  }
  if (
    candidate.executionFeatures.sameSymbolConflict &&
    !candidate.executionFeatures.stackingOverride
  ) {
    failedFloors.push('same_symbol_stacking');
  }

  return {
    eligible: failedFloors.length === 0,
    failedFloors,
  };
}
