# TDD: Originator -> Entry Gate Context Integration

## Implementation Status

Status: implemented in the current repo state.

Implemented:

- originator handoff now preserves selector and TA context for the chosen symbol
- deterministic originator gate context is built in `src/core/entry_gate_market_context.ts`
- `LlmEntryGate` now consumes live `markPrice`, computes/validates stop geometry, and clamps leverage to the mechanical ceiling
- structured market context is rendered into the gate prompt
- `llm_entry_gate_log` observability fields were added with backward-compatible migration behavior
- targeted unit and integration coverage exists for context building, gate behavior, originator wiring, origination flow, and gate-log persistence

Verification status:

- `tests/core/entry_gate_market_context.test.ts`
- `tests/core/llm_entry_gate.test.ts`
- `tests/core/autonomous-wiring.test.ts`
- `tests/core/origination-pipeline.test.ts`
- `tests/memory/llm_entry_gate_log.test.ts`
- `./node_modules/.bin/tsc --noEmit`

## Scope

Design a concrete integration that gives `LlmEntryGate` the objective market and risk context it already asks for when deciding approval and leverage for originator trades.

This design is specifically about the originator path:

`selectDiscoveryMarkets -> TaSurface -> OriginationTrigger -> LlmTradeOriginator -> AutonomousManager originator handoff -> LlmEntryGate`

The goal is not to replace the LLM gate.
The goal is to stop starving it of the deterministic inputs required for high-confidence leverage selection.

## Current Proven Repo State

### The gate asks for leverage evidence it does not receive

In [src/core/llm_entry_gate.ts](../src/core/llm_entry_gate.ts), the prompt explicitly says leverage should scale only when all of these hold:

- high edge
- high confidence
- clear directional regime
- deep liquidity
- well-defined stop

The prompt currently only receives:

- `symbol`
- `side`
- `notionalUsd`
- `leverage`
- `leverageMax`
- `edge`
- `confidence`
- `signalClass`
- `regime`
- `session`
- `entryReasoning`
- optional `invalidationPrice`
- optional `suggestedTtlMinutes`
- optional `expectedRMultiple`

Current `EntryGateCandidate` therefore has no structured fields for:

- current mark price
- stop distance
- liquidation distance
- leverage ceiling from stop geometry
- liquidity score
- liquidity bucket
- execution score
- spread proxy
- open interest
- day volume
- funding context
- trend context beyond a free-form `regime` string

### The originator handoff uses placeholder context

In [src/core/autonomous.ts](../src/core/autonomous.ts), the originator path currently sends the gate:

- `edge: 0.1`
- `regime: 'unknown'`
- no explicit liquidity field
- no execution quality field
- no stop-distance field
- no mark price field inside the candidate

This is the central integration gap.

### The runtime already has most of the missing evidence

The originator scan already computes or fetches:

- top-market discovery candidates from [src/discovery/market_selector.ts](../src/discovery/market_selector.ts)
  - `liquidityScore`
  - `executionScore`
  - `fundingScore`
  - `openInterestUsd`
  - `dayVolumeUsd`
  - `spreadProxyBps`
- TA snapshots from [src/core/ta_surface.ts](../src/core/ta_surface.ts)
  - `price`
  - `oiUsd`
  - `oiDelta1hPct`
  - `oiDelta4hPct`
  - `fundingRatePct`
  - `volumeVs24hAvgPct`
  - `priceVsEma20_1h`
  - `trendBias`
  - `alertReason`
- selected originator proposal fields from [src/core/llm_trade_originator.ts](../src/core/llm_trade_originator.ts)
  - `invalidationPrice`
  - `suggestedTtlMinutes`
  - `confidence`
  - `leverage`
  - `expectedRMultiple`
  - `tradeType`
- execution-time market state from `marketClient.getMarket(symbol)`
  - `markPrice`
  - `metadata.maxLeverage`

### The gate already receives `markPrice` but ignores it

