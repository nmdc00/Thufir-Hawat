# Implementation Plan (Hyperliquid Pivot)

## Status (2026-02-12)
- Phases 1-3 are implemented in code.
- Phase 4 is mostly complete: tests/build are passing on Node 22, coverage thresholds are configured, and live verification now supports (a) read-only connectivity and (b) an authenticated order roundtrip (place tiny far-off limit order, then cancel) via `hyperliquid_order_roundtrip`.
- Phase 5 remains ongoing iteration work.

## Phase 1: Perp Integration
- Hyperliquid client + market list
- Live executor
- Order/position tools
- Perp risk checks

## Phase 2: Discovery Engine
- Signals (price/vol, cross-asset, funding/OI, orderflow)
- Hypotheses + expressions
- Probe sizing + guardrails
- Reflexivity detector:
  - Crowding + fragility + catalyst scoring (reflexive reversal setups)
  - Narrative snapshots from intel with artifact caching
  - Catalyst registry and proximity scoring

## Phase 3: Agent + Tooling
- Tool calling wired into agent modes
- Autonomy loop uses discovery outputs
- Autonomy thresholds enforced (`minEdge`, `requireHighConfidence`, `pauseOnLossStreak`)
- On-chain scoring uses live Hyperliquid funding/orderflow/book signals
- CLI and docs updated

## Phase 4: Verification
- Run tests
- Live API verification with small orders (order roundtrip: place -> open orders -> cancel)
- Monitor error handling and edge cases

## Phase 5: Learning
- Record trade artifacts
- Track signal quality and drift
- Iterate on sizing + prioritization
