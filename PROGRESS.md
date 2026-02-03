# Thufir Progress

Last updated: 2026-02-02

## North Star
Autonomous trading assistant for prediction markets with strong guardrails:
- AI makes trade decisions autonomously
- Proactively finds opportunities based on current events
- Wallet safety and limits enforced at every step
- Every prediction and trade logged for calibration
- Full conversational interface for discussing predictions

## New Design Docs (2026-01-30)

These docs formalize Thufir’s next evolution: from “autonomous trader + chat” into an **agentic system** and a **fragility/black-swan detector** (mentat framing).

- `BLACK_SWAN_DETECTOR.md`
  - Mentat loop: detect **fragility and tail-risk exposure** instead of predicting events.
  - First-class objects: `Assumption`, `Mechanism`, `FragilityCard`.
  - `FragilityScore` and four structural detectors: leverage, coupling, illiquidity, consensus.
  - Standard output: Mentat Report + monitoring checklist.

- `AGENTIC_THUFIR.md`
  - Agentic-first architecture: **Reason → Plan → Tool → Observe → Update → Decide**.
  - Plan objects, tool registry, memory-before-reasoning, reflection + critic pass.
  - Provider independence: agent loop sits above `llm-mux`.
  - Execution modes: Chat Mode vs Agent Mode (`thufir agent run <goal>`).

- `AGENT_ORCHESTRATION.md`
  - Implementation contract / alias for the agentic-first transformation.
  - Defines orchestration rules, tool invocation contract, multi-agent roles, and loop semantics.
  - Should be kept in sync with `AGENTIC_THUFIR.md` (same design, implementation-focused framing).

- `LLM_INFRASTRUCTURE_AND_EXECUTION_CONTROL.md`
  - Treats LLMs as shared infrastructure with explicit budgets and cooldowns.
  - Introduces execution modes (`MONITOR_ONLY`, `LIGHT_REASONING`, `FULL_AGENT`) enforced before any LLM call.
  - Defines backpressure, retry suppression, and provider cooldown behavior.
  - Collapses multi-call chains and gates critic execution.
  - Offloads trivial tasks (summarization, compression, extraction) to free local LLMs (Ollama).
  - Ensures graceful degradation under rate limits instead of cascading failures.

## Plan (from Claude feedback, adjusted for autonomous trading)

### V1: Autonomous Core (Week 1-2) - MOSTLY COMPLETE
- [ ] Fork Clawdbot (gateway + sessions) - using lightweight substitute
- [x] Basic Augur read/write
- [x] AI trade decision loop (autonomous scanning)
- [x] Record every prediction + trade
- [x] **Conversational chat** - free-form discussion about events/markets

### V8: Platform Migration - Augur Turbo
- [x] **Augur Client** - GraphQL subgraph queries for markets
- [x] **AMM Trader** - Direct contract interaction for buy/sell
- [x] **Execution Adapter** - `AugurLiveExecutor` implementing `ExecutionAdapter`
- [x] **Market Normalization** - Convert Augur markets to common `Market` interface

See: `docs/AUGUR_IMPLEMENTATION.md`

### V9: Technical Analysis Pivot (NEW PRIORITY)
**Goal:** Add short-term crypto trading capabilities via technical analysis.

**Phase 1: Price Data + Indicators**
- [x] Add CCXT for exchange data (Binance, etc.)
- [x] Implement PriceService with OHLCV caching
- [x] Add `technicalindicators` package
- [x] Core indicators: RSI, MACD, Bollinger Bands, Moving Averages
- [x] CLI: `thufir ta <symbol>` - show technical snapshot

**Phase 2: Signal Generation**
- [x] TechnicalSnapshot generation across timeframes
- [x] Signal scoring algorithm (-1 to 1)
- [x] Fuse with existing news sentiment (weighted combination)
- [x] CLI: `thufir signals` - show current signals

**Phase 3: On-Chain Data**
- [ ] Coinglass integration (funding rates, OI, liquidations)
- [ ] Whale Alert integration (large transactions)
- [x] On-chain signal scoring (neutral placeholder)
- [x] Add to signal fusion (neutral when disabled)

**Phase 4: Strategy Framework**
- [x] Strategy interface (entry/exit conditions, risk params)
- [x] Implement strategies: Trend Following, Mean Reversion, News Catalyst
- [x] CLI: `thufir strategy <name>` - run strategy scan

