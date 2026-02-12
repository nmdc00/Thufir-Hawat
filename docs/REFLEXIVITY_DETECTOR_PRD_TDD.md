# Reflexivity Detector (Crypto Perps): PRD + TDD

Last updated: 2026-02-12

## Context
Thufir’s current discovery loop already computes market microstructure signals (price/vol, cross-asset divergence, funding/OI skew, orderflow imbalance) and can map them into probe-sized perp expressions. The gap is that many of the best perp opportunities are *reflexive*: positioning and narrative create the conditions for their own reversal once a catalyst forces repricing.

This doc defines a “Reflexivity Detector” capability: identify *crowded + fragile* setups, bind them to a *time-bounded catalyst*, and produce expressions with explicit thesis invalidation conditions.

---

# PRD

## Goal
Detect and act on reflexive reversal opportunities in crypto perps by combining:
1. Crowding/positioning metrics (funding, OI, basis proxies, orderflow).
2. Narrative consensus and “narrative exhaustion” signals from the intel pipeline.
3. Catalyst proximity (scheduled and monitored stochastic catalysts).
4. Thesis lifecycle: explicit invalidation rules that force exit when the mechanism breaks.

## Non-goals
- Becoming a discretionary “TA bot” driven primarily by chart patterns.
- Predicting long-horizon fundamentals.
- Automated “news trading” without positioning context.
- Building a full backtester in this phase (design for it, but don’t block shipping on it).

## Target User
Single operator running Thufir in:
- `MONITOR_ONLY` (alerts and artifacts only), or
- `LIGHT_REASONING` / `FULL_AGENT` (autonomous probe trades under risk limits).

## Definitions
- **Narrative**: a widely repeated causal story that coordinates positioning (e.g. “X is the next Y”, “ETF inflows will do Z”).
- **Crowding**: one-sided leverage/positioning evidenced by funding/basis, OI expansion, and flow.
- **Fragility**: sensitivity to small negative deltas due to liquidation cascades / margin stress / orderbook thinness.
- **Catalyst**: an event that can force recognition and close the gap between narrative and mechanism (scheduled or emergent).
- **Reflexive reversal**: a regime where the *positioning itself* becomes the vulnerability; a small shock triggers forced unwind, amplifying price move.

## Core Product Requirements

### R1: Output “Crowded + Fragile + Catalyst” Setups
For each candidate symbol (initially the configured Hyperliquid universe), emit a setup when:
- Crowding score is high (venue-normalized, not fixed thresholds).
- Fragility score is high (liquidation/topology proxies, rapid OI growth, one-sided flow).
- A catalyst exists within the configured time horizon (or a monitored stochastic catalyst risk is elevated).

Each setup must include:
- `consensusNarrative`: short synthesized narrative (1-2 sentences).
- `keyAssumptions[]`: explicit assumptions the crowd is relying on.
- `fragilityDrivers[]`: measurable drivers (funding percentile, OI acceleration, orderbook thinness, sentiment unanimity).
- `catalysts[]`: with dates (for scheduled) and confidence/monitor rules (for stochastic).
- `timeHorizon`: minutes/hours/days.
- `imWrongIf[]`: explicit invalidation conditions (state-based; not only price-based).

### R2: Narrative Consensus and Exhaustion Signal
From the existing intel store (news/social/data), the system must produce a structured narrative snapshot per symbol:
- What the dominant claim is.
- How unanimous it is (dispersion).
- Whether reasoning quality is degrading (e.g., “because it’s going up” style).

This must be stored as an artifact so repeated runs can reuse it without repeated LLM calls when inputs are unchanged.

### R3: Catalyst Calendar and Binding
The system must maintain a catalyst registry:
- Scheduled events: CPI/FOMC, major earnings (e.g., COIN/MSTR), known token unlocks, protocol upgrades/governance votes.
- Stochastic events: exploit risk, exchange instability, regulatory headlines, stablecoin stress.

For scheduled events, the system must:
- Store event time in UTC.
- Link candidate setups to the nearest relevant event inside the horizon window.

For stochastic events, the system must:
- Define monitor rules (which intel sources / keywords / signals increase probability).
- Not “hallucinate” event times; represent uncertainty explicitly.

### R4: Thesis Invalidation as a First-Class Circuit Breaker
Every emitted setup must include explicit invalidation conditions. Examples (state-based):
- Crowding defuses: funding + OI normalize without price breaking (edge decays).
- Catalyst passes with no repricing (time stop).
- Opposite catalyst emerges (regime change).
- Market microstructure shifts: spreads widen / depth collapses beyond limits (execution risk).

Invalidation conditions must be evaluated on each scan cycle in the autonomy loop.

### R5: Safety and Risk Guardrails
The detector must respect existing safety controls (risk checks, probe sizing, daily limits), plus add:
- Carry-cost awareness: avoid “shorting too early” without a catalyst bound to the horizon.
- Venue normalization: use percentiles/z-scores so thresholds aren’t hard-coded.
- Degradation rules: in `MONITOR_ONLY`, generate alerts and artifacts without placing orders.

