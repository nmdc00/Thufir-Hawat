# Thufir

Thufir is an autonomous crypto/perps trading agent built around one idea: let the LLM reason about market context and trade thesis, but keep execution, sizing, and risk controls deterministic.

The current codebase runs through a gateway process, is operated in practice through Telegram, persists state in SQLite, and targets Hyperliquid for perp trading. Paper mode is the default. CLI commands still exist for local development and debugging.

## Current Model

Thufir is not a pure rules engine and not a pure chat trader.

- Discovery, trade thesis, and narrative judgment can use LLM reasoning.
- Execution gates, sizing caps, journal writes, and most risk controls are deterministic.
- Open-position management now has a coherence loop from `v1.97`:
  - `PositionBook` tracks open positions in shared in-memory state.
  - `LlmEntryGate` can approve, reject, or resize new trades before execution.
  - `LlmExitConsultant` can re-evaluate open positions during heartbeat ticks.
  - `PositionHeartbeatService` still enforces mechanical trigger paths even when LLM consultation is disabled.

## Current Decision Flow

Today, the key autonomous trading path is:

```text
candidate/proposal
  -> deterministic risk + wallet checks
  -> LlmEntryGate
  -> executor
  -> journals / learning writes
```

The important current code seams are:

- `src/core/autonomous.ts`
  Builds candidates, runs deterministic checks, calls the entry gate, and executes.
- `src/core/llm_entry_gate.ts`
  Accepts a structured candidate and returns `approve`, `reject`, or `resize`, plus optional leverage guidance.
- `src/core/autonomy_policy.ts`
  Applies deterministic policy gating/downweighting before execution.
- `src/core/perp_lifecycle.ts`
  Builds execution-quality learning artifacts on close.

This means the repo already has a real pre-execution control point. The next step is to make learned evidence first-class there instead of keeping it mostly post-trade.

## Adaptive Learning Direction

The v2.x learning direction is:

```text
trade/decision
  -> dossier
  -> review
  -> counterfactuals
  -> retrieval features
  -> policy evidence
  -> future decision-time enforcement
```

The intended v2.2 enforcement model is:

```text
candidate/proposal
  -> deterministic hard risk checks
  -> retrieval lookup
  -> active policy lookup
  -> adaptive decision enforcement
  -> LlmEntryGate
  -> executor
```

The goal is to answer three hard questions with explicit wiring:

1. Can retrieval really alter live decisions?
   Yes, but only through bounded modifiers such as confidence haircuts, size haircuts, leverage caps, confirmation escalation, or reject-band escalation.
2. Can policy really resize/reject based on learned evidence?
   Yes, but only through a deterministic enforcement layer with minimum evidence thresholds, bounded deltas, and expiry.
3. Can weak evidence be prevented from poisoning the loop?
   Yes, by requiring evidence counts, confidence, freshness, contradiction checks, and missing-data flags before learned signals gain real authority.

This is documented in:
- [release/v2.2-adaptive-decision-learning.prd.md](/home/nmcdc/projects/Thufir-Hawat/release/v2.2-adaptive-decision-learning.prd.md)
- [release/v2.2-adaptive-decision-learning.tdd.md](/home/nmcdc/projects/Thufir-Hawat/release/v2.2-adaptive-decision-learning.tdd.md)
- [release/v2.3.3-production-sanity-fixes.tdd.md](/home/nmcdc/projects/Thufir-Hawat/release/v2.3.3-production-sanity-fixes.tdd.md)

## Architecture

```text
Channels (CLI / Telegram / WhatsApp)
  -> Gateway
    -> Agent
      -> AutonomousManager
      -> ConversationHandler
      -> TradeManagementService
      -> PositionHeartbeatService
    -> Memory (SQLite journals/state)
    -> Intel / Search / Market data
    -> Execution adapters (paper / live Hyperliquid / webhook)
```

Operationally, the live channel in use is Telegram. CLI remains useful for local inspection and development workflows.

Key runtime pieces:

- `src/gateway/index.ts`: process entrypoint, channel wiring, schedulers, heartbeat startup
- `src/core/agent.ts`: agent assembly and LLM client accessors
- `src/core/autonomous.ts`: scan loop, policy filters, entry gate, execution
- `src/core/position_heartbeat.ts`: polling-based position supervision and exit actions
- `src/core/position_book.ts`: shared open-position view used by entry/exit coherence logic
- `src/core/llm_entry_gate.ts`: approve/reject/resize gate for new autonomous trades
- `src/core/autonomy_policy.ts`: deterministic pre-execution policy filters and downweight logic
- `src/core/perp_lifecycle.ts`: closed-trade execution-learning case construction
- `src/trade-management/`: exchange-native risk controls and stop management
- `src/memory/`: SQLite-backed journals, policy state, sessions, alerts, artifacts

## What `v1.97` Added

- Shared `PositionBook` state for open positions
- LLM entry gating before autonomous execution
- LLM exit consultation during heartbeat supervision
- Config switches to disable either LLM path without removing the mechanical loop
- Acceptance coverage for fallback behavior and toggle behavior

This matters because the system now has a tighter feedback loop between:

1. why a trade was opened
2. what other positions are already live
3. whether new trades conflict with the existing book
4. whether an open thesis still makes sense as market context changes

## Current Learning State

The current tree has real learning infrastructure, but it is still uneven:

- implemented today:
  - `execution_quality` learning case generation on close
  - entry-gate journaling
  - deterministic risk / wallet enforcement
  - proposal-to-gate-to-execution control path
