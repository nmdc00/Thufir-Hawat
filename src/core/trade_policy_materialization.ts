import type { ThufirConfig } from './config.js';
import type { LearningCase } from '../memory/learning_cases.js';
import { listLearningCases } from '../memory/learning_cases.js';
import {
  deactivateTradePolicyAdjustmentsForScope,
  replaceActiveTradePolicyAdjustment,
  type TradePolicyAdjustmentInput,
  type TradePolicyAdjustmentRecord,
  type TradePolicyAdjustmentScope,
} from '../memory/trade_policy_adjustments.js';

type PolicyAdjustmentDerivation = Omit<TradePolicyAdjustmentInput, 'domain'>;

type EvidenceStats = {
  evidenceCount: number;
  thesisFailureCount: number;
  thesisFailureRate: number;
  negativePnlCount: number;
  negativePnlRate: number;
  averageQualityScore: number | null;
  helpfulConfirmationCount: number;
  helpfulCooldownCount: number;
  suggestedCooldownMinutes: number | null;
  dominantFailureMode: string | null;
  averageLeverageOnLoss: number | null;
};

function toFiniteNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBooleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function extractCompositeQualityScore(learningCase: LearningCase): number | null {
  const qualityScores = learningCase.qualityScores ?? {};
  const composite = toFiniteNumberOrNull(qualityScores.compositeScore);
  if (composite != null) {
    return composite;
  }
  const atomicScores = [
    qualityScores.directionScore,
    qualityScores.timingScore,
    qualityScores.sizingScore,
    qualityScores.exitScore,
  ]
    .map((value) => toFiniteNumberOrNull(value))
    .filter((value): value is number => value != null);
  if (atomicScores.length === 0) return null;
  return atomicScores.reduce((sum, value) => sum + value, 0) / atomicScores.length;
}

function normalizeDirection(side: string | null): 'long' | 'short' | null {
  if (side === 'buy' || side === 'long') return 'long';
  if (side === 'sell' || side === 'short') return 'short';
  return null;
}

function extractFailureMode(learningCase: LearningCase): string | null {
  const context = learningCase.context ?? {};
  const policyInputs = learningCase.policyInputs ?? {};
  const planContext =
    policyInputs.planContext && typeof policyInputs.planContext === 'object'
      ? (policyInputs.planContext as Record<string, unknown>)
      : null;
  return (
    normalizeString(context.failureMode) ??
    normalizeString(planContext?.failureMode) ??
    normalizeString(planContext?.failure_mode) ??
    null
  );
}

function extractHelpfulConfirmation(learningCase: LearningCase): boolean {
  const context = learningCase.context ?? {};
  const policyInputs = learningCase.policyInputs ?? {};
  const planContext =
    policyInputs.planContext && typeof policyInputs.planContext === 'object'
      ? (policyInputs.planContext as Record<string, unknown>)
      : null;
  return (
    toBooleanOrNull(context.confirmationHelpful) === true ||
    toBooleanOrNull(policyInputs.confirmationHelpful) === true ||
    toBooleanOrNull(planContext?.confirmationHelpful) === true ||
    toBooleanOrNull(planContext?.confirmation_helpful) === true
  );
}

function extractHelpfulCooldown(learningCase: LearningCase): { helpful: boolean; cooldownMinutes: number | null } {
  const context = learningCase.context ?? {};
  const policyInputs = learningCase.policyInputs ?? {};
  const planContext =
    policyInputs.planContext && typeof policyInputs.planContext === 'object'
      ? (policyInputs.planContext as Record<string, unknown>)
      : null;
  return {
    helpful:
      toBooleanOrNull(context.cooldownHelpful) === true ||
      toBooleanOrNull(policyInputs.cooldownHelpful) === true ||
      toBooleanOrNull(planContext?.cooldownHelpful) === true ||
      toBooleanOrNull(planContext?.cooldown_helpful) === true,
    cooldownMinutes:
      toFiniteNumberOrNull(context.cooldownMinutes) ??
      toFiniteNumberOrNull(policyInputs.cooldownMinutes) ??
      toFiniteNumberOrNull(planContext?.cooldownMinutes) ??
      toFiniteNumberOrNull(planContext?.cooldown_minutes) ??
      null,
  };
}

