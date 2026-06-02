# PRD/TDD: Close Trade Finalizer

## Status

Status: planning

Single-release scope: this release must ship the full close-finalization loop, including canonical close artifacts, async finalization, policy learning, dashboard/API observability, bootstrap for currently open positions, and release-grade tests.

## Problem

Thufir currently learns from pieces of a perp trade lifecycle, but it does not have one canonical artifact that represents the completed net position.

Production already records reduce-only close journals and execution-quality learning cases. It also materializes active policy adjustments from those cases. However, the close lifecycle is scattered across inline `perp_place_order` logic, journal payloads, learning cases, and policy-adjustment materialization. Tables such as `trade_closes`, `trade_reflections`, and `regret_learning_cases` exist as concepts or surfaces but are not the active source of truth.

This creates four problems:

- Closed-trade learning is hard to audit because facts, scores, reflections, and policy mutations are spread across multiple surfaces.
- Policy learning can be active without an obvious canonical close record explaining exactly what was learned.
- Partial reduces and full closes are not clearly separated in the learning model.
- Dashboard observability can drift from runtime reality, as happened with the learning tab API mismatch.

## Product Thesis

Every full close of a net perp position must produce one canonical close artifact. That artifact becomes the source of truth for deterministic reflection, regret/counterfactual learning, prediction resolution, policy-learning evidence, and dashboard observability.

The close execution path remains safety-critical and synchronous. The learning finalization path is asynchronous, durable, idempotent, and near-real-time.

## Goals

1. Create a canonical close artifact for every full close of a net position lifecycle.
2. Preserve clean attribution by modeling one active net position lifecycle per symbol at a time.
3. Record partial reduces as lifecycle events without prematurely finalizing the trade thesis.
4. Run close learning finalization asynchronously through a durable SQLite-backed job queue.
5. Keep policy learning fully automatic while separating close evidence generation from policy mutation authority.
6. Expose every new finalizer and policy-learning surface through the dashboard/API in the same release.
7. Bootstrap currently open positions so their future closes finalize correctly.

## Non-Goals

- No backfill of historical closed reduce-only journals into canonical close artifacts.
- No manual approval requirement for policy promotions.
- No new trading strategy.
- No synthetic comparable probability for Hyperliquid-only perps.
- No simultaneous long and short lifecycle on the same symbol.
- No LLM dependency for canonical close finalization.

## Authority Model

### Close Execution

Primary authority: `perp_place_order` / execution path.

Responsibilities:

- Execute or reject the reduce-only order.
- Verify reduce-only postcondition where possible.
- Detect whether the position was partially reduced or fully closed.
- Clear active exit policy synchronously on full close.
- Write a minimal close/reduce event and durable finalization job.
- Return promptly to the caller.

Close execution must not wait for reflection, policy learning, or LLM calls.

### Close Trade Finalizer

Primary authority for post-close evidence.

Responsibilities:

- Consume durable finalization jobs.
- Build canonical full-close artifacts.
- Build partial-reduce lifecycle events.
- Produce deterministic reflections.
- Produce regret/counterfactual learning cases.
- Resolve linked perp prediction outcomes when eligible.
- Emit evidence consumed by the Policy Learner.
- Maintain finalization status and errors.

The finalizer does not directly decide future policy.

### Policy Learner

Primary authority for future behavior changes.

Responsibilities:

- Read canonical close evidence and scoped execution-quality cases.
- Promote evidence into active `trade_policy_adjustments` automatically when thresholds are met.
- Downweight, block, cap leverage, require confirmation, or apply cooldowns without manual approval.
- Keep promotions scoped, auditable, reversible, and expiring or re-evaluable.

### LLM Reflection

Advisory enrichment only.

LLM reflection may propose tags such as `failure_mode`, `missed_confirmation`, or `cooldown_helpful`, but deterministic evidence must confirm those tags before automatic policy enforcement. LLM reflection must never block deterministic close finalization.

## Lifecycle Model

### One Net Position Lifecycle Per Symbol

At any time, a symbol has at most one active net position lifecycle.

Rules:

- Same-symbol same-direction adds merge into the active lifecycle.
- Same-symbol reduce-only orders become lifecycle events.
- Full flatten closes the lifecycle.
- Opposite-direction orders must first close or flip the existing lifecycle.
- A flip is modeled as full close of the old lifecycle plus open of a new opposite lifecycle.
- Sub-strategy attribution is stored as tags on the lifecycle, not separate active lifecycles.

