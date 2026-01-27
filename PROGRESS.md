# Bijaz Progress

Last updated: 2026-01-27

## North Star
Autonomous trading assistant for prediction markets with strong guardrails:
- AI makes trade decisions autonomously
- Proactively finds opportunities based on current events
- Wallet safety and limits enforced at every step
- Every prediction and trade logged for calibration
- Full conversational interface for discussing predictions

## Plan (from Claude feedback, adjusted for autonomous trading)

### V1: Autonomous Core (Week 1-2) - MOSTLY COMPLETE
- [ ] Fork Clawdbot (gateway + sessions) - using lightweight substitute
- [x] Basic Polymarket read/write
- [x] AI trade decision loop (autonomous scanning)
- [x] Record every prediction + trade
- [x] **Conversational chat** - free-form discussion about events/markets

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
- [x] Polymarket comments integration
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

## Current Work Log

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
- **Polymarket CLOB Execution Adapter - Token ID Resolution Fixed**
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
    - `bijaz markets tokens <id>` - Fetch token IDs from CLOB for a market
    - `bijaz markets clob-status` - Test CLOB API connectivity
  - Fixed TypeScript errors in `stream.ts` (EventEmitter super() call)
  - All execution tests passing (8/8)

### 2026-01-26 (Session 5)
- **Conversational intel alert setup**
- **Alert scoring + ranking** (keywords/entities/sentiment)
- **Intel retention pruning** + CLI preview
- **Docs/config alignment**
- **Intel source registry + roaming controls** (trust thresholds, social opt-in)
- **Env setup + validation CLI** (`bijaz env init`, `bijaz env check`) + `.env.example`

### 2026-01-26 (Session 4)
- **Persistent chat memory (Clawdbot-style)** with JSONL transcripts + summaries
- **Automatic compaction** with rolling summary and transcript rewrite
- **Semantic memory recall** via embeddings (OpenAI or Google)
- **Intel vector search** with SQLite embeddings
- **New intel sources**: NewsAPI, Google News (SerpAPI), Twitter/X, Polymarket comments
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
  ```

- **New Commands**:
  - `/top10` or `/opportunities` - Get daily top 10 trades
  - `/fullauto [on|off]` - Toggle autonomous execution
  - `/pause` - Pause autonomous trading
  - `/resume` - Resume autonomous trading
  - `/status` - Show status and today's P&L
  - `/report` - Full daily report

- **New CLI Commands**:
  - `bijaz top10` - Get opportunities
  - `bijaz auto status` - Show autonomous status
  - `bijaz auto report` - Generate daily report

- Updated agent to integrate AutonomousManager
- Updated PredictionInput to include executed/executionPrice/positionSize
- Added autonomous_trades table for tracking auto trades
- TypeScript compiles clean

### 2026-01-26 (Session 2)
- **Added conversational chat capability** (`src/core/conversation.ts`)
  - Free-form discussion about future events and predictions
  - Automatic market search when discussing topics
  - LLM gives probability estimates with reasoning
  - Conversation history per user
- Added market search to Polymarket client (`searchMarkets()`)
- Updated agent to route non-command messages to conversation handler
- Added new commands: `/ask`, `/analyze`, `/markets`, `/clear`, `/help`
- Updated CLI with working `bijaz chat` and `bijaz ask` commands
- Updated README with new conversational features and planned proactive intelligence

### 2026-01-26 (Session 1)
- Implemented local SQLite initialization and schema loading.
- Added prediction recording + listing + detail view via CLI.
- Added config loader + logger.
- Implemented LLM provider selection (Anthropic/OpenAI/local).
- Added Polymarket market data client (Gamma API).
- Added autonomous agent loop + decision engine.
- Added Telegram polling adapter + WhatsApp Cloud API webhook adapter.
- Added gateway server and execution adapters (paper + webhook).
- Added watchlist helpers and wallet audit logging.
- Updated README with autonomy, execution modes, channels, and provider options.
- Added RSS intel pipeline + storage, CLI intel fetch/recent, and `/intel` + `/briefing` chat commands.
- Added calibration summaries, outcome resolver, and daily briefing scheduler.
- Implemented intel search, richer briefings, and user profile memory.
- Added wallet keystore encryption, wallet CLI commands, and wallet loading helper.

## What's Working (as of 2026-01-27)
- [x] Conversational chat about events/markets
- [x] Market search and analysis (`/ask`, `/analyze`, `/markets`)
- [x] **Daily Top 10 Opportunities** (`/top10`)
- [x] **Full autonomous mode with toggle** (`/fullauto on|off`)
- [x] **P&L tracking and daily reports** (`/status`, `/report`)
- [x] **Auto-pause on loss streaks**
- [x] Autonomous scanning with LLM decisions
- [x] Paper trading mode
- [x] Prediction recording and calibration
- [x] RSS intel pipeline
- [x] NewsAPI / Twitter / Google News / Polymarket comments intel
- [x] Semantic intel retrieval (embeddings)
- [x] Persistent chat memory with automatic compaction
- [x] Semantic chat memory recall
- [x] Telegram and WhatsApp adapters
- [x] Daily reports pushed to channels
- [x] Scheduled outcome resolver
- [x] Scheduled intel fetch
- [x] Conversational intel alert setup
- [x] Alert scoring + ranking
- [x] Intel alerts for watchlist-related news
- [x] Wallet keystore encryption
- [x] CLI commands
- [x] Portfolio/position tracking + balance reporting
- [x] Trade ledger with realized PnL
- [x] Market cache sync job + CLI
- [x] Proactive search (Clawdbot-style local loop)
- [x] Clawdbot-style session key routing (gateway + session keys)
- [x] Agent intelligence: research planner + decision explanations
- [x] Exposure limits enforced (per-market + per-domain)
- [x] Ledger vs on-chain balance reconciliation (CLI)
- [x] Daily PnL rollups (CLI)
- [x] Market data live subscriptions (watchlist-only + staleness fallback)
- [x] Live execution adapter (CLOB) implemented (requires live test trade)
- [x] Multi-agent routing with per-agent session isolation (chat)
- [x] LLM plan/execute pipeline (Claude plans, OpenAI executes)

## What's Missing
- [ ] **Live trading test** - Execute real trade on Polymarket (adapter code complete, needs testing)
- [ ] **Position tracking from CLOB** - Query positions from CLOB API (local ledger exists)
- [ ] Full Clawdbot fork (gateway + sessions + channels beyond Telegram/WhatsApp)
- [ ] ChromaDB vector search (optional; SQLite embeddings now exist)

## Next Steps (Priority Order)
1) **Test live execution with real Polymarket trade**
   - CLOB API integration: DONE
   - Token ID resolution: DONE
   - Order signing: DONE
   - Next: Execute $1 test trade on testnet/mainnet

2) **Add position tracking from CLOB API**
   - Query user positions from CLOB
   - Reconcile with local ledger
   - Display in CLI and chat

3) **Evaluate Clawdbot fork scope**
   - Keep lightweight routing + partial isolation
   - Decide on skills/plugin lifecycle + extra channels

3) **Fork Clawdbot for proactive search**
   - Multi-step reasoning
   - Autonomous news monitoring
