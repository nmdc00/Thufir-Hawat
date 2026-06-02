# Complete Trade Plan: Close-Finalized Perp Learning Loop

## Objective

Thufir should trade fully automatically while making every completed net perp position auditable and learnable. The close execution path stays fast. The post-close learning path turns each full close into canonical evidence that can change future behavior without manual approval.

## Runtime Loop

1. Scan market.
2. Build candidate thesis, signal class, expected edge, invalidation, time stop, and sizing.
3. Apply global policy gate, including active learned close-policy adjustments.
4. Open or skip.
5. Manage the active net position through heartbeat, exit consultant, and risk controls.
6. Record partial reduces as lifecycle events.
7. On full close, enqueue durable finalization.
8. Finalizer creates canonical close artifact, reflection, regret cases, and policy evidence.
9. Policy learner automatically promotes repeated bad evidence into scoped future constraints.
10. Dashboard exposes the queue, close artifacts, regret cases, and active learned policies.

## Entry Rules

- One active net position lifecycle per symbol.
- Same-direction adds merge into the active lifecycle.
- Opposite-direction flips are treated as close old lifecycle plus open new lifecycle.
- Every entry must carry enough context for future close attribution:
  - symbol
  - direction
  - signal class
  - market regime
  - volatility/liquidity bucket
  - expected edge
  - trade archetype
  - invalidation price or time stop where available
  - reasoning and plan context

## Position Management

- Heartbeat and exit consultant can reduce or close.
- Partial reduce:
  - records `trade_close_events.close_kind = partial_reduce`
  - does not create `trade_closes`
  - does not finalize thesis correctness for the whole lifecycle
  - can still contribute execution/risk telemetry
- Full close:
  - records `trade_close_events.close_kind = full_close`
  - enqueues `close_finalization_jobs`
  - clears active exit policy synchronously
  - never waits on reflection, LLM, or policy learning

## Close Finalization

The worker claims due jobs and finalizes deterministically.

Required outputs:

- `trade_closes`: canonical completed net-position artifact
- `trade_reflections`: deterministic structured reflection
- `regret_learning_cases`: counterfactual/regret evidence where facts support it
- `policy_promotion_events`: automatic promotion audit when policy changes
- `trade_policy_adjustments`: active future constraints

SLO:

- target finalization under 10 seconds
- delayed after 30 seconds
- retry immediately, then 15 seconds, then 60 seconds
- terminal failure after repeated retries

## Future Behavior Changes

Learned policy adjustments are scoped and automatic.

Supported actions:

- block similar setups
- downweight size
- cap leverage
- require confirmation
- cooldown

Scope keys should stay narrow first:

- symbol
- direction
- signal class
- market regime
- trigger reason

Hard blocks are allowed only when evidence is narrow, auditable, and expiring.

## Dashboard Checks

The `learning` tab must show:

- job counts by status
- delayed and failed jobs
- partial reduce count
- full close count
- recent canonical closes
- deterministic reflection status
- regret case counts
- active policy adjustments
- promotion history

Empty sections are acceptable only when the underlying pipeline has produced zero rows. Missing API sections are a release blocker.

## Release Test Gates

Minimum gates for this release:

- schema migration creates all finalizer and policy tables
- partial reduce creates only a close event
- full close creates close event and finalization job
- worker finalizes job into `trade_closes`
- reflection is deterministic and non-LLM-blocking
- regret rows appear for negative-R or left-on-table cases
- policy promotion writes active adjustment and promotion event
- future entry gate applies the active adjustment
- dashboard API returns populated close-learning sections
- dashboard UI renders the learning tab

## Operational Plan

1. Deploy schema and runtime code together.
2. Start clean for historical closed trades.
3. Bootstrap currently open positions through existing lifecycle state.
4. Let future full closes populate canonical close artifacts.
5. Watch finalizer backlog after deploy:
   - pending should drain quickly
   - failed terminal should stay zero
   - delayed should stay near zero
6. Confirm first production full close creates:
   - one full close event
   - one finalized job
   - one trade close
   - one reflection
   - policy promotion only if thresholds are met

## Rollback

If finalizer behavior misbehaves:

- disable the worker interval or stop job execution
- keep close execution untouched
- leave recorded close events/jobs in DB for later replay
- deactivate active `trade_policy_adjustments`

Trading safety remains with execution, risk gates, and exchange reduce-only protections.
