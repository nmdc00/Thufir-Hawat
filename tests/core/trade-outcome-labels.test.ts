import { describe, expect, it } from 'vitest';

import {
  LABEL_SCHEMA_VERSION,
  computeTradeOutcomeLabels,
  type TradeOutcomeLabelInput,
} from '../../src/core/trade_outcome_labels.js';

const T0 = 1_760_000_000_000;
const HOUR = 60 * 60 * 1000;

describe('trade outcome labels (label schema v2)', () => {
  it('labels a compliant planned loss as direction incorrect and process compliant', () => {
    const labels = computeTradeOutcomeLabels({
      entrySide: 'buy',
      entryPrice: 100,
      exitPrice: 95,
      entryAtMs: T0,
      exitAtMs: T0 + HOUR,
      canonicalNetPnlUsd: -50.25,
      invalidationType: 'price_level',
      invalidationPrice: 95,
      timeStopAtMs: T0 + 4 * HOUR,
      horizonEndMs: T0 + 4 * HOUR,
      exitMode: 'thesis_invalidation',
      pathHigh: 101,
      pathLow: 94.5,
      horizonEndPrice: 93,
      approvedMaxSize: 10,
      effectiveSize: 10,
      approvedMaxLeverage: 3,
      effectiveLeverage: 2,
      contractMutatedAfterEntry: false,
      riskBudgetUsd: 50,
      effectiveRiskUsd: 50,
    });

    // The independence contract: a planned stop is a compliant process with an
    // incorrect direction call and a net loss — never collapsed into thesisCorrect.
    expect(labels.processCompliant).toBe(true);
    expect(labels.directionOutcome).toBe('incorrect');
    expect(labels.profitableAfterCosts).toBe(false);
    expect(labels.thesisInvalidationHit).toBe(true);
    expect(labels.netR).toBeCloseTo(-1.005, 8);
    expect(labels.ineligibleReason).toBeNull();
    expect(labels.processComplianceTrace).toEqual({
      sizeWithinApproval: 'pass',
      leverageWithinApproval: 'pass',
      exitWithinTimeStop: 'pass',
      exitConsistentWithContract: 'pass',
      contractUnchangedAfterEntry: 'pass',
    });
  });

  it('does not infer direction correctness from invalidation or exit mode', () => {
    // Stopped out (invalidation observed on the holding path), but the declared
    // horizon resolved favorably: direction is correct despite the invalidation.
    const stoppedButRight: TradeOutcomeLabelInput = {
      entrySide: 'buy',
      entryPrice: 100,
      exitPrice: 97,
      entryAtMs: T0,
      exitAtMs: T0 + HOUR,
      canonicalNetPnlUsd: -30,
      invalidationType: 'price_level',
      invalidationPrice: 97,
      horizonEndMs: T0 + 4 * HOUR,
      exitMode: 'thesis_invalidation',
      pathObservations: [
        { timestampMs: T0, price: 100 },
        { timestampMs: T0 + HOUR, price: 96.9 },
        { timestampMs: T0 + 4 * HOUR, price: 108 },
      ],
    };
    const labelsA = computeTradeOutcomeLabels(stoppedButRight);
    expect(labelsA.thesisInvalidationHit).toBe(true);
    expect(labelsA.directionOutcome).toBe('correct');

    // Same price evidence with a different exit mode and no invalidation
    // contract: direction must not move.
    const labelsB = computeTradeOutcomeLabels({
      ...stoppedButRight,
      exitMode: 'risk_reduction',
      invalidationType: null,
      invalidationPrice: null,
    });
    expect(labelsB.directionOutcome).toBe('correct');

    // A profitable take-profit exit with an adverse horizon resolution is
    // direction incorrect: exit mode carries no direction evidence.
    const labelsC = computeTradeOutcomeLabels({
      entrySide: 'buy',
      entryPrice: 100,
      exitPrice: 104,
      entryAtMs: T0,
      exitAtMs: T0 + HOUR,
      canonicalNetPnlUsd: 40,
      horizonEndMs: T0 + 4 * HOUR,
      exitMode: 'take_profit',
      pathHigh: 105,
      pathLow: 99,
      horizonEndPrice: 92,
    });
    expect(labelsC.profitableAfterCosts).toBe(true);
    expect(labelsC.directionOutcome).toBe('incorrect');
  });

  it('leaves direction unresolved when horizon path evidence is absent', () => {
    // No horizon end price and no observation series at all.
    const noEvidence = computeTradeOutcomeLabels({
      entrySide: 'sell',
      entryPrice: 100,
      exitPrice: 90,
      canonicalNetPnlUsd: 100,
      invalidationType: 'price_level',
      invalidationPrice: 105,
      horizonEndMs: T0 + 4 * HOUR,
      exitMode: 'thesis_invalidation',
      pathHigh: 106,
      pathLow: 88,
    });
    expect(noEvidence.directionOutcome).toBe('unresolved');

    // An observation series that stops before the declared horizon end is
    // absent evidence — never interpolated into a resolution.
    const truncatedSeries = computeTradeOutcomeLabels({
      entrySide: 'buy',
      entryPrice: 100,
      exitPrice: 103,
      entryAtMs: T0,
      exitAtMs: T0 + HOUR,
      canonicalNetPnlUsd: 30,
      horizonEndMs: T0 + 4 * HOUR,
      pathObservations: [
        { timestampMs: T0, price: 100 },
        { timestampMs: T0 + HOUR, price: 103 },
      ],
    });
    expect(truncatedSeries.directionOutcome).toBe('unresolved');
  });

  it('scores sizing from risk budget rather than asset units', () => {
    const base: TradeOutcomeLabelInput = {
      entrySide: 'buy',
      entryPrice: 1,
      canonicalNetPnlUsd: 10,
      invalidationType: 'price_level',
      riskBudgetUsd: 100,
      effectiveSize: 1000, // large raw asset quantity
      invalidationPrice: 0.95,
    };

    // 1000 units with a $0.05 stop = $50 risk against a $100 budget: peak score,
    // regardless of the large raw asset quantity.
    const withinBudget = computeTradeOutcomeLabels(base);
    expect(withinBudget.sizingScore).toBe(1);

    // Identical asset quantity, wider stop: $200 risk on a $100 budget.
    const doubleRisk = computeTradeOutcomeLabels({ ...base, invalidationPrice: 0.8 });
    expect(doubleRisk.sizingScore).toBe(0);

    // 1.5x the approved risk degrades proportionally.
    const overBudget = computeTradeOutcomeLabels({ ...base, invalidationPrice: 0.85 });
    expect(overBudget.sizingScore).toBeCloseTo(0.5, 8);

    // Same asset quantity produced three different scores: the unit is risk
    // USD versus budget USD, not asset size.
    expect(new Set([withinBudget.sizingScore, doubleRisk.sizingScore, overBudget.sizingScore]).size).toBe(3);
  });

  it('produces the same sizing score for equivalent BTC and equity notional risk', () => {
    // 0.002 BTC at $50,000 with a $49,000 stop: $2 risk.
    const btc = computeTradeOutcomeLabels({
      entrySide: 'buy',
      entryPrice: 50_000,
      canonicalNetPnlUsd: 5,
      invalidationType: 'price_level',
      invalidationPrice: 49_000,
      effectiveSize: 0.002,
      riskBudgetUsd: 1.6,
    });

    // 1 equity share at $40 with a $38 stop: $2 risk. Same budget.
    const equity = computeTradeOutcomeLabels({
      entrySide: 'buy',
      entryPrice: 40,
      canonicalNetPnlUsd: 5,
      invalidationType: 'price_level',
      invalidationPrice: 38,
      effectiveSize: 1,
      riskBudgetUsd: 1.6,
    });

    expect(btc.sizingScore).not.toBeNull();
    expect(btc.sizingScore).toBe(equity.sizingScore);
    // ratio 2/1.6 = 1.25 -> proportional degradation to 0.75.
    expect(btc.sizingScore).toBeCloseTo(0.75, 8);
  });

  it('versions every deterministic label payload', () => {
    const input: TradeOutcomeLabelInput = {
      entrySide: 'buy',
      entryPrice: 100,
      exitPrice: 95,
      entryAtMs: T0,
      exitAtMs: T0 + HOUR,
      canonicalNetPnlUsd: -50,
      invalidationType: 'price_level',
      invalidationPrice: 95,
      timeStopAtMs: T0 + 4 * HOUR,
      horizonEndMs: T0 + 4 * HOUR,
      exitMode: 'thesis_invalidation',
      pathHigh: 101,
      pathLow: 94.5,
      horizonEndPrice: 93,
      approvedMaxSize: 10,
      effectiveSize: 10,
      approvedMaxLeverage: 3,
      effectiveLeverage: 2,
      contractMutatedAfterEntry: false,
      riskBudgetUsd: 50,
    };
    const labels = computeTradeOutcomeLabels(input);

    expect(LABEL_SCHEMA_VERSION).toBe('v2');
    expect(labels.labelSchemaVersion).toBe(LABEL_SCHEMA_VERSION);

    const parsed = JSON.parse(labels.deterministicPayload) as Record<string, unknown>;
    expect(parsed.label_schema_version).toBe('v2');
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());

    // Semantically identical input with a different property insertion order
    // must serialize to the identical payload string (hash-stable).
    const reordered: TradeOutcomeLabelInput = {
      riskBudgetUsd: 50,
      contractMutatedAfterEntry: false,
      effectiveLeverage: 2,
      approvedMaxLeverage: 3,
      effectiveSize: 10,
      approvedMaxSize: 10,
      horizonEndPrice: 93,
      pathLow: 94.5,
      pathHigh: 101,
      exitMode: 'thesis_invalidation',
      horizonEndMs: T0 + 4 * HOUR,
      timeStopAtMs: T0 + 4 * HOUR,
      invalidationPrice: 95,
      invalidationType: 'price_level',
      canonicalNetPnlUsd: -50,
      exitAtMs: T0 + HOUR,
      entryAtMs: T0,
      exitPrice: 95,
      entryPrice: 100,
      entrySide: 'buy',
    };
    expect(computeTradeOutcomeLabels(reordered).deterministicPayload).toBe(
      labels.deterministicPayload
    );

    // Every payload carries the version, including minimal-evidence payloads.
    const minimal = computeTradeOutcomeLabels({ entrySide: 'sell', entryPrice: null });
    expect(
      (JSON.parse(minimal.deterministicPayload) as Record<string, unknown>).label_schema_version
    ).toBe('v2');
    expect(minimal.directionOutcome).toBe('unresolved');
    expect(minimal.netR).toBeNull();
    expect(minimal.ineligibleReason).toBe('missing_canonical_net_pnl');
  });
});