`LlmEntryGate.evaluate(candidate, markPrice)` currently receives the mark price but names it `_markPrice` and does not use it.

That means stop geometry can be computed at the exact gate seam today, but currently is not.

### Discovery path is materially richer than originator path

The quant/discovery path already passes non-placeholder values into the gate:

- `edge: expr.expectedEdge`
- `regime`
- `signalClass`
- machine-readable `invalidationPrice`

It still lacks some structured fields, but it is not using the same placeholder contract as originator.

## Problem Statement

The LLM gate is conservative by design, which is correct.
The runtime then compounds that conservatism by failing to provide the gate with the evidence required to justify anything other than low leverage.

The result is predictable:

- leverage stays near the floor,
- not because `hyperliquid.maxLeverage` is low,
- but because the gate is forced to reason from placeholders.

## Design Goals

1. Preserve the LLM gate as the final discretionary approval layer.
2. Feed the gate structured, deterministic market and risk context for originator trades.
3. Reuse runtime-computed signals rather than asking the LLM originator to self-report them.
4. Compute stop geometry and leverage ceilings mechanically before leverage is finalized.
5. Keep the originator prompt and gate prompt separated:
   - originator proposes a thesis
   - runtime computes objective context
   - gate validates the trade and selects leverage within hard bounds

## Non-Goals

1. Do not let the originator LLM decide its own supporting evidence contract.
2. Do not rely on free-form `thesisText` parsing to recover liquidity or regime.
3. Do not replace the gate with a fully deterministic leverage engine in this release.
4. Do not require a destructive database migration; observability fields may be added only as backward-compatible nullable extensions.

## Design Decision

The gate context for originator trades should be built in `AutonomousManager` after the originator proposal is chosen and before `LlmEntryGate.evaluate(...)` is called.

This is the correct seam because:

- the proposal symbol is now known,
- the runtime already has the selector candidates and TA snapshots for that scan,
- execution-time `markPrice` and exchange max leverage are available,
- the context can be computed deterministically without trusting the originator LLM.

The design must not encode this context inside `TradeProposal`.
`TradeProposal` is thesis output.
Gate context is runtime-derived validation input.

## Proposed Architecture

### New runtime layer

Add a small context-building layer:

`originator proposal + selector candidate + TA snapshot + market state -> EntryGateMarketContext`

Recommended new module:

- `src/core/entry_gate_market_context.ts`

Recommended responsibilities:

1. merge originator proposal context for the selected symbol
2. compute risk geometry from `markPrice` and `invalidationPrice`
3. derive normalized regime and liquidity fields
4. produce a gate-ready structured payload

### High-level flow

`selectDiscoveryMarkets`
-> retain full `DiscoveryCandidate[]` instead of only `symbol[]`
-> `TaSurface.computeAll(topMarkets)`
-> `LlmTradeOriginator.propose(bundle)`
-> locate selected symbol in:
- selector candidate map
- TA snapshot map
-> fetch live `market`
-> build `EntryGateMarketContext`
-> pass enriched `EntryGateCandidate` to `LlmEntryGate.evaluate(...)`

## Proposed Data Contract

### 1. Extend `EntryGateCandidate`

Keep existing fields and add:

```ts
type EntryGateCandidate = {
  symbol: string;
  side: 'buy' | 'sell';
  notionalUsd: number;
  leverage: number;
  leverageMax: number;
  edge: number;
  confidence: number;
  signalClass: string;
  regime: string;
  session: string;
  entryReasoning: string;
  invalidationPrice?: number | null;
  suggestedTtlMinutes?: number;
  expectedRMultiple?: number;

  marketContext?: {
    markPrice: number | null;
    stopDistancePct: number | null;
    liquidationMovePctAtCandidateLeverage: number | null;
    liquidationBufferPct: number | null;
    mechanicalLeverageCeiling: number | null;

    trendBias: 'up' | 'down' | 'flat' | 'unknown';
    priceVsEma20_1hPct: number | null;
    regimeSource: 'originator_runtime' | 'discovery' | 'fallback';

    liquidityBucket: 'thin' | 'normal' | 'deep' | 'unknown';
    liquidityScore: number | null;
    executionScore: number | null;
    fundingScore: number | null;
    spreadProxyBps: number | null;
    openInterestUsd: number | null;
    dayVolumeUsd: number | null;

    oiUsd: number | null;
    oiDelta1hPct: number | null;
    oiDelta4hPct: number | null;
    fundingRatePct: number | null;
    volumeVs24hAvgPct: number | null;
    alertReason: string | null;
    triggerReason: 'cadence' | 'ta_alert' | 'event' | null;
  };
};
```

