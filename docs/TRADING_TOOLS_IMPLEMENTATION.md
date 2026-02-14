# Trading Tools (Perps)

## Core Tools
- `perp_market_list`: list available perp symbols
- `perp_market_get`: get market metadata + mark price
- `perp_place_order`: place order (market/limit, leverage, reduce-only)
- `perp_open_orders`: list open orders
- `perp_cancel_order`: cancel order by id
- `perp_positions`: list open positions
- `trade_management_open_envelopes`: list open trade envelopes (mechanical exit layer)
- `trade_management_recent_closes`: list recent trade-management close records
- `trade_management_summary`: compute a compact journal summary (last N closes)
- `get_portfolio`: combined balances + perp positions
- `perp_analyze`: market analysis with directional probability + risks
- `position_analysis`: exposure + liquidation risk report
- `discovery_report`: summarize signals/hypotheses/expressions
- `trade_review`: recent trade recap with mark-to-market

## Risk Guardrails
- Max notional per market
- Max leverage caps
- Liquidation distance checks
- Correlation caps across symbols

## Execution
- Adapter: `src/execution/modes/hyperliquid-live.ts`
- Client: `src/execution/hyperliquid/client.ts`
- Market list: `src/execution/hyperliquid/markets.ts`

## Signals (Discovery)
- `signal_price_vol_regime`
- `signal_cross_asset_divergence`
- `signal_hyperliquid_funding_oi_skew`
- `signal_hyperliquid_orderflow_imbalance`

## Notes
Legacy tools (`place_bet`, order book, price history) are removed.
