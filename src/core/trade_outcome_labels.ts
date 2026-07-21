/**
 * Independent trade outcome labels — label schema v2.
 *
 * Pure, deterministic derivation of lifecycle outcome labels per the v2.6
 * canonical trade learning TDD ("Label Semantics"). Replaces the conflated
 * `thesisCorrect` boolean and the unit-dependent sizing score in
 * `decision_component_scores.ts`. This module has no I/O and no DB access;
 * the close finalizer wires it in a later task.
 *
 * Label independence contract:
 * - `directionOutcome` is derived ONLY from the entry side and the declared
 *   horizon price-path evidence. It is never inferred from invalidation
 *   flags or exit mode.
 * - `processCompliant` is a deterministic policy trace, independent of PnL.
 * - A compliant planned stop is expressible as `processCompliant=true`,
 *   `directionOutcome='incorrect'`, `profitableAfterCosts=false`.
 */

import type { InvalidationType } from './trade_contract.js';

export const LABEL_SCHEMA_VERSION = 'v2';

export type EntrySide = 'buy' | 'sell';
export type DirectionOutcome = 'correct' | 'incorrect' | 'unresolved';
export type ComplianceCheckResult = 'pass' | 'fail' | 'unknown';

export interface PathObservation {
  timestampMs: number;
  price: number;
}

export interface TradeOutcomeLabelInput {
  entrySide: EntrySide;
  entryPrice: number | null;
  exitPrice?: number | null;
  entryAtMs?: number | null;
  exitAtMs?: number | null;

  /** Canonical net PnL (gross - entry fees - close fees - funding). */
  canonicalNetPnlUsd?: number | null;

  // Declared exit contract (immutable at entry).
  invalidationType?: InvalidationType | null;
  invalidationPrice?: number | null;
  timeStopAtMs?: number | null;
  /** Declared thesis horizon end (thesis_expires_at, falling back to the time stop). */
  horizonEndMs?: number | null;

  // Price-path evidence. Prefer the observation series; the summary fields
  // are a fallback for callers that only persist extremes.
  pathObservations?: PathObservation[] | null;
  /** Holding-period (entry -> exit) high. Summary fallback. */
  pathHigh?: number | null;
  /** Holding-period (entry -> exit) low. Summary fallback. */
  pathLow?: number | null;
  /** Observed price at the declared horizon end. Summary fallback. */
  horizonEndPrice?: number | null;

  // Exit facts. Used only for process compliance, never for direction.
  exitMode?: string | null;

  // Gate-approval trace for process compliance.
  approvedMaxSize?: number | null;
  effectiveSize?: number | null;
  approvedMaxLeverage?: number | null;
  effectiveLeverage?: number | null;
  contractMutatedAfterEntry?: boolean | null;

  // Risk sizing. `effectiveRiskUsd` may be supplied directly; otherwise it
  // is derived from effective size and the price-level invalidation distance.
  riskBudgetUsd?: number | null;
  effectiveRiskUsd?: number | null;
}

export interface ProcessComplianceTrace {
  sizeWithinApproval: ComplianceCheckResult;
  leverageWithinApproval: ComplianceCheckResult;
  exitWithinTimeStop: ComplianceCheckResult;
  exitConsistentWithContract: ComplianceCheckResult;
  contractUnchangedAfterEntry: ComplianceCheckResult;
}

export interface TradeOutcomeLabels {
  labelSchemaVersion: typeof LABEL_SCHEMA_VERSION;
  profitableAfterCosts: boolean | null;
  directionOutcome: DirectionOutcome;
  thesisInvalidationHit: boolean | null;
  processCompliant: boolean | null;
  processComplianceTrace: ProcessComplianceTrace;
  timingScore: number | null;
  sizingScore: number | null;
  exitScore: number | null;
  netR: number | null;
  /** Machine-readable reason why netR is null (policy-evidence ineligibility). */
  ineligibleReason: string | null;
  /** Canonical JSON (recursively sorted keys) of the labels, suitable for hashing. */
  deterministicPayload: string;
}

/** Exit-score penalty applied when the exit breached the declared contract. */
const NON_COMPLIANT_EXIT_MULTIPLIER = 0.5;

