# Thufir Development Progress

**Last Updated:** 2026-02-11

## Current Status
Hyperliquid perps + autonomous discovery are integrated. Identity prompts are platform-agnostic (tool-driven). On this branch, `pnpm build` and `pnpm exec vitest run` pass on Node 22.

## Completed
- Hyperliquid market client (list/get symbols, mark price, metadata)
- Live executor for Hyperliquid perps
- Perp risk checks (max notional, leverage caps, liquidation distance, correlation caps)
- Discovery engine (signals -> hypotheses -> expressions)
- Perp tools (`perp_market_list`, `perp_market_get`, `perp_place_order`, `perp_open_orders`, `perp_cancel_order`, `perp_positions`)
- Portfolio now surfaces perp positions
- User-facing prompts updated away from legacy market flows
- CLI and docs updated to remove legacy market commands
- Full test suite passing in this branch (`32` files / `99` tests)
- TypeScript build passing in this branch
- Coverage configuration hardened (vendor-remap exclusions + minimum thresholds)
- Live verification command added: `thufir env verify-live` (read-only smoke check)
- Lint gate fixed (`pnpm lint` now runs against TypeScript sources with project ESLint config)

## In Progress
- Authenticated live API verification in a real account (requires `HYPERLIQUID_PRIVATE_KEY`)
- Tightening discovery/reporting outputs for live operation clarity

## Next Steps
1. Run `thufir env verify-live` with real credentials and execute a tiny manual order/cancel roundtrip
2. Review discovery signal quality on live data and adjust sizing/confidence weighting
3. Decide whether to keep legacy memory tables or complete migration to trade-based stats