**Phase 5: Execution**
- [x] Map technical signals to Augur crypto markets (basic strike/timeframe match)
- [ ] Signal → Bet decision → Execute flow
- [ ] Track signal accuracy in calibration system

**Architecture:**
```
Intel Layer (news) + Technical Layer (TA) + On-Chain Data
                    ↓
              Signal Fusion
                    ↓
         Strategy Evaluation
                    ↓
    Augur Turbo Crypto Markets (BTC/ETH above/below X)
```

See: `docs/TECHNICAL_ANALYSIS_PIVOT.md`

### V10: Manifold Markets Integration (Calibration Platform)
**Goal:** Use Manifold (play money) to calibrate event-driven predictions before real money.

- [ ] **ManifoldClient** - Full API wrapper (markets, bets, users)
- [ ] **ManifoldExecutor** - Implements `ExecutionAdapter` interface
- [ ] **Market Normalization** - Convert to common `Market` interface
- [ ] **Calibration Tracker** - Brier scores, calibration curves
- [ ] **CLI Commands** - `thufir manifold search/bet/portfolio/calibration`
- [ ] **Connect to Intel Layer** - Cross-reference news with Manifold markets
- [ ] **Shadow Mode** - Record predictions without betting (baseline)
- [ ] **Autonomous Mode** - Small bets, tune thresholds

**Why Manifold:**
- Play money (Mana) = zero financial risk
- General event markets (politics, tech, culture) = matches Thufir's intel-driven design
- Free API, generous rate limits
- Perfect for calibration before real money deployment

**Calibration Workflow:**
1. Shadow mode (record predictions, no bets) → baseline data
2. Small bets (10-50 mana) → tune confidence thresholds
3. Full deployment → apply learnings to real money

See: `docs/MANIFOLD_INTEGRATION.md`

### V2: Memory & Calibration (Week 3-4) - COMPLETE
- [x] Track outcomes when markets resolve
- [x] Brier score + calibration by domain
- [x] Over/under-confidence reporting in LLM prompts

### V3: Intel Layer (Week 5-6) - COMPLETE
- [x] RSS feeds
- [x] Daily briefing
- [x] Alerts for position-impacting news
- [x] NewsAPI integration
- [x] Twitter/X integration
- [x] Google News (SerpAPI) integration
- [x] Vector search (SQLite embeddings)

### V4: Proactive Intelligence (NEW PRIORITY)
- [x] **Daily Top 10 Trades**: Cross-reference news with markets, find edge
- [x] **Event-driven scanning**: When news breaks, find affected markets
- [x] **Full autonomous mode toggle**: On/off for auto-betting with P&L reports
- [ ] Fork Clawdbot for proactive search capabilities

### V5: Semi-Automated Controls (Week 7-8)
- [ ] Optional approval rules and risk flags
- [ ] Pause on loss streaks
- [ ] Learn approval patterns

### V6: Specialize (Week 9+)
- [ ] Pick one domain (politics? crypto? sports?)
- [ ] Deep prompts + specialized data sources
- [ ] Trade only where edge exists

### V7: Mentat + Agentic-First (NEW PRIORITY)
- [x] **Agentic-first orchestration layer** (`AGENT_ORCHESTRATION.md`)
  - Tool registry + tool invocation contract (no guessing when fetch is required)
  - Plan objects + loop runner (Reason → Plan → Tool → Observe → Update → Decide)
  - Reflection step after tool results
  - Critic/self-audit pass before final output
  - CLI agent mode: `thufir agent run <goal>`

- [x] **Fragility / Black Swan Detector** (`BLACK_SWAN_DETECTOR.md`)
  - Implemented: `Assumption`/`Mechanism`/`FragilityCard` storage + delta tracking
  - Implemented: detector bundle + fragility score + mentat scan/report CLI
  - Implemented: multi-agent mentat loop (Cartographer/Skeptic/Risk Officer) with merged outputs
  - Implemented: mentat auto-scan/report appended in chat, daily reports, and autonomous P&L report (config-gated)
  - Implemented: scheduled mentat monitoring + alerts (gateway)
  - **Implemented: pre-trade fragility analysis + fragility-aware critic**
  - Implemented: multi-timescale monitoring via mentat schedules + system map persistence