- partially implemented or planned in release docs:
  - dossier-backed learning
  - thesis-vs-execution separation
  - structured trade review
  - retrieval-driven decision support
  - adaptive policy enforcement

In other words, the repo already supports learning artifacts, but the main open problem is wiring those artifacts back into future decisions with bounded authority.

## Quick Start

### Prerequisites

- Node.js `22.x`
- `pnpm` `9.x`
- one of:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
- for live Hyperliquid trading only:
  - `HYPERLIQUID_PRIVATE_KEY`

### Install

```bash
git clone git@github.com:nmdc00/Thufir-Hawat.git
cd Thufir-Hawat
pnpm install
cp config/default.yaml ~/.thufir/config.yaml
```

### Run

```bash
pnpm thufir --help
pnpm thufir gateway
```

Useful commands:

```bash
pnpm thufir env verify-live --symbol BTC
pnpm thufir auto status
pnpm thufir intel search "btc funding"
pnpm thufir mentat scan --system Hyperliquid
```

## Configuration

Primary config file: `~/.thufir/config.yaml`

Reference defaults live in [config/default.yaml](/home/nmcdc/projects/Thufir-Hawat/config/default.yaml).

### Execution Mode

```yaml
execution:
  mode: paper      # paper | webhook | live
  provider: hyperliquid
```

### Autonomous Scan

```yaml
autonomy:
  enabled: false
  fullAuto: false
  scanIntervalSeconds: 900
  maxTradesPerScan: 3
  maxTradesPerDay: 25
  minEdge: 0.05
  pauseOnLossStreak: 3
```

### LLM Entry Gate

```yaml
autonomy:
  llmEntryGate:
    enabled: true
    timeoutMs: 5000
    rejectOnBothFail: true
```

Meaning:

- `enabled`: skip the LLM gate entirely when `false`
- `timeoutMs`: timeout for each gate call
- `rejectOnBothFail`: if both primary and fallback LLM calls fail, reject by default when `true`

### Position Heartbeat + LLM Exit Consult

```yaml
heartbeat:
  enabled: true
  tickIntervalSeconds: 30
  rollingBufferSize: 60
  triggers:
    pnlShiftPct: 1.5
    liquidationProximityPct: 5.0
    volatilitySpikePct: 2.0
    volatilitySpikeWindowTicks: 10
    timeCeilingMinutes: 0
    triggerCooldownSeconds: 180
  llmExitConsult:
    enabled: true
    firstConsultMinutes: 20
    cadenceMinutes: 20
    roeThresholds: [3, 7, 15]
    approachTtlMinutes: 15
    timeoutMs: 8000
```

Meaning:

- heartbeat triggers still enforce mechanical exits/reductions
- `timeCeilingMinutes: 0` disables the generic max-hold close so thesis time stops and the exit consultant govern duration
- `llmExitConsult.enabled: false` keeps the rules-only heartbeat path
- the consultant can be triggered by time held, ROE threshold crossings, or thesis TTL approach

### Trade Management

```yaml
tradeManagement:
  enabled: false
  defaults:
    stopLossPct: 3.0
    takeProfitPct: 5.0
    maxHoldHours: 72
  monitorIntervalSeconds: 900
  activeMonitorIntervalSeconds: 60
  useExchangeStops: true
  liquidationGuardDistanceBps: 800
```

### Proactive Refresh

```yaml
agent:
  proactiveRefresh:
    enabled: false
    intentMode: time_sensitive   # off | time_sensitive | always
    ttlSeconds: 900
    maxLatencyMs: 4500
    strictFailClosed: true
```

## Command Surface

### CLI (local/dev)

```bash
thufir env verify-live --symbol BTC
thufir wallet status
thufir portfolio
thufir intel search "btc funding"
thufir intel fetch
thufir chat
thufir ask "macro setup this week"
thufir mentat scan --system Hyperliquid
thufir delphi run --symbol BTC --horizon-hours 24 --count 3
thufir auto status
thufir auto report
thufir gateway
```

### Telegram Commands

- `/help`
- `/status`
- `/report`
- `/briefing`
- `/intel`
- `/watch <symbol>`
- `/watchlist`
- `/scan`
- `/delphi ...`
- `/perp <symbol> <buy|sell> <sizeUsd> [leverage]`
- `/markets <query>`
- `/analyze <symbol>`
- `/fullauto on|off`
- `/pause`
- `/resume`

## Deployment

### Local / VPS

```bash
pnpm install
cp config/default.yaml ~/.thufir/config.yaml
pnpm thufir gateway
```

### Server Pattern Used In Production

- systemd service runs `pnpm thufir gateway`
- config path is injected with `THUFIR_CONFIG_PATH`
- repo is built in place with:

```bash
bash scripts/update.sh
```

That script expects the server checkout to be on the intended branch and able to fast-forward cleanly.

## Project Layout

```text
src/
  agent/
  core/
  delphi/
  discovery/
  execution/
  gateway/
  intel/
  markets/
  memory/
  mentat/
  trade-management/
config/
docs/
scripts/
tests/
```

## Development

Standard checks:

```bash
pnpm typecheck
pnpm vitest run
```

If the suite is sharing a stale DB path, isolate it explicitly:

```bash
THUFIR_DB_PATH=/tmp/thufir-test.sqlite pnpm vitest run
```

## Safety Notes

- Do not enable `fullAuto` with loose wallet limits.
- Keep live mode off until paper behavior is stable.
- Do not store private keys in committed config.
- Review Telegram gateway exposure carefully before binding outside loopback.

## License

MIT. See `LICENSE`.

## Disclaimer

Trading perpetual futures can result in total loss. This repository is engineering software, not financial advice.