## Data Inputs
- Hyperliquid:
  - Funding rates + funding history (already used in `src/discovery/signals.ts` and `src/technical/onchain.ts`).
  - Open interest and context (`getMetaAndAssetCtxs`).
  - Recent trades and L2 book (for orderflow and depth imbalance).
- Intel pipeline:
  - `intel_items` from SQLite (via `listRecentIntel` / existing store).
  - Source types: news/social/data/custom.
- Configuration:
  - Symbol universe (`hyperliquid.symbols`).
  - Time horizons and thresholds.
  - Catalyst registry file (YAML/JSON) and update cadence.

## Outputs
- New discovery signal kind: `reflexivity_fragility` (or equivalent), producing:
  - `directionalBias`: direction of expected reversal or continuation conditional on catalyst.
  - `confidence`: bounded [0,1] from measurable drivers + catalyst proximity.
  - `metrics`: crowding, fragility, catalyst proximity, narrative unanimity/exhaustion.
  - `evidence`: references to intel IDs used (for audit).
- Expression plan augmentation:
  - `expectedEdge` computed from probability-weighted gap closure within horizon.
  - `invalidation` populated from `imWrongIf[]`.

## User Stories
- As an operator, I want Thufir to tell me when a market is fragile because everyone is on the same side, so I can pre-position around a catalyst.
- As an operator, I want each trade proposal to state “I’m wrong if…” so I can audit exits and prevent thesis drift.
- As an operator, I want the system to reuse narrative artifacts when nothing material changed, to avoid LLM cost and inconsistency.

## Success Metrics (MVP)
- Setup quality:
  - Higher adverse-move frequency post-catalyst for flagged “fragile long” setups vs baseline.
  - Lower average carry-cost loss from “too early” entries (measured by funding paid/received during holding).
- Operational:
  - Artifact reuse rate for narrative extraction > 70% in steady state.
  - `MONITOR_ONLY` emits deterministic outputs with zero LLM calls when no deltas are detected.
- Safety:
  - No increase in risk limit violations relative to baseline discovery engine.

## Acceptance Criteria
- The system can emit at least one complete setup object for a configured symbol that includes: narrative, assumptions, catalyst, fragility drivers, and invalidation rules.
- The autonomy loop can evaluate invalidation rules and recommend exit regardless of PnL.
- The detector functions in `MONITOR_ONLY` without trading, and in `FULL_AGENT` it produces probe-sized expressions only when catalyst-bound.

---

# TDD

## Design Principles
- Prefer deterministic computation for scoring where possible; use LLM for structured extraction/summarization only.
- All LLM outputs must be strict JSON with schema versioning and robust validation.
- Persist artifacts with stable keys so reruns reuse prior reasoning when inputs don’t materially change.
- “Catalyst proximity” is required for taking carry-cost-negative positions (e.g., shorting high-funding longs).

## Proposed Module Layout
Add a new reflexivity layer that plugs into the existing discovery engine:
- `src/reflexivity/types.ts`
  - JSON schemas and TypeScript types for narrative snapshots, catalyst entries, and setups.
- `src/reflexivity/narrative.ts`
  - Build per-symbol narrative snapshot from recent intel items.
  - Deterministic hashing of inputs to enable artifact reuse.
- `src/reflexivity/catalysts.ts`
  - Load scheduled catalysts from a repo file (e.g. `config/catalysts.yaml`).
  - Provide query APIs: `getUpcoming(symbol, now, horizon)`.
- `src/reflexivity/fragility.ts`
  - Compute crowding/fragility scores from Hyperliquid metrics and narrative features.
- `src/discovery/signals.ts`
  - Add `signalReflexivityFragility(config, symbol)` that returns a `SignalPrimitive`.
- `src/discovery/types.ts`
  - Add `kind: 'reflexivity_fragility'` and extend metrics typing.
- `src/discovery/engine.ts`
  - Call the new signal generator alongside existing ones; cluster as usual.

## Data Model (Artifacts and Storage)

### Option A (Preferred for MVP): Workspace Artifact Store
Use the existing “decision artifacts” storage approach (see `docs/EXECUTION_MODES_BUDGET_DECISION_ARTIFACTS.md`) and add:
- Namespace: `reflexivity:narrative:{symbol}:{hash}`
- Namespace: `reflexivity:setup:{symbol}:{asof}`

Pros: avoids schema migration and keeps iteration fast.
Cons: less queryable than SQL tables.

### Option B: SQLite Tables (If Queryability Needed)
Extend `src/memory/schema.sql` with:
- `reflexivity_narratives`:
  - `id`, `symbol`, `asof`, `input_hash`, `json`, `intel_ids_json`
- `reflexivity_catalysts`:
  - `id`, `symbol_scope`, `event_type`, `scheduled_utc`, `confidence`, `json`
- `reflexivity_setups`:
  - `id`, `symbol`, `asof`, `directional_bias`, `scores_json`, `invalidation_json`, `json`

## Catalyst Registry Format
Add `config/catalysts.yaml` (or `.json`) with entries like:
- `id`
- `type`: `macro|earnings|unlock|upgrade|regulatory|other`
- `symbols`: `['BTC','ETH']` or `['*']`
- `scheduledUtc`: ISO-8601 (required for scheduled catalysts)
- `description`
- `tags[]`

