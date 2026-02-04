# Thufir Development Progress

**Last Updated:** 2026-02-04

## Current Status
Hyperliquid perps + autonomous discovery are integrated. Legacy market flows are removed from user-facing paths. Tests are added but not run in this branch yet.

## Completed
- Hyperliquid market client (list/get symbols, mark price, metadata)
- Live executor for Hyperliquid perps
- Perp risk checks (max notional, leverage caps, liquidation distance, correlation caps)
- Discovery engine (signals -> hypotheses -> expressions)
- Perp tools (`perp_market_list`, `perp_market_get`, `perp_place_order`, `perp_open_orders`, `perp_cancel_order`, `perp_positions`)
- Portfolio now surfaces perp positions
- User-facing prompts updated away from legacy market flows
- CLI and docs updated to remove legacy market commands

## In Progress
- Live Hyperliquid API verification in a real account
- Test run + coverage confirmation
- Tightening discovery/reporting outputs for clarity

## Next Steps
1. Run tests (`pnpm test`) and fix any regressions
2. Validate live API flow with a small perp order
3. Review discovery signals output on live data
4. Decide if to keep legacy memory tables or migrate to trade-based stats