export function scopeFromLearningCase(learningCase: LearningCase): TradePolicyAdjustmentScope {
  const context = learningCase.context ?? {};
  return {
    symbol: normalizeString(context.symbol),
    direction: normalizeDirection(normalizeString(context.direction)),
    strategySource: normalizeString(context.strategySource),
    triggerReason: normalizeString(context.triggerReason) ?? normalizeString(context.entryTrigger),
    signalClass: normalizeString(context.signalClass),
    symbolClass: normalizeString(context.symbolClass),
    session: normalizeString(context.session),
    marketRegime: normalizeString(context.marketRegime),
    volatilityBucket: normalizeString(context.volatilityBucket),
    liquidityBucket: normalizeString(context.liquidityBucket),
  };
}

function sameScope(left: TradePolicyAdjustmentScope, right: TradePolicyAdjustmentScope): boolean {
  return (
    (left.symbol ?? null) === (right.symbol ?? null) &&
    (left.direction ?? null) === (right.direction ?? null) &&
    (left.strategySource ?? null) === (right.strategySource ?? null) &&
    (left.triggerReason ?? null) === (right.triggerReason ?? null) &&
    (left.signalClass ?? null) === (right.signalClass ?? null) &&
    (left.symbolClass ?? null) === (right.symbolClass ?? null) &&
    (left.session ?? null) === (right.session ?? null) &&
    (left.marketRegime ?? null) === (right.marketRegime ?? null) &&
    (left.volatilityBucket ?? null) === (right.volatilityBucket ?? null) &&
    (left.liquidityBucket ?? null) === (right.liquidityBucket ?? null)
  );
}

function buildEvidenceStats(scopedCases: LearningCase[]): EvidenceStats {
  let thesisFailureCount = 0;
  let negativePnlCount = 0;
  let helpfulConfirmationCount = 0;
  let helpfulCooldownCount = 0;
  const qualityScores: number[] = [];
  const failureModeCounts = new Map<string, number>();
  const cooldownMinutes: number[] = [];
  const leverageOnLoss: number[] = [];

  for (const learningCase of scopedCases) {
    const outcome = learningCase.outcome ?? {};
    const thesisCorrect = toBooleanOrNull(outcome.thesisCorrect);
    if (thesisCorrect === false) {
      thesisFailureCount += 1;
    }
    const netPnl = toFiniteNumberOrNull(outcome.netRealizedPnlUsd ?? outcome.realizedPnlUsd);
    if (netPnl != null && netPnl < 0) {
      negativePnlCount += 1;
      const leverage = toFiniteNumberOrNull(learningCase.action?.leverage);
      if (leverage != null) {
        leverageOnLoss.push(leverage);
      }
    }
    const quality = extractCompositeQualityScore(learningCase);
    if (quality != null) {
      qualityScores.push(quality);
    }
    if (extractHelpfulConfirmation(learningCase)) {
      helpfulConfirmationCount += 1;
    }
    const cooldown = extractHelpfulCooldown(learningCase);
    if (cooldown.helpful) {
      helpfulCooldownCount += 1;
    }
    if (cooldown.cooldownMinutes != null) {
      cooldownMinutes.push(cooldown.cooldownMinutes);
    }
    const failureMode = extractFailureMode(learningCase);
    if (failureMode) {
      failureModeCounts.set(failureMode, (failureModeCounts.get(failureMode) ?? 0) + 1);
    }
  }

  let dominantFailureMode: string | null = null;
  let dominantFailureModeCount = -1;
  for (const [failureMode, count] of failureModeCounts.entries()) {
    if (count > dominantFailureModeCount) {
      dominantFailureMode = failureMode;
      dominantFailureModeCount = count;
    }
  }

  return {
    evidenceCount: scopedCases.length,
    thesisFailureCount,
    thesisFailureRate: scopedCases.length > 0 ? thesisFailureCount / scopedCases.length : 0,
    negativePnlCount,
    negativePnlRate: scopedCases.length > 0 ? negativePnlCount / scopedCases.length : 0,
    averageQualityScore:
      qualityScores.length > 0
        ? qualityScores.reduce((sum, value) => sum + value, 0) / qualityScores.length
        : null,
    helpfulConfirmationCount,
    helpfulCooldownCount,
    suggestedCooldownMinutes:
      cooldownMinutes.length > 0
        ? Math.max(...cooldownMinutes)
        : null,
    dominantFailureMode,
    averageLeverageOnLoss:
      leverageOnLoss.length > 0
        ? leverageOnLoss.reduce((sum, value) => sum + value, 0) / leverageOnLoss.length
        : null,
  };
}