function toFinite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositive(value: unknown): number | null {
  const parsed = toFinite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Snaps floating-point residue (e.g. from `1 - 0.8`) to a stable precision. */
function roundScore(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** Canonical JSON with recursively sorted object keys, for stable hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',');
  return `{${body}}`;
}

interface ResolvedPathEvidence {
  holdingHigh: number | null;
  holdingLow: number | null;
  horizonEndPrice: number | null;
}

function resolvePathEvidence(input: TradeOutcomeLabelInput): ResolvedPathEvidence {
  const observations = (input.pathObservations ?? [])
    .filter((obs) => Number.isFinite(obs?.timestampMs) && toPositive(obs?.price) != null)
    .slice()
    .sort((a, b) => a.timestampMs - b.timestampMs);

  let holdingHigh: number | null = null;
  let holdingLow: number | null = null;
  let horizonEndPrice: number | null = null;

  if (observations.length > 0) {
    const holdingStart = toFinite(input.entryAtMs) ?? Number.NEGATIVE_INFINITY;
    const holdingEnd = toFinite(input.exitAtMs) ?? Number.POSITIVE_INFINITY;
    const holding = observations.filter(
      (obs) => obs.timestampMs >= holdingStart && obs.timestampMs <= holdingEnd
    );
    if (holding.length > 0) {
      holdingHigh = Math.max(...holding.map((obs) => obs.price));
      holdingLow = Math.min(...holding.map((obs) => obs.price));
    }

    const horizonEndMs = toFinite(input.horizonEndMs);
    // Non-null: guarded by `observations.length > 0` above.
    const lastObservation = observations[observations.length - 1]!;
    // The horizon is resolved only when the series actually covers its end;
    // a series that stops early is absent evidence, not a resolution.
    if (horizonEndMs != null && lastObservation.timestampMs >= horizonEndMs) {
      const atOrBefore = observations.filter((obs) => obs.timestampMs <= horizonEndMs);
      horizonEndPrice =
        atOrBefore.length > 0
          ? atOrBefore[atOrBefore.length - 1]!.price
          : observations[0]!.price;
    }
  }

  holdingHigh ??= toPositive(input.pathHigh);
  holdingLow ??= toPositive(input.pathLow);
  horizonEndPrice ??= toPositive(input.horizonEndPrice);

  return { holdingHigh, holdingLow, horizonEndPrice };
}

function resolveDirectionOutcome(
  entrySide: EntrySide,
  entryPrice: number | null,
  horizonEndPrice: number | null
): DirectionOutcome {
  if (entryPrice == null || horizonEndPrice == null) return 'unresolved';
  const favorableMove =
    entrySide === 'buy' ? horizonEndPrice - entryPrice : entryPrice - horizonEndPrice;
  return favorableMove > 0 ? 'correct' : 'incorrect';
}

function resolveThesisInvalidationHit(
  input: TradeOutcomeLabelInput,
  entryPrice: number | null,
  evidence: ResolvedPathEvidence
): boolean | null {
  if (input.invalidationType !== 'price_level') return null;
  const invalidationPrice = toPositive(input.invalidationPrice);
  if (invalidationPrice == null || entryPrice == null) return null;
  if (input.entrySide === 'buy') {
    if (evidence.holdingLow == null) return null;
    return evidence.holdingLow <= invalidationPrice;
  }
  if (evidence.holdingHigh == null) return null;
  return evidence.holdingHigh >= invalidationPrice;
}