### 2. New helper type

```ts
type OriginatorSymbolContext = {
  selector?: DiscoveryCandidate | null;
  ta?: TaSnapshot | null;
  triggerReason?: 'cadence' | 'ta_alert' | 'event' | null;
};
```

This helper should be internal to the integration layer.

## Field Sourcing Rules

### Objective market / execution fields

Source from `DiscoveryCandidate` when available:

- `liquidityScore`
- `executionScore`
- `fundingScore`
- `openInterestUsd`
- `dayVolumeUsd`
- `spreadProxyBps`

Reason:
- these are already cross-universe normalized for the originator shortlist,
- they are better leverage inputs than raw TA values alone.

### Objective local activity fields

Source from `TaSnapshot`:

- `price`
- `oiUsd`
- `oiDelta1hPct`
- `oiDelta4hPct`
- `fundingRatePct`
- `volumeVs24hAvgPct`
- `priceVsEma20_1h`
- `trendBias`
- `alertReason`

Reason:
- this gives the gate local structure and momentum context for the exact symbol proposed.

### Objective stop geometry fields

Source from:

- `proposal.invalidationPrice`
- execution-time `markPrice`
- candidate `leverage`
- market or config `leverageMax`

These must be computed mechanically, not inferred by the LLM.

## Regime and Liquidity Derivation Rules

### Regime

For originator trades, replace `regime: 'unknown'` with a deterministic runtime regime.

Recommended initial rule:

1. if `trendBias !== 'flat'` and `abs(priceVsEma20_1hPct) >= 0.75`, classify as `trending`
2. else if `abs(oiDelta1hPct) >= 8` and `volumeVs24hAvgPct >= 100`, classify as `high_vol_expansion`
3. else classify as `choppy`

If a shared helper is preferred, extract a general-purpose regime resolver rather than duplicating logic inside `autonomous.ts`.

### Liquidity bucket

Primary rule:

- if selector candidate exists, derive from `liquidityScore`
  - `>= 0.75 -> deep`
  - `>= 0.40 and < 0.75 -> normal`
  - `< 0.40 -> thin`

Fallback rule when selector metadata is unavailable:

- if `oiUsd >= 100_000_000` and `volumeVs24hAvgPct >= 50`, use `deep`
- if `oiUsd <= 10_000_000`, use `thin`
- otherwise use `normal`

The fallback should be clearly marked as lower-quality than selector-backed context.

## Mechanical Risk Geometry

These calculations should happen before the LLM call.

### Required formulas

If `markPrice > 0` and `invalidationPrice` is finite:

```text
stopDistancePct =
  abs(markPrice - invalidationPrice) / markPrice

liquidationMovePctAtCandidateLeverage =
  1 / leverage

liquidationBufferPct =
  liquidationMovePctAtCandidateLeverage - stopDistancePct

mechanicalLeverageCeiling =
  floor(min(leverageMax, 0.7 / stopDistancePct))
```

### Semantics

- `stopDistancePct` tells the gate how tight the thesis is
- `liquidationMovePctAtCandidateLeverage` tells the gate how far price can move before liquidation
- `liquidationBufferPct` tells the gate whether the thesis stop actually sits inside or outside the liquidation boundary
- `mechanicalLeverageCeiling` is the hard maximum leverage compatible with the stop rule already enforced in the originator prompt

