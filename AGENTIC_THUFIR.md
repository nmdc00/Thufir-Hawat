# AGENTIC_THUFIR.md
Last updated: 2026-02-01

## Purpose

Define the agentic-first architecture of Thufir Hawat.

Thufir is not a chat wrapper.
Thufir is an agent that reasons, plans, uses tools, and self-critiques.

---

# Identity

Agent identity: Thufir Hawat — mentat-style risk and fragility analyst.

Behavioral traits:

- mechanism-first reasoning
- tail-risk awareness
- assumption tracking
- falsifier reporting
- low narrative trust
- tool-first fact gathering

Identity is loaded from workspace files and injected every call.

---

# Execution Model

Replace:

prompt → answer

With:

goal → plan → tools → reflection → critic → result

---

# Agent Stack

## Layer 1 — Identity
Workspace identity files define persona and rules.

## Layer 2 — Orchestration
Agent loop runner executes plan/tool/reflection cycles.

## Layer 3 — Tools
External IO:
- markets
- intel
- web
- memory
- trading

## Layer 4 — Modes
Behavior presets:
- chat
- trade
- mentat

---

# Planning Requirements

Plans must:

- decompose goals
- reference tools
- be revisable
- expose blockers
- track confidence

---

# Tool-First Rule

When question depends on:

- current events
- prices
- news
- positions
- external state

Agent MUST call tools.

Guessing is a violation.

---

# Memory-First Rule

Before planning, retrieve:

- semantic memory
- recent sessions
- relevant fragility cards
- assumptions

Inject as structured context.

---

# Reflection Requirement

After each tool:

Agent must update:

- hypotheses
- assumptions
- confidence
- next step

---

# Critic Requirement

Every high-stakes output:

- trade
- fragility report
- opportunity ranking

Must run critic pass.

---

# Provider Independence

Anthropic/OpenAI/local/llm-mux are interchangeable.

No provider-specific prompting logic allowed outside identity prelude.

---

# Session Model

Session tracks:

- plan
- state
- assumptions
- tool results
- fragility signals

Not just message history.

---

# Acceptance Signals

Thufir is agentic when:

- answers cite tool calls
- plans are visible
- assumptions are explicit
- critic notes appear
- identity never drifts

---

# Implementation Status (2026-02-01)

Implemented:

- Agentic orchestrator loop with planner/reflector/critic
- Tool registry + adapters with dot-notation aliases
- Memory-first retrieval (session memory + QMD when enabled)
- Mode detection (chat/trade/mentat)
- Identity prelude injected in main conversation path
- Identity prompt modes (full/minimal/none) for token control (default: full)
- **Pre-trade fragility analysis** (automatic mentat scan before trades)
- **Fragility-aware critic** (stricter review for high-fragility trades)
- **Fragility trace in responses** (auto-shown for high fragility, optional otherwise)

Not yet implemented:

- User-visible plan/tool trace by default (optional via config)
- Tool-first rule enforced on non-orchestrator paths