function resolveProcessCompliance(
  input: TradeOutcomeLabelInput,
  thesisInvalidationHit: boolean | null
): { processCompliant: boolean | null; trace: ProcessComplianceTrace } {
  const effectiveSize = toPositive(input.effectiveSize);
  const approvedMaxSize = toPositive(input.approvedMaxSize);
  const sizeWithinApproval: ComplianceCheckResult =
    effectiveSize == null || approvedMaxSize == null
      ? 'unknown'
      : effectiveSize <= approvedMaxSize
        ? 'pass'
        : 'fail';

  const effectiveLeverage = toPositive(input.effectiveLeverage);
  const approvedMaxLeverage = toPositive(input.approvedMaxLeverage);
  const leverageWithinApproval: ComplianceCheckResult =
    effectiveLeverage == null || approvedMaxLeverage == null
      ? 'unknown'
      : effectiveLeverage <= approvedMaxLeverage
        ? 'pass'
        : 'fail';

  const exitAtMs = toFinite(input.exitAtMs);
  const timeStopAtMs = toFinite(input.timeStopAtMs);
  const exitWithinTimeStop: ComplianceCheckResult =
    exitAtMs == null || timeStopAtMs == null
      ? 'unknown'
      : exitAtMs <= timeStopAtMs
        ? 'pass'
        : 'fail';

  // Exit-mode consistency with the declared contract:
  // - a claimed invalidation exit must be corroborated by the observed path;
  // - a manual exit is a discretionary override of the declared contract.
  // Exit mode is admissible evidence here (compliance), never for direction.
  const exitMode = typeof input.exitMode === 'string' ? input.exitMode.trim() : null;
  let exitConsistentWithContract: ComplianceCheckResult;
  if (exitMode == null || exitMode === '' || exitMode === 'unknown') {
    exitConsistentWithContract = 'unknown';
  } else if (exitMode === 'manual') {
    exitConsistentWithContract = 'fail';
  } else if (exitMode === 'thesis_invalidation') {
    exitConsistentWithContract =
      thesisInvalidationHit == null ? 'unknown' : thesisInvalidationHit ? 'pass' : 'fail';
  } else {
    exitConsistentWithContract = 'pass';
  }

  const contractUnchangedAfterEntry: ComplianceCheckResult =
    input.contractMutatedAfterEntry == null
      ? 'unknown'
      : input.contractMutatedAfterEntry
        ? 'fail'
        : 'pass';

  const trace: ProcessComplianceTrace = {
    sizeWithinApproval,
    leverageWithinApproval,
    exitWithinTimeStop,
    exitConsistentWithContract,
    contractUnchangedAfterEntry,
  };

  const results = Object.values(trace);
  const processCompliant = results.includes('fail')
    ? false
    : results.every((result) => result === 'unknown')
      ? null
      : true;

  return { processCompliant, trace };
}

function resolveTimingScore(
  input: TradeOutcomeLabelInput,
  entryPrice: number | null,
  exitPrice: number | null,
  evidence: ResolvedPathEvidence
): number | null {
  if (entryPrice == null) return null;
  if (evidence.holdingHigh == null && evidence.holdingLow == null && exitPrice == null) {
    return null;
  }
  const high = Math.max(
    entryPrice,
    evidence.holdingHigh ?? entryPrice,
    evidence.holdingLow ?? entryPrice,
    exitPrice ?? entryPrice
  );
  const low = Math.min(
    entryPrice,
    evidence.holdingHigh ?? entryPrice,
    evidence.holdingLow ?? entryPrice,
    exitPrice ?? entryPrice
  );
  const range = high - low;
  if (range <= 0) return null;
  return clamp01(
    input.entrySide === 'buy' ? (high - entryPrice) / range : (entryPrice - low) / range
  );
}

function resolveExitScore(
  input: TradeOutcomeLabelInput,
  entryPrice: number | null,
  exitPrice: number | null,
  evidence: ResolvedPathEvidence,
  trace: ProcessComplianceTrace
): number | null {
  if (entryPrice == null || exitPrice == null) return null;
  if (evidence.holdingHigh == null && evidence.holdingLow == null) return null;
  const high = Math.max(
    entryPrice,
    evidence.holdingHigh ?? entryPrice,
    evidence.holdingLow ?? entryPrice,
    exitPrice
  );
  const low = Math.min(
    entryPrice,
    evidence.holdingHigh ?? entryPrice,
    evidence.holdingLow ?? entryPrice,
    exitPrice
  );
  const availableMove = input.entrySide === 'buy' ? high - entryPrice : entryPrice - low;
  if (availableMove <= 0) return null;
  const capturedMove =
    input.entrySide === 'buy' ? exitPrice - entryPrice : entryPrice - exitPrice;
  // Captured/attainable is scale-invariant: dividing both by risk-per-unit
  // yields the same fraction, so this is the risk-adjusted capture fraction.
  const baseScore = clamp01(capturedMove / availableMove);
  const exitContractBreached =
    trace.exitWithinTimeStop === 'fail' || trace.exitConsistentWithContract === 'fail';
  return exitContractBreached ? baseScore * NON_COMPLIANT_EXIT_MULTIPLIER : baseScore;
}

