/**
 * Learning eligibility — shared gate for the v2.6 canonical trade learning
 * pipeline ("Eligibility and Historical Data").
 *
 * Pure, deterministic evaluation of whether a closed lifecycle may be used
 * as training/evidence input to policy materialization, adaptive edge,
 * prediction baselines, signal-weight training, counterfactual evaluation,
 * and dashboards. This module has no I/O and no DB access; the close
 * finalizer (a later task) maps its own row shape onto `EligibilityInput`
 * and persists `eligible` / `ineligibilityReasons` onto `trade_closes`.
 *
 * A close is eligible only when all six rules pass. Rules do not
 * short-circuit: a row that fails multiple rules reports every applicable
 * reason so operators can see all quarantine causes at once, not just the
 * first one encountered.
 */

export type ExecutionMode = 'paper' | 'live';

/**
 * Provenance of the close row. Only `'normal'` lifecycles are eligible.
 * Positions already open when v2.6 deploys have no entry context and
 * finalize as bootstrap lifecycles (`perp:<symbol>:bootstrap:*`) — they are
 * permanently quarantined under rule 6, not backfilled.
 */
export type LearningSourceKind = 'normal' | 'bootstrap' | 'manual_repair' | 'test_probe' | 'duplicate';

export type IneligibilityReason =
  | 'before_clean_data_cutoff'
  | 'missing_lifecycle_linkage'
  | 'pnl_reconciliation_failure'
  | 'missing_label_inputs'
  | 'unsupported_schema_version'
  | 'bootstrap_lifecycle'
  | 'manual_repair'
  | 'test_probe'
  | 'duplicate';

/**
 * Currently supported accounting schema versions. Accounting is versioned
 * independently of labels (see `perp_close_accounting.ts`,
 * `ACCOUNTING_SCHEMA_VERSION = 'v1'`); this set grows only when a new
 * accounting schema version ships and is proven readable.
 */
export const SUPPORTED_ACCOUNTING_SCHEMA_VERSIONS: ReadonlySet<number | string> = new Set(['v1']);

/**
 * Currently supported label schema versions (see `trade_outcome_labels.ts`,
 * `LABEL_SCHEMA_VERSION = 'v2'`). Legacy `thesis_correct`-derived rows are
 * not policy evidence under label schema v2 and must not be admitted here.
 */
export const SUPPORTED_LABEL_SCHEMA_VERSIONS: ReadonlySet<string> = new Set(['v2']);

export interface LearningEligibilityConfig {
  /** ISO date/timestamp; closes at or before this are excluded (rule 1). */
  cleanDataCutoff: string;
  /** USD tolerance for authority-vs-canonical PnL reconciliation (rule 3). */
  reconciliationPrecisionUsd: number;
}

/**
 * Fields a caller's own close row must be mapped onto to evaluate the six
 * eligibility rules. Deliberately decoupled from any persisted row type —
 * a future finalizer maps its DB row onto this shape.
 */
export interface EligibilityInput {
  /** ISO timestamp of the terminal close event. */
  closedAtIso: string;

  // Rule 2: entry context, lifecycle ID, fills, and terminal close linkage.
  entryContextId: string | null;
  lifecycleId: string | null;
  hasLinkedFills: boolean;
  hasTerminalClose: boolean;

  // Rule 3: mode-appropriate authority vs. canonical PnL reconciliation.
  // Paper mode: paper-book realized delta. Live mode: aggregated fill
  // authority. `authorityRealizedPnlUsd` carries whichever applies.
  executionMode: ExecutionMode;
  authorityRealizedPnlUsd: number | null;
  canonicalNetPnlUsd: number | null;

  // Rule 4: required label inputs (see `trade_outcome_labels.ts` input
  // contract) present on the row.
  requiredLabelInputsPresent: boolean;

  // Rule 5: accounting and label schema versions must both be supported.
  accountingSchemaVersion: number | string | null;
  labelSchemaVersion: string | null;

  // Rule 6: provenance. Anything other than 'normal' is permanently
  // quarantined.
  sourceKind: LearningSourceKind;
}

export interface LearningEligibilityResult {
  eligible: boolean;
  ineligibilityReasons: IneligibilityReason[];
}

