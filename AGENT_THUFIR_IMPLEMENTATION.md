# Agentic Thufir Implementation Progress

Last updated: 2026-02-01

## Summary

Transform Thufir from chat-first to agentic-first architecture per AGENTIC_THUFIR.md.

**Core Change:** Replace direct LLM calls with orchestrator loop:
```
goal -> memory -> plan -> (tool -> reflect)* -> synthesize -> critic -> result
```

---

## Progress Overview

| # | Module | Status | Files Created | Notes |
|---|--------|--------|---------------|-------|
| 1 | Identity Core | COMPLETE | 2/2 | types.ts, identity.ts |
| 2 | Tool Registry | COMPLETE | 8/7 | +system-tools, +index |
| 3 | Modes Layer | COMPLETE | 5/5 | All mode files |
| 4 | Planning Module | COMPLETE | 2/2 | types.ts, planner.ts |
| 5 | Reflection Module | COMPLETE | 2/2 | types.ts, reflector.ts |
| 6 | Critic Module | COMPLETE | 2/2 | types.ts, critic.ts |
| 7 | Orchestrator | COMPLETE | 3/3 | types.ts, state.ts, orchestrator.ts |
| 8 | Public Exports | COMPLETE | 2/2 | types.ts, index.ts |
| 9 | Integration | COMPLETE | 3 modified | config + conversation + autonomousScan |
| 10 | Workspace Identity | COMPLETE | 4/4 | AGENTS.md, IDENTITY.md, SOUL.md, USER.md |
| 11 | CLI Rename | COMPLETE | 6+ modified | thufir bin/scripts/env paths |

**Overall:** Implementation complete; remaining work is verification + UX surfacing
(tool trace/plan visibility).

## Step 13: Pre-Trade Fragility Integration - COMPLETE

**Status:** Done

**Files modified:**
- [x] `src/agent/critic/types.ts` - Added `TradeFragilityContext` interface
- [x] `src/agent/critic/critic.ts` - Fragility-aware critic prompt and stricter rules
- [x] `src/agent/orchestrator/orchestrator.ts` - Pre-trade fragility scan integration
- [x] `src/agent/orchestrator/types.ts` - Added `FragilitySummary` interface
- [x] `src/mentat/scan.ts` - Added `runQuickFragilityScan()` for fast pre-trade analysis
- [x] `src/core/conversation.ts` - Fragility trace display in responses
- [x] `src/core/config.ts` - Added `enablePreTradeFragility` and `showFragilityTrace` options

**Implemented:**
1. **Quick Fragility Scan** - Lightweight market-specific scan before trade execution
2. **Fragility-Aware Critic** - Updated critic to consider fragility in trade reviews:
   - New issue types: `fragility_ignored`, `tail_risk_ignored`
   - Auto-reject high-fragility trades (>0.7) with any risk issues
   - Stricter review for moderate fragility (>0.5)
3. **Orchestrator Integration** - Runs fragility scan before `place_bet`/`trade.place` tools
4. **Response Display** - Auto-shows fragility trace for high-fragility trades (>0.6)
5. **Config Options:**
   - `agent.enablePreTradeFragility: true` (default) - Enable/disable pre-trade scans
   - `agent.showFragilityTrace: false` (default) - Always show fragility in responses

**Flow:**
1. Orchestrator detects trade tool in plan
2. Runs `runQuickFragilityScan()` on target market
3. Passes fragility context to critic
4. Critic applies stricter rules for high-fragility trades
5. Fragility summary included in orchestrator result
6. High-fragility trades show warning in response

**Blocking:** Nothing

---

## Step 12: QMD Knowledge Base Integration - COMPLETE

**Status:** Done

**Files created:**
- [x] `src/agent/tools/adapters/qmd-tools.ts` - QMD query/index tools
- [x] `src/agent/tools/adapters/mentat-tools.ts` - Mentat storage tools