function resolveEffectiveRiskUsd(
  input: TradeOutcomeLabelInput,
  entryPrice: number | null
): number | null {
  const direct = toPositive(input.effectiveRiskUsd);
  if (direct != null) return direct;
  const effectiveSize = toPositive(input.effectiveSize);
  const invalidationPrice = toPositive(input.invalidationPrice);
  if (
    input.invalidationType !== 'price_level' ||
    effectiveSize == null ||
    invalidationPrice == null ||
    entryPrice == null
  ) {
    return null;
  }
  const riskPerUnit = Math.abs(entryPrice - invalidationPrice);
  if (riskPerUnit <= 0) return null;
  return effectiveSize * riskPerUnit;
}

function resolveSizingScore(
  effectiveRiskUsd: number | null,
  riskBudgetUsd: number | null
): number | null {
  if (effectiveRiskUsd == null || riskBudgetUsd == null) return null;
  const ratio = roundScore(effectiveRiskUsd / riskBudgetUsd);
  // Peaks at 1.0 whenever effective risk is within the approved budget;
  // degrades linearly (proportionally) as effective risk exceeds it.
  return ratio <= 1 ? 1 : clamp01(roundScore(2 - ratio));
}

function hasInvalidationContract(input: TradeOutcomeLabelInput): boolean {
  if (input.invalidationType === 'structure_break') return true;
  if (input.invalidationType === 'price_level') {
    return toPositive(input.invalidationPrice) != null;
  }
  return false;
}

export function computeTradeOutcomeLabels(input: TradeOutcomeLabelInput): TradeOutcomeLabels {
  const entryPrice = toPositive(input.entryPrice);
  const exitPrice = toPositive(input.exitPrice);
  const canonicalNetPnlUsd = toFinite(input.canonicalNetPnlUsd);

  const evidence = resolvePathEvidence(input);

  const profitableAfterCosts = canonicalNetPnlUsd == null ? null : canonicalNetPnlUsd > 0;
  const directionOutcome = resolveDirectionOutcome(
    input.entrySide,
    entryPrice,
    evidence.horizonEndPrice
  );
  const thesisInvalidationHit = resolveThesisInvalidationHit(input, entryPrice, evidence);
  const { processCompliant, trace } = resolveProcessCompliance(input, thesisInvalidationHit);

  const timingScore = resolveTimingScore(input, entryPrice, exitPrice, evidence);
  const exitScore = resolveExitScore(input, entryPrice, exitPrice, evidence, trace);

  const riskBudgetUsd = toPositive(input.riskBudgetUsd);
  const effectiveRiskUsd = resolveEffectiveRiskUsd(input, entryPrice);
  const sizingScore = resolveSizingScore(effectiveRiskUsd, riskBudgetUsd);

  let netR: number | null = null;
  let ineligibleReason: string | null = null;
  if (canonicalNetPnlUsd == null) {
    ineligibleReason = 'missing_canonical_net_pnl';
  } else if (riskBudgetUsd == null) {
    ineligibleReason = 'missing_risk_budget';
  } else if (!hasInvalidationContract(input)) {
    ineligibleReason = 'missing_invalidation_contract';
  } else {
    netR = canonicalNetPnlUsd / riskBudgetUsd;
  }

  const deterministicPayload = canonicalJson({
    label_schema_version: LABEL_SCHEMA_VERSION,
    profitable_after_costs: profitableAfterCosts,
    direction_outcome: directionOutcome,
    thesis_invalidation_hit: thesisInvalidationHit,
    process_compliant: processCompliant,
    process_compliance_trace: trace,
    timing_score: timingScore,
    sizing_score: sizingScore,
    exit_score: exitScore,
    net_r: netR,
    ineligible_reason: ineligibleReason,
  });

  return {
    labelSchemaVersion: LABEL_SCHEMA_VERSION,
    profitableAfterCosts,
    directionOutcome,
    thesisInvalidationHit,
    processCompliant,
    processComplianceTrace: trace,
    timingScore,
    sizingScore,
    exitScore,
    netR,
    ineligibleReason,
    deterministicPayload,
  };
}
