# TDD: Live/Paper Execution Parity

## Status

Status: implemented for perpetual-trade runtime parity.

Implemented on 2026-05-25:

- `PaperExecutor` no longer persists perp lifecycle side effects directly
- `perp_place_order` owns shared perp open/close lifecycle finalization
- `AutonomousManager` originator and quant execution now route through the shared perp tool path
- `Thufir.trade(...)` now routes through `perp_place_order` instead of bypassing lifecycle logic
- fallback/dead ownership in autonomous open-path persistence was removed
- `tool-executor` now imports canonical paper/perp lifecycle helpers instead of carrying shadow copies for runtime use

This TDD defines the refactor required to make `paper` and `live` execution follow the same trade lifecycle, with funding source and venue interaction as the only intentional differences.

## Scope

Make perpetual trade execution mode-independent across the real runtime:

- `paper` and `live` must share the same trade lifecycle
- the same trade request must pass through the same validation, journaling, learning, and exit-policy flows
- the only intentional difference between modes must be where fills and balances come from:
  - `paper`: simulated book state
  - `live`: exchange state

This TDD covers all major perp execution entrypoints that currently matter in repo runtime:

- `executeToolCall('perp_place_order', ...)`
- `AutonomousManager` originator and quant/discovery paths
- `Thufir.trade(...)`

The goal is not "make paper feel similar to live."
The goal is stricter:

- same runtime contract
- same persistence contract
- same lifecycle semantics
- same observability
- same close behavior
- only different execution backend

## Problem Statement

The codebase currently treats execution mode as more than a backend choice.
It changes where side effects happen, which artifacts are persisted, and which lifecycle logic is exercised.

That creates three classes of risk:

1. paper success does not prove live behavior
2. some code paths bypass shared persistence and policy layers
3. dead or duplicate logic accumulates because each path owns a different subset of lifecycle work

If `paper` is supposed to be the same system with simulated funds, this architecture is wrong.

## Current Proven Repo State

### 1. The execution adapter contract is too thin

In [src/execution/executor.ts](../src/execution/executor.ts), `ExecutionAdapter.execute(...)` returns:

- `executed`
- `message`
- optional `realizedPnlUsd`
- optional `feeUsd`
- optional `orderId`

That contract is too small to represent a canonical fill lifecycle.
It does not explicitly model:

- requested vs filled size
- average fill price
- execution mode
- partial fill state
- venue payload
- fill timestamps
- whether the result opened, reduced, or fully closed a position

Because the adapter return contract is too weak, upper layers infer lifecycle state differently per path.

### 2. `PaperExecutor` performs persistence side effects directly

In [src/execution/modes/paper.ts](../src/execution/modes/paper.ts), `PaperExecutor.execute(...)` does more than simulate fills.

For perp trades, it directly writes:

- `recordPerpTrade(...)`
- `logWalletOperation(...)`

For prediction-market style trades, it directly writes:

- `createPrediction(...)`
- `createLearningCase(...)`
- `recordExecution(...)`
- `recordTrade(...)`
- `logWalletOperation(...)`

This means paper mode owns persistence that live mode does not.

That is the core parity violation.

### 3. `HyperliquidLiveExecutor` is much narrower than `PaperExecutor`

In [src/execution/modes/hyperliquid-live.ts](../src/execution/modes/hyperliquid-live.ts), the live adapter:

- prepares venue-specific price/size formatting
- updates leverage on exchange
- submits/cancels orders
- returns a small `TradeResult`

It does not write:

- `perp_trades`
- `wallet_audit_log`
- `predictions`
- `learning_cases`
- `position_exit_policy`
- `decision_artifacts`

So today:

- paper mode = execution + persistence
- live mode = execution only

This is not backend parity.

### 4. `perp_place_order` owns a large shared lifecycle, but only for one entrypoint

In [src/core/tool-executor.ts](../src/core/tool-executor.ts), `perp_place_order` already performs a rich lifecycle around the adapter:

- book-mode selection
- live/paper policy gating
- risk validation
- trade-contract validation
- fee estimation
- execution retry
- journaling via `recordPerpTradeJournal(...)`
- evidence persistence
- `recordPerpTrade(...)`
- `position_exit_policy` maintenance
- prediction-resolution follow-through
- execution learning-case creation
- `decision_audit`

This is closer to the right architecture.

But it is currently:

- too large
- mode-branch heavy
- not the only perp entrypoint
- partially compensating for adapter asymmetry rather than enforcing a clean contract