- [x] **Evaluation dashboard + decision audit**
  - Implemented: CLI `thufir eval` summary (live-mode metrics)
  - Implemented: decision_audit table + logger for trade/process metrics
  - Implemented: evaluation summary tool for agent/CLI consumption

- [x] **Identity invariance enforcement**
  - Guarantee identity injection on every LLM call regardless of provider/path
  - Ensure tool calls and multi-agent flows cannot bypass identity prelude
  - Implemented across Anthropic/OpenAI + internal/trivial paths

- [x] **LLM Infrastructure & Execution Control**
  - Global call/token budget with critical reserves
  - Provider cooldown + backpressure (no retry spirals)
  - Execution mode selection enforced before any LLM call
  - Deterministic fast-path scans (idle cycles = 0 LLM calls)
  - Trivial task offload to local LLM (Ollama)
  - Enforced across non-user-facing and background paths

## Current Work Log

### 2026-02-02 (Session 14)
- **Platform Migration Decision: Augur Turbo**
  - Decided to migrate to Augur Turbo as alternative

- **Augur Research**
  - Augur Turbo: AMM on Polygon, sports/crypto markets, active but limited
  - Augur v2: Ethereum mainnet, rebooting, low activity
  - Created `docs/AUGUR_IMPLEMENTATION.md` - migration guide

- **Strategic Pivot: Short-Term Trading + Technical Analysis**
  - Problem: Thufir designed for event-driven prediction (news → bet on outcomes)
  - Augur Turbo markets (crypto prices, sports) don't match intel-driven approach
  - Solution: Add technical analysis layer for short-term crypto trading
  - Created `docs/TECHNICAL_ANALYSIS_PIVOT.md` - comprehensive design

- **Technical Analysis Components Designed**
  - Price Data: CCXT for OHLCV from Binance/exchanges
  - Indicators: RSI, MACD, Bollinger Bands, Moving Averages (via `technicalindicators` npm)
  - On-Chain: Coinglass (funding rates, OI), Whale Alert
  - Signal Fusion: Combine TA + existing news sentiment + on-chain
  - Strategies: Trend Following, Mean Reversion, News Catalyst
  - Execution: Map signals to Augur crypto markets

- **New Architecture**
  - Intel Layer (existing) + Technical Layer (new) → Signal Fusion → Strategy → Execute
  - Keeps existing news/intel as confirming factor
  - TA becomes primary signal generator for short-term trades

### 2026-02-02 (Session 15)
- **Augur Turbo Implementation (Core)**
  - Added Augur subgraph client + normalizer + AMM trader + live executor.
  - Replaced legacy live execution paths with `AugurLiveExecutor`.
  - Added Augur config defaults + wallet RPC alignment.
- **Market/Tool Updates**
  - Market cache sync now uses Augur client.
  - Tools updated to describe Augur market IDs and AMM behavior.
  - Order book + price history tools return Augur-safe snapshots.
- **Infra Cleanup**
  - Removed legacy stream usage from gateway (Augur has no stream).
  - Updated whitelist to Augur contracts and tests accordingly.
  - Removed legacy tests (comments, stream) and updated remaining tests/configs.
  - Removed legacy execution/comment code paths and added Augur subgraph positions to portfolio output.
  - Updated ExecutionAdapter contract (open orders + cancel) and aligned docs.
  - Implemented technical analysis pivot core: price service, indicators, signals, strategy CLI, Augur mapping.

- **Manifold Markets Integration (Calibration Platform)**
  - Play money (Mana) for zero-risk calibration
  - General event markets match Thufir's intel-driven design
  - Created `docs/MANIFOLD_INTEGRATION.md` - full implementation guide
  - API: REST + WebSocket, 500 req/min, free
  - Calibration tracking: Brier scores, calibration curves, overconfidence ratio
  - Workflow: Shadow mode → Small bets → Full deployment → Apply to real money

### 2026-02-01 (Session 12)
- **LLM infrastructure hardening**
  - Identified rate-limit failures as execution-shape issue (not provider tier)
  - Designed execution-mode gating (MONITOR_ONLY / LIGHT_REASONING / FULL_AGENT)
  - Added local LLM path for trivial tasks (Ollama-compatible)
  - Consolidated budget, cooldown, and backpressure rules into
    `LLM_INFRASTRUCTURE_AND_EXECUTION_CONTROL.md`
  - Began refactor to eliminate LLM calls from idle scans and low-signal paths
