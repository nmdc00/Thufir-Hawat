import { describe, expect, it } from 'vitest';

import {
  ACCOUNTING_SCHEMA_VERSION,
  buildPerpCloseAccounting,
  type PerpCloseAccountingInput,
} from '../../src/core/perp_close_accounting.js';

describe('buildPerpCloseAccounting', () => {
  it('includes entry fees, all close fees, and funding in canonical net pnl', () => {
    const result = buildPerpCloseAccounting({
      entryFills: [{ eventSequence: 1, size: 1, feeUsd: 2 }],
      closeEvents: [
        {
          eventSequence: 2,
          sizeReduced: 1,
          grossRealizedPnlUsd: 100,
          closeFeesUsd: 3,
          fundingUsd: 4,
        },
      ],
      fundingSupported: true,
    });

    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    expect(event.grossRealizedPnlUsd).toBe(100);
    expect(event.entryFeesAllocatedUsd).toBe(2);
    expect(event.closeFeesUsd).toBe(3);
    expect(event.fundingUsd).toBe(4);
    // 100 - 2 (entry fees) - 3 (close fees) - 4 (funding) = 91
    expect(event.canonicalNetPnlUsd).toBe(91);
    expect(event.accountingSchemaVersion).toBe(ACCOUNTING_SCHEMA_VERSION);

    expect(result.aggregate.totalCanonicalNetPnlUsd).toBe(91);
    expect(result.aggregate.totalEntryFeesUsd).toBe(2);
    expect(result.aggregate.totalCloseFeesUsd).toBe(3);
    expect(result.aggregate.totalFundingUsd).toBe(4);
    expect(result.aggregate.fundingSupported).toBe(true);
    expect(result.aggregate.accountingSchemaVersion).toBe(ACCOUNTING_SCHEMA_VERSION);
  });

  it('allocates entry fees across partial reductions exactly once', () => {
    const input: PerpCloseAccountingInput = {
      entryFills: [
        { eventSequence: 1, size: 1, feeUsd: 1 },
        { eventSequence: 3, size: 1, feeUsd: 2 },
      ],
      closeEvents: [
        { eventSequence: 2, sizeReduced: 0.5, grossRealizedPnlUsd: 10, closeFeesUsd: 0.1 },
        { eventSequence: 4, sizeReduced: 0.5, grossRealizedPnlUsd: 10, closeFeesUsd: 0.1 },
        { eventSequence: 5, sizeReduced: 1, grossRealizedPnlUsd: 20, closeFeesUsd: 0.2 },
      ],
    };

    const result = buildPerpCloseAccounting(input);

    // Total entry fees across the lifecycle: 1 + 2 = 3.
    const sumAllocated = result.events.reduce((sum, e) => sum + e.entryFeesAllocatedUsd, 0);
    expect(sumAllocated).toBe(3);
    expect(result.aggregate.totalEntryFeesUsd).toBe(3);

    // No event double-counts: each event's allocation should be independently
    // consistent with the fills that existed as of its own sequence.
    // First reduction (seq 2) only sees the first entry fill (seq 1, fee 1),
    // reducing 0.5 of the 1 opened as of then => 0.5 * 1 = 0.5 allocated.
    expect(result.events[0].entryFeesAllocatedUsd).toBe(0.5);
  });

  it('absorbs floating point residue into the terminal close event', () => {
    const result = buildPerpCloseAccounting({
      entryFills: [{ eventSequence: 1, size: 3, feeUsd: 1 }],
      closeEvents: [
        { eventSequence: 2, sizeReduced: 1, grossRealizedPnlUsd: 1, closeFeesUsd: 0 },
        { eventSequence: 3, sizeReduced: 1, grossRealizedPnlUsd: 1, closeFeesUsd: 0 },
        { eventSequence: 4, sizeReduced: 1, grossRealizedPnlUsd: 1, closeFeesUsd: 0 },
      ],
    });

    // 1 / 3 does not divide evenly in micro-USD (333333.33...). The sum must
    // still reconcile exactly to the total entry fee of $1, with the last
    // event absorbing whatever residue remains.
    const sumAllocated = result.events.reduce((sum, e) => sum + e.entryFeesAllocatedUsd, 0);
    expect(sumAllocated).toBe(1);

    const [first, second, terminal] = result.events;
    expect(first.entryFeesAllocatedUsd).toBeCloseTo(1 / 3, 6);
    expect(second.entryFeesAllocatedUsd).toBeCloseTo(1 / 3, 6);
    // The terminal event absorbs the leftover residue rather than an
    // independently-rounded 1/3 share.
    expect(terminal.entryFeesAllocatedUsd).toBe(1 - first.entryFeesAllocatedUsd - second.entryFeesAllocatedUsd);
  });

  it('is invariant to event replay and ordering after sequence normalization', () => {
    const entryFills = [
      { eventSequence: 1, size: 1, feeUsd: 1.23 },
      { eventSequence: 4, size: 2, feeUsd: 3.45 },
    ];
    const closeEvents = [
      { eventSequence: 2, sizeReduced: 0.4, grossRealizedPnlUsd: 12.5, closeFeesUsd: 0.05 },
      { eventSequence: 5, sizeReduced: 1.6, grossRealizedPnlUsd: 33.1, closeFeesUsd: 0.15 },
      { eventSequence: 6, sizeReduced: 1, grossRealizedPnlUsd: 9.9, closeFeesUsd: 0.02 },
    ];

    const baseline = buildPerpCloseAccounting({
      entryFills: [...entryFills],
      closeEvents: [...closeEvents],
    });

    // Shuffle both arrays' order but keep eventSequence values intact.
    const shuffledResult = buildPerpCloseAccounting({
      entryFills: [entryFills[1], entryFills[0]],
      closeEvents: [closeEvents[2], closeEvents[0], closeEvents[1]],
    });

    expect(shuffledResult).toEqual(baseline);
  });

  it('rejects fill totals that do not reconcile with reduced size', () => {
    expect(() =>
      buildPerpCloseAccounting({
        entryFills: [{ eventSequence: 1, size: 1, feeUsd: 1 }],
        closeEvents: [
          { eventSequence: 2, sizeReduced: 0.6, grossRealizedPnlUsd: 5, closeFeesUsd: 0 },
          { eventSequence: 3, sizeReduced: 0.6, grossRealizedPnlUsd: 5, closeFeesUsd: 0 },
        ],
      }),
    ).toThrow(/reconcile/);
  });

  it('rejects fill totals that reduce more than was opened as of that sequence', () => {
    expect(() =>
      buildPerpCloseAccounting({
        entryFills: [{ eventSequence: 3, size: 1, feeUsd: 1 }],
        closeEvents: [
          { eventSequence: 1, sizeReduced: 1, grossRealizedPnlUsd: 5, closeFeesUsd: 0 },
        ],
      }),
    ).toThrow(/reconcile/);
  });

  it('rejects nonzero funding while funding_supported is false', () => {
    expect(() =>
      buildPerpCloseAccounting({
        entryFills: [{ eventSequence: 1, size: 1, feeUsd: 1 }],
        closeEvents: [
          {
            eventSequence: 2,
            sizeReduced: 1,
            grossRealizedPnlUsd: 10,
            closeFeesUsd: 0.1,
            fundingUsd: 2,
          },
        ],
      }),
    ).toThrow(/fundingSupported/);

    // Also rejected when fundingSupported is explicitly false.
    expect(() =>
      buildPerpCloseAccounting({
        entryFills: [{ eventSequence: 1, size: 1, feeUsd: 1 }],
        closeEvents: [
          {
            eventSequence: 2,
            sizeReduced: 1,
            grossRealizedPnlUsd: 10,
            closeFeesUsd: 0.1,
            fundingUsd: -2,
          },
        ],
        fundingSupported: false,
      }),
    ).toThrow(/fundingSupported/);
  });
});
