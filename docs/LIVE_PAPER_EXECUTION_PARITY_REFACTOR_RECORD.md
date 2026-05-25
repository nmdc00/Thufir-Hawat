# Live/Paper Execution Parity Refactor Record

## Purpose

This document records what changed in the live/paper execution parity refactor, why it changed, how the runtime behaved before, how it behaves now, what dead ownership was removed, and what validation has and has not been completed.

This is the safekeeping record for the refactor implemented from:

- [LIVE_PAPER_EXECUTION_PARITY_TDD.md](./LIVE_PAPER_EXECUTION_PARITY_TDD.md)

## Problem Before The Refactor

The system did not treat `paper` and `live` as the same perp trade lifecycle with different funding/execution backends.

Instead, execution behavior diverged in three important ways:

1. `PaperExecutor` owned perp persistence side effects directly.
2. `AutonomousManager` owned its own open-trade lifecycle logic after execution.
3. `Thufir.trade(...)` bypassed the richer lifecycle path entirely.

That meant:

- paper execution was not a trustworthy proof of live lifecycle behavior
- the same trade concept could persist different artifacts depending on entrypoint
- side-effect ownership was duplicated
- dead or overlapping logic accumulated over time

## Before: Runtime Ownership Model

### 1. `PaperExecutor` mixed simulation with lifecycle persistence

Before this refactor, perp execution through:

- [src/execution/modes/paper.ts](../src/execution/modes/paper.ts)

did all of the following in one place:

- simulated the fill
- wrote `perp_trades`
- wrote wallet audit records

This made paper mode an execution backend plus a persistence owner.

### 2. `perp_place_order` had the richest lifecycle, but only for one path

The most complete lifecycle was already inside:

- [src/core/tool-executor.ts](../src/core/tool-executor.ts)

This path handled:

- risk checks
- spending checks
- contract validation
- retries
- journaling
- evidence
- exit policy maintenance
- close-learning finalization

But this only helped callers that actually used `perp_place_order`.

### 3. `AutonomousManager` reimplemented open-trade lifecycle work

Before the refactor:

- [src/core/autonomous.ts](../src/core/autonomous.ts)

called `this.executor.execute(...)` directly for originator and quant/discovery opens, then separately did:

- prediction creation
- learning-case creation
- exit-policy writes
- autonomous trade row writes
- journaling
- notifications

This meant autonomous had a second lifecycle owner for opens.

### 4. `Thufir.trade(...)` bypassed the shared lifecycle

Before the refactor:

- [src/index.ts](../src/index.ts)

did:

- market lookup
- risk check
- limiter reservation
- direct `executor.execute(...)`

It did not route through the shared `perp_place_order` lifecycle.

So the programmatic API was a third execution path with thinner semantics.

## After: Runtime Ownership Model

The target architecture for perp trades is now:

1. caller builds intent
2. caller routes through shared `perp_place_order`
3. shared path performs validation, execution, and lifecycle finalization
4. backend adapter only executes/simulates

### Post-Refactor Cleanup

After the main parity refactor shipped, a follow-up hotfix removed a remaining source of drift:

- [src/core/tool-executor.ts](../src/core/tool-executor.ts) had retained local copies of paper/perp helper logic
- the canonical extracted helpers already existed in:
  - [src/core/perp_lifecycle.ts](../src/core/perp_lifecycle.ts)
  - [src/core/tool_executor_paper.ts](../src/core/tool_executor_paper.ts)

The runtime now imports and uses those canonical modules directly, so:

- the tested helper modules and the live `perp_place_order` path are the same code
- duplicate helper ownership inside `tool-executor` is removed
- future helper changes only need to be made in one place

### 1. `PaperExecutor` is now backend-only for perps

Current behavior in:

- [src/execution/modes/paper.ts](../src/execution/modes/paper.ts)

For perp trades, `PaperExecutor` now:

- validates fill inputs
- simulates the order through `placePaperPerpOrder(...)`
- returns execution result fields

It no longer directly writes:

- `recordPerpTrade(...)`
- `logWalletOperation(...)`

for perp flows.

This is the key parity fix.

### 2. `perp_place_order` is now the canonical shared perp lifecycle owner

Current behavior in:

- [src/core/tool-executor.ts](../src/core/tool-executor.ts)

This path now owns the canonical shared lifecycle for perp orders across entrypoints, including:

- input normalization
- policy/risk checks
- execution retry
- position reconciliation
- lifecycle trade id resolution
- shared journaling
- evidence persistence
- optional open-prediction creation and linkage
- exit policy linkage
- close-learning and policy-adjustment finalization

### 3. `AutonomousManager` now routes opens through `perp_place_order`

Current behavior in:

- [src/core/autonomous.ts](../src/core/autonomous.ts)

For both:

- originator opens
- quant/discovery opens

the manager now routes through a shared helper that calls:

- `executeToolCall('perp_place_order', ...)`

instead of calling `this.executor.execute(...)` directly for opens.

This preserves:

- existing autonomous candidate selection logic
- existing gate behavior
- existing notifications
- autonomous summary row writes

while removing autonomous ownership of the main open-trade lifecycle.

### 4. `Thufir.trade(...)` now routes through `perp_place_order`

Current behavior in:

- [src/index.ts](../src/index.ts)

`Thufir.trade(...)` still sizes by USD notional, but once sized it now routes through:

- `executeToolCall('perp_place_order', ...)`

instead of calling the executor directly.

That means the programmatic API now inherits:

- shared validation
- shared journaling
- shared persistence
- shared exit-policy behavior

instead of bypassing it.

## Concrete Code Changes

### `src/execution/modes/paper.ts`

Removed direct perp-side writes:

- `recordPerpTrade(...)`
- `logWalletOperation(...)`

Paper perp execution now returns execution results only.

### `src/core/tool-executor.ts`

Added shared open-prediction creation support for perp opens:

- `maybeCreatePerpOpenPredictionArtifacts(...)`

This allows callers such as autonomous flows to keep creating perp predictions without reintroducing caller-owned lifecycle logic.

Also added:

- prediction linkage into exit policy writes
- fallback lifecycle trade-id persistence when position snapshots cannot resolve a trade id
- propagation of `modelProbability` and `reasoning` from shared input into the actual execution decision

### `src/core/autonomous.ts`

Added:

- `executeSharedPerpOrder(...)`

Refactored both originator and quant/discovery opens to use the shared tool path.

Removed autonomous-owned open lifecycle responsibilities such as:

- direct executor open calls
- autonomous-only prediction creation for opens
- autonomous-only exit-policy writes for opens
- autonomous-only duplicate journaling for opens

Autonomous still owns:

- scan/origination logic
- candidate ranking
- entry-gate preparation
- autonomous summary row writes
- notifications

### `src/index.ts`

Replaced direct executor-based trading with shared tool routing.

The method still:

- computes size from `sizeUsd`
- checks market mark price availability

but lifecycle responsibility now belongs to `perp_place_order`.

## Dead Code And Duplicate Ownership Removed

The refactor explicitly cleaned duplicate ownership rather than leaving old logic in place.

Removed or functionally extinguished:

- perp-side direct persistence from `PaperExecutor`
- autonomous-owned open prediction writes
- autonomous-owned open exit-policy writes
- autonomous-owned duplicate open journaling
- programmatic direct-executor bypass in `Thufir.trade(...)`

What remains intentionally separate:

- autonomous summary writes to `autonomous_trades`
- autonomous notifications
- strategy-specific scan/origination selection

Those are not execution lifecycle duplicates. They are entrypoint-specific reporting and orchestration concerns.

## What Stayed The Same

The refactor did not intentionally change:

- strategy selection logic
- entry-gate policy content
- discovery ranking logic
- exchange execution backend semantics
- paper fill simulation rules
- reduce-only close learning path ownership inside the shared tool lifecycle

The goal was lifecycle convergence, not strategy redesign.

## Test And Validation Record

## Verified Passing

Typecheck:

- `PATH=/home/nmcdc/.nvm/versions/node/v22.22.0/bin:$PATH ./node_modules/.bin/tsc --noEmit`

Broad regression batch:

- `tests/core/autonomous-*.test.ts`
- `tests/core/tool-executor-*.test.ts`
- `tests/core/thufir-trade-parity.test.ts`
- `tests/execution/paper-executor-perp-parity.test.ts`
- `tests/agent/orchestrator-autonomous-trade.test.ts`

These passed together under the repo's Node 22 runtime:

- `26` test files passed
- `138` tests passed

## What Those Passing Tests Prove

They prove:

- autonomous originator opens now flow through the shared lifecycle
- autonomous quant/discovery opens now flow through the shared lifecycle
- exit-policy linkage still works after the refactor
- `Thufir.trade(...)` no longer bypasses the shared lifecycle
- `PaperExecutor` no longer owns perp persistence side effects directly
- autonomous quant sizing is applied once before handoff; the shared lifecycle no longer double-applies the policy gate
- the shared spending limiter contract is now consistently USD-notional based, not base-size based

## Validation Gap Closed

The earlier SQLite-native blocker in this checkout was resolved locally and the DB-backed lifecycle surface is now green, including:

- [tests/core/tool-executor-perps.test.ts](../tests/core/tool-executor-perps.test.ts)
- [tests/core/tool-executor-exit-policy.test.ts](../tests/core/tool-executor-exit-policy.test.ts)
- [tests/core/tool-executor-calibration-risk-policy.test.ts](../tests/core/tool-executor-calibration-risk-policy.test.ts)

## Practical Risk Assessment

### Low-risk areas

- programmatic API no longer bypasses lifecycle
- autonomous open flows no longer own separate lifecycle logic
- paper perp adapter no longer persists perp lifecycle side effects directly
- broader autonomous and tool-executor regression coverage is green in this checkout

### Residual risk

- this validation batch is broad for the touched runtime seam, but it is not a full all-repo test run
