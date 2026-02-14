# Thufir Development Progress

**Last Updated:** 2026-02-13
**Last Updated:** 2026-02-13

## Current Status
Hyperliquid perps + autonomous discovery are integrated. Identity prompts are platform-agnostic (tool-driven). On this branch, `pnpm build` and `pnpm exec vitest run` pass on Node 22.

## Completed
- Hyperliquid market client (list/get symbols, mark price, metadata)
- Live executor for Hyperliquid perps
- Perp risk checks (max notional, leverage caps, liquidation distance, correlation caps)
- Discovery engine (signals -> hypotheses -> expressions)
- Autonomous execution thresholds now enforced (`minEdge`, `requireHighConfidence`, `pauseOnLossStreak`)
- Technical on-chain snapshot now computes live score from Hyperliquid funding/orderflow/book data
- Perp tools (`perp_market_list`, `perp_market_get`, `perp_place_order`, `perp_open_orders`, `perp_cancel_order`, `perp_positions`)
- Portfolio now surfaces perp positions
- User-facing prompts updated away from legacy market flows
- CLI and docs updated to remove legacy market commands
- Full test suite passing in this branch (`32` files / `99` tests)
- TypeScript build passing in this branch
- Coverage configuration hardened (vendor-remap exclusions + minimum thresholds)
- Live verification tools added:
  - `hyperliquid_verify_live` (read-only smoke check + authenticated readiness checks)
  - `hyperliquid_order_roundtrip` (authenticated place+cancel roundtrip)
- Funding remediation tools added for Hyperliquid collateral blockers:
  - `evm_usdc_balances` (Polygon/Arbitrum probe)
  - `cctp_bridge_usdc` (Polygon <-> Arbitrum USDC via CCTP v1)
  - `hyperliquid_deposit_usdc` (transfer Arbitrum USDC to HL bridge deposit address)
- Lint gate fixed (`pnpm lint` now runs against TypeScript sources with project ESLint config)
- Reflexivity detector (crowding + fragility + catalyst):
  - Catalyst registry support (`config/catalysts.yaml`)
  - Narrative snapshot extraction with decision-artifact caching (optional LLM JSON mode)
  - Reflexivity fragility scoring wired into discovery as `reflexivity_fragility` signal
  - Setup artifacts persisted (`reflexivity_setup_v1`)
- Trade management (perps):
  - Envelope recording at entry (immutable exit parameters + journal metadata)
  - Programmatic `Thufir.trade()` also records envelopes (so monitor covers non-tool usage)
  - Exchange-side TP/SL trigger placement (bracket orders) where supported
  - Mechanical position monitor with exit priority: liquidation guard, stop loss, trailing stop, take profit, time stop
  - Orphan position handling (default envelope applied to untracked positions)
  - Fill reconciliation for closes (client order ids + `userFillsByTime` best-effort average fill px + fees)
  - Paper-mode monitor support (exit rules enforced against markPrice without venue positions)
  - Webhook-mode monitor support (exit rules enforced and close orders forwarded reduce-only)
  - Periodic price-path sampling for MAE/MFE summaries in reflections
  - Dust handling for residual positions (stop retrying when remaining notional is below threshold)
  - Anti-overtrading gates for full-auto (max concurrent, cooldown, daily cap, loss streak pause)
  - Journal summary + journal-informed entry selection + post-trade reflections persisted for learning

## In Progress
- Real-account verification rollout:
  - deploy updated code to the running server process
  - restart gateway to pick up `.env` changes
  - ensure Arbitrum ETH is available for gas (required for CCTP receive + deposit transfer)
- Optional expansion of on-chain providers (e.g. Coinglass/Whale APIs)
- Reflexivity follow-ups:
  - wire thesis invalidation evaluation into the autonomy loop (exit-on-thesis-break)
  - improve carry-cost modeling and catalyst binding requirements before auto-exec
- Trade management follow-ups:
  - richer reconciliation for exchange-side TP/SL fills (capture exact fill px/fees from venue APIs)
  - store price-path samples (MAE/MFE over time) for more grounded reflections

## Next Steps
1. Deploy updated build to the server and restart gateway to pick up EVM RPC env vars
2. Run `hyperliquid_verify_live`, then `hyperliquid_order_roundtrip` with a tiny size (requires confirmation)
3. If collateral missing: run `evm_usdc_balances` -> `cctp_bridge_usdc` -> `hyperliquid_deposit_usdc` (requires Arbitrum ETH gas)
