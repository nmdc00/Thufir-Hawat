import { describe, expect, it } from 'vitest';

import {
  evaluateLearningEligibility,
  filterEligibleThenLimit,
  type EligibilityInput,
  type LearningEligibilityConfig,
} from '../../src/core/learning_eligibility.js';

const config: LearningEligibilityConfig = {
  cleanDataCutoff: '2026-06-13T00:00:00.000Z',
  reconciliationPrecisionUsd: 1e-8,
};

function baseInput(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    closedAtIso: '2026-07-01T00:00:00.000Z',
    entryContextId: 'ctx-1',
    lifecycleId: 'perp:BTC:1234',
    hasLinkedFills: true,
    hasTerminalClose: true,
    executionMode: 'paper',
    authorityRealizedPnlUsd: 10,
    canonicalNetPnlUsd: 10,
    requiredLabelInputsPresent: true,
    accountingSchemaVersion: 'v1',
    labelSchemaVersion: 'v2',
    sourceKind: 'normal',
    ...overrides,
  };
}

describe('evaluateLearningEligibility', () => {
  it('excludes closes before the clean data cutoff', () => {
    const before = evaluateLearningEligibility(
      baseInput({ closedAtIso: '2026-06-01T00:00:00.000Z' }),
      config
    );
    expect(before.eligible).toBe(false);
    expect(before.ineligibilityReasons).toContain('before_clean_data_cutoff');

    const atCutoff = evaluateLearningEligibility(
      baseInput({ closedAtIso: '2026-06-13T00:00:00.000Z' }),
      config
    );
    expect(atCutoff.eligible).toBe(false);
    expect(atCutoff.ineligibilityReasons).toContain('before_clean_data_cutoff');

    const after = evaluateLearningEligibility(
      baseInput({ closedAtIso: '2026-06-14T00:00:00.000Z' }),
      config
    );
    expect(after.eligible).toBe(true);
    expect(after.ineligibilityReasons).not.toContain('before_clean_data_cutoff');
  });

  it('quarantines missing entry context instead of fabricating context', () => {
    const result = evaluateLearningEligibility(baseInput({ entryContextId: null }), config);
    expect(result.eligible).toBe(false);
    expect(result.ineligibilityReasons).toContain('missing_lifecycle_linkage');

    // Missing lifecycle ID, unlinked fills, and no terminal close all trip
    // the same linkage rule — none of them should be silently backfilled.
    expect(
      evaluateLearningEligibility(baseInput({ lifecycleId: null }), config).ineligibilityReasons
    ).toContain('missing_lifecycle_linkage');
    expect(
      evaluateLearningEligibility(baseInput({ hasLinkedFills: false }), config).ineligibilityReasons
    ).toContain('missing_lifecycle_linkage');
    expect(
      evaluateLearningEligibility(baseInput({ hasTerminalClose: false }), config).ineligibilityReasons
    ).toContain('missing_lifecycle_linkage');
  });

  it('quarantines pnl reconciliation failures with explicit reasons', () => {
    const mismatched = evaluateLearningEligibility(
      baseInput({ authorityRealizedPnlUsd: 10, canonicalNetPnlUsd: 10.5 }),
      config
    );
    expect(mismatched.eligible).toBe(false);
    expect(mismatched.ineligibilityReasons).toContain('pnl_reconciliation_failure');

    const missingAuthority = evaluateLearningEligibility(
      baseInput({ authorityRealizedPnlUsd: null }),
      config
    );
    expect(missingAuthority.eligible).toBe(false);
    expect(missingAuthority.ineligibilityReasons).toContain('pnl_reconciliation_failure');

    // Within the configured USD precision reconciles cleanly.
    const withinPrecision = evaluateLearningEligibility(
      baseInput({ authorityRealizedPnlUsd: 10, canonicalNetPnlUsd: 10 + 1e-9 }),
      config
    );
    expect(withinPrecision.ineligibilityReasons).not.toContain('pnl_reconciliation_failure');

    // Live mode uses the same reconciliation rule against the aggregated
    // fill authority value.
    const liveMismatch = evaluateLearningEligibility(
      baseInput({ executionMode: 'live', authorityRealizedPnlUsd: 5, canonicalNetPnlUsd: 5.02 }),
      config
    );
    expect(liveMismatch.ineligibilityReasons).toContain('pnl_reconciliation_failure');
  });

  it('admits only supported accounting and label schema versions', () => {
    const badAccounting = evaluateLearningEligibility(
      baseInput({ accountingSchemaVersion: 'v0' }),
      config
    );
    expect(badAccounting.eligible).toBe(false);
    expect(badAccounting.ineligibilityReasons).toContain('unsupported_schema_version');

    const badLabel = evaluateLearningEligibility(baseInput({ labelSchemaVersion: 'v1' }), config);
    expect(badLabel.eligible).toBe(false);
    expect(badLabel.ineligibilityReasons).toContain('unsupported_schema_version');

    const missingBoth = evaluateLearningEligibility(
      baseInput({ accountingSchemaVersion: null, labelSchemaVersion: null }),
      config
    );
    expect(missingBoth.ineligibilityReasons).toContain('unsupported_schema_version');

    const supported = evaluateLearningEligibility(baseInput(), config);
    expect(supported.ineligibilityReasons).not.toContain('unsupported_schema_version');
    expect(supported.eligible).toBe(true);
  });

  it('filters eligible outcomes before limiting the result set', () => {
    type Row = { id: string; input: EligibilityInput };
    const rows: Row[] = [
      { id: 'blocked-1', input: baseInput({ requiredLabelInputsPresent: false }) },
      { id: 'eligible-1', input: baseInput() },
      { id: 'blocked-2', input: baseInput({ sourceKind: 'duplicate' }) },
      { id: 'eligible-2', input: baseInput() },
      { id: 'eligible-3', input: baseInput() },
    ];

    const limited = filterEligibleThenLimit(rows, (row) => row.input, config, 2);

    // If the limit were applied before filtering, blocked-1 and eligible-1
    // would win the first two slots and crowd out completed outcomes.
    expect(limited.map((row) => row.id)).toEqual(['eligible-1', 'eligible-2']);
    expect(limited).toHaveLength(2);
  });

  it('permanently quarantines bootstrap lifecycles from positions open across the deploy boundary', () => {
    const bootstrap = evaluateLearningEligibility(
      baseInput({
        lifecycleId: 'perp:BTC:bootstrap:1',
        entryContextId: null,
        sourceKind: 'bootstrap',
      }),
      config
    );
    expect(bootstrap.eligible).toBe(false);
    expect(bootstrap.ineligibilityReasons).toContain('bootstrap_lifecycle');

    const manualRepair = evaluateLearningEligibility(baseInput({ sourceKind: 'manual_repair' }), config);
    expect(manualRepair.ineligibilityReasons).toContain('manual_repair');

    const testProbe = evaluateLearningEligibility(baseInput({ sourceKind: 'test_probe' }), config);
    expect(testProbe.ineligibilityReasons).toContain('test_probe');

    const duplicate = evaluateLearningEligibility(baseInput({ sourceKind: 'duplicate' }), config);
    expect(duplicate.ineligibilityReasons).toContain('duplicate');
  });
});
