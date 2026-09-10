# Thufir — Autonomous Trading Agent

Thufir is an autonomous crypto/perpetuals trading system built around a deliberately asymmetric responsibility split:

```text
market data → LLM proposal → typed contract → deterministic risk engine
             → independent review → execution → position management
             → outcome / evaluation loop
```

The LLM supplies context, a thesis, and a proposed action. It does not get to decide whether that action may spend money. Execution, sizing, wallet limits, mechanical exits, persistence, and kill switches remain deterministic and auditable.

Thufir targets Hyperliquid perpetuals, persists state and decision evidence in SQLite, and is operated through a gateway with Telegram as the primary operational interface. Paper mode is the safe repository default; the same execution boundary also supports a Hyperliquid live adapter when explicitly configured.

## Why this is an engineering project

This repository is a case study in putting an unreliable, probabilistic component inside a controlled production system. The interesting problems are not trading returns; they are the boundaries around autonomy:

- typed model contracts and runtime validation
- deterministic risk, wallet, leverage, and exposure limits
- independent pre-execution review and bounded resizing
- asynchronous execution and position supervision
- provider/model abstraction with fallback and budget controls
- kill switches, pause-on-loss-streak behavior, and fail-closed paths
- SQLite journals, incident feeds, observability, and replayable evaluation artifacts
- promotion/demotion of learned policy evidence with thresholds, expiry, and audit history

The intended production control loop is:

```text
Hyperliquid market data
  → discovery and trade thesis
  → structured proposal
  → deterministic risk / wallet checks
  → LLM entry gate (approve / reject / resize)
  → paper or live execution adapter
  → heartbeat supervision and mechanical risk actions
  → close finalization, learning case, and policy evidence
```

This is an autonomous execution system, not a chatbot with a trading prompt. The codebase contains both paper and live paths, but no README claim should be read as a promise of profitability or as evidence that live mode is enabled on every deployment.

## Production case study: when semantics were not enough

A useful failure pattern from the Paires application illustrates why the system has strict runtime boundaries:

```text
model output was semantically valid
  → runtime schema/contract mismatch
  → execution failed
  → stricter runtime validation and a regression evaluation were added
```

The lesson is broader than trading: a model can be “right” in natural language and still be unsafe for a typed runtime. Thufir therefore validates structured outputs at the boundary, records the decision and failure context, and keeps execution behind deterministic checks. The same approach is used for provider failures, stale or missing evidence, and mechanical position-management fallbacks.

## Architecture

```text
Telegram / CLI
      ↓
    Gateway ─────────────── Dashboard / status / incident feed
      ↓
    Agent ─────── LLM provider abstraction + fallback + budgets
      ↓
    AutonomousManager
      ├─ discovery / market context / proposal
      ├─ deterministic risk + wallet enforcement
      ├─ LlmEntryGate: approve / reject / resize
      └─ execution adapter: paper | webhook | Hyperliquid live
                              ↓
                    PositionHeartbeatService
                    ├─ mechanical exits and reductions
                    └─ optional LLM exit consultation
                              ↓
                    SQLite journals, dossiers,
                    incidents, learning cases, policy history
```

Operationally, the deployment pattern is a systemd-managed gateway with configuration injected through `THUFIR_CONFIG_PATH`; `scripts/update.sh` updates the server checkout. The exact live service state should be verified on the target host before describing a deployment as actively trading.

### What the inspected runtime evidence proves

The available SQLite operational snapshot is useful evidence, but it is not a substitute for checking the running host. It contains 168 perp-trade records: 136 explicitly marked `paper` and 32 older records marked `executed`. It contains no open paper positions and no rows yet in the entry-gate log, exit-consult log, incident log, learning-case table, or policy-adjustment table.

That means this repository can accurately claim that the control surfaces and persistence schema exist, while it should not claim that LLM entry/exit consultation, adaptive policy promotion, or live-capital execution are active on every deployment. Those claims require a fresh server-side check and runtime evidence.

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

This means the repo has a real pre-execution control point. The adaptive-learning work adds bounded policy evidence around that point, but the inspected runtime snapshot does not yet prove that those learned adjustments are being produced or applied in operation.

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
- [release/v2.2-adaptive-decision-learning.prd.md](release/v2.2-adaptive-decision-learning.prd.md)
- [release/v2.2-adaptive-decision-learning.tdd.md](release/v2.2-adaptive-decision-learning.tdd.md)
- [release/v2.3.3-production-sanity-fixes.tdd.md](release/v2.3.3-production-sanity-fixes.tdd.md)
- [release/v2.3.4-production-runtime-followup.tdd.md](release/v2.3.4-production-runtime-followup.tdd.md)
- [release/v2.3.5-exit-consult-context-hotfix.tdd.md](release/v2.3.5-exit-consult-context-hotfix.tdd.md)

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
- implemented in the tree but requiring runtime validation on each deployment:
  - dossier-backed learning
  - thesis-vs-execution separation
  - structured trade review
  - retrieval-driven decision support
  - adaptive policy enforcement

In other words, the repo contains the learning and enforcement surfaces, while the main operational question is whether a given deployment is generating enough trusted evidence to exercise them.

## Quick Start

### Prerequisites

- Node.js `22.x`
- `pnpm` `9.x`
- either an OpenAI API key or a launchdock-authenticated OpenAI/Codex account
- for live Hyperliquid trading only:
  - `HYPERLIQUID_PRIVATE_KEY`

### Install

```bash
git clone git@github.com:nmdc00/Thufir-Hawat.git
cd Thufir-Hawat
pnpm install
cp config/default.yaml ~/.thufir/config.yaml
```

### Paper-mode production install

For an Ubuntu/Debian VPS with a user-level systemd session, the production
installer provisions the complete config, launchdock, Ollama, and persistent
Thufir services. It pauses for the operator to authenticate the OpenAI
subscription; credentials are never stored in the repository:

```bash
git clone https://github.com/your-account/Thufir-Hawat.git
cd Thufir-Hawat
bash scripts/install_production.sh
```

During installation, run the displayed command in the same account:

```bash
launchdock auth login openai --no-browser
```

The installer queries launchdock after authentication, tests the models
available to that account, and asks the operator to select the primary model.
It then pulls `qwen2.5:1.5b-instruct`, enables user lingering, and smoke-tests
launchdock, Ollama, and the Thufir health endpoint. The resulting deployment
remains in paper mode until explicitly changed.

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

Reference defaults live in [config/default.yaml](config/default.yaml).

### LLM providers

The production setup uses launchdock for the subscribed OpenAI/Codex account
and Ollama for small local tasks:

```yaml
agent:
  provider: openai
  model: <model selected during launchdock setup>
  openaiModel: <model selected during launchdock setup>
  executorModel: <model selected during launchdock setup>
  executorProvider: openai

  useProxy: true
  proxyBaseUrl: http://127.0.0.1:8090

  localBaseUrl: http://127.0.0.1:11434
  trivialTaskProvider: local
  trivialTaskModel: qwen2.5:1.5b-instruct
```

The installer queries launchdock’s `/v1/models` endpoint after authentication,
tests the advertised models with a real request, and asks the operator to
select one. Do not hard-code a model ID in deployment automation: model
availability depends on the authenticated account and can change over time.

`fallbackModel` is a provider-specific fallback setting. It is not the local
Ollama model; local work is controlled by `trivialTaskProvider` and
`trivialTaskModel`.

The gateway binds to loopback by default. Remote access should be provided by
an authenticated channel or a separately configured reverse proxy; the
`gateway.auth` YAML block is not currently a supported gateway setting.

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