### 5. `AutonomousManager` duplicates execution lifecycle work

In [src/core/autonomous.ts](../src/core/autonomous.ts), autonomous execution paths call `this.executor.execute(...)` directly and then perform their own persistence logic:

- `recordPerpTradeJournal(...)`
- `createPrediction(...)`
- `upsertPositionExitPolicy(...)`
- `recordPerpTrade(...)`
- notifications
- daily-limit confirmation/release

This means autonomous trading does not share the same full lifecycle implementation as `perp_place_order`.

So even before comparing `paper` vs `live`, the repo already has:

- tool-executor lifecycle
- autonomous lifecycle
- thin programmatic lifecycle

That fragmentation must be addressed in this refactor.

### 6. `Thufir.trade(...)` is a third, thinner execution path

In [src/index.ts](../src/index.ts), `Thufir.trade(...)`:

- loads market state
- checks risk
- checks limiter
- calls `executor.execute(...)`
- confirms or releases daily limit

It does not route through the richer shared persistence path used by `perp_place_order`.

That makes `Thufir.trade(...)` a bypass around the intended lifecycle.

### 7. Paper/live branching leaks into lifecycle reconciliation

In [src/core/tool-executor.ts](../src/core/tool-executor.ts), there are mode-aware helpers such as:

- `resolvePerpBookMode(...)`
- `resolvePerpExecutor(...)`
- `getPerpPositionSnapshotForLifecycle(...)`
- `getPaperPositionSnapshot(...)`
- `evaluatePaperReduceOnlyPostcondition(...)`

Some of these are legitimate backend abstractions.
Some exist only because lifecycle ownership is split between adapter and caller.

This TDD must separate:

- necessary backend adapters
- accidental complexity created by historical drift

### 8. Production proof already surfaced the mismatch

Recent production validation proved:

- a paper trade through a real runtime path writes paper/perp artifacts
- a direct `recordEntryGateDecision(...)` write was still needed to prove `llm_entry_gate_log` migration

That demonstrated a broader truth:

- not all runtime invariants are proven by one execution path
- persistence responsibility is scattered

This refactor should reduce those blind spots by making the write path canonical.

## Design Goals

1. `paper` and `live` use the same trade lifecycle.
2. Execution adapters become backend-specific I/O layers, not persistence owners.
3. All perp entrypoints converge on one lifecycle service.
4. Open, reduce, and full-close semantics are mode-independent.
5. Journaling, learning, exit-policy, and evidence writes occur in one canonical place.
6. Tests can prove parity using a live-mocked backend and a paper backend with identical assertions.
7. Dead code introduced by overlapping old and new ownership is deleted promptly once parity is proven.

## Non-Goals

1. Do not redesign strategy logic, LLM prompts, or autonomous selection policy in this release.
2. Do not redesign exchange integration beyond the minimum needed to normalize execution results.
3. Do not add a second parallel lifecycle pipeline.
4. Do not preserve thin convenience APIs if they materially bypass the shared lifecycle.
5. Do not keep deprecated paths "just in case" once parity coverage exists.

## Pragmatic Engineer-Aligned Execution Principles

This refactor should follow engineering principles associated with pragmatic, high-signal system work:

### 1. Start from the real seam, not a purity ideal

The real seam is:

`trade intent -> backend execution -> lifecycle finalization`

Do not begin by rewriting everything into abstract patterns.
Start by identifying which code currently owns:

- execution submission
- fill reconciliation
- persistence side effects

Then move ownership deliberately.

### 2. Stabilize the contract before moving code

Define the canonical execution result first.
Once upper layers depend on one normalized result type, persistence can move safely out of adapters.

### 3. Prefer vertical slices over big-bang replacement

Implement in bounded slices:

1. normalize execution result contract
2. introduce shared lifecycle finalizer for one entrypoint
3. port second and third entrypoints
4. remove dead ownership from adapters

Each slice must ship with proving tests.

### 4. Delete aggressively after proof exists

Do not leave old paper-only side-effect paths in place after parity is proven.
That is how mode drift reappears.

### 5. Reduce moving parts before adding more abstractions

If an abstraction only wraps one branch or preserves historical shape without reducing complexity, delete it.
Do not create indirection that merely renames old divergence.

### 6. Make production proof cheap

The resulting architecture should make it easy to prove behavior in production by exercising one canonical path, rather than separately validating:

- adapter writes
- lifecycle writes
- paper-only special cases

