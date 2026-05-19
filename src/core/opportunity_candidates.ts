import {
  detectOpportunitySymbolClass,
  normalizeOpportunityFeatures,
} from './opportunity_normalization.js';
import {
  computeOpportunityComponentScores,
  computeOpportunityScore,
  evaluateOpportunityHardFloors,
} from './opportunity_scoring.js';
import type {
  OpportunityCandidate,
  OpportunityCandidateInput,
  OpportunitySignalClass,
} from './opportunity_types.js';

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function inferTriggerReasons(input: OpportunityCandidateInput): string[] {
  const reasons = [...(input.triggerReasons ?? [])];
  if (Math.abs(input.attentionFeatures.volumeAbnormalityPct) > 0) reasons.push('abnormal_volume');
  if (Math.abs(input.attentionFeatures.oiAbnormalityPct) > 0) reasons.push('abnormal_oi');
  if ((input.attentionFeatures.fundingRatePct ?? 0) !== 0) reasons.push('abnormal_funding');
  if (Math.abs(input.attentionFeatures.realizedMovePct) > 0) reasons.push('abnormal_realized_move');
  if (input.attentionFeatures.eventIntensity > 0) reasons.push('event_trigger');
  if (input.attentionFeatures.cadenceWeight > 0) reasons.push('cadence_inclusion');
  return uniq(reasons);
}

function inferSignalClass(input: OpportunityCandidateInput): OpportunitySignalClass {
  if (input.signalClass) return input.signalClass;
  if ((input.attentionFeatures.fundingRatePct ?? 0) !== 0) return 'funding_revert';
  if (input.regimeFeatures.marketRegime === 'reversion') return 'mean_reversion';
  if (input.regimeFeatures.marketRegime === 'breakout') return 'momentum_breakout';
  return 'unknown';
}

export function createOpportunityCandidate(input: OpportunityCandidateInput): OpportunityCandidate {
  const symbolClass = input.symbolClass ?? detectOpportunitySymbolClass(input.symbol);
  const normalizedFeatures = normalizeOpportunityFeatures({
    symbolClass,
    attentionFeatures: input.attentionFeatures,
    executionFeatures: input.executionFeatures,
  });

  const provisionalCandidate = {
    symbol: input.symbol,
    symbolClass,
    signalClass: inferSignalClass(input),
    triggerReasons: inferTriggerReasons(input),
    attentionFeatures: input.attentionFeatures,
    structuralFeatures: input.structuralFeatures,
    crowdingFeatures: input.crowdingFeatures,
    regimeFeatures: input.regimeFeatures,
    executionFeatures: input.executionFeatures,
    normalizedFeatures,
  };

  const componentScores = computeOpportunityComponentScores(provisionalCandidate);
  const opportunityScore = computeOpportunityScore(componentScores);
  const hardFloorVerdict = evaluateOpportunityHardFloors({
    symbolClass,
    structuralFeatures: input.structuralFeatures,
    executionFeatures: input.executionFeatures,
    componentScores,
  });

  return {
    ...provisionalCandidate,
    componentScores,
    hardFloorVerdict,
    opportunityScore,
  };
}

export function createOpportunityCandidates(
  inputs: OpportunityCandidateInput[]
): OpportunityCandidate[] {
  return inputs.map((input) => createOpportunityCandidate(input));
}
