# Tool Calling Implementation

## Overview
Thufir uses tool calling for market data, trading, discovery signals, and intel. All tools are registered in `src/agent/tools/adapters` and executed via `src/core/tool-executor.ts`.

## Key Tool Groups
- **Perp Markets**: `perp_market_list`, `perp_market_get`
- **Perp Trading**: `perp_place_order`, `perp_open_orders`, `perp_cancel_order`, `perp_positions`
- **Portfolio**: `get_portfolio`, `get_positions`
- **Discovery Signals**: `signal_price_vol_regime`, `signal_cross_asset_divergence`, `signal_hyperliquid_funding_oi_skew`, `signal_hyperliquid_orderflow_imbalance`, `discovery_run`
- **Intel/Web**: `intel_search`, `intel_recent`, `twitter_search`, `web_search`, `web_fetch`

## Safety
- Tool executor enforces validation and risk checks for perps.
- Trading tools require confirmation.

## Deprecated
Legacy market tools and schemas have been removed from active tool lists.