## Proposed Architecture

## 1. Canonical layering

The target layering is:

1. `TradeIntentNormalizer`
2. `TradePreflightService`
3. `ExecutionBackend`
4. `TradeLifecycleFinalizer`
5. `TradeStateReader`

### Layer responsibilities

#### A. `TradeIntentNormalizer`

Input:

- tool input
- autonomous expression
- originator proposal
- programmatic trade request

Output:

- one canonical `PerpTradeIntent`

Responsibilities:

- normalize field names
- normalize side/reduce-only semantics
- normalize optional contract fields
- attach origin metadata

#### B. `TradePreflightService`

Responsibilities:

- validate config/mode policy
- validate live-mode restrictions
- validate trade contract
- validate risk limits
- estimate fees
- fetch market snapshot
- size adjustments and policy multipliers

This service must be mode-aware only where unavoidable.
It must not write persistent lifecycle artifacts.

#### C. `ExecutionBackend`

Responsibilities:

- place/cancel orders
- reconcile backend-native fill or position response
- return canonical normalized result

This layer is the only place where paper and live should differ materially.

#### D. `TradeLifecycleFinalizer`

Responsibilities:

- persist `perp_trades`
- persist `decision_artifacts` / `perp_trade_journal`
- persist `wallet_audit_log`
- persist `position_exit_policy`
- persist predictions / learning cases when applicable
- update/resolve lifecycle state on close
- handle evidence and close-review side effects

This must be shared by:

- `perp_place_order`
- `AutonomousManager`
- `Thufir.trade(...)`

#### E. `TradeStateReader`

Responsibilities:

- read post-trade position state
- resolve whether an order opened, reduced, or closed a position
- expose one normalized position snapshot API

Mode-specific fetching is acceptable here, but the returned shape must be canonical.

## 2. Canonical contracts

### `PerpTradeIntent`

Recommended shape:

```ts
type PerpTradeIntent = {
  symbol: string;
  side: 'buy' | 'sell';
  reduceOnly: boolean;
  requestedSize: number;
  orderType: 'market' | 'limit';
  price?: number | null;
  leverage?: number | null;

  origin:
    | { source: 'tool_executor'; toolName: 'perp_place_order' }
    | { source: 'autonomous_originator'; proposalRecordId?: number | null }
    | { source: 'autonomous_quant'; hypothesisId?: string | null }
    | { source: 'programmatic'; userId?: string | null };

  contract: {
    tradeArchetype?: 'scalp' | 'intraday' | 'swing' | null;
    invalidationType?: 'price_level' | 'structure_break' | null;
    invalidationPrice?: number | null;
    timeStopAtMs?: number | null;
    takeProfitR?: number | null;
    trailMode?: 'none' | 'atr' | 'structure' | null;
    exitContractSerialized?: string | null;
  };

  policy: {
    signalClass?: string | null;
    marketRegime?: 'trending' | 'choppy' | 'high_vol_expansion' | 'low_vol_compression' | null;
    volatilityBucket?: 'low' | 'medium' | 'high' | null;
    liquidityBucket?: 'thin' | 'normal' | 'deep' | null;
    expectedEdge?: number | null;
    entryTrigger?: 'news' | 'technical' | 'hybrid' | null;
    planContext?: Record<string, unknown> | null;
  };

  reasoning?: string | null;
  hypothesisId?: string | null;
};
```

### `PerpExecutionResult`

Recommended shape:

```ts
type PerpExecutionResult = {
  mode: 'paper' | 'live';
  status: 'executed' | 'failed' | 'partial';
  symbol: string;
  side: 'buy' | 'sell';
  reduceOnly: boolean;

  requestedSize: number;
  effectiveSize: number;
  filledSize: number;

  orderType: 'market' | 'limit';
  requestedPrice?: number | null;
  avgFillPrice?: number | null;
  markPriceAtExecution?: number | null;
  leverage?: number | null;

  orderId?: string | null;
  venueOrderId?: string | number | null;
  executedAtMs: number;

  realizedPnlUsd?: number | null;
  feeUsd?: number | null;
  feeToken?: string | null;

  rawBackendPayload?: unknown;
  message: string;
};
```

### `PerpPositionSnapshot`

Recommended shape:

```ts
type PerpPositionSnapshot = {
  mode: 'paper' | 'live';
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number | null;
  leverage: number | null;
  markPrice: number | null;
  unrealizedPnlUsd?: number | null;
  openedAtMs?: number | null;
  sourceTradeId?: number | null;
};
```