export function deriveTradePolicyAdjustments(
  config: ThufirConfig,
  scopedCases: LearningCase[],
  _scope?: TradePolicyAdjustmentScope
): PolicyAdjustmentDerivation[] {
  const policyConfig = (config.autonomy as Record<string, unknown> | undefined)?.tradePolicyAdjustments as
    | Record<string, unknown>
    | undefined;
  const minSamples = Math.max(1, Math.floor(Number(policyConfig?.minSamples ?? 3)));
  if (scopedCases.length < minSamples) {
    return [];
  }

  const stats = buildEvidenceStats(scopedCases);
  const blockFailureRate = Number(policyConfig?.blockOnThesisFailureRatio ?? 0.8);
  const downweightFailureRate = Number(policyConfig?.downweightOnThesisFailureRatio ?? 0.5);
  const downweightNegativePnlRate = Number(policyConfig?.downweightOnNegativePnlRatio ?? 0.6);
  const blockBelowScore = Number(policyConfig?.blockBelowScore ?? 0.35);
  const downweightBelowScore = Number(policyConfig?.downweightBelowScore ?? 0.55);
  const downweightMultiplier = clamp(Number(policyConfig?.downweightMultiplier ?? 0.5), 0.05, 1);
  const leverageCapTrigger = Number(policyConfig?.leverageCapOnNegativePnlRatio ?? 0.7);
  const cooldownMinSamples = Math.max(2, Math.floor(Number(policyConfig?.cooldownMinSamples ?? 2)));
  const confirmationMinSamples = Math.max(2, Math.floor(Number(policyConfig?.confirmationMinSamples ?? 2)));

  const evidencePayload = {
    evidenceCount: stats.evidenceCount,
    thesisFailureRate: stats.thesisFailureRate,
    negativePnlRate: stats.negativePnlRate,
    averageQualityScore: stats.averageQualityScore,
    helpfulConfirmationCount: stats.helpfulConfirmationCount,
    helpfulCooldownCount: stats.helpfulCooldownCount,
    dominantFailureMode: stats.dominantFailureMode,
    averageLeverageOnLoss: stats.averageLeverageOnLoss,
  };

  const adjustments: PolicyAdjustmentDerivation[] = [];

  if (
    stats.helpfulConfirmationCount >= confirmationMinSamples &&
    stats.thesisFailureRate >= downweightFailureRate
  ) {
    adjustments.push({
      policyKey: 'confirmation',
      action: 'require_confirmation',
      sizeMultiplier: 1,
      confirmationRequired: true,
      confidence: clamp(stats.helpfulConfirmationCount / stats.evidenceCount, 0, 1),
      evidenceCount: stats.evidenceCount,
      thesisFailureRate: stats.thesisFailureRate,
      negativePnlRate: stats.negativePnlRate,
      averageQualityScore: stats.averageQualityScore,
      rationale: `confirmation required after ${stats.helpfulConfirmationCount}/${stats.evidenceCount} helpful gate interventions`,
      evidencePayload,
    });
  }

  if (
    stats.dominantFailureMode &&
    stats.helpfulCooldownCount >= cooldownMinSamples &&
    stats.negativePnlRate >= downweightNegativePnlRate
  ) {
    const cooldownMinutes = Math.max(15, Math.floor(stats.suggestedCooldownMinutes ?? 30));
    adjustments.push({
      policyKey: 'cooldown',
      action: 'cooldown',
      sizeMultiplier: 1,
      cooldownMinutes,
      confidence: clamp(stats.helpfulCooldownCount / stats.evidenceCount, 0, 1),
      evidenceCount: stats.evidenceCount,
      thesisFailureRate: stats.thesisFailureRate,
      negativePnlRate: stats.negativePnlRate,
      averageQualityScore: stats.averageQualityScore,
      rationale: `cooldown ${cooldownMinutes}m for repeated failure mode ${stats.dominantFailureMode}`,
      evidencePayload: {
        ...evidencePayload,
        failureMode: stats.dominantFailureMode,
      },
    });
  }

  if (
    stats.averageLeverageOnLoss != null &&
    stats.negativePnlRate >= leverageCapTrigger &&
    stats.averageLeverageOnLoss >= 3
  ) {
    const leverageCap = Math.max(1, Math.floor(stats.averageLeverageOnLoss - 1));
    adjustments.push({
      policyKey: 'leverage',
      action: 'cap_leverage',
      sizeMultiplier: 1,
      leverageCap,
      confidence: clamp(stats.negativePnlRate, 0, 1),
      evidenceCount: stats.evidenceCount,
      thesisFailureRate: stats.thesisFailureRate,
      negativePnlRate: stats.negativePnlRate,
      averageQualityScore: stats.averageQualityScore,
      rationale: `cap leverage at ${leverageCap}x after repeated losses at avg ${stats.averageLeverageOnLoss.toFixed(2)}x`,
      evidencePayload,
    });
  }

  if (
    stats.thesisFailureRate >= blockFailureRate ||
    (stats.averageQualityScore != null && stats.averageQualityScore <= blockBelowScore)
  ) {
    adjustments.push({
      policyKey: 'size',
      action: 'block',
      sizeMultiplier: 0,
      confidence: Math.max(
        stats.thesisFailureRate,
        stats.averageQualityScore == null ? 0 : 1 - stats.averageQualityScore
      ),
      evidenceCount: stats.evidenceCount,
      thesisFailureRate: stats.thesisFailureRate,
      negativePnlRate: stats.negativePnlRate,
      averageQualityScore: stats.averageQualityScore,
      rationale:
        stats.averageQualityScore != null && stats.averageQualityScore <= blockBelowScore
          ? `blocked after ${stats.evidenceCount} closes: average_quality=${stats.averageQualityScore.toFixed(2)}`
          : `blocked after ${stats.evidenceCount} closes: thesis_failure_rate=${stats.thesisFailureRate.toFixed(2)}`,
      evidencePayload,
    });
    return adjustments;
  }

  if (
    stats.thesisFailureRate >= downweightFailureRate ||
    stats.negativePnlRate >= downweightNegativePnlRate ||
    (stats.averageQualityScore != null && stats.averageQualityScore < downweightBelowScore)
  ) {
    adjustments.push({
      policyKey: 'size',
      action: 'downweight',
      sizeMultiplier: downweightMultiplier,
      confidence: Math.max(
        stats.thesisFailureRate,
        stats.negativePnlRate,
        stats.averageQualityScore == null ? 0 : 1 - stats.averageQualityScore
      ),
      evidenceCount: stats.evidenceCount,
      thesisFailureRate: stats.thesisFailureRate,
      negativePnlRate: stats.negativePnlRate,
      averageQualityScore: stats.averageQualityScore,
      rationale:
        stats.averageQualityScore != null && stats.averageQualityScore < downweightBelowScore
          ? `downweighted after ${stats.evidenceCount} closes: average_quality=${stats.averageQualityScore.toFixed(2)}`
          : `downweighted after ${stats.evidenceCount} closes: thesis_failure_rate=${stats.thesisFailureRate.toFixed(2)} negative_pnl_rate=${stats.negativePnlRate.toFixed(2)}`,
      evidencePayload,
    });
  }

  return adjustments;
}

