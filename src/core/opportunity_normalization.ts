import type {
  OpportunityAttentionFeatures,
  OpportunityExecutionFeatures,
  OpportunityNormalizedFeatures,
  OpportunitySymbolClass,
} from './opportunity_types.js';

export interface OpportunityNormalizationBaselines {
  volumeBaselinePct: number;
  oiBaselinePct: number;
  fundingBaselinePct: number;
  realizedMoveBaselinePct: number;
  liquidityBaselineUsd: number;
  spreadBaselineBps: number;
  targetStopDistancePct: number;
  targetExpectedR: number;
}

export const OPPORTUNITY_NORMALIZATION_BASELINES: Record<
  OpportunitySymbolClass,
  OpportunityNormalizationBaselines
> = {
  crypto: {
    volumeBaselinePct: 150,
    oiBaselinePct: 12,
    fundingBaselinePct: 25,
    realizedMoveBaselinePct: 5,
    liquidityBaselineUsd: 5_000_000,
    spreadBaselineBps: 15,
    targetStopDistancePct: 2.5,
    targetExpectedR: 3,
  },
  xyz: {
    volumeBaselinePct: 60,
    oiBaselinePct: 8,
    fundingBaselinePct: 0,
    realizedMoveBaselinePct: 2,
    liquidityBaselineUsd: 500_000,
    spreadBaselineBps: 40,
    targetStopDistancePct: 3,
    targetExpectedR: 2.5,
  },
  unknown: {
    volumeBaselinePct: 100,
    oiBaselinePct: 10,
    fundingBaselinePct: 15,
    realizedMoveBaselinePct: 3,
    liquidityBaselineUsd: 1_000_000,
    spreadBaselineBps: 25,
    targetStopDistancePct: 3,
    targetExpectedR: 2.75,
  },
};

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function detectOpportunitySymbolClass(symbol: string): OpportunitySymbolClass {
  return symbol.trim().toUpperCase().startsWith('XYZ:') ? 'xyz' : 'crypto';
}

function normalizeRelativeAbnormality(value: number, baseline: number): number {
  if (!Number.isFinite(value) || baseline <= 0) return 0;
  const ratio = Math.abs(value) / baseline;
  return clamp01(ratio / (1 + ratio));
}

function normalizeLiquidity(liquidityUsd: number, baselineUsd: number): number {
  if (!Number.isFinite(liquidityUsd) || liquidityUsd <= 0 || baselineUsd <= 0) return 0;
  return clamp01(liquidityUsd / (liquidityUsd + baselineUsd));
}

function normalizeSpread(spreadBps: number, baselineBps: number): number {
  if (!Number.isFinite(spreadBps) || spreadBps < 0 || baselineBps <= 0) return 0;
  return clamp01(1 - spreadBps / (spreadBps + baselineBps));
}

function normalizeStopDistance(stopDistancePct: number, targetStopDistancePct: number): number {
  if (!Number.isFinite(stopDistancePct) || stopDistancePct <= 0 || targetStopDistancePct <= 0) {
    return 0;
  }
  const ratio = Math.min(stopDistancePct, targetStopDistancePct) / targetStopDistancePct;
  return clamp01(ratio);
}

function normalizeExpectedR(expectedR: number, targetExpectedR: number): number {
  if (!Number.isFinite(expectedR) || expectedR <= 0 || targetExpectedR <= 0) return 0;
  return clamp01(expectedR / targetExpectedR);
}

export function normalizeOpportunityFeatures(input: {
  symbolClass: OpportunitySymbolClass;
  attentionFeatures: OpportunityAttentionFeatures;
  executionFeatures: OpportunityExecutionFeatures;
}): OpportunityNormalizedFeatures {
  const baselines = OPPORTUNITY_NORMALIZATION_BASELINES[input.symbolClass];
  const { attentionFeatures, executionFeatures } = input;

  return {
    volumeAbnormality: normalizeRelativeAbnormality(
      attentionFeatures.volumeAbnormalityPct,
      baselines.volumeBaselinePct
    ),
    oiAbnormality: normalizeRelativeAbnormality(
      attentionFeatures.oiAbnormalityPct,
      baselines.oiBaselinePct
    ),
    fundingAbnormality:
      attentionFeatures.fundingRatePct == null || baselines.fundingBaselinePct <= 0
        ? 0.5
        : normalizeRelativeAbnormality(
            attentionFeatures.fundingRatePct,
            baselines.fundingBaselinePct
          ),
    realizedMoveAbnormality: normalizeRelativeAbnormality(
      attentionFeatures.realizedMovePct,
      baselines.realizedMoveBaselinePct
    ),
    liquidityQuality: normalizeLiquidity(
      executionFeatures.liquidityUsd,
      baselines.liquidityBaselineUsd
    ),
    spreadQuality: normalizeSpread(executionFeatures.spreadBps, baselines.spreadBaselineBps),
    stopDistanceQuality: normalizeStopDistance(
      executionFeatures.stopDistancePct,
      baselines.targetStopDistancePct
    ),
    expectedRQuality: normalizeExpectedR(
      executionFeatures.expectedR,
      baselines.targetExpectedR
    ),
  };
}
