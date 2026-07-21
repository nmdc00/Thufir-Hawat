/**
 * Canonical perp close accounting — accounting schema v1.
 *
 * Pure, deterministic derivation of net realized PnL for a perp position
 * close event, per the v2.6 canonical trade learning TDD ("2. trade_close_events
 * - append-only execution facts", "Binding accounting definitions"). This module
 * has no I/O and no DB access. The executor calls the single exported
 * `buildPerpCloseAccounting(...)` function and passes its returned object
 * unchanged to the event writer, prediction resolver, and response metadata —
 * no writer may recompute net PnL from a subset of fees.
 *
 * Binding rules implemented here (see the TDD for the authoritative text):
 * - All canonical USD amounts are computed internally in integer micro-USD
 *   (1e-6 USD) with half-even (banker's) rounding at ingestion, and returned
 *   as their exact decimal value.
 * - canonical_net_pnl_usd = gross_realized_pnl_usd - entry_fees_allocated_usd
 *   - close_fees_usd - funding_usd.
 * - funding_usd is signed: positive means the position PAID funding (reduces
 *   net PnL, hence the subtraction above), negative means it RECEIVED funding.
 * - Entry fees are summed over all entry fills on the lifecycle. Allocation to
 *   a given reduction is proportional to size_reduced / total_opened_size,
 *   using the size-weighted aggregate entry economics that exist as of that
 *   reduction's event sequence (a reduction that precedes a later scale-in
 *   allocates only against entry fills with eventSequence <= its own).
 * - Entry-fee allocation across all reductions sums exactly to total entry
 *   fees; the terminal (last, by event sequence) close event absorbs any
 *   rounding residue rather than letting it vanish or double count.
 * - Accounting schema v1 has no funding capture: funding_usd defaults to 0
 *   and fundingSupported defaults to false. A nonzero funding_usd supplied
 *   while fundingSupported is false is a reconciliation failure.
 */

export const ACCOUNTING_SCHEMA_VERSION = 'v1';

/** Micro-USD scale factor (1 USD = 1_000_000 micro-USD). */
const MICRO_USD_SCALE = 1_000_000;

/** Tolerance for asset-size (not USD) reconciliation comparisons. */
const SIZE_EPSILON = 1e-9;

export interface PerpEntryFillInput {
  /** Monotonic per-lifecycle sequence number for this entry fill. */
  eventSequence: number;
  /** Asset quantity added to the position by this fill (base units, not USD). */
  size: number;
  /** USD fee paid for this entry fill. */
  feeUsd: number;
}

export interface PerpCloseEventInput {
  /** Monotonic per-lifecycle sequence number for this close/reduction event. */
  eventSequence: number;
  /** Asset quantity removed from the position by this reduction (base units). */
  sizeReduced: number;
  /** Gross realized PnL in USD for this reduction, before any fee/funding deduction. */
  grossRealizedPnlUsd: number;
  /** USD fee paid to close this portion of the position. */
  closeFeesUsd: number;
  /**
   * Signed net funding cash flow in USD attributable to this reduction.
   * Positive = position paid funding. Negative = position received funding.
   * Must be 0 (or omitted) unless `fundingSupported` is true.
   */
  fundingUsd?: number | null;
}

export interface PerpCloseAccountingInput {
  /** Ordered (any input order accepted; sequence is what matters) entry fills for the lifecycle. */
  entryFills: PerpEntryFillInput[];
  /** Ordered (any input order accepted) partial/final reduction events for the lifecycle. */
  closeEvents: PerpCloseEventInput[];
  /**
   * Whether funding capture is supported by this accounting run. Defaults to
   * false (accounting schema v1 has no funding-payment capture mechanism).
   */
  fundingSupported?: boolean;
}

export interface PerpCloseEventAccounting {
  eventSequence: number;
  sizeReduced: number;
  grossRealizedPnlUsd: number;
  /** This event's share of total lifecycle entry fees. */
  entryFeesAllocatedUsd: number;
  closeFeesUsd: number;
  fundingUsd: number;
  canonicalNetPnlUsd: number;
  accountingSchemaVersion: typeof ACCOUNTING_SCHEMA_VERSION;
}