export function deriveTradePolicyAdjustment(
  config: ThufirConfig,
  scopedCases: LearningCase[]
): PolicyAdjustmentDerivation | null {
  return deriveTradePolicyAdjustments(config, scopedCases)[0] ?? null;
}

export function materializeTradePolicyAdjustmentFromLearningCase(params: {
  config: ThufirConfig;
  learningCase: LearningCase;
}): TradePolicyAdjustmentRecord | null {
  const enabled =
    ((params.config.autonomy as Record<string, unknown> | undefined)?.tradePolicyAdjustments as
      | Record<string, unknown>
      | undefined)?.enabled !== false;
  if (!enabled || params.learningCase.caseType !== 'execution_quality' || params.learningCase.domain !== 'perp') {
    return null;
  }

  const scope = scopeFromLearningCase(params.learningCase);
  if (!scope.signalClass && !scope.triggerReason && !scope.marketRegime) {
    return null;
  }

  const recentCases = listLearningCases({
    caseType: 'execution_quality',
    domain: 'perp',
    limit: 200,
  }).filter((candidate) => sameScope(scopeFromLearningCase(candidate), scope));

  const derived = deriveTradePolicyAdjustments(params.config, recentCases, scope);
  if (derived.length === 0) {
    deactivateTradePolicyAdjustmentsForScope('perp', scope);
    return null;
  }

  let lastRecord: TradePolicyAdjustmentRecord | null = null;
  for (const adjustment of derived) {
    lastRecord = replaceActiveTradePolicyAdjustment({
      domain: 'perp',
      ...scope,
      ...adjustment,
      sourceLearningCaseId: params.learningCase.id,
      sourceTradeId: params.learningCase.sourceTradeId ?? null,
      evidencePayload: {
        ...(adjustment.evidencePayload ?? {}),
        sourceLearningCaseId: params.learningCase.id,
      },
      expiresAt:
        adjustment.action === 'cooldown' && adjustment.cooldownMinutes != null
          ? new Date(Date.now() + adjustment.cooldownMinutes * 60_000).toISOString()
          : null,
      active: true,
    });
  }

  return lastRecord;
}