function isBeforeCleanDataCutoff(closedAtIso: string, cleanDataCutoff: string): boolean {
  const closedAtMs = Date.parse(closedAtIso);
  const cutoffMs = Date.parse(cleanDataCutoff);
  // Unparseable or missing timestamps cannot be proven newer than the
  // cutoff, so they are treated as failing the check (fail closed).
  if (!Number.isFinite(closedAtMs) || !Number.isFinite(cutoffMs)) return true;
  return closedAtMs <= cutoffMs;
}

function hasLifecycleLinkage(input: EligibilityInput): boolean {
  return (
    typeof input.entryContextId === 'string' &&
    input.entryContextId.length > 0 &&
    typeof input.lifecycleId === 'string' &&
    input.lifecycleId.length > 0 &&
    input.hasLinkedFills === true &&
    input.hasTerminalClose === true
  );
}

function pnlReconciles(input: EligibilityInput, precisionUsd: number): boolean {
  if (input.authorityRealizedPnlUsd == null || input.canonicalNetPnlUsd == null) return false;
  if (!Number.isFinite(input.authorityRealizedPnlUsd) || !Number.isFinite(input.canonicalNetPnlUsd)) {
    return false;
  }
  const delta = Math.abs(input.authorityRealizedPnlUsd - input.canonicalNetPnlUsd);
  return delta <= precisionUsd;
}

function hasSupportedSchemaVersions(input: EligibilityInput): boolean {
  if (input.accountingSchemaVersion == null || !SUPPORTED_ACCOUNTING_SCHEMA_VERSIONS.has(input.accountingSchemaVersion)) {
    return false;
  }
  if (input.labelSchemaVersion == null || !SUPPORTED_LABEL_SCHEMA_VERSIONS.has(input.labelSchemaVersion)) {
    return false;
  }
  return true;
}

/**
 * Evaluates all six eligibility rules against a close. Rules never
 * short-circuit — every applicable reason is collected so a row can be seen
 * to have failed on, e.g., both schema version and PnL reconciliation.
 */
export function evaluateLearningEligibility(
  input: EligibilityInput,
  config: LearningEligibilityConfig
): LearningEligibilityResult {
  const reasons: IneligibilityReason[] = [];

  // Rule 1: newer than the clean data cutoff.
  if (isBeforeCleanDataCutoff(input.closedAtIso, config.cleanDataCutoff)) {
    reasons.push('before_clean_data_cutoff');
  }

  // Rule 2: entry context, lifecycle ID, fills, and terminal close linked.
  if (!hasLifecycleLinkage(input)) {
    reasons.push('missing_lifecycle_linkage');
  }

  // Rule 3: mode-appropriate authority and canonical PnL reconcile.
  if (!pnlReconciles(input, config.reconciliationPrecisionUsd)) {
    reasons.push('pnl_reconciliation_failure');
  }

  // Rule 4: required label inputs present.
  if (!input.requiredLabelInputsPresent) {
    reasons.push('missing_label_inputs');
  }

  // Rule 5: accounting and label schema versions are supported.
  if (!hasSupportedSchemaVersions(input)) {
    reasons.push('unsupported_schema_version');
  }

  // Rule 6: not a bootstrap, manual repair, test probe, or duplicate.
  // Bootstrap lifecycles (positions already open at v2.6 deploy) are
  // permanently quarantined — nobody reconstructs their context at close
  // time; that is the anti-pattern this pipeline removes.
  if (input.sourceKind === 'bootstrap') reasons.push('bootstrap_lifecycle');
  if (input.sourceKind === 'manual_repair') reasons.push('manual_repair');
  if (input.sourceKind === 'test_probe') reasons.push('test_probe');
  if (input.sourceKind === 'duplicate') reasons.push('duplicate');

  return { eligible: reasons.length === 0, ineligibilityReasons: reasons };
}

/**
 * Filters candidate rows down to eligible ones BEFORE truncating to
 * `limit`. Resolved evidence queries must filter eligibility before
 * applying a limit so blocked journal rows cannot crowd completed outcomes
 * out of a training window.
 */
export function filterEligibleThenLimit<T>(
  rows: T[],
  toInput: (row: T) => EligibilityInput,
  config: LearningEligibilityConfig,
  limit: number
): T[] {
  const eligibleRows = rows.filter((row) => evaluateLearningEligibility(toInput(row), config).eligible);
  return eligibleRows.slice(0, limit);
}
