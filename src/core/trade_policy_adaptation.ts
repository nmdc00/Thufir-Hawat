import type {
  TradePolicyAdjustment,
  TradePolicyAdjustmentValue,
} from '../memory/trade_policy_adjustments.js';

export interface TradePolicyAdjustmentEvidence {
  setupFamily?: string | null;
  regime?: string | null;
  failureMode?: string | null;
  gateHelped?: boolean | null;
  win?: boolean | null;
  netRealizedPnlUsd?: number | null;
  sampleWeight?: number | null;
}

export interface TradePolicyAdjustmentProposal {
  policyDomain: 'size' | 'leverage' | 'confirmation' | 'cooldown' | 'confidence';
  policyKey: string;
  adjustmentType: 'set' | 'scale' | 'flag';
  oldValue: TradePolicyAdjustmentValue;
  newValue: TradePolicyAdjustmentValue;
  delta: number | null;
  evidenceCount: number;
  confidence: number;
  reasonSummary: string;
}

export interface RuntimeTradePolicyAdjustment extends TradePolicyAdjustmentProposal {
  id: string;
  scope: Record<string, unknown> | null;
}

export interface TradePolicyAdjustmentRuntimeContext {
  symbol?: string | null;
  direction?: 'long' | 'short' | null;
  strategySource?: string | null;
  triggerReason?: string | null;
  signalClass?: string | null;
  regime?: string | null;
  symbolClass?: string | null;
  session?: string | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeScopeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function valuesMatch(scopeValue: unknown, contextValue: string | boolean | null | undefined): boolean {
  if (scopeValue == null) return true;
  if (Array.isArray(scopeValue)) {
    return scopeValue.some((value) => valuesMatch(value, contextValue));
  }
  const scopeBoolean = readBoolean(scopeValue);
  if (scopeBoolean != null && typeof contextValue === 'boolean') {
    return scopeBoolean === contextValue;
  }
  const normalizedScope = normalizeScopeText(scopeValue);
  const normalizedContext =
    typeof contextValue === 'string' ? normalizeScopeText(contextValue) : contextValue ?? null;
  return normalizedScope != null && normalizedContext != null && normalizedScope === normalizedContext;
}

function resolveDominantFailureMode(evidence: TradePolicyAdjustmentEvidence[]): {
  failureMode: string | null;
  count: number;
} {
  const counts = new Map<string, number>();
  for (const row of evidence) {
    const normalized = row.failureMode?.trim().toLowerCase();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  let failureMode: string | null = null;
  let count = 0;
  for (const [key, value] of counts.entries()) {
    if (value > count || (value === count && key < (failureMode ?? key))) {
      failureMode = key;
      count = value;
    }
  }
  return { failureMode, count };
}

export function filterActionableTradePolicyAdjustments<T extends TradePolicyAdjustmentProposal & { id?: string | null }>(
  adjustments: T[]
): T[] {
  return adjustments.filter((adjustment) => {
    const evidenceCount = adjustment.evidenceCount ?? 0;
    const confidence = adjustment.confidence ?? 0;

    switch (adjustment.policyDomain) {
      case 'size':
        return (
          typeof adjustment.newValue === 'number' &&
          Number.isFinite(adjustment.newValue) &&
          evidenceCount >= 3 &&
          confidence >= 0.25 &&
          adjustment.newValue >= 0.55 &&
          adjustment.newValue <= 0.95
        );
      case 'leverage':
        return (
          typeof adjustment.newValue === 'number' &&
          Number.isFinite(adjustment.newValue) &&
          adjustment.newValue > 0 &&
          evidenceCount >= 2 &&
          confidence >= 0.25
        );
      case 'confirmation':
        return evidenceCount >= 2 && confidence >= 0.25 && adjustment.newValue !== false;
      case 'confidence':
        return (
          typeof adjustment.newValue === 'number' &&
          Number.isFinite(adjustment.newValue) &&
          evidenceCount >= 3 &&
          confidence >= 0.25 &&
          adjustment.newValue >= 0.1 &&
          adjustment.newValue <= 0.45
        );
      case 'cooldown':
        return evidenceCount >= 5 && confidence >= 0.6 && adjustment.newValue !== false;
      default:
        return false;
    }
  });
}

export function selectRuntimeTradePolicyAdjustments(
  adjustments: TradePolicyAdjustment[],
  context: TradePolicyAdjustmentRuntimeContext,
  now = new Date()
): RuntimeTradePolicyAdjustment[] {
  const nowMs = now.getTime();
  const matched = adjustments
    .filter((row) => row.active)
    .filter((row) => {
      if (!row.expiresAt) return true;
      const expiresAtMs = Date.parse(row.expiresAt);
      return Number.isNaN(expiresAtMs) || expiresAtMs > nowMs;
    })
    .filter((row) =>
      valuesMatch(row.scope?.symbol, context.symbol) &&
      valuesMatch(row.scope?.direction, context.direction) &&
      valuesMatch(row.scope?.strategySource, context.strategySource) &&
      valuesMatch(row.scope?.triggerReason, context.triggerReason) &&
      valuesMatch(row.scope?.signalClass, context.signalClass) &&
      valuesMatch(row.scope?.regime, context.regime) &&
      valuesMatch(row.scope?.symbolClass, context.symbolClass) &&
      valuesMatch(row.scope?.session, context.session)
    )
    .map((row) => {
      const policyDomain = row.policyDomain;
      if (
        policyDomain !== 'size' &&
        policyDomain !== 'leverage' &&
        policyDomain !== 'confirmation' &&
        policyDomain !== 'cooldown' &&
        policyDomain !== 'confidence'
      ) {
        return null;
      }
      return {
        id: row.id,
        scope: row.scope,
        policyDomain,
        policyKey: row.policyKey,
        adjustmentType:
          row.adjustmentType === 'set' || row.adjustmentType === 'scale' || row.adjustmentType === 'flag'
            ? row.adjustmentType
            : 'set',
        oldValue: row.oldValue,
        newValue: row.newValue,
        delta: row.delta,
        evidenceCount: row.evidenceCount ?? 0,
        confidence: row.confidence ?? 0,
        reasonSummary: row.reasonSummary ?? '',
      } satisfies RuntimeTradePolicyAdjustment;
    })
    .filter(Boolean) as RuntimeTradePolicyAdjustment[];

  return matched;
}

export function deriveTradePolicyAdjustments(
  evidence: TradePolicyAdjustmentEvidence[]
): TradePolicyAdjustmentProposal[] {
  if (evidence.length === 0) return [];
  const weightedCount = evidence.reduce((sum, row) => sum + Math.max(0.5, row.sampleWeight ?? 1), 0);
  const losses = evidence.filter((row) => row.win === false).length;
  const wins = evidence.filter((row) => row.win === true).length;
  const gateHelpCount = evidence.filter((row) => row.gateHelped === true).length;
  const dominantFailureMode = resolveDominantFailureMode(evidence);
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0.5;
  const confidence = clamp(weightedCount / 8, 0.25, 0.95);
  const rows: TradePolicyAdjustmentProposal[] = [];

  if (weightedCount >= 3 && winRate < 0.45) {
    const sizeMultiplier = clamp(0.85 - (0.45 - winRate), 0.55, 0.85);
    rows.push({
      policyDomain: 'size',
      policyKey: 'setup_family_max_size',
      adjustmentType: 'scale',
      oldValue: 1,
      newValue: sizeMultiplier,
      delta: sizeMultiplier - 1,
      evidenceCount: evidence.length,
      confidence,
      reasonSummary: 'Recent evidence shows the setup family underperforming; reduce size.'
    });
    rows.push({
      policyDomain: 'confidence',
      policyKey: 'sparse_precedent_penalty',
      adjustmentType: 'set',
      oldValue: 0,
      newValue: clamp(0.2 + (0.45 - winRate), 0.2, 0.45),
      delta: null,
      evidenceCount: evidence.length,
      confidence,
      reasonSummary: 'Weak historical support should reduce confidence in similar trades.'
    });
  }

  if (gateHelpCount >= 2) {
    rows.push({
      policyDomain: 'confirmation',
      policyKey: 'gate_intervention_prior',
      adjustmentType: 'flag',
      oldValue: false,
      newValue: true,
      delta: null,
      evidenceCount: evidence.length,
      confidence,
      reasonSummary: 'Historical gate interventions added value and should remain active.'
    });
  }

  if (
    dominantFailureMode.failureMode &&
    dominantFailureMode.count >= 3 &&
    weightedCount >= 5 &&
    losses >= 3 &&
    winRate < 0.4
  ) {
    rows.push({
      policyDomain: 'cooldown',
      policyKey: `failure_mode:${dominantFailureMode.failureMode}`,
      adjustmentType: 'flag',
      oldValue: false,
      newValue: true,
      delta: null,
      evidenceCount: evidence.length,
      confidence: clamp(confidence - 0.1, 0.2, 0.95),
      reasonSummary: 'Repeated failure mode detected; apply a cooldown until new evidence arrives.'
    });
  }

  return rows;
}
