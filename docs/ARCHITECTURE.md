# Thufir Architecture

## Goal
A single, coherent system for autonomous market discovery and execution on crypto perps (initially Hyperliquid).

## Core Loops
1. **Discovery Loop**
- Pulls market data and signals
- Clusters signals into hypotheses
- Maps hypotheses to trade expressions (probe-sized orders)

2. **Execution Loop**
- Enforces risk limits
- Places/cancels orders via execution adapter
- Records trade artifacts and outcomes

3. **Learning Loop**
- Stores decision artifacts and outcomes
- Tracks signal performance and error types
- Adjusts future probe sizing and prioritization

## Main Components
- `src/discovery/`
  - `signals.ts` (price/vol, cross-asset, funding/OI, orderflow)
  - `hypotheses.ts` (competing explanations)
  - `expressions.ts` (trade plans)
  - `engine.ts` (orchestrates discovery)
- `src/execution/`
  - `hyperliquid/` (client + market list)
  - `modes/hyperliquid-live.ts` (live execution)
  - `perp-risk.ts` (risk checks)
- `src/core/`
  - `agent.ts` (commands, routing)
  - `autonomous.ts` (autonomous scan + execution)
  - `tool-executor.ts` (tool execution and validation)
- `src/agent/`
  - tool adapters + orchestrator

## Data Flow
1. Signals pull market info -> clusters
2. Hypotheses -> expressions
3. Expressions -> risk checks -> execution
4. Trades + artifacts -> memory

## Configuration
- `execution.provider: hyperliquid`
- `hyperliquid.accountAddress` and `HYPERLIQUID_PRIVATE_KEY`
- `hyperliquid.symbols` to constrain the universe