For stochastic catalysts, omit `scheduledUtc` and include:
- `monitorQueries[]`: keywords/entities
- `sources[]`: intel sources to watch

## Narrative Snapshot Schema (LLM Output)
Strict JSON, versioned:
```json
{
  "schemaVersion": "1",
  "symbol": "ETH",
  "asofUtc": "2026-02-12T17:00:00Z",
  "consensusNarrative": "…",
  "consensusClaims": ["…"],
  "impliedAssumptions": ["…"],
  "dissentingViews": ["…"],
  "unanimityScore": 0.0,
  "exhaustionScore": 0.0,
  "evidenceIntelIds": ["intel_…"],
  "notes": "Optional; short."
}
```

Validation rules:
- Reject/repair non-JSON output deterministically.
- Clamp scores to [0,1].
- `evidenceIntelIds` must be subset of provided intel IDs.

## Scoring (Crowding, Fragility, Catalyst)
Compute scores as bounded [0,1] values:
- `crowdingScore`:
  - Funding percentile/z-score (venue-normalized over a rolling window).
  - OI level and OI acceleration (e.g., 24h delta).
  - Basis proxy if available (perp vs spot), else omit.
- `fragilityScore`:
  - One-sided orderflow (`signalHyperliquidOrderflowImbalance`).
  - Book depth imbalance / spread widening (from L2 book).
  - “Distance to pain” proxy: proximity to recent swing levels combined with leverage norms (best-effort).
  - Narrative unanimity and exhaustion (from narrative snapshot).
- `catalystProximityScore`:
  - Scheduled: decays with time-to-event; 1.0 near the event window, 0 outside horizon.
  - Stochastic: driven by monitor triggers and source reliability; never treated as “scheduled”.

Combine:
- `setupScore = w1*crowding + w2*fragility + w3*catalystProximity`
Where weights are configurable in `config/default.yaml` (and can later be learned).

Directional bias:
- If funding is highly positive with rising OI and unanimity is high, default bias is **down** (fragile-long unwind).
- If funding is highly negative with rising OI and unanimity is high, default bias is **up** (fragile-short squeeze).
- Otherwise allow “neutral” unless catalysts strongly skew.

## Expression Mapping
Augment `mapExpressionPlan` so `expectedEdge` is not a fixed function of confidence only.

For reflexive setups:
- `expectedEdge ≈ P(repricing within horizon) * expectedImpact - carryCost - slippage`
Where:
- `P(repricing)` is derived from `setupScore` and catalyst proximity.
- `carryCost` is funding bleed estimate given current funding rate and expected holding time.

## Thesis Invalidation Evaluation
Represent invalidation rules as machine-checkable conditions evaluated each cycle, e.g.:
- `crowding_defused`: funding percentile drops below threshold AND OI growth slows below threshold.
- `catalyst_expired`: now > eventTime + graceWindow.
- `setup_degraded`: setupScore drops below threshold for N consecutive scans.
- `execution_risk_high`: spreads/depth cross limits for M minutes.

These rules should drive exit recommendations even if PnL is positive/negative.

## Config Additions
Add to `config/default.yaml` (names illustrative):
- `reflexivity.enabled: boolean`
- `reflexivity.horizon: 'minutes'|'hours'|'days'`
- `reflexivity.horizonSeconds: number`
- `reflexivity.weights: { crowding, fragility, catalyst }`
- `reflexivity.thresholds: { setupScoreMin, unanimityMin, fundingPctMin, oiAccelMin }`
- `reflexivity.catalystsFile: 'config/catalysts.yaml'`
- `reflexivity.llm: { enabled, mode: 'trivial'|'standard', maxIntelItems }`

## Execution Mode Integration
- In `MONITOR_ONLY`: compute deterministic scores; only run narrative extraction if material intel deltas exist.
- In `LIGHT_REASONING`: allow one LLM call for narrative snapshot refresh when needed.
- In `FULL_AGENT`: allow narrative refresh + setup synthesis, but still keep trade decision bounded by guardrails and risk checks.

## Test Plan
Unit tests:
- Scoring functions clamp and behave monotonically with inputs (`crowdingScore`, `fragilityScore`, `catalystProximityScore`).
- Input hashing and artifact reuse: same inputs => same hash => no new LLM call.
- JSON schema validation for narrative snapshots (reject/repair cases).

Integration tests:
- Given fixture intel items + fixture Hyperliquid snapshots, detector emits a `reflexivity_fragility` signal.
- Invalidation rule evaluation triggers an exit recommendation when conditions flip.

Negative tests:
- Missing funding history / thin markets: detector degrades gracefully to “no setup”.
- LLM returns malformed output: system falls back to deterministic neutral narrative snapshot.

## Rollout Plan
1. Implement catalyst registry + deterministic crowding/fragility scoring (no LLM).
2. Add narrative snapshot extraction (LLM) with strong caching and strict schema validation.
3. Add invalidation engine and wire it into autonomy loop decision artifacts.
4. Tighten thresholds and weights via offline analysis and observed outcomes.

