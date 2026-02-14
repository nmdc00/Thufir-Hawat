# Trade Management & Learning Framework (Hyperliquid Perps)

This document defines how Thufir manages open perp positions and learns from past trades.

## Versioning

- **v1.0**: Baseline spec (frozen snapshot).
- **v1.1**: Current spec (implemented on branch `spec/trade-management-1.1`).

---

## v1.1 (Current)

### Purpose

Establish a strict separation:

- **The LLM decides when and why to enter.**
- **The system decides when to exit.**

This is architecture: exits are mechanical and do not route through LLM reasoning.

### Core Principle

Thufir has two brains:

- **Narrative Brain (LLM):** builds the thesis, chooses direction, selects entry, and proposes trade parameters at entry time.
- **Mechanical Brain (system):** enforces exits, records lifecycle events, and feeds back performance statistics. No LLM call sits between an exit condition and a close.

### Trade Lifecycle

#### Entry

When an entry is executed, the system records an immutable envelope.

```ts
type TradeEnvelope = {
  // Identity
  tradeId: string;
  hypothesisId: string | null;
  symbol: string;
  side: 'buy' | 'sell';

  // Position
  entryPrice: number;
  size: number;
  leverage: number | null;
  notionalUsd: number | null;
  marginUsd: number | null;

  // Exit rules (immutable once recorded)
  stopLossPct: number;
  takeProfitPct: number;
  maxHoldSeconds: number;
  trailingStopPct: number | null;
  trailingActivationPct: number;
  maxLossUsd: number | null;

  // Audit: proposed vs applied (non-null when bounds clamped)
  proposed: {
    stopLossPct: number;
    takeProfitPct: number;
    maxHoldSeconds: number;
    trailingStopPct: number | null;
    trailingActivationPct: number;
  } | null;

  // Journal fields
  thesis: string | null;
  signalKinds: string[];
  invalidation: string | null;
  catalystId: string | null;
  narrativeSnapshot: string | null;

  // Runtime monitor state (mutable)
  highWaterPrice: number | null; // longs
  lowWaterPrice: number | null;  // shorts
  trailingActivated: boolean;

  // Time
  enteredAt: string;  // ISO-8601
  expiresAt: string;  // enteredAt + maxHoldSeconds

  // Exchange-side bracket order ids (optional)
  tpOid: string | null;
  slOid: string | null;

  status: 'open' | 'closed';
};
```

#### Exit Rules (Mechanical, Priority Ordered)

The position monitor evaluates exits in this order. **First rule that fires wins.**

1. **Liquidation Guard:** if mark is within `liquidationGuardDistanceBps` of liquidation → close immediately.
2. **Hard Stop Loss:** if P&L <= `-stopLossPct` → close immediately.
3. **Trailing Stop:** if trailing is armed and price retraces by `trailingStopPct` from watermark → close.
4. **Take Profit:** if P&L >= `+takeProfitPct` → close.
5. **Time Stop:** if `now > expiresAt` → close.

Trailing stop semantics are side-aware:

- Long: watermark is `highWaterPrice`; trigger when `mid <= highWaterPrice * (1 - trailPct)`.
- Short: watermark is `lowWaterPrice`; trigger when `mid >= lowWaterPrice * (1 + trailPct)`.

#### Exit Recording

Each close writes a close record.

```ts
type TradeCloseRecord = {
  tradeId: string;
  symbol: string;
  exitPrice: number;
  exitReason:
    | 'stop_loss'
    | 'take_profit'
    | 'time_stop'
    | 'trailing_stop'
    | 'liquidation_guard'
    | 'manual'
    | 'orphan_default';
  pnlUsd: number;
  pnlPct: number;
  holdDurationSeconds: number;
  fundingPaidUsd: number;
  feesUsd: number;
  closedAt: string;
};
```

### Parameter Bounds

LLM-proposed parameters are bounded by config. If values are clamped, the system records `proposed` vs applied.

### Stop Loss and Account Risk

`stopLossPct` is necessary for monitoring, but sizing must be constrained by account equity risk:

```
maxLossUsd = (maxAccountRiskPct / 100) * accountEquityUsd
capNotionalUsd = maxLossUsd / (stopLossPct / 100)
appliedNotionalUsd = min(requestedNotionalUsd, capNotionalUsd)
```

### Signal Convergence (Pre-Filter)

Before expressions are eligible for entry, enforce:

- **Minimum agreeing signal count** (non-neutral, same direction).
- **Weighted threshold** across agreeing signals.
- **Time horizon alignment:** cluster horizon is the shortest among high-weight agreeing signals.

### Learning Loop

#### Pre-Scan Summary

Before evaluating new opportunities, compute a summary from recent closes (win rate, average win/loss, exit reasons, signal effectiveness) and include it in the LLM’s context when making entry decisions.

#### Entry Selectivity (LLM, Journal-Informed)

In full-auto mode, Thufir uses the journal summary plus the eligible expressions list to decide which, if any, expressions to execute. The intended steady-state is **NO TRADE** on most scans.

#### Post-Trade Reflection

After a close, request an LLM reflection constrained to recorded facts (envelope + close record + watermarks) and store:

```ts
type TradeReflection = {
  tradeId: string;
  thesisCorrect: boolean;
  timingCorrect: boolean;
  exitReasonAppropriate: boolean;
  whatWorked: string;
  whatFailed: string;
  lessonForNextTrade: string;
};
```

### Position Monitor

Runs independently from the scan loop:

- No open positions: every `monitorIntervalSeconds` (default 900s).
- Positions open: every `activeMonitorIntervalSeconds` (default 60s).

While monitoring, record periodic mid-price samples for each open trade. These samples are used to compute simple MAE/MFE-style summaries and to ground post-trade reflections.

Execution modes:

- `live`: monitor reconciles actual venue positions (via `clearinghouseState`).
- `paper` / `webhook`: monitor treats open envelopes as the source of truth and evaluates exits against mark price; in `webhook` it forwards reduce-only closes via the executor.

### Exchange-Side Stops (Preferred)

Where supported:

1. Place entry.
2. Place reduce-only TP/SL trigger orders attached to the position.

The polling monitor remains a backup and handles trailing/time/liquidation guard plus reconciliation. When one side of the bracket fills, the system cancels the sibling order best-effort (OCO behavior).

### Close Execution Policy

When an exit fires:

1. Submit reduce-only IOC close with base slippage.
2. Verify closure after `closeTimeoutSeconds`.
3. Retry once with expanded slippage (`closeSlippageMultiplier`).
4. If still open, record an incident and keep retrying on subsequent ticks (no silent failure).

The close order uses a client order id so fills can be reconciled via `userFillsByTime` and the close record can store actual average fill price and fees when available (instead of mark/mid approximations).

**Hyperliquid client order id (cloid) format:** `0x` + 32 hex chars (16 bytes). Human-readable IDs are rejected by the API validator.

**Dust policy:** if a residual position remains after retries but its notional is below `dustMaxRemainingNotionalUsd`, Thufir stops retrying and closes the envelope with exit reason `dust`.

### Anti-Overtrading Rules

- Max concurrent positions
- Cooldown after close (same symbol)
- Daily entry cap
- Loss streak pause window

---

## v1.0 (Frozen Snapshot)

This is the baseline spec snapshot captured before v1.1 edits (as provided in chat on 2026-02-13).

### Trade Management & Learning Framework (v1.0)

#### Purpose

This document defines how Thufir manages open positions and learns from past trades. It establishes a clean separation: **the LLM decides when and why to enter. The system decides when to exit.** This is non-negotiable architecture, not a limitation — it exists because LLMs cannot reliably cut losing positions. They will always construct a reason to hold.

---

### 1. The Core Principle

Thufir has two brains:

- **The Narrative Brain (LLM):** Reads market structure, identifies crowded positions, detects narrative exhaustion, selects entries, sets trade parameters at entry time. This is where reflexivity analysis, signal interpretation, and thesis construction happen. The LLM has full autonomy here.

- **The Mechanical Brain (system):** Enforces exits, manages position lifecycle, tracks P&L, and feeds performance data back into the narrative brain. No LLM reasoning step sits between a stop being hit and a position being closed. Ever.