## 3. Ownership rules

### Execution backends may do:

- venue/API formatting
- simulated fill generation
- venue fill lookup
- order cancellation
- backend-native position reads

### Execution backends may not do:

- `recordPerpTrade(...)`
- `recordPerpTradeJournal(...)`
- `createPrediction(...)`
- `createLearningCase(...)`
- `recordExecution(...)`
- `recordTrade(...)`
- `logWalletOperation(...)`
- `upsertPositionExitPolicy(...)`

Any adapter currently doing these must be cleaned.

## 4. Entry point convergence

### `perp_place_order`

Current state:

- closest to desired lifecycle shape
- too large
- mixes normalization, execution, persistence, and mode branching

Target state:

- normalizes tool input to `PerpTradeIntent`
- calls shared preflight
- calls shared backend
- calls shared lifecycle finalizer

### `AutonomousManager`

Current state:

- has independent execution + journaling + prediction + exit-policy logic

Target state:

- originator path builds canonical `PerpTradeIntent`
- quant path builds canonical `PerpTradeIntent`
- both call same lifecycle pipeline as `perp_place_order`

### `Thufir.trade(...)`

Current state:

- thin convenience path that bypasses rich lifecycle

Target options:

1. reimplement it as a wrapper over the canonical pipeline
2. deprecate it if wrapper semantics are misleading or redundant

This TDD recommends option 1 if programmatic usage is still desired.
If it remains too thin or duplicate after refactor, delete it.

## Dead Code And Duplicate Ownership Cleanup Plan

Dead code cleanup is mandatory for this refactor.
Do not treat it as follow-up.

### 1. `PaperExecutor` direct side-effect writes

In [src/execution/modes/paper.ts](../src/execution/modes/paper.ts), remove direct persistence once the shared lifecycle finalizer exists:

- `recordPerpTrade(...)`
- `logWalletOperation(...)`
- `createPrediction(...)`
- `createLearningCase(...)`
- `recordExecution(...)`
- `recordTrade(...)`

After refactor, `PaperExecutor` should:

- simulate fills
- mutate simulated book state
- return normalized execution result

Nothing more.

### 2. Thin `TradeResult` shape

In [src/execution/executor.ts](../src/execution/executor.ts), replace or extend the current `TradeResult` contract.

Once all callers use the new canonical result:

- delete compatibility-only fields or adapters that exist only to bridge legacy shape

### 3. `Thufir.trade(...)` bypass behavior

In [src/index.ts](../src/index.ts), either:

- route `trade(...)` through shared lifecycle
- or deprecate/remove it

Do not leave a convenience path that silently preserves old behavior.

### 4. Autonomous duplicated post-execution logic

In [src/core/autonomous.ts](../src/core/autonomous.ts), delete the duplicated blocks that independently do:

- `createPrediction(...)`
- `upsertPositionExitPolicy(...)`
- `recordPerpTrade(...)`
- `recordPerpTradeJournal(...)`

Replace them with:

- shared intent creation
- shared lifecycle finalizer invocation

### 5. Tool-executor mode-specific compensation branches

Audit branches in [src/core/tool-executor.ts](../src/core/tool-executor.ts) that only exist because paper and live adapters expose different behavior.

Candidates to shrink or delete after normalization:

- `isNativePaperExecutor` checks that compensate for paper-owned state
- paper-only postcondition checks that should become backend reconciliation hooks
- duplicated trade recording around failed/executed states

Do not delete a branch until parity tests prove it is redundant.

### 6. Legacy prediction-market trade path inside `PaperExecutor`

If prediction-market execution is still legitimately separate, keep it.
If it survives only because `PaperExecutor` historically owned side effects, split it into:

- prediction-market execution backend
- prediction-market lifecycle finalizer

This TDD is focused on perp parity, but the ownership rule should be consistent.

## Implementation Plan

## Phase 0: Add proof before moving behavior

Add parity-focused tests that snapshot current expected artifacts for:

- paper open
- paper reduce-only partial close
- paper full close
- live-mocked open
- live-mocked close
- autonomous originator open
- autonomous quant open
- programmatic `Thufir.trade(...)`

Goal:

- lock behavior before refactor
- expose where paths differ today

## Phase 1: Introduce canonical result types

Create:

- `src/execution/perp_execution_result.ts`
- `src/core/perp_trade_intent.ts`
- possibly `src/core/perp_position_snapshot.ts`

