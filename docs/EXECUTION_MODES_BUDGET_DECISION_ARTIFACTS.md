# Execution Modes, Budgets, Decision Artifacts, Local Trivial Tasks

Last updated: 2026-02-04

## Purpose
Define the concrete implementation plan for:
- Execution modes (MONITOR_ONLY, LIGHT_REASONING, FULL_AGENT) + budgeted degradation
- Decision artifacts and reuse to reduce repeat reasoning
- Trivial task routing to local Ollama (free tier)

This is a build plan and acceptance checklist, not a high-level vision doc.

## Scope
Applies to the agentic orchestrator, autonomous scans, and any path that calls LLMs.

## Non-goals
- Changing trade logic itself
- Model-provider switching beyond the trivial-task path
- Re-architecting the orchestrator

## Current Baseline (Observed)
- Local LLM is already supported via `LocalClient` and `agent.trivialTaskProvider`.
- There are LLM queues/limiters, but no explicit execution-tier enforcement.
- Mentat scans and orchestrator can call LLMs in multiple entry points.

## Part 2: Execution Modes + Budget + Cooldown

### Desired Behavior
1. Every LLM-triggering path must select `ExecutionMode` before doing anything expensive.
2. Most cycles should short-circuit to MONITOR_ONLY when no material changes occur.
3. Budget limits should degrade behavior deterministically without fallback loops.
4. Cooldowns should prevent retry spirals across providers/models.

### Execution Modes
- `MONITOR_ONLY`
- `LIGHT_REASONING`
- `FULL_AGENT`

### Gating Rules (Minimum)
- MONITOR_ONLY if:
  - No material deltas since last run
  - Budget exhausted or provider cooldown active
- LIGHT_REASONING if:
  - Deltas exist but are small
  - Not critical and budget allows one call
- FULL_AGENT if:
  - Critical action requested
  - Significant deltas detected
  - Budget reserve allows

### Integration Points (Files)
- `src/core/autonomous.ts`
- `src/core/agent.ts`
- `src/core/opportunities.ts`
- `src/core/conversation.ts`
- `src/agent/orchestrator/orchestrator.ts`
- `src/core/llm.ts` (budget and cooldown enforcement)
- `src/core/config.ts` and `config/default.yaml` (settings)

### Data Required
- Last scan timestamp
- Last material delta hash
- Budget state (calls/tokens)
- Provider cooldown state

### Plan of Record
1. Add `ExecutionMode` type and a shared selector in a single place.
2. Make every scan/agent entry point call the selector before LLM usage.
3. Persist execution decisions and reasons for observability.
4. Enforce “no LLM” when in MONITOR_ONLY.
5. Add budget reserve logic and explicit degrade path.
6. Make cooldown logic visible in logs with provider+model context.

### Acceptance Criteria
- At least 80% of autonomous scans exit with MONITOR_ONLY in steady-state.
- Budget exhaustion results in a deterministic MONITOR_ONLY response without retries.
- Cooldowns prevent repeated calls within the cooldown window.

## Part 3: Decision Artifacts (Learning Without Model Updates)

### Goal
Reduce repeated reasoning and improve consistency by persisting and reusing decision artifacts.

### What to Store
- Decision summary: “We saw X, did Y, outcome Z.”
- Preconditions and invalidation rules
- Market identifiers and timestamp
- Confidence and fragility context
- Links to evidence or intel snapshots

### Where to Store
- Use workspace storage (existing persistence approach) with a new namespace.
- Keep artifacts searchable by market, topic, and outcome.

### When to Create
- After each decision-making cycle that reaches trade/no-trade output.
- After mentat scans when fragility signals cross thresholds.

### When to Reuse
- Before running LIGHT_REASONING or FULL_AGENT.
- If a matching artifact is fresh and still valid, skip LLM and surface prior rationale.

### Integration Points (Files)
- `src/core/opportunities.ts`
- `src/agent/orchestrator/orchestrator.ts`
- `src/mentat/scan.ts`
- `src/core/conversation.ts`

### Plan of Record
1. Define artifact schema (JSON) with versioning.
2. Add a simple index to query by market and time.
3. Add a “reuse check” before any orchestrator run.
4. Write artifacts post-decision with outcome metadata.
5. Add invalidation on material delta or expiry.

### Acceptance Criteria
- Repeated scans of unchanged markets reuse artifacts without LLM calls.
- Artifacts are retrievable with deterministic criteria.
- Artifacts include invalidation logic and timestamps.

## Part 4: Trivial Task Routing to Ollama

### Goal
Ensure summarization, extraction, formatting, and compression use local models by default.

### What Counts as Trivial
- Summarization
- Entity/keyword extraction
- Formatting and titles
- JSON normalization
- Tool routing hints

### What Is Not Trivial
- Trade decisions
- Probability estimation
- Multi-step planning
- Mentat synthesis

### Integration Points (Files)
- `src/core/llm.ts` (create and route trivial client)
- `src/core/conversation.ts`
- `src/core/opportunities.ts`
- `src/mentat/scan.ts`

### Plan of Record
1. Define a clear “trivial task” call site API or helper.
2. Route eligible tasks to `createTrivialTaskClient`.
3. Add strict guardrails so local LLM cannot be used for non-trivial contexts.
4. Log trivial task usage with model and duration.

### Acceptance Criteria
- Trivial tasks consistently route to Ollama when enabled.
- Non-trivial tasks never call the local provider.
- Failure of local model falls back to deterministic non-LLM output or skips.

## Rollout Strategy
1. Introduce execution modes and enforcement first.
2. Add decision artifacts with reuse checks.
3. Route trivial tasks to Ollama and audit usage.

## Observability
- Log selected execution mode and reason.
- Track LLM call counts by provider, model, and context.
- Track artifact reuse rate and cache hit ratio.

## Test Plan
- Unit tests for execution-mode selection.
- Unit tests for decision artifact invalidation.
- Integration tests for trivial task routing.

## Risks and Mitigations
- Risk: Over-aggressive MONITOR_ONLY prevents legitimate actions.
  - Mitigation: Explicit thresholds and overrides for critical paths.
- Risk: Artifact reuse hides new deltas.
  - Mitigation: Strong invalidation rules and short TTL for volatile markets.
- Risk: Local model failure causes silent drops.
  - Mitigation: Explicit fallback behavior and logging.
