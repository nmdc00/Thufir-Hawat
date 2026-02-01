# Thufir Development Progress

**Last Updated:** 2026-02-01

---

## Current Status: Trading Tools + Agentic Orchestration Complete

All trading tools implemented (Phases 12-17). Tool calling works with Anthropic and OpenAI fallback.

---

## Phase Completion

| Phase | Status | Notes |
|-------|--------|-------|
| 1. Foundation | COMPLETE | Project setup, wallet security |
| 2. Polymarket Integration | COMPLETE | Market data, order execution |
| 3. Memory & Predictions | COMPLETE | Prediction storage, calibration |
| 4. Intelligence Layer | COMPLETE | RSS, NewsAPI, vector storage |
| 5. Agent Reasoning | COMPLETE | LLM works with tool calling |
| 5.5. Tool Calling | COMPLETE | See [TOOL_CALLING_IMPLEMENTATION.md](./TOOL_CALLING_IMPLEMENTATION.md) |
| Agentic Orchestration | COMPLETE | Planner/reflect/critic loop integrated |
| Mentat / Black Swan | PARTIAL | Scan/report + storage done; roles/alerts pending |
| 9. Twitter Search | COMPLETE | Real-time Twitter + SerpAPI fallback |
| 10. Web Search | COMPLETE | SerpAPI + Brave fallback |
| 11. Web Fetch | COMPLETE | Readability + SSRF protection |
| 12. Current Time | COMPLETE | Temporal awareness |
| **13. Place Bet** | **COMPLETE** | Autonomous trading via tool |
| 14. Get Portfolio | COMPLETE | View positions/balance |
| 15. Get Predictions | COMPLETE | Betting history |
| 16. Get Order Book | COMPLETE | Market depth |
| 17. Price History | COMPLETE | Historical odds |
| 6. Channel Integration | IN PROGRESS | Telegram working |
| 7. Polish & Testing | NOT STARTED | |

---

## Current Sprint: Agentic + Mentat (PARTIAL)

### Tasks

- [x] Agentic orchestrator loop (plan -> tool -> reflect -> critic)
- [x] Integrations for chat/opportunities/autonomy (agent.useOrchestrator)
- [x] Mentat storage + detectors + scan/report generators
- [x] CLI commands: `thufir mentat scan`, `thufir mentat report`
- [x] Surface plan/tool trace/critic notes to users (config flags)
- [x] Wire mentat reports into agentic runtime (config flags, chat + daily report + autonomous P&L)
- [x] Mentat role loop + monitoring alerts (gateway scheduler)
- [ ] E2E testing + deploy verification

### Phase 9 - Real-Time Twitter Search (Complete)

- [x] Add `twitter_search` tool schema
- [x] Implement Twitter API v2 direct search
- [x] Implement SerpAPI fallback
- [x] Update system prompt with twitter_search
- [x] Test hybrid fallback behavior (3 tests passing)

### Next: Phase 10 & 11 - Web Tools

See [WEB_TOOLS_IMPLEMENTATION.md](./WEB_TOOLS_IMPLEMENTATION.md)

**Phase 10: Web Search** (COMPLETE)
- [x] Add `web_search` tool schema
- [x] Implement SerpAPI search (primary)
- [x] Implement Brave Search fallback
- [x] Update system prompt
- [x] Add tests

**Phase 11: Web Fetch** (COMPLETE)
- [x] Add `web_fetch` tool schema
- [x] Install `@mozilla/readability`, `jsdom`
- [x] Implement `fetchAndExtract()` with Readability
- [x] Add timeout and SSRF protection
- [x] Update system prompt
- [x] Add tests

### Next: Phase 12-17 - Trading Tools

See [TRADING_TOOLS_IMPLEMENTATION.md](./TRADING_TOOLS_IMPLEMENTATION.md)

**Phase 12: Current Time** (COMPLETE)
- [x] Add `current_time` tool

**Phase 13: Place Bet** (COMPLETE)
- [x] Add `place_bet` tool schema
- [x] Add `place_bet` handler with exposure/spending limit checks
- [x] Integrate with executor (ExecutionAdapter)
- [x] Record predictions for calibration tracking
- [x] Add 11 unit tests (all passing)
- [x] Update system prompt

**Phase 14: Get Portfolio** (COMPLETE)
- [x] Add `get_portfolio` tool
- [x] Show positions, balances, P&L

**Phase 15: Get Predictions** (COMPLETE)
- [x] Add `get_predictions` tool
- [x] Show betting history and stats

**Phase 16: Get Order Book** (COMPLETE)
- [x] Add `get_order_book` tool
- [x] CLOB API integration

**Phase 17: Price History** (COMPLETE)
- [x] Add `price_history` tool
- [x] Gamma API integration

---

## Recent Changes

### 2026-02-01
- Agentic orchestrator (planner/reflect/critic) integrated behind `agent.useOrchestrator`
- Mentat scan/report + storage + detectors implemented; CLI commands added
- QMD memory retrieval added to orchestrator planning (when enabled)
- Optional tool trace + critic notes appended to chat responses (config flags)
- Optional mentat auto-scan/report appended in chat, daily reports, and autonomous P&L report (config flags)
- Optional plan trace appended to chat responses (config flag)
- Identity prompt modes added for token control (default: full; internal: minimal)
- Mentat monitoring scheduler + alerts (config flags)
- Clawdbot-style heartbeat scheduler + HEARTBEAT.md
- Proactive search can run via heartbeat mode (config)
- Proactive search can send direct summaries without LLM (config)
- CLI `intel proactive --send` sends direct summaries to channels

### 2026-01-27
- Tool calling implemented for Anthropic + OpenAI fallback
- Updated system prompt to reflect real tools
- Added unit tests for tool schemas/executor and OpenAI tool loop
- **Tool calling implementation:**
  - `src/core/tool-schemas.ts` - 14 tools defined
  - `src/core/tool-executor.ts` - Tool execution logic
  - `src/core/llm.ts` - AgenticAnthropicClient + AgenticOpenAiClient
  - `src/core/conversation.ts` - Uses agentic client
  - `src/core/agent.ts` - Passes tool context (config, marketClient, executor, limiter)
  - Tests created for tool calling (135 tests passing)
- **Phase 9 Complete:** Real-time Twitter search with hybrid fallback (Twitter API v2 + SerpAPI)
- **Phase 10 & 11 Complete:** Web search and web fetch tools with SSRF protection
- **Phases 12-17 Complete:** Trading tools implemented
  - `current_time` - Temporal awareness (timezone support)
  - `place_bet` - Autonomous trading with exposure/spending limits, calibration tracking
  - `get_portfolio` - View positions, balances, P&L (chain or paper mode)
  - `get_predictions` - Betting history with stats (win rate, ROI)
  - `get_order_book` - CLOB market depth with liquidity warnings
  - `price_history` - Historical odds from Gamma API

---

## Deployment Notes

### Current Config Issues (Resolved)
- Model name updated to current version
- `apiBaseUrl` is ignored for Anthropic provider (expected behavior)

### Environment
- Server: Hetzner cloud
- Gateway port: 18789
- Channels: Telegram enabled

---

## Quick Links

- [Full Implementation Plan](./IMPLEMENTATION_PLAN.md)
- [Tool Calling Implementation](./TOOL_CALLING_IMPLEMENTATION.md)