### Partial Reduces

Partial reduces create lifecycle events, not final trade reflections.

Required fields:

- lifecycle id
- reduce event id
- symbol, side, size reduced, remaining size
- realized/net PnL where available
- fee data
- exit mode and thesis-invalidation flag
- component scores where computable
- triggering authority: heartbeat, exit consultant, manual, autonomous, emergency

Partial reduces can update execution/risk statistics but cannot finalize thesis correctness for the whole position.

### Full Closes

Full closes create the canonical close artifact.

Required fields:

- lifecycle id
- close event id
- symbol and closed side
- opened_at, closed_at, hold duration
- weighted average entry price
- final exit price
- total opened size, total reduced size, final close size
- gross realized PnL, fees, net realized PnL
- captured R, left-on-table R, MFE/MAE proxy when available
- exit mode
- thesis invalidation flag
- thesis correctness
- deterministic component scores
- linked prediction id
- linked entry/exit journals
- linked exit policy
- source authority
- bootstrap quality
- deterministic finalization status
- LLM reflection status

## Async Job Model

Full close writes a durable `close_finalization_jobs` row in SQLite inside the same logical finalization handoff as the minimal close event.

The gateway process runs a worker that claims and executes jobs.

Job states:

- `pending`
- `running`
- `finalized`
- `failed_retryable`
- `failed_terminal`

Required job fields:

- id
- close_event_id
- lifecycle_id
- trade_id
- symbol
- status
- attempts
- lease_owner
- lease_expires_at
- last_error
- created_at
- updated_at
- finalized_at

Reliability rules:

- Finalizer is idempotent.
- Unique key prevents duplicate close artifacts for the same close event.
- Startup scans unfinished jobs.
- Expired `running` leases return to `pending` or `failed_retryable`.
- Failed jobs keep enough error detail for dashboard triage.

SLO:

- Deterministic finalization target: under 10 seconds after full close.
- Mark delayed after 30 seconds.
- Mark failed retryable after 3 failed attempts or 2 minutes.
- Retry cadence: immediate, 15 seconds, 60 seconds.
- Optional LLM reflection has independent status and may lag.

## Deterministic Reflection

Every full close must receive a deterministic reflection.

Required fields:

- thesis_correct
- timing_correct
- exit_reason_appropriate
- what_worked codes
- what_failed codes
- lesson_for_next_trade codes
- source facts used
- confidence

This reflection is structured and generated without an LLM.

## Optional LLM Reflection

LLM reflection runs asynchronously after deterministic finalization.

It may add:

- narrative summary
- failure-mode tags
- missed-confirmation tags
- counterfactual hypotheses
- qualitative lesson text

It may not:

- change canonical close facts
- block deterministic finalization
- directly activate policy
- overwrite deterministic thesis correctness

## Regret And Counterfactual Learning

The finalizer creates regret/counterfactual cases for full closes when enough data exists.

Examples:

- closed too early: later price path would have hit 2R/3R
- held too long: MFE decayed into loss
- wrong thesis: invalidation hit quickly
- bad sizing: high leverage on low-quality or incomplete signal
- missed confirmation: repeated failures where a known confirmation would have filtered the entry
- cooldown-needed: repeated losses from same failure mode within a scope

Regret cases are evidence. Policy Learner decides whether they affect future behavior.

## Policy Learning

Policy learning is fully automatic.

The Policy Learner promotes evidence into active policy when thresholds are met. Manual approval is not part of the runtime loop. Human control is through observability, config, and emergency override.

Supported automatic actions:

- downweight scoped setup
- block scoped setup
- cap leverage
- require internal confirmation
- apply scoped cooldown

Guardrails:

- Hard block requires stronger evidence than downweight.
- Hard block must be narrowly scoped where possible.
- Every policy has source close IDs or learning case IDs.
- Every policy has evidence count, confidence, reason, updated time, and expiry or re-evaluation path.
- Entry gate logs the exact adjustment IDs that affected the decision.
- Operator can disable or clear adjustments through config/tooling, but approval is not required for activation.

## Bootstrap

Historical closed trades are not backfilled.

Currently open positions are bootstrapped so their future closes can be finalized.

Bootstrap requirements:

- Scan current paper/live open positions at rollout.
- Create or repair active lifecycle rows.
- Link existing entry journal, prediction, exit policy, and trade id where possible.
- Mark lifecycle with `bootstrap_quality`: `clean`, `partial`, or `unlinked`.
- Future close finalizes even for partial/unlinked bootstrap, but reflection confidence is reduced.
- Dashboard shows bootstrap quality.
- No historical closed-trade policy learning from pre-finalizer rows.

## Dashboard And API Requirements

Every new artifact must be surfaced in the dashboard/API in this release.

Required sections:

- finalizer backlog by status
- delayed/failed jobs
- recently finalized closes
- recent partial reduces
- deterministic reflections
- LLM reflection status
- regret/counterfactual cases
- active policy adjustments
- policy promotion history
- blocked/downweighted setup counts
- source close IDs and learning case IDs for each active policy
- bootstrap quality for open positions
- finalizer SLO metrics

The dashboard API contract must be tested with seeded DB rows.

## Data Model

Exact schema can evolve during implementation, but the release must provide these logical tables or equivalent normalized surfaces:

- `position_lifecycles`
- `position_lifecycle_events`
- `trade_closes`
- `trade_reflections`
- `regret_learning_cases`
- `trade_counterfactuals`
- `close_finalization_jobs`
- `policy_promotion_events`

Existing tables that must be linked:

- `perp_trades`
- `perp_position_lifecycles`
- `decision_artifacts`
- `learning_cases`
- `learning_events`
- `weight_updates`
- `signal_weights`
- `trade_policy_adjustments`
- `position_exit_policy`
- `predictions`

## Implementation Plan

### Phase 1: Schema And Bootstrap

- Add lifecycle, close, reflection, regret, counterfactual, and finalization-job schema.
- Add migrations with idempotent guards.
- Add bootstrap scanner for currently open positions.
- Add dashboard API empty states.

### Phase 2: Synchronous Close Handoff

- Update reduce-only path to detect partial reduce vs full close.
- Persist minimal lifecycle event.
- Enqueue durable finalization job on full close.
- Keep existing close journal behavior during migration.
- Ensure close execution does not wait on finalizer.

### Phase 3: Async Finalizer Worker

- Implement worker claim/lease/retry logic.
- Create canonical close artifact.
- Create deterministic reflection.
- Create regret/counterfactual cases.
- Resolve linked prediction where eligible.
- Mark job finalized.

### Phase 4: Policy Learner Integration

- Make Policy Learner consume canonical close evidence.
- Preserve existing `trade_policy_adjustments` semantics.
- Add policy promotion events.
- Ensure active adjustments point back to close/finalizer evidence.

### Phase 5: Optional LLM Reflection

- Add async LLM reflection worker or sub-job.
- Store separate LLM reflection status.
- Ensure failures do not affect deterministic finalization.

### Phase 6: Dashboard/API Completion

- Add all required dashboard sections.
- Add API tests with seeded data.
- Add production sanity query checklist.

### Phase 7: Remove Duplicate Authority

- Disable post-close learning/policy writes outside finalizer.
- Keep compatibility reads where needed.
- Add tests that fail if new post-close policy writes bypass finalizer.

## Test Plan

This release is not complete until the following gates pass.

### 1. Schema And Migration Tests

- Fresh DB creates all new tables and indexes.
- Existing DB migrates without losing old data.
- Re-running migration is idempotent.
- Unique constraints prevent duplicate close artifacts for same close event.
- Bootstrap migration creates lifecycle rows for current open positions only.
- Historical reduce-only journals are not backfilled into `trade_closes`.

### 2. Unit Tests: Lifecycle Classification

- Add same-direction order merges into active lifecycle.
- Partial reduce emits lifecycle event and leaves lifecycle open.
- Full reduce emits close event and marks lifecycle closed.
- Flip emits close old lifecycle plus open new lifecycle.
- Opposite-direction open is blocked unless explicitly modeled as flip.
- One active lifecycle per symbol invariant holds.

### 3. Unit Tests: Job Queue

- Full close enqueues one job.
- Duplicate enqueue is ignored/idempotent.
- Worker claims pending jobs with lease.
- Expired running lease is retried.
- Immediate/15s/60s retry cadence works.
- Job moves to `failed_retryable` after retry threshold.
- Terminal validation errors move to `failed_terminal`.
- Process restart resumes pending/running-expired jobs.

### 4. Unit Tests: Deterministic Finalizer

- Full close creates `trade_closes`.
- Deterministic reflection is created without LLM.
- Close links to entry journal, exit journal, prediction, exit policy, and lifecycle.
- Net PnL equals realized PnL minus fees.
- Component scores are persisted.
- Bootstrap quality lowers reflection confidence when partial/unlinked.
- Re-running finalizer does not duplicate artifacts.