export interface PerpCloseAccountingAggregate {
  totalOpenedSize: number;
  totalReducedSize: number;
  totalGrossRealizedPnlUsd: number;
  totalEntryFeesUsd: number;
  totalCloseFeesUsd: number;
  totalFundingUsd: number;
  totalCanonicalNetPnlUsd: number;
  fundingSupported: boolean;
  accountingSchemaVersion: typeof ACCOUNTING_SCHEMA_VERSION;
}

export interface PerpCloseAccountingResult {
  /** One accounting result per close event, sorted ascending by eventSequence. */
  events: PerpCloseEventAccounting[];
  /** Aggregate/final lifecycle totals across all close events. */
  aggregate: PerpCloseAccountingAggregate;
}

/**
 * Rounds a real number to the nearest integer using half-even (banker's)
 * rounding, tolerant of float representation noise near the .5 boundary.
 */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  const TIE_EPSILON = 1e-9;
  if (diff < 0.5 - TIE_EPSILON) return floor;
  if (diff > 0.5 + TIE_EPSILON) return floor + 1;
  // Exact (or float-noise-near-exact) tie: round to the even neighbor.
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Converts a decimal USD amount to an integer micro-USD bigint via half-even rounding. */
function toMicroUsd(usd: number): bigint {
  return BigInt(roundHalfEven(usd * MICRO_USD_SCALE));
}

/** Converts an integer micro-USD bigint back to its exact decimal USD value. */
function fromMicroUsd(micro: bigint): number {
  return Number(micro) / MICRO_USD_SCALE;
}

/**
 * Multiplies a micro-USD integer amount by a plain ratio (e.g. size_reduced /
 * total_opened_size) and rounds the result to the nearest micro-USD integer
 * using half-even rounding. Trade-scale micro-USD amounts stay well within
 * Number's safe-integer range, so the bigint -> Number round trip here is exact.
 */
function scaleMicroUsd(micro: bigint, ratio: number): bigint {
  return BigInt(roundHalfEven(Number(micro) * ratio));
}

/**
 * Computes canonical net PnL accounting for every reduction (partial or
 * final) on a perp position lifecycle, allocating multi-fill entry fees
 * proportionally and exactly across the reductions.
 *
 * Throws if the supplied fills/reductions do not reconcile (a reduction
 * would draw down more size than was ever opened as of its sequence), or if
 * a nonzero funding value is supplied while `fundingSupported` is not true.
 */
