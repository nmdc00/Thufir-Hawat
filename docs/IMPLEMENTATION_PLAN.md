# Implementation Plan (Hyperliquid Pivot)

## Status (2026-02-11)
- Phases 1-3 are implemented in code.
- Phase 4 is partially complete: tests/build are passing on Node 22, coverage thresholds are configured, and a live smoke-check command exists; authenticated live account verification remains.
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

## Phase 3: Agent + Tooling
- Tool calling wired into agent modes
- Autonomy loop uses discovery outputs
- CLI and docs updated

## Phase 4: Verification
- Run tests
- Live API verification with small orders
- Monitor error handling and edge cases

## Phase 5: Learning
- Record trade artifacts
- Track signal quality and drift
- Iterate on sizing + prioritization