- **Evaluation dashboard + decision audit**
  - Added CLI evaluation dashboard (`thufir eval`) for live-mode metrics
  - Added decision_audit table + logger for trade/process metrics
  - Added evaluation summary tool for agent/CLI consumption
- **OpenClaw gateway vendor + launcher**
  - Vendored OpenClaw repo in `vendor/openclaw`
  - Added `thufir gateway --openclaw` to launch OpenClaw gateway
  - Added `scripts/start-all.sh` to start OpenClaw + Thufir gateways with logs/pids
  - Updated `scripts/update.sh` to pull/install OpenClaw and restart `openclaw-gateway` when present

### 2026-02-01 (Session 13)
- **Agentic UX + persistence**
  - Added plan persistence + resume (session store, orchestrator resume)
  - Added CLI `thufir agent run` with tool/plan/critic/fragility traces
  - Tool-first guardrails for non-orchestrator chat (tool snapshot)
- **Mentat monitoring upgrades**
  - System map persistence + report inclusion
  - Multi-timescale mentat schedules (gateway)
- **LLM infra enforcement**
  - Execution contexts for non-chat/background LLM calls (decision, explain, research, proactive, mentat)
  - Identity prelude enforced for all providers/paths
- **CLOB positions**
  - Portfolio tool uses CLOB trade history in live mode
- **Tests**
  - `pnpm test` timed out (120s). Failures in `vendor/openclaw` tests (discord monitor, gateway agent e2e, embedded runner chdir in workers) and `vendor` suites. Node 22 installed via nvm; rerun still fails in vendor.

### 2026-02-01 (Session 11)
- **Pre-Trade Fragility Integration**
  - Added `runQuickFragilityScan()` for fast market-specific fragility analysis
  - Integrated fragility scan into orchestrator trade flow (runs before `place_bet`/`trade.place`)
  - Updated critic with fragility-aware review:
    - New issue types: `fragility_ignored`, `tail_risk_ignored`
    - Auto-reject high-fragility trades (>0.7) with any risk issues
    - Stricter review for moderate fragility (>0.5)
  - Added `TradeFragilityContext` to critic context
  - Added `FragilitySummary` to orchestrator result
  - Auto-display fragility trace for high-fragility trades (>0.6)
  - Config options: `enablePreTradeFragility` (default: true), `showFragilityTrace` (default: false)
  - Fixed pre-existing bugs: duplicate import in conversation.ts, missing `join` import in gateway/index.ts

### 2026-01-31 (Session 9)
- **Thufir rename + agentic integration**
  - Project renamed to Thufir (bin/script/envs/config paths)
  - Identity prelude loader + injector (THUFIR_HAWAT marker)
  - Workspace identity updated for Thufir Hawat (AGENTS/IDENTITY/SOUL/USER)
  - Added dot-notation tool aliases + new tools (`comments.get`, `memory.query`, `calculator`)
  - Conversation, opportunities, autonomous scan, and autonomous manager wired to orchestrator when enabled
  - Mentat storage tables + delta tracking implemented (assumptions/mechanisms/fragility cards)
  - Debug enforcement added in orchestrator (identity marker + tool/iteration logging)

### 2026-02-01 (Session 10)
- **Docs + status reconciliation**
  - Updated progress/docs to reflect agentic + mentat implementation reality
  - Added AGENT_ORCHESTRATION.md contract doc
  - Added optional tool trace + critic notes in chat responses (config flags)
  - Added optional mentat auto-scan/report in chat, daily reports, and autonomous P&L report (config flags)
  - Added optional plan trace in chat responses (config flag)
  - Added identity prompt modes to reduce token usage (default: full; internal: minimal)
  - Added mentat monitoring scheduler + alert channels (config flags)
  - Implemented mentat role loop (Cartographer/Skeptic/Risk Officer)
  - Added Clawdbot-style heartbeat scheduler + HEARTBEAT.md
  - Wired proactive search into heartbeat mode (config `notifications.proactiveSearch.mode: heartbeat`)
  - Added direct proactive search summaries (no LLM) to save tokens
  - Added CLI `intel proactive --send` for direct summaries