Tasks:

- define canonical shapes
- add mappers from legacy adapter output where needed
- do not move persistence yet

## Phase 2: Extract shared lifecycle finalizer

Create a dedicated module, e.g.:

- `src/core/perp_trade_lifecycle.ts`

Responsibilities:

- accept `PerpTradeIntent`
- accept `PerpExecutionResult`
- accept before/after `PerpPositionSnapshot`
- write all shared artifacts

Sub-functions should be narrow:

- `finalizePerpTradeOpen(...)`
- `finalizePerpTradeFailure(...)`
- `finalizePerpTradeClose(...)`
- `persistPerpTradeEvidence(...)`
- `persistPerpLearningArtifacts(...)`

## Phase 3: Rebase `perp_place_order` on the shared finalizer

Keep `perp_place_order` as first migration target because it already covers the richest lifecycle.

Tasks:

- leave policy/risk normalization in place initially
- route final persistence through the new finalizer
- reduce direct writes in the case body

Acceptance condition:

- functionality unchanged
- tests still pass
- total lines in `perp_place_order` decrease materially

## Phase 4: Make adapters backend-only

After `perp_place_order` finalization is shared:

- strip direct persistence from `PaperExecutor`
- keep paper book mutation and fill synthesis only
- map live venue output into the same result contract

Acceptance condition:

- adapters no longer write lifecycle DB artifacts directly

## Phase 5: Port `AutonomousManager`

Replace autonomous direct persistence with:

- build intent
- execute through adapter/backend
- finalize through shared lifecycle

This is high risk because originator/quant paths also maintain prediction and exit semantics.
Port only after tool-executor parity is proven.

## Phase 6: Port or deprecate `Thufir.trade(...)`

Preferred:

- wrap canonical perp lifecycle path

Fallback:

- deprecate and remove if duplicate convenience behavior creates confusion

## Phase 7: Delete dead code immediately

Once all entrypoints are migrated and parity tests are green:

- remove dead helper branches
- remove legacy compatibility mappers
- remove adapter-side persistence
- remove duplicate autonomous execution finalization blocks

## File Plan

### New

- `docs/LIVE_PAPER_EXECUTION_PARITY_TDD.md`
- `src/core/perp_trade_intent.ts`
- `src/core/perp_trade_lifecycle.ts`
- `src/execution/perp_execution_result.ts`
- `src/execution/perp_position_snapshot.ts`
- `tests/core/perp-execution-parity.test.ts`
- `tests/core/perp-trade-lifecycle.test.ts`
- `tests/core/autonomous-perp-lifecycle-parity.test.ts`

### Updated

- `src/execution/executor.ts`
- `src/execution/modes/paper.ts`
- `src/execution/modes/hyperliquid-live.ts`
- `src/core/tool-executor.ts`
- `src/core/autonomous.ts`
- `src/index.ts`
- `src/memory/perp_trades.ts`
- `src/memory/perp_trade_journal.ts`
- `src/memory/position_exit_policy.ts`
- `src/memory/audit.ts`
- `src/memory/predictions.ts`
- `src/memory/learning_cases.ts`

### Delete or deprecate after migration

- any adapter-side persistence helpers that become unused
- any thin compatibility shims for old `TradeResult`
- any autonomous-specific post-execution duplication that the shared lifecycle replaces
- potentially `Thufir.trade(...)` if it cannot be made lifecycle-canonical without preserving misleading semantics

## Test Strategy

## 1. Unit tests: canonical result normalization

Add tests for:

- paper backend -> normalized execution result
- live backend -> normalized execution result
- failed execution -> normalized failure result
- partial fill representation

## 2. Unit tests: lifecycle finalizer

Add tests for:

- open writes expected shared artifacts
- reduce-only partial close preserves active position semantics
- full close resolves linked artifacts and clears exit policy where appropriate
- failed execution writes failed trade/journal state
- mode-specific fields do not change shared artifact semantics

## 3. Parity tests: paper vs live-mocked

This is the most important proving layer.

For the same `PerpTradeIntent`, assert that paper and live-mocked runs produce the same normalized artifact set except for explicitly allowed differences.

Allowed differences:

- `execution_mode`
- venue/raw payload
- live-only order identifiers
- paper-only simulated mark provenance if unavoidable

Not allowed to differ:

- whether `perp_trades` row exists
- whether journal exists
- exit-policy behavior
- learning-case behavior
- close-resolution behavior
- evidence and decision artifacts semantics