The LLM proposes. The system disposes.

---

### 2. Trade Lifecycle

#### 2.1 Entry

When the autonomous scan produces an `ExpressionPlan` that passes all filters (`minEdge`, confidence, risk limits, spending limits), the system executes the trade. At entry time, the following parameters **must** be recorded and become immutable for that trade:

```typescript
type TradeEnvelope = {
  // Identity
  tradeId: string;
  hypothesisId: string;
  symbol: string;
  side: 'buy' | 'sell';

  // Position
  entryPrice: number;
  size: number;
  leverage: number;
  notionalUsd: number;
  marginUsd: number;           // notionalUsd / leverage — actual capital at risk

  // Exit Rules (set at entry, never modified by LLM after)
  stopLossPct: number;              // hard stop as % of entry price
  takeProfitPct: number;            // TP as % of entry price
  maxHoldSeconds: number;           // time stop
  trailingStopPct: number | null;   // trail distance from high-water mark
  trailingActivationPct: number;    // profit % required before trailing activates
  maxLossUsd: number;               // absolute USD loss cap (stopLossPct * notionalUsd / 100)

  // Proposed vs Applied (for audit when bounds clamp values)
  proposed: {
    stopLossPct: number;
    takeProfitPct: number;
    maxHoldSeconds: number;
    trailingStopPct: number | null;
  } | null;                         // null if no clamping occurred

  // Thesis (for journal and learning)
  thesis: string;             // one-line summary of why
  signalKinds: string[];      // which signals converged to trigger entry
  invalidation: string;       // "I'm wrong if..." from reflexivity setup
  catalystId: string | null;  // upcoming catalyst driving the timing
  narrativeSnapshot: string;  // consensus narrative at time of entry

  // Runtime state (updated by position monitor)
  highWaterPrice: number;     // best price seen since entry (for trailing stop)
  trailingActivated: boolean; // whether trailing stop is armed

  // Timestamps
  enteredAt: string;          // ISO-8601
  expiresAt: string;          // enteredAt + maxHoldSeconds
};
```

#### 2.2 Exit Rules (Mechanical — No LLM Override)

The position monitor checks open positions on every scan cycle. Exits are evaluated in the following priority order — **the first rule that fires wins**:

1. **Liquidation Guard:** If mark price approaches within `800 bps` of liquidation price → close immediately. This is a safety net that should never fire if the other stops are working. If it does fire, log it as an incident — it means position sizing or leverage was wrong.

2. **Hard Stop Loss:** If unrealized P&L hits `-stopLossPct` from entry → close immediately. No confirmation, no LLM consultation. Default: `3.0%` of entry price (configurable per-trade at entry).

3. **Trailing Stop:** If position has been in profit beyond `trailingActivationPct` at any point, and then retraces to `trailingStopPct` below the high-water mark → close. Default activation: `1.0%` in profit. Default trail: `2.0%` from peak. This locks in profits on winning trades without capping upside.

4. **Take Profit:** If unrealized P&L hits `+takeProfitPct` from entry → close immediately. Default: `5.0%` of entry price.

5. **Time Stop:** If `now > expiresAt` → close regardless of P&L. No extensions. Default: `72 hours`. The thesis either played out or it didn't.

#### 2.3 Exit Recording

Every exit writes a `TradeCloseRecord`:

```typescript
type TradeCloseRecord = {
  tradeId: string;
  exitPrice: number;
  exitReason: 'stop_loss' | 'take_profit' | 'time_stop' | 'trailing_stop' | 'liquidation_guard' | 'manual';
  pnlUsd: number;
  pnlPct: number;
  holdDurationSeconds: number;
  fundingPaidUsd: number;     // total funding paid/received while holding
  feesUsd: number;
  closedAt: string;
};
```

---

### 3. LLM Autonomy at Entry

The LLM sets the exit parameters at entry time as part of the `ExpressionPlan`. This is where its reasoning matters:

- A high-conviction reflexivity setup with an imminent catalyst might warrant a tighter take profit (3%) and a wider stop (4%) — the trade should resolve quickly.
- A funding-rate-carry trade with no specific catalyst might use a wider take profit (8%), tighter stop (2%), and longer max hold (120 hours) — the edge accumulates over time.
- A volatile small-cap perp should have a wider stop (5%) to avoid noise, but a strict time stop (24 hours) because liquidity can evaporate.

The LLM picks the parameters. The system enforces them. The LLM **cannot** modify stop/TP/time parameters after entry. If conditions change materially, the correct action is to close the trade (via the `close_position` tool) and re-enter with new parameters if warranted.

#### 3.1 Parameter Bounds

The LLM's choices are bounded by config to prevent insane parameterization:

```yaml
trade_management:
  defaults:
    stop_loss_pct: 3.0
    take_profit_pct: 5.0
    max_hold_hours: 72
    trailing_stop_pct: 2.0
    trailing_activation_pct: 1.0

  bounds:
    stop_loss_pct:    { min: 1.0, max: 8.0 }
    take_profit_pct:  { min: 2.0, max: 15.0 }
    max_hold_hours:   { min: 1, max: 168 }     # 1 hour to 7 days
    trailing_stop_pct: { min: 0.5, max: 5.0 }
```

#### 3.2 Stop Loss and Account Risk

A `stopLossPct` expressed as percentage of entry price is necessary for the position monitor, but **position sizing should be derived from max acceptable USD loss, not the other way around**. A 3% stop on a 5x leveraged position is a 15% margin loss. On a $20 account, that's $3 gone.

The `maxLossUsd` field in `TradeEnvelope` makes this explicit:

```
maxLossUsd = (stopLossPct / 100) * notionalUsd
marginRiskPct = (maxLossUsd / marginUsd) * 100
accountRiskPct = (maxLossUsd / totalAccountEquity) * 100
```

**Constraint:** `accountRiskPct` must not exceed a configurable cap (default: `5%`). If the proposed stop + size + leverage would risk more than 5% of account equity, reduce `size` until it fits. This is enforced at entry time, before the order is placed.

```yaml
trade_management:
  max_account_risk_pct: 5.0   # max % of total equity at risk per trade
```

---

### 4. Signal Convergence Requirements

The current system allows the LLM to enter trades on a single signal. This produces noisy entries. The following convergence rules should be enforced **before** the LLM sees the opportunity:

#### 4.1 Minimum Signal Count

An `ExpressionPlan` is only generated when the `SignalCluster` contains **at least 2 non-neutral signals pointing in the same direction**.

#### 4.2 Signal Hierarchy

Weight signals and require a threshold (suggest `1.5`) before generating an expression.

#### 4.3 Time Horizon Alignment

Signals with `timeHorizon: 'minutes'` should not drive entries for `timeHorizon: 'days'` trades. The cluster's effective time horizon should be the **shortest** horizon among high-weight contributing signals.

---

### 5. Learning Loop

#### 5.1 Pre-Scan Journal Review

Before every autonomous scan, pull last 20 closed trades and include a summary in the LLM context.

#### 5.2 Post-Trade Reflection

After every close, record a constrained reflection grounded in recorded facts.

#### 5.3 Signal Effectiveness Tracking

Track signal kind performance and surface warnings when signals are net-negative.

---

### 6. Position Monitor Implementation

Monitor runs independently from scan. **Active positions** require tighter monitoring.

#### 6.0 Exchange-Side Stop Orders (Preferred)

Where supported, place reduce-only TP/SL trigger orders at entry and use polling as a backup.

#### 6.1 Close Execution Policy

Define a retry and incident policy for close failures (do not silently leave positions open).

---

### 7. Anti-Overtrading Rules

Cap concurrent positions, symbol cooldown, daily entries, and enforce a loss-streak pause.

---

### 8. The No-Trade Default

System prompt addition: default to no trade; most scans should take no action.

---

### 9. Implementation Priority

Envelope -> monitor -> convergence -> journal summary -> reflection -> anti-overtrading -> signal effectiveness.

---

### 10. What This Doesn't Change

Reflexivity remains core; discovery pipeline unchanged; LLM controls entry; system controls exits.