### 5. Unit Tests: Partial Reduces

- Partial reduce creates lifecycle event only.
- Partial reduce does not create full `trade_closes`.
- Partial reduce does not finalize thesis correctness.
- Partial reduce can store realized PnL and exit mode.
- Later full close summarizes the complete net lifecycle including prior reduces.

### 6. Unit Tests: Prediction Resolution

- Full close with linked prediction resolves outcome with `outcome_basis = final`.
- Profitable close resolves in favor of predicted outcome.
- Losing close resolves against predicted outcome.
- Missing linked prediction does not fail finalization.
- Perp rows without comparator remain excluded from `learning_examples`.

### 7. Unit Tests: Regret And Counterfactuals

- Closed too early creates counterfactual when later path reaches target.
- Held too long creates regret case when MFE decays into loss.
- Thesis invalidation creates thesis-failure case.
- Missing path data skips path-dependent regret without failing finalization.
- Regret cases link to canonical close id.

### 8. Unit Tests: Policy Learner

- Below minimum evidence creates no active policy.
- Downweight threshold creates active downweight adjustment.
- Block threshold creates active block adjustment.
- Leverage-loss evidence creates leverage cap.
- Confirmation evidence creates require-confirmation policy.
- Cooldown evidence creates expiring cooldown.
- Policy promotion event links source close ids and learning case ids.
- Existing active scoped policy is replaced, not duplicated.
- Policy deactivates when evidence no longer supports it.

### 9. Integration Tests: Paper Runtime

- Paper open -> partial reduce -> full close -> async finalizer completes.
- Paper full close returns before finalizer completes.
- Finalizer completes within SLO in deterministic test clock.
- Dashboard API shows close as pending then finalized.
- Policy adjustment affects a future matching paper entry.
- Non-matching scope is not affected.

### 10. Integration Tests: Live-Mocked Runtime

- Same lifecycle as paper using mocked live fills.
- Artifact semantics match paper except backend-native metadata.
- Full close resolves fills and fees from mocked Hyperliquid data.
- Live missing fills marks job retryable, not silently finalized.
- Live finalization idempotency holds across retry.

### 11. Entry Point Parity Tests

For equivalent close scenarios, assert same canonical artifacts from:

- manual/tool `perp_place_order`
- heartbeat close
- LLM exit consultant close
- autonomous reduce/close path

Allowed differences:

- source authority
- user-facing message
- backend order id

Not allowed to differ:

- lifecycle classification
- close artifact existence
- reflection existence
- policy evidence semantics
- job behavior

### 12. Dashboard/API Tests

Seed DB rows and assert API exposes:

- finalizer backlog
- delayed and failed jobs
- finalized closes
- partial reduce events
- deterministic reflections
- LLM reflection statuses
- regret/counterfactual rows
- active policy adjustments
- promotion history
- source evidence ids
- bootstrap quality
- SLO metrics

The learning tab must not show empty states when seeded close/policy data exists.

### 13. Production Validation

Before release:

- Start service on exact release SHA.
- Confirm migrations applied.
- Confirm bootstrap rows for current open positions.
- Execute controlled paper open -> full close.
- Confirm close execution returns before finalization.
- Confirm finalization reaches `finalized`.
- Confirm dashboard shows finalized close and policy evidence.
- Confirm no duplicate close artifacts after service restart.
- Confirm active policy adjustment affects a matching future candidate.

## Acceptance Criteria

1. Every full close creates a durable finalization job.
2. Every finalized full close has exactly one canonical close artifact.
3. Every finalized full close has a deterministic reflection.
4. Partial reduces are represented as lifecycle events and do not finalize thesis correctness.
5. Policy learning remains automatic and consumes canonical close evidence.
6. Dashboard/API exposes all new finalizer and policy-learning surfaces.
7. Current open positions are bootstrapped; historical closed trades are not.
8. The finalizer is idempotent and retryable.
9. Close execution is never blocked by reflection, LLM, or policy materialization.
10. Paper and live-mocked close semantics match except for backend-native metadata.

## Primary Tradeoff

This release chooses reliable attribution over minimal implementation size. It accepts a larger refactor because future autonomous policy should not learn from scattered close fragments. The close finalizer becomes the durable evidence source; the policy learner remains the automatic behavior-change authority.
