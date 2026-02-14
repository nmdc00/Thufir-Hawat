# Handoff

Last updated: 2026-02-13

This document is a fast path for continuing development on Thufir Hawat.

## Current Status

Thufir Hawat is a Hyperliquid-perps-focused autonomous discovery + execution system.

- `pnpm build` and `pnpm test` are expected to pass on Node 22 (see `docs/PROGRESS.md` for the authoritative status).
- Execution modes: `paper` (default), `webhook`, `live`.
- The agentic orchestrator supports tool traces / plan traces / critic notes / fragility traces.
- Trade management is enforced mechanically (envelopes + position monitor + exchange-side TP/SL where supported + best-effort fill reconciliation).

Legacy prediction-market experiments (Augur/Manifold/CLOB) are not part of the current codebase.

## Quick Start (Dev)

```bash
pnpm install
mkdir -p ~/.thufir
cp config/default.yaml ~/.thufir/config.yaml

pnpm thufir env init
pnpm thufir env check

pnpm thufir gateway
```

## Live Mode Checklist (Hyperliquid)

1. Set credentials:
```bash
export HYPERLIQUID_PRIVATE_KEY="0x..."
export HYPERLIQUID_ACCOUNT_ADDRESS="0x..."
```

2. Set `execution.mode: live` in `~/.thufir/config.yaml`.

3. Verify read-only + authenticated readiness:
```bash
pnpm thufir env verify-live --symbol BTC

# Side-effecting: places a tiny far-off limit order then cancels (will prompt).
pnpm thufir agent run --mode trade "Run hyperliquid_order_roundtrip for BTC size=0.001" --show-tools --show-plan
```

## Where Things Live

- CLI: `src/cli/index.ts`
- Config schema/loader: `src/core/config.ts`
- Gateway entrypoint: `src/gateway/index.ts`
- Agent orchestration: `src/agent/orchestrator/`
- Tool execution + schemas: `src/core/tool-executor.ts`, `src/core/tool-schemas.ts`
- Hyperliquid client/execution: `src/execution/hyperliquid/`
- Discovery loop: `src/discovery/`
- Mentat/fragility: `src/mentat/`
- Memory/DB: `src/memory/`

## Next Steps

1. Run a live verification roundtrip on a tiny size and confirm end-to-end safety gates.
2. Tighten exit-on-invalidation logic (thesis invalidation evaluation) in the autonomy loop.
3. Expand on-chain/intel providers if they improve signal quality (without adding brittle dependencies).

## Key Docs

- `README.md` - quick start + CLI reference
- `docs/PROGRESS.md` - current implementation status
- `docs/ARCHITECTURE.md` - system architecture
- `THUFIR_HAWAT_AUTONOMOUS_MARKET_DISCOVERY.md` - design north-star
- `docs/WALLET_SECURITY.md` - wallet/key handling + limits
- `BLACK_SWAN_DETECTOR.md` - fragility objects + mentat framing
