# BLACK_SWAN_DETECTOR.md
Last updated: 2026-02-01

## Purpose

Thufir does not predict black swans.
Thufir detects fragility and tail-risk exposure.

Output = fragility conditions, not event forecasts.

---

# Implementation Status (2026-02-01)

Implemented:

- Mentat storage tables + delta tracking (assumptions, mechanisms, fragility cards)
- Detector bundle (leverage, coupling, illiquidity, consensus, irreversibility)
- Mentat scan + report generators
- CLI commands: `thufir mentat scan`, `thufir mentat report`
- Optional mentat auto-scan/report in chat, daily reports, and autonomous P&L report (config-gated)
- Cartographer/Skeptic/Risk Officer role loop (merged outputs)
- Scheduled mentat monitoring + alerts (gateway)
- Tool adapters: `mentat_store_*`, `mentat_query`
- **Pre-trade fragility analysis** (`runQuickFragilityScan`) - automatic before trade execution
- **Fragility-aware critic** - stricter review for high-fragility trades (>0.6 score)
- **Trade decision integration** - fragility data passed to critic for risk assessment

Not yet implemented:

- Continuous multi-timescale monitoring + alerting pipeline
- System map builder (explicit dependency graph)

---

# Principle

Black swans arise from:

- hidden leverage
- tight coupling
- illiquidity
- consensus monoculture
- assumption fragility

Detect structure, not events.

---

# Mentat Loop

1. Ingest signals
2. Build system map
3. Extract assumptions
4. Stress assumptions
5. Identify mechanisms
6. Compute fragility score
7. Emit fragility cards
8. Store + compare deltas

---

# Core Objects

## Assumption

- id
- statement
- system
- dependencies
- evidence_for
- evidence_against
- stress_score
- last_tested

---

## Mechanism

- id
- name
- causal_chain
- trigger_class
- propagation_path

---

## FragilityCard

- id
- system
- mechanism
- exposure_surface
- convexity
- early_signals[]
- falsifiers[]
- downside
- recovery_capacity
- score
- updated_at

---

# FragilityScore

Scalar:

Fragility =
  leverage *
  coupling *
  illiquidity *
  consensus *
  irreversibility

Normalized 0–1.

Track delta over time.

---

# Detectors

## Leverage
- funding extremes
- OI spikes
- crowded carry

## Coupling
- correlation spikes
- shared collateral
- dependency hubs

## Illiquidity
- depth drop
- spread widening
- slippage rise

## Consensus
- narrative similarity
- declining viewpoint variance
- rising certainty language

---

# Agent Roles

Cartographer — map system  
Skeptic — attack assumptions  
Risk Officer — map exposure & convexity

Disagreement required.

---

# Output: Mentat Report

- FragilityScore
- Top FragilityCards
- Assumptions under stress
- Mechanisms
- Falsifiers
- Monitoring checklist

---

# Learning

Store:

- near misses
- assumption failures
- mechanism confirmations

Never optimize for prediction accuracy.
Optimize for failure detection quality.
