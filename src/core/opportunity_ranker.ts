import { createOpportunityCandidates } from './opportunity_candidates.js';
import type {
  OpportunityCandidate,
  OpportunityCandidateInput,
  OpportunityRankRecord,
} from './opportunity_types.js';

export interface OpportunityRankingResult {
  rankedCandidates: OpportunityCandidate[];
  shortlist: OpportunityCandidate[];
  records: OpportunityRankRecord[];
}

function compareCandidates(left: OpportunityCandidate, right: OpportunityCandidate): number {
  if (left.hardFloorVerdict.eligible !== right.hardFloorVerdict.eligible) {
    return left.hardFloorVerdict.eligible ? -1 : 1;
  }
  if (right.opportunityScore !== left.opportunityScore) {
    return right.opportunityScore - left.opportunityScore;
  }
  if (
    right.componentScores.structuralEdgeScore !== left.componentScores.structuralEdgeScore
  ) {
    return right.componentScores.structuralEdgeScore - left.componentScores.structuralEdgeScore;
  }
  if (
    right.componentScores.executionQualityScore !== left.componentScores.executionQualityScore
  ) {
    return right.componentScores.executionQualityScore - left.componentScores.executionQualityScore;
  }
  if (right.componentScores.attentionScore !== left.componentScores.attentionScore) {
    return right.componentScores.attentionScore - left.componentScores.attentionScore;
  }
  const symbolCompare = left.symbol.localeCompare(right.symbol);
  if (symbolCompare !== 0) return symbolCompare;
  return left.signalClass.localeCompare(right.signalClass);
}

export function rankOpportunityCandidates(
  candidates: OpportunityCandidate[],
  options?: {
    shortlistSize?: number;
    scanId?: string;
    createdAt?: Date;
  }
): OpportunityRankingResult {
  const shortlistSize = Math.max(1, options?.shortlistSize ?? 5);
  const rankedCandidates = [...candidates].sort(compareCandidates);
  const shortlist = rankedCandidates
    .filter((candidate) => candidate.hardFloorVerdict.eligible)
    .slice(0, shortlistSize);

  const shortlistKeys = new Set(shortlist.map((candidate) => `${candidate.symbol}:${candidate.signalClass}`));
  const createdAt = (options?.createdAt ?? new Date()).toISOString();
  const scanId = options?.scanId ?? 'scan';

  const records = rankedCandidates.map<OpportunityRankRecord>((candidate, index) => ({
    scanId,
    symbol: candidate.symbol,
    symbolClass: candidate.symbolClass,
    rank: index + 1,
    opportunityScore: candidate.opportunityScore,
    componentScores: candidate.componentScores,
    triggerReasons: candidate.triggerReasons,
    failedFloors: candidate.hardFloorVerdict.failedFloors,
    selectedForShortlist: shortlistKeys.has(`${candidate.symbol}:${candidate.signalClass}`),
    createdAt,
  }));

  return {
    rankedCandidates,
    shortlist,
    records,
  };
}

export function scoreAndRankOpportunityCandidates(
  inputs: OpportunityCandidateInput[],
  options?: {
    shortlistSize?: number;
    scanId?: string;
    createdAt?: Date;
  }
): OpportunityRankingResult {
  return rankOpportunityCandidates(createOpportunityCandidates(inputs), options);
}