**Files modified:**
- [x] `scripts/setup.sh` - Bun + QMD installation
- [x] `scripts/install_hetzner.sh` - Production QMD setup
- [x] `src/core/tool-executor.ts` - QMD + mentat tool executors
- [x] `src/core/tool-schemas.ts` - Tool schemas
- [x] `src/core/config.ts` - QMD config schema
- [x] `src/agent/orchestrator/orchestrator.ts` - Memory-first QMD integration
- [x] `src/gateway/index.ts` - Periodic embedding scheduler
- [x] `config/default.yaml` - QMD config section

**Implemented:**
1. **QMD Tools:**
   - `qmd_query` - Hybrid search (BM25 + vector + LLM reranking)
   - `qmd_index` - Store content in knowledge base

2. **Mentat Tools:**
   - `mentat_store_assumption` - Track assumptions with evidence
   - `mentat_store_fragility` - Fragility cards per BLACK_SWAN_DETECTOR.md
   - `mentat_query` - Query mentat knowledge

3. **Auto-Indexing:**
   - Web search results auto-indexed to `thufir-research`
   - Web fetch results optionally auto-indexed
   - Fire-and-forget pattern (doesn't slow main response)

4. **Orchestrator Integration:**
   - Memory-First Rule: QMD queried before planning
   - Results injected as "## Knowledge Base" context
   - Combined with traditional session memory

5. **Scheduler:**
   - `qmd embed` runs hourly (configurable)
   - Keeps embeddings fresh for vector search

**Blocking:** Nothing

---

## Step 1: Identity Core - COMPLETE

**Status:** Done

**Files created:**
- [x] `src/agent/identity/types.ts` - AgentIdentity, BehavioralTrait, THUFIR_TRAITS
- [x] `src/agent/identity/identity.ts` - loadThufirIdentity, buildIdentityPrompt, getIdentityPrompt

**Implemented:**
1. `AgentIdentity` interface with name, role, traits, marker, rawContent (now includes USER.md)
2. `BehavioralTrait` type with 6 mentat behaviors
3. `loadThufirIdentity(config)` - loads from workspace files with fallback
4. `buildIdentityPrompt(identity)` - generates system prompt
5. `loadIdentityPrelude(config)` + `injectIdentity(messages, prelude)` for identity enforcement
6. `getIdentityPrompt(config)` - backward compatible with loadThufirIdentity

**Blocking:** Nothing

---

## Step 2: Tool Registry - COMPLETE

**Files created:**
- [x] `src/agent/tools/types.ts` - ToolDefinition, ToolResult, ToolExecution, etc.
- [x] `src/agent/tools/registry.ts` - AgentToolRegistry class with caching
- [x] `src/agent/tools/adapters/market-tools.ts` - 5 tools
- [x] `src/agent/tools/adapters/intel-tools.ts` - 3 tools
- [x] `src/agent/tools/adapters/trading-tools.ts` - 3 tools
- [x] `src/agent/tools/adapters/memory-tools.ts` - 1 tool
- [x] `src/agent/tools/adapters/web-tools.ts` - 2 tools
- [x] `src/agent/tools/adapters/system-tools.ts` - 2 tools
- [x] `src/agent/tools/adapters/index.ts` - Combined exports

**Implemented:**
1. `ToolDefinition` interface with Zod schema, execute, sideEffects, requiresConfirmation, cacheTtlMs
2. `AgentToolRegistry` class with register/get/list/execute, caching (30s TTL)
3. 16+ tools wrapped from existing executeToolCall()
4. Dot-notation aliases: `markets.search`, `markets.get`, `intel.search`, `trade.place`, `web.search`
5. New tools: `comments.get`, `memory.query`, `calculator`
6. Tool categorization: markets, intel, trading, memory, web, system

**Blocking:** Nothing

---

## Step 3: Modes Layer - COMPLETE

**Files created:**
- [x] `src/agent/modes/types.ts` - AgentMode, ModeConfig, ModeDetectionResult
- [x] `src/agent/modes/chat.ts` - 4 iterations, no critic, read-only
- [x] `src/agent/modes/trade.ts` - 8 iterations, critic required, trading enabled
- [x] `src/agent/modes/mentat.ts` - 12 iterations, critic, deep analysis
- [x] `src/agent/modes/registry.ts` - detectMode, getModeConfig, isToolAllowed

**Implemented:**
1. `ModeConfig` interface with maxIterations, requireCritic, allowedTools, temperature
2. Three modes with appropriate settings
3. `detectMode(message)` with pattern matching for trade/mentat intent
4. `getModeConfig(mode)`, `isToolAllowed(mode, tool)`, `getAllowedTools(mode)`

**Blocking:** Nothing

---

## Step 4: Planning Module - COMPLETE

**Files created:**
- [x] `src/agent/planning/types.ts`
- [x] `src/agent/planning/planner.ts`

**Implemented:**
1. `AgentPlan` and `PlanStep` structures with revision tracking
2. `createPlan()` with tool-first planning prompt
3. `revisePlan()` for tool-driven plan updates
4. Fallback plan on parse failure

---

## Step 5: Reflection Module - COMPLETE

**Files created:**
- [x] `src/agent/reflection/types.ts`
- [x] `src/agent/reflection/reflector.ts`

**Implemented:**
1. `Reflection` and `Hypothesis`/`Assumption` types
2. `reflect()` tool-result reflection loop
3. State application helpers

---

## Step 6: Critic Module - COMPLETE

**Files created:**
- [x] `src/agent/critic/types.ts`
- [x] `src/agent/critic/critic.ts`

**Implemented:**
1. `CriticResult` interface with issues, revisedResponse, approved
2. `runCritic()` and approval logic
3. `shouldRunCritic()` heuristics for trades and mentat mode

---

## Step 7: Orchestrator - COMPLETE

**Status:** Done

**Files created:**
- [x] `src/agent/orchestrator/types.ts` - AgentState, OrchestratorContext, OrchestratorResult
- [x] `src/agent/orchestrator/state.ts` - State management functions
- [x] `src/agent/orchestrator/orchestrator.ts` - Main runOrchestrator loop

**Implemented:**
1. `AgentState` interface with sessionId, mode, plan, assumptions, hypotheses, toolExecutions, confidence, iteration
2. State management functions: createAgentState, updatePlan, addToolExecution, applyReflectionToState, etc.
3. `runOrchestrator(goal, ctx, options)` - Main entry point
4. Main loop: mode detection -> memory -> plan -> (tool -> reflect)* -> synthesize -> critic -> result
5. Tool-first and memory-first rule enforcement via planning phase
6. `createOrchestrator(ctx)` factory for bound context
7. Confirmation callbacks for side-effect tools

**Blocking:** Nothing

---

## Step 8: Public Exports - COMPLETE

**Files created:**
- [x] `src/agent/types.ts`
- [x] `src/agent/index.ts`

**Implemented:**
1. Shared types re-exports
2. Public API exports for orchestrator, identity, registry, modes

---

## Step 9: Integration - COMPLETE

**Files modified:**
- [x] `src/core/config.ts` - Add `useOrchestrator` flag
- [x] `src/core/conversation.ts` - Orchestrator integration point
- [x] `src/core/opportunities.ts` - Orchestrator-backed scan when enabled
- [x] `src/core/agent.ts` - Route autonomous scan to orchestrator when enabled
- [x] `src/core/llm.ts` - Replace loadThufirIdentity prelude into LLM paths

**What's done:**
1. Config flag: `agent.useOrchestrator?: boolean`
2. Conversation chat path routes to orchestrator when enabled
3. Opportunities scanner can use orchestrator synthesis when enabled
4. Legacy autonomous scan can use orchestrator decision synthesis when enabled
5. Autonomous manager reuses orchestrator assets for scans/reports when enabled

**Remaining:**
1. Integrate orchestrator into any remaining non-chat LLM flows (if new ones are added)

**Blocking:** All modules (1-8)

---

## Step 10: Workspace Identity Update - COMPLETE

**Files modified:**
- [x] `workspace/AGENTS.md` - Thufir Hawat bootstrap + marker
- [x] `workspace/IDENTITY.md` - Mentat persona
- [x] `workspace/SOUL.md` - Mentat principles
- [x] `workspace/USER.md` - User context template

**Implemented:**
1. Renamed project -> Thufir Hawat
2. Added mentat framing + identity marker
3. Preserved core capabilities (markets, trading, intel)

---

## Step 11: CLI Rename (bijaz -> thufir) - COMPLETE

**Files modified:**
- [x] `package.json` - Change bin/script to `thufir`
- [x] `src/cli/index.ts` - Update CLI branding/name
- [x] `src/core/agent.ts` - Update workspace path references
- [x] `README.md` - Update command examples
- [x] All env var references now `THUFIR_*`

**Current state in package.json:**
```json
"bin": { "thufir": "./dist/cli/index.js" },
"scripts": { "thufir": "tsx src/cli/index.ts" }
```

**Remaining:**
1. None identified in code; keep docs/examples in sync with "thufir" naming.

**Blocking:** Nothing (can be done in parallel)

---

## Verification Checklist (Pending)

After implementation, verify:

- [ ] **Identity test:** `thufir chat "Who are you?"` -> responds as Thufir Hawat
- [ ] **Tool-first test:** `thufir chat "What's happening with Bitcoin today?"` -> tools called before answering
- [ ] **Mode detection test:** `thufir chat "Buy YES on X"` -> trade mode activated
- [ ] **Reflection test:** Tool results update hypotheses/assumptions
- [ ] **Critic test:** Trade decision shows critic notes
- [ ] **Iteration cap test:** Complex goal respects maxIterations
- [ ] **Existing tests pass:** `npm test`
- [ ] **QMD query test:** `qmd query "bitcoin"` returns results
- [ ] **QMD auto-index test:** Web search results appear in QMD
- [ ] **Mentat storage test:** Store assumption via tool, query it back
- [ ] **Orchestrator memory test:** QMD context appears in planning phase

---

## Directory Structure (Target)

```
src/agent/
  index.ts                    # Public exports
  types.ts                    # Shared types

  identity/
    identity.ts               # Thufir Hawat identity loader
    types.ts                  # Identity types

  orchestrator/
    orchestrator.ts           # Main agent loop
    state.ts                  # AgentState management
    types.ts                  # Orchestrator types

  planning/
    planner.ts                # Plan creation/revision
    types.ts                  # Plan types

  tools/
    registry.ts               # Tool registry
    types.ts                  # Tool interface
    adapters/
      market-tools.ts         # Wrap existing market tools
      intel-tools.ts          # Wrap existing intel tools
      trading-tools.ts        # Wrap existing trading tools
      memory-tools.ts         # Wrap memory tools
      web-tools.ts            # Wrap web tools
      qmd-tools.ts            # QMD knowledge base tools
      mentat-tools.ts         # Mentat storage tools
      index.ts                # Combined exports

  reflection/
    reflector.ts              # Post-tool reflection
    types.ts

  critic/
    critic.ts                 # Critic pass for high-stakes
    types.ts

  modes/
    types.ts                  # Mode interface
    chat.ts                   # Chat mode config
    trade.ts                  # Trade mode config
    mentat.ts                 # Mentat mode config
    registry.ts               # Mode lookup
```

---

## Critical Files Reference

| File | Purpose |
|------|---------|
| `src/core/llm.ts:18-69` | Existing identity loader to replace |
| `src/core/llm.ts:327-429` | Existing OrchestratorClient to supersede |
| `src/core/agent.ts:159` | handleMessage() integration point |
| `src/core/conversation.ts:279` | chat() method to update |
| `src/core/tool-executor.ts` | executeToolCall() to wrap |
| `src/core/tool-schemas.ts` | THUFIR_TOOLS to adapt |

---

## Notes

- Keep backward compatibility with `useOrchestrator: false` (default)
- Existing code paths preserved for gradual migration
- All new code in `src/agent/` to avoid disrupting existing structure