## 4. Entry-point parity tests

For the same canonical trade request, compare artifacts from:

- `perp_place_order`
- `AutonomousManager` open path
- `Thufir.trade(...)`

These paths may differ in origin metadata, but not in lifecycle contract.

## 5. Dead-code detection gates

Add tests or lint-like assertions that fail if:

- `PaperExecutor.execute(...)` still imports lifecycle persistence writers
- `Thufir.trade(...)` still bypasses shared lifecycle
- autonomous path still directly writes artifacts that should be owned by shared finalizer

## Release Contract

The refactor is only complete if the following invariants are proven on the final branch SHA.

### Invariant 1

For perp opens, `paper` and `live` use the same lifecycle finalization code.

Proof:

- parity tests on finalizer invocation path
- no adapter-side lifecycle DB writes remain

### Invariant 2

For perp closes, `paper` and `live` resolve exit-policy and learning artifacts identically except for backend-native metadata.

Proof:

- close parity tests
- full-close state transition tests

### Invariant 3

`AutonomousManager`, `perp_place_order`, and `Thufir.trade(...)` converge on one canonical perp lifecycle.

Proof:

- shared finalizer unit coverage
- entrypoint parity tests

### Invariant 4

Production proof can be obtained by exercising one canonical path plus any intentionally separate LLM-gate seam, not by separately validating paper-only and live-only persistence behavior.

Proof:

- architecture review after migration
- production smoke plan

## Production Validation Plan

After implementation:

1. prove branch parity with live-mocked and paper parity suite
2. deploy to staging or production-safe environment
3. run one small paper round-trip through the canonical path
4. confirm expected tables/artifacts written
5. if live execution is enabled later, run one minimal live round-trip using the same request shape and compare artifacts

The production proof should no longer require separate reasoning about adapter-owned persistence.

## Risks

### 1. Close-path regressions

The most fragile area is not open execution but close reconciliation:

- reduce-only semantics
- full-close detection
- linked prediction resolution
- exit-policy clearing

Mitigation:

- make close parity tests mandatory before deleting old logic

### 2. Hidden consumers of legacy `TradeResult`

A wider contract change may reveal callers that assumed the old thin shape.

Mitigation:

- add a migration layer temporarily
- delete it once all callers are ported

### 3. Autonomous behavior drift

Autonomous flows have bespoke notifications and proposal-status updates.

Mitigation:

- lifecycle finalizer should own trade artifact writes
- autonomous path should still own proposal-status transitions and user-facing scan messaging

### 4. Over-abstraction

This refactor can easily become a large abstraction exercise.

Mitigation:

- require each new module to delete more code than it adds
- require line-count reduction in `PaperExecutor` and `tool-executor`
- reject abstractions that do not eliminate duplicated ownership

## Acceptance Criteria

This TDD is complete when all of the following are true:

1. `PaperExecutor` no longer directly writes lifecycle DB artifacts.
2. `HyperliquidLiveExecutor` and `PaperExecutor` both return the same normalized execution-result contract.
3. `perp_place_order`, `AutonomousManager`, and `Thufir.trade(...)` all use the same shared perp lifecycle finalizer.
4. Paper and live-mocked parity tests pass for open, partial close, full close, and failed execution.
5. Dead duplicate ownership is removed, not merely deprecated in comments.
6. Production paper and live validation require proving one canonical lifecycle, not mode-specific persistence behavior.

## Recommended First Cut

To keep the first implementation bounded, do this first:

1. introduce canonical perp execution result type
2. extract shared finalizer for `perp_place_order` only
3. remove direct perp-side writes from `PaperExecutor`
4. add paper vs live-mocked parity tests for `perp_place_order`

That first cut already solves the most dangerous architectural problem:

- adapters stop owning lifecycle persistence

Once that is stable, migrate:

5. `AutonomousManager`
6. `Thufir.trade(...)`
7. dead-code cleanup

## Final Recommendation

Treat this as a runtime ownership refactor, not an adapter polish task.

If the final design still allows any of the following, it is incomplete:

- paper-only lifecycle side effects
- a thin convenience trade path that bypasses canonical finalization
- autonomous execution persisting trade artifacts independently from tool execution
- dead compatibility code left behind after parity is proven

The end state should be simple to explain:

- one intent shape
- one preflight path
- one execution-result contract
- one lifecycle finalizer
- two backends

That is what "the only difference is the origin of the funds" actually requires.
