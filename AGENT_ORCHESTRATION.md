# AGENT_ORCHESTRATION.md
Last updated: 2026-02-01

## Purpose

Implementation contract for the agentic-first orchestration layer. This document
mirrors AGENTIC_THUFIR.md but anchors it to the actual code paths.

---

## Current Implementation Map

- Orchestrator loop: `src/agent/orchestrator/orchestrator.ts`
- Orchestrator state/types: `src/agent/orchestrator/state.ts`, `src/agent/orchestrator/types.ts`
- Planner: `src/agent/planning/planner.ts`
- Reflection: `src/agent/reflection/reflector.ts`
- Critic: `src/agent/critic/critic.ts`
- Modes: `src/agent/modes/*` (chat, trade, mentat)
- Tool registry/adapters: `src/agent/tools/registry.ts`, `src/agent/tools/adapters/*`
- Identity prelude: `src/agent/identity/identity.ts`
- Mentat tooling: `src/agent/tools/adapters/mentat-tools.ts`
- QMD tooling: `src/agent/tools/adapters/qmd-tools.ts`

### Integration Points

- Chat: `src/core/conversation.ts` (agent.useOrchestrator)
- Opportunities: `src/core/opportunities.ts` (agent.useOrchestrator)
- Autonomous manager: `src/core/autonomous.ts` (agent.useOrchestrator)
- Agent loop: `src/core/agent.ts` (agent.useOrchestrator)

### Config Flags

```yaml
agent:
  useOrchestrator: false     # Use agentic orchestrator loop
  useExecutorModel: false    # Use split orchestrator/executor models
  executorModel: gpt-5.2
  executorProvider: openai
```

---

## Execution Semantics (Implemented)

1. Detect mode (chat/trade/mentat).
2. Memory-first: gather session context + QMD context (if enabled).
3. Create plan (tool-first).
4. Iterate: tool -> reflect -> update plan (bounded by max iterations).
5. Synthesize response.
6. Run critic pass when required by mode.
7. Return result with metadata (mode, confidence, tool usage).

---

## Not Yet Implemented

- Explicit multi-agent role split (Cartographer/Skeptic/Risk Officer).
- Persistent plan state across sessions (plan is per-run).
- User-visible tool trace / plan transcript (currently internal).
- Automatic mentat report generation in agent mode (CLI-only today).

---

## Acceptance Checks (2026-02-01)

1. Identity prelude present on orchestrator runs (marker enforced) - IMPLEMENTED.
2. Tool-first planning when tools are needed - IMPLEMENTED in orchestrator path.
3. Critic pass on trades/mentat mode - IMPLEMENTED in orchestrator path.
4. QMD memory retrieval before planning - IMPLEMENTED when enabled.
5. User-visible tool trace - NOT IMPLEMENTED.