### 2026-01-30 (Session 8)
- **Mentat + Agentic-first design formalized**
  - Added `BLACK_SWAN_DETECTOR.md` (fragility detection + tail-risk exposure)
  - Added `AGENTIC_THUFIR.md` (agent loop, planning, tools, reflection, critic pass)
  - Added `AGENT_ORCHESTRATION.md` (implementation contract / alias)
- **Next implementation target**
  - Convert Thufir from chat-first to agentic-first: centralized tool registry + plan loop + memory retrieval before reasoning
  - Implement fragility objects + scoring and emit Mentat reports

### 2026-01-27 (Session 7)
- **LLM orchestration pipeline**
  - Claude (Sonnet 4.5) plans; OpenAI executes trade decisions
  - OpenAI fallback for planning on Anthropic rate limits
  - Info-digest compression for large contexts (token efficiency)
- **Multi-agent routing + partial isolation**
  - Per-agent session routing in gateway
  - Per-agent chat transcript storage (shared DB/ledger/intel)
  - Tests added for session isolation

### 2026-01-27 (Session 6)
  - Updated `Market` interface to include `conditionId`, `tokens`, `clobTokenIds`, `negRisk` fields
  - Added CLOB API methods for fetching market data with token IDs:
    - `getMarket(conditionId)` - fetch market with full token details
    - `listMarkets()` - list markets from CLOB API
    - `getTokenIds(conditionId)` - convenience method for token lookup
    - `isNegRiskMarket(conditionId)` - check market type
  - `LiveExecutor` now properly fetches token IDs from CLOB when not in market data
    - Added token ID cache to avoid repeated API calls
    - `fetchAndCacheTokenIds()` method for CLOB API fetching
    - `getTokenId()` never falls back to market ID (was broken)
    - `checkNegRiskMarket()` now async, fetches from CLOB if needed
  - Market normalization extracts token IDs from various API formats
  - Added `enrichWithTokenIds()` convenience method on market client
  - **New CLI commands**:
    - `thufir markets tokens <id>` - Fetch token IDs from CLOB for a market
    - `thufir markets clob-status` - Test CLOB API connectivity
  - Fixed TypeScript errors in `stream.ts` (EventEmitter super() call)
  - All execution tests passing (8/8)

### 2026-01-26 (Session 5)
- **Conversational intel alert setup**
- **Alert scoring + ranking** (keywords/entities/sentiment)
- **Intel retention pruning** + CLI preview
- **Docs/config alignment**
- **Intel source registry + roaming controls** (trust thresholds, social opt-in)
- **Env setup + validation CLI** (`thufir env init`, `thufir env check`) + `.env.example`

### 2026-01-26 (Session 4)
- **Persistent chat memory (Clawdbot-style)** with JSONL transcripts + summaries
- **Automatic compaction** with rolling summary and transcript rewrite
- **Semantic memory recall** via embeddings (OpenAI or Google)
- **Intel vector search** with SQLite embeddings
- **New intel sources**: NewsAPI, Google News (SerpAPI), Twitter/X
- **Scheduled jobs**: daily report push, outcome resolver, intel fetch
- **CLI upgrades**: portfolio view, trade buy/sell, wallet limits show/set, memory inspect/compact
- **Default model switched** to `claude-sonnet-4-5-20251101`

### 2026-01-26 (Session 3)
- **Implemented Daily Top 10 Opportunities** (`src/core/opportunities.ts`)
  - Scans markets and cross-references with recent news
  - LLM estimates probabilities and identifies edge
  - Ranks opportunities by edge * confidence
  - `/top10` command to get daily opportunities report
  - Formats nice report with reasoning and suggested amounts

- **Implemented Full Autonomous Mode** (`src/core/autonomous.ts`)
  - `AutonomousManager` class handles all autonomous trading
  - On/off toggle via `/fullauto on|off` commands
  - Auto-executes trades when edge detected (respects limits)
  - Tracks P&L and consecutive losses
  - Auto-pauses after configurable loss streak
  - Daily P&L report scheduled at configurable time
  - Events: `trade-executed`, `opportunity-found`, `daily-report`, `paused`, `resumed`

- **New Config Options** (in `config.yaml`):
  ```yaml
  autonomy:
    fullAuto: false          # Master toggle for auto-execution
    minEdge: 0.05            # Minimum edge to trade (5%)
    requireHighConfidence: false
    pauseOnLossStreak: 3     # Pause after N losses
    dailyReportTime: "20:00" # P&L report time
    maxTradesPerScan: 3