### Hard constraints

1. `mechanicalLeverageCeiling` must clamp any LLM-suggested leverage.
2. If `mechanicalLeverageCeiling < 1`, the gate should reject.
3. If `liquidationBufferPct <= 0`, the gate should reject unless it resizes leverage downward enough to restore positive buffer.

This is a deterministic safety contract, not a discretionary prompt preference.

## Prompt Changes

### `LlmEntryGate` system behavior

The gate prompt should continue to decide approve/reject/resize and final leverage, but it should no longer be forced to infer risk geometry or liquidity from sparse prose.

### Add a structured market context block

Include an explicit section in the user prompt:

```text
## Market Structure Context

- Current mark price: ...
- Invalidation price: ...
- Stop distance: ...%
- Candidate leverage: ...x
- Mechanical leverage ceiling from stop geometry: ...x
- Liquidation move at candidate leverage: ...%
- Buffer between invalidation and liquidation: ...%
- Regime: ...
- Trend bias: ...
- Price vs EMA20 1h: ...%
- Liquidity bucket: ...
- Liquidity score: ...
- Execution score: ...
- Spread proxy: ... bps
- Open interest USD: ...
- Day volume USD: ...
- OI delta 1h: ...%
- OI delta 4h: ...%
- Funding rate annualized: ...%
- Volume vs 24h average: ...%
- Trigger reason: ...
- Alert reason: ...
```

### Prompt instructions must tighten

Add explicit instructions:

1. never suggest leverage above the mechanical ceiling
2. treat `thin` liquidity or poor execution score as strong reasons to keep leverage low or reject
3. treat negative liquidation buffer as invalid unless leverage is resized lower
4. use the structured context first and thesis prose second

## Runtime Wiring Changes

### 1. `src/core/autonomous.ts`

Originator path changes:

- retain full selector candidates, not only symbol strings
- build:
  - `selectorBySymbol`
  - `taBySymbol`
- after `proposal !== null`, gather:
  - selected TA snapshot
  - selected discovery candidate
  - execution-time market state
- compute deterministic originator gate context
- populate enriched `gateCandidate`

Recommended new helper calls:

```ts
const originatorContext = buildOriginatorSymbolContext(...);
const gateCandidate = buildEntryGateCandidateFromOriginator(...);
```

### 2. `src/core/llm_entry_gate.ts`

Changes:

- extend `EntryGateCandidate`
- consume `markPrice` instead of ignoring it
- compute and/or validate mechanical risk geometry
- render structured context block in prompt
- clamp `suggestedLeverage` to:
  - `candidate.leverageMax`
  - `mechanicalLeverageCeiling`

### 3. `src/discovery/market_selector.ts`

No behavioral redesign required.
This file already exposes the best selector-side liquidity and execution metrics for the originator integration.

Optional refactor:

- extract score-to-bucket helpers if the originator integration needs shared bucket semantics

### 4. `src/core/ta_surface.ts`

No mandatory schema change is required for the first integration release.

Optional extension:

- add `dayVolumeUsd` and `spreadProxyBps` if later it becomes desirable for originator-only scans to work without selector metadata

## Observability

The initial implementation now includes backward-compatible observability extensions:

- add `mechanical_leverage_ceiling`
- add `stop_distance_pct`
- add `liquidity_score`
- add `execution_score`
- add `liquidity_bucket`

to `llm_entry_gate_log`.

These fields are implemented as nullable columns with additive migration behavior, matching the existing log-table hardening style already used in this repo.

## Failure and Fallback Rules

### Missing selector metadata

If the chosen symbol has no `DiscoveryCandidate`:

- continue using TA snapshot + mark price + invalidation
- derive fallback `liquidityBucket`
- set normalized selector-based fields to `null`
- do not block by default solely because selector metadata is missing

### Missing TA snapshot

If the chosen symbol has no `TaSnapshot`:

- continue if `markPrice` and invalidation are present
- set TA-derived fields to `null`
- downgrade regime to `unknown` only when no deterministic substitute exists

### Missing mark price

If `markPrice <= 0`:

- do not compute stop geometry
- gate may still run, but it must be unable to approve leverage above 1x

Preferred stricter rule:

- reject originator execution if both `markPrice` and stop geometry are unavailable

### Missing invalidation price

Already reject.
This design keeps that behavior unchanged.

## File Plan

### New

- `docs/ORIGINATOR_ENTRY_GATE_CONTEXT_INTEGRATION_TDD.md`
- `src/core/entry_gate_market_context.ts`
- `tests/core/entry_gate_market_context.test.ts`

### Updated

- `src/core/autonomous.ts`
- `src/core/llm_entry_gate.ts`
- `tests/core/llm_entry_gate.test.ts`
- `tests/core/autonomous-wiring.test.ts`
- `tests/core/origination-pipeline.test.ts`

### Updated

- `src/memory/llm_entry_gate_log.ts`
- `tests/memory/llm_entry_gate_log.test.ts`

### Optional updated

- `src/discovery/market_selector.ts`
- `src/core/ta_surface.ts`

## Test Strategy

### Unit tests: new market-context builder

Add `tests/core/entry_gate_market_context.test.ts` to cover:

1. selector + TA + mark price + invalidation -> full context object
2. stop distance and leverage ceiling calculations
3. fallback liquidity bucket when selector metadata is absent
4. negative liquidation buffer detection
5. no mark price -> null geometry fields

### Unit tests: `LlmEntryGate`

Extend `tests/core/llm_entry_gate.test.ts` to cover:

1. prompt includes structured market context block
2. leverage suggestions are clamped to mechanical ceiling
3. gate rejects when ceiling `< 1`
4. gate rejects or resizes when liquidation buffer is non-positive
5. missing market context does not crash fallback path

### Integration tests: originator wiring

Extend `tests/core/autonomous-wiring.test.ts` to assert:

1. originator gate candidate is no longer created with `edge: 0.1` and `regime: 'unknown'` placeholders when objective context exists
2. selected TA snapshot and selector candidate are used for the proposed symbol
3. `markPrice` flows into geometry computation
4. leverage returned from gate cannot exceed mechanical ceiling

### Integration tests: origination pipeline

Extend `tests/core/origination-pipeline.test.ts` to assert:

1. originator proposal symbol is joined back to selector and TA context
2. deep-liquidity candidate receives deep-liquidity gate inputs
3. thin-liquidity candidate receives conservative gate inputs
4. gate handoff remains valid when trigger reason is `cadence`, `ta_alert`, or `event`

## Rollout Order

1. add deterministic context builder and unit tests
2. wire originator path to preserve selector and TA metadata
3. expand gate candidate and prompt
4. add leverage-clamping logic
5. add or extend observability fields if desired

## Acceptance Criteria

The integration is complete when all of the following are true:

1. originator trades no longer enter `LlmEntryGate` with `regime: 'unknown'` when TA context exists
2. originator trades no longer enter `LlmEntryGate` with a hardcoded `edge: 0.1` when a deterministic edge input can be derived or sourced
3. the gate prompt receives explicit stop distance, leverage ceiling, and liquidity/execution context
4. the gate cannot approve leverage above the mechanical ceiling implied by mark price and invalidation
5. tests prove that selector metadata and TA metadata are joined to the chosen originator symbol before gate evaluation

## Recommended First Implementation Cut

To keep the first cut bounded, implement only:

1. selector candidate retention in `runOriginatorScan`
2. TA snapshot join by proposed symbol
3. stop geometry computation from `markPrice` and `invalidationPrice`
4. prompt expansion
5. leverage clamp to mechanical ceiling

This first cut already solves the main failure mode:

- the gate finally sees explicit stop geometry,
- the gate finally sees explicit liquidity and execution context when available,
- low leverage becomes an informed choice instead of a placeholder-driven default.
