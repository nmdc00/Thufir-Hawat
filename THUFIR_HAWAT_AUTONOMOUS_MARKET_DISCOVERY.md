# THUFIR_HAWAT_AUTONOMOUS_MARKET_DISCOVERY.md
Last updated: 2026-02-04

## Purpose

Define a **single, coherent architecture** for Thufir Hawat that:
- does NOT rely on predefined events
- does NOT rely on prediction markets
- does NOT rely on oracles or calendars
- does NOT rely on Grok or Twitter-native models

Instead, Thufir:
- autonomously discovers **what matters**
- forms competing hypotheses
- finds **where markets express those hypotheses**
- executes **minimal, test-sized trades**
- learns structurally over time without fine-tuning

Primary execution venue (initial): **crypto derivatives (perpetuals / volatility)**  
Primary target platform: **Hyperliquid**

---

## Core Philosophy

Markets do not trade events.  
Markets trade **information pressure, uncertainty, positioning, and fragility release**.

Thufir’s job is not to answer:
> “Will X happen?”

Thufir’s job is to answer:
> **“Where is information pressure building that is not yet priced, and where will it express first?”**

---

## High-Level Architecture

Thufir operates as a **continuous multi-loop system**:

1. **Discovery Loop**  
   Identify emerging pressure clusters without predefined events.
2. **Hypothesis Loop**  
   Generate competing, testable hypotheses for each pressure cluster.
3. **Expression Loop**  
   Map hypotheses to tradeable instruments and expected expression.
4. **Execution Loop**  
   Place minimal probes under strict risk constraints.
5. **Learning Loop**  
   Classify outcomes, update priors, and adjust signal weights.

---

## Discovery Loop (Signal Primitives)

The system must have **explicit, finite signal primitives**. Suggested initial set:

- **Price/Vol Regime Shifts**  
  Sudden changes in realized vol, ATR, and trend slope.
- **Order Flow Imbalance**  
  Persistent buy/sell pressure, thin book absorption, or sweep patterns.
- **Funding and OI Skew**  
  Extreme or diverging funding vs price direction, OI spikes or cliffs.
- **Cross-Asset Divergence**  
  BTC/ETH vs majors, perps vs spot, or sector dispersion anomalies.
- **On-Chain Flow Surprises**  
  Exchange inflow/outflow shocks or whale concentration shifts.

Each signal primitive yields:  
`signal_id`, `market`, `directional_bias`, `confidence`, `time_horizon`, `raw_metrics`

---

## Hypothesis Loop (Competing Explanations)

For each pressure cluster, Thufir creates **2–4 competing hypotheses**.  
Every hypothesis must be structured and testable:

**Hypothesis Schema**
- `pressure_source`: what is driving the pressure
- `expected_expression`: how the market should move if true
- `time_horizon`: minutes / hours / days
- `invalidation`: observable conditions that disprove it
- `trade_map`: instruments to express the view
- `risk_notes`: tail risks and fragility triggers

Hypotheses must be **mutually exclusive or meaningfully differentiated**.  
No narrative-only hypotheses are allowed.

---

## Expression Loop (Hypothesis → Instrument)

Mapping must be deterministic:

- **Uncertainty Expansion** → long vol, long straddles, or long gamma exposure  
- **Positioning Squeeze** → perp directional with tight liquidation risk controls  
- **Macro Spillover** → relative value pairs or beta-hedged exposure  
- **Liquidity Fragility** → smaller size, wider stops, or avoid trade

Each hypothesis yields a **trade expression plan**:
- instrument(s)
- direction
- entry zone
- invalidation trigger
- expected move

---

## Execution Loop (Minimal Probe Trades)

Define “minimal test-sized” strictly:

- **Probe Size**: 0.25%–0.75% of bankroll per hypothesis
- **Max Risk per Cluster**: 1.5% of bankroll
- **Max Daily Loss**: 3% of bankroll
- **No martingale, no averaging down**

Execution constraints:
- Use limit orders where possible.
- Enforce max slippage (basis points cap).
- Require explicit invalidation conditions.
- Auto-cancel if time horizon expires.

---

## Learning Loop (Structural, Not Fine-Tuned)

The system learns by **weighting signal primitives and hypothesis classes**:

Stored memory objects:
- signal bundle → hypothesis → trade → outcome → error class

Error classes:
- `false_signal`
- `timing_error`
- `incomplete_mapping`
- `execution_slippage`
- `tail_event`

Update rules:
- Exponential decay on weights.
- Penalize repeated error classes.
- Promote signals that perform across regimes.

---

## Hyperliquid Constraints (Initial Platform)

Execution must respect platform limits:
- Order types supported
- Max leverage allowed
- Slippage/impact controls
- Funding exposure caps
- Kill-switch on API errors or abnormal fills

If any of these are violated, **force paper mode**.

---

## Autonomy Guardrails

- No trade without hypothesis object.
- No hypothesis without invalidation condition.
- No execution if risk limits breached.
- Auto-disable if 3 consecutive invalidations or daily loss limit hit.

---

## Minimal MVP Plan

1. Implement signal primitives (price/vol + funding/OI).
2. Build hypothesis schema + generator.
3. Map to 1–2 Hyperliquid instruments.
4. Execute probe trades with strict risk caps.
5. Log outcomes and update weights.

---

## Open Questions

- Which signal primitives are highest signal-to-noise for Hyperliquid?
- What is the minimum viable set of instruments?
- What is an acceptable false-positive rate for probes?
