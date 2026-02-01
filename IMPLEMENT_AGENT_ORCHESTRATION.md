# IMPLEMENT_AGENT_ORCHESTRATION.md
Last updated: 2026-02-01

## Goal

Implement AGENT_ORCHESTRATION + AGENTIC_THUFIR + BLACK_SWAN_DETECTOR
inside current Thufir codebase (no OpenClaw fork).

---

# Step 1 — Identity Core

Create:

src/agent/identity/identity.ts
src/agent/identity/types.ts

Functions:

- loadThufirIdentity(config)
- loadIdentityPrelude(config)
- injectIdentity(messages, prelude)
- buildIdentityPrompt(identity)

Load from workspace:

AGENTS.md
IDENTITY.md
SOUL.md
USER.md

Assert marker:
IDENTITY_MARKER: THUFIR_HAWAT

Remove all other identity loaders.

Status: COMPLETE

---

# Step 2 — Tool Registry

Create:

src/agent/tools/registry.ts
src/agent/tools/types.ts
src/agent/tools/adapters/*

Tool interface:

- name
- description
- schema
- execute()

Wrap existing systems as tools:

- intel.search
- markets.search
- markets.get
- comments.get
- trade.place
- memory.query
- web.search (map to NewsAPI + SerpAPI initially)
- calculator

Status: COMPLETE

---

# Step 3 — Orchestrator

Create:

src/agent/orchestrator/orchestrator.ts
src/agent/orchestrator/state.ts
src/agent/orchestrator/types.ts

Implements loop:

- retrieve memory
- build/update plan
- choose action
- call tool or finalize
- reflect
- critic pass

Configurable iteration cap.

Status: COMPLETE

---

# Step 4 — Modes

Create:

src/agent/modes/

- chat_mode.ts
- trade_mode.ts
- mentat_mode.ts

Each defines:

- allowed tools
- max iterations
- output schema
- constraints

Status: COMPLETE

---

# Step 5 — Integrations (COMPLETE)

Replace direct LLM calls with orchestrator in:

- conversation handler ✅
- opportunities/top10 ✅
- autonomous manager ✅

Providers remain unchanged.

Status: COMPLETE

---

# Step 6 — Mentat Storage (Phase 2) (COMPLETE)

Add DB tables:

assumptions
mechanisms
fragility_cards

Add upsert + delta tracking. ✅

Status: COMPLETE

---

# Step 7 — Debug Enforcement (COMPLETE)

Add debug logs:

- provider path
- identity marker present
- tools called
- iterations used

Fail in debug if identity missing.

Status: COMPLETE

---

# Step 8 — QMD Knowledge Base (COMPLETE)

Add local hybrid search for persistent memory.

Tools:
- qmd_query (search knowledge base)
- qmd_index (store content)
- mentat_store_assumption (store assumptions)
- mentat_store_fragility (store fragility cards)
- mentat_query (query mentat knowledge)

Integration:
- Orchestrator queries QMD before planning (Memory-First Rule) ✅
- Web search/fetch auto-index to QMD ✅
- Periodic embedding scheduler (hourly) ✅

Status: COMPLETE

---

# Acceptance Tests

Status (2026-02-01):

1. Ask identity → responds as Thufir Hawat
   - Not run (requires CLI/session run with workspace + provider).
2. Fresh news question → tool called first
   - Not run (requires live intel/web tools + provider).
3. Top10 → shows tool-driven reasoning
   - Partially met: Top10 uses orchestrator when enabled; tool trace only in chat via config.
4. Mentat scan → outputs fragility cards
   - **Partially met:** CLI scan/report implemented; not wired into orchestrator by default.
5. Trade decision → critic pass present
   - Partially met: critic exists in orchestrator trade mode; legacy path does not expose critic output.
6. QMD memory retrieval → context in planning
   - **Implemented:** Orchestrator calls qmd_query before planning, injects as "## Knowledge Base" context.