export function buildPerpCloseAccounting(
  input: PerpCloseAccountingInput,
): PerpCloseAccountingResult {
  const { entryFills, closeEvents } = input;
  const fundingSupported = input.fundingSupported ?? false;

  if (entryFills.length === 0) {
    throw new Error('buildPerpCloseAccounting: at least one entry fill is required');
  }
  if (closeEvents.length === 0) {
    throw new Error('buildPerpCloseAccounting: at least one close event is required');
  }

  // Never rely on input array order — normalize by event sequence so replay
  // with the same sequences in a different array order is invariant.
  const sortedFills = [...entryFills].sort((a, b) => a.eventSequence - b.eventSequence);
  const sortedCloses = [...closeEvents].sort((a, b) => a.eventSequence - b.eventSequence);

  for (const closeEvent of sortedCloses) {
    const funding = closeEvent.fundingUsd ?? 0;
    if (funding !== 0 && !fundingSupported) {
      throw new Error(
        `buildPerpCloseAccounting: nonzero funding_usd (${funding}) supplied for event ` +
          `sequence ${closeEvent.eventSequence} while fundingSupported is false ` +
          '(accounting schema v1 has no funding capture)',
      );
    }
  }

  const totalOpenedSize = sortedFills.reduce((sum, fill) => sum + fill.size, 0);
  const totalReducedSize = sortedCloses.reduce((sum, close) => sum + close.sizeReduced, 0);

  if (totalReducedSize - totalOpenedSize > SIZE_EPSILON) {
    throw new Error(
      'buildPerpCloseAccounting: total reduced size ' +
        `${totalReducedSize} exceeds total opened size ${totalOpenedSize} — fill totals do not ` +
        'reconcile with reduced size',
    );
  }

  const totalEntryFeesMicroUsd = sortedFills.reduce(
    (sum, fill) => sum + toMicroUsd(fill.feeUsd),
    0n,
  );

  let cumulativeReducedSize = 0;
  let allocatedEntryFeesMicroUsdSoFar = 0n;

  const events: PerpCloseEventAccounting[] = sortedCloses.map((closeEvent, index) => {
    const fillsAsOfSequence = sortedFills.filter(
      (fill) => fill.eventSequence <= closeEvent.eventSequence,
    );
    const openedSizeAsOfSequence = fillsAsOfSequence.reduce((sum, fill) => sum + fill.size, 0);

    cumulativeReducedSize += closeEvent.sizeReduced;

    if (openedSizeAsOfSequence <= 0 || cumulativeReducedSize - openedSizeAsOfSequence > SIZE_EPSILON) {
      throw new Error(
        'buildPerpCloseAccounting: close event at sequence ' +
          `${closeEvent.eventSequence} reduces cumulative size to ${cumulativeReducedSize}, ` +
          `which exceeds the ${openedSizeAsOfSequence} opened as of that sequence — fill totals ` +
          'do not reconcile with reduced size',
      );
    }

    const isTerminalEvent = index === sortedCloses.length - 1;

    let entryFeesAllocatedMicroUsd: bigint;
    if (isTerminalEvent) {
      // Absorb whatever rounding residue is left so the sum of all
      // allocations equals total entry fees exactly.
      entryFeesAllocatedMicroUsd = totalEntryFeesMicroUsd - allocatedEntryFeesMicroUsdSoFar;
    } else {
      const feesAsOfSequenceMicroUsd = fillsAsOfSequence.reduce(
        (sum, fill) => sum + toMicroUsd(fill.feeUsd),
        0n,
      );
      const ratio = closeEvent.sizeReduced / openedSizeAsOfSequence;
      entryFeesAllocatedMicroUsd = scaleMicroUsd(feesAsOfSequenceMicroUsd, ratio);
    }
    allocatedEntryFeesMicroUsdSoFar += entryFeesAllocatedMicroUsd;

    const grossRealizedPnlMicroUsd = toMicroUsd(closeEvent.grossRealizedPnlUsd);
    const closeFeesMicroUsd = toMicroUsd(closeEvent.closeFeesUsd);
    const fundingMicroUsd = toMicroUsd(closeEvent.fundingUsd ?? 0);

    const canonicalNetPnlMicroUsd =
      grossRealizedPnlMicroUsd - entryFeesAllocatedMicroUsd - closeFeesMicroUsd - fundingMicroUsd;

    return {
      eventSequence: closeEvent.eventSequence,
      sizeReduced: closeEvent.sizeReduced,
      grossRealizedPnlUsd: fromMicroUsd(grossRealizedPnlMicroUsd),
      entryFeesAllocatedUsd: fromMicroUsd(entryFeesAllocatedMicroUsd),
      closeFeesUsd: fromMicroUsd(closeFeesMicroUsd),
      fundingUsd: fromMicroUsd(fundingMicroUsd),
      canonicalNetPnlUsd: fromMicroUsd(canonicalNetPnlMicroUsd),
      accountingSchemaVersion: ACCOUNTING_SCHEMA_VERSION,
    };
  });

  const totalGrossRealizedPnlMicroUsd = events.reduce(
    (sum, event) => sum + toMicroUsd(event.grossRealizedPnlUsd),
    0n,
  );
  const totalCloseFeesMicroUsd = events.reduce(
    (sum, event) => sum + toMicroUsd(event.closeFeesUsd),
    0n,
  );
  const totalFundingMicroUsd = events.reduce(
    (sum, event) => sum + toMicroUsd(event.fundingUsd),
    0n,
  );
  const totalCanonicalNetPnlMicroUsd =
    totalGrossRealizedPnlMicroUsd -
    totalEntryFeesMicroUsd -
    totalCloseFeesMicroUsd -
    totalFundingMicroUsd;

  const aggregate: PerpCloseAccountingAggregate = {
    totalOpenedSize,
    totalReducedSize,
    totalGrossRealizedPnlUsd: fromMicroUsd(totalGrossRealizedPnlMicroUsd),
    totalEntryFeesUsd: fromMicroUsd(totalEntryFeesMicroUsd),
    totalCloseFeesUsd: fromMicroUsd(totalCloseFeesMicroUsd),
    totalFundingUsd: fromMicroUsd(totalFundingMicroUsd),
    totalCanonicalNetPnlUsd: fromMicroUsd(totalCanonicalNetPnlMicroUsd),
    fundingSupported,
    accountingSchemaVersion: ACCOUNTING_SCHEMA_VERSION,
  };

  return { events, aggregate };
}
