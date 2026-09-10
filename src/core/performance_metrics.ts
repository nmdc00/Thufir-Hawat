export interface AutonomousScanTelemetrySummary {
  totalMs: number;
  discoveryMs: number;
  filterMs: number;
  executionMs: number;
  expressions: number;
  eligible: number;
  executed: number;
  blockedOrSkipped: number;
  attemptedReviews: number;
  skippedCooldown: number;
  skippedIneligible: number;
  reviewBudget: number | null;
}

export class AutonomousScanTelemetry {
  private startedAtMs: number;
  private discoveryDoneAtMs: number | null = null;
  private filterDoneAtMs: number | null = null;
  private finishedAtMs: number | null = null;

  constructor(nowMs?: number) {
    this.startedAtMs = nowMs ?? Date.now();
  }

  markDiscoveryDone(nowMs?: number): void {
    this.discoveryDoneAtMs = nowMs ?? Date.now();
  }

  markFilterDone(nowMs?: number): void {
    this.filterDoneAtMs = nowMs ?? Date.now();
  }

  markFinished(nowMs?: number): void {
    this.finishedAtMs = nowMs ?? Date.now();
  }

  summarize(input: {
    expressions: number;
    eligible: number;
    executed: number;
    attemptedReviews?: number;
    skippedCooldown?: number;
    reviewBudget?: number | null;
  }): AutonomousScanTelemetrySummary {
    const finished = this.finishedAtMs ?? Date.now();
    const discoveryDone = this.discoveryDoneAtMs ?? finished;
    const filterDone = this.filterDoneAtMs ?? discoveryDone;
    const totalMs = Math.max(0, finished - this.startedAtMs);
    const discoveryMs = Math.max(0, discoveryDone - this.startedAtMs);
    const filterMs = Math.max(0, filterDone - discoveryDone);
    const executionMs = Math.max(0, finished - filterDone);
    const blockedOrSkipped = Math.max(0, input.eligible - input.executed);
    const attemptedReviews = Math.max(0, input.attemptedReviews ?? 0);
    const skippedCooldown = Math.max(0, input.skippedCooldown ?? 0);
    const skippedIneligible = Math.max(0, input.expressions - input.eligible);

    return {
      totalMs,
      discoveryMs,
      filterMs,
      executionMs,
      expressions: Math.max(0, input.expressions),
      eligible: Math.max(0, input.eligible),
      executed: Math.max(0, input.executed),
      blockedOrSkipped,
      attemptedReviews,
      skippedCooldown,
      skippedIneligible,
      reviewBudget: input.reviewBudget ?? null,
    };
  }
}
