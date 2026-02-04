/**
 * Trade Mode Configuration
 *
 * Mode for executing trades on markets.
 * Includes trading tools, requires critic pass and confirmation.
 */

import type { ModeConfig } from './types.js';

/**
 * All tools allowed in trade mode.
 */
const TRADE_TOOLS = [
  // Market tools
  'market_search',
  'market_get',
  'markets.search',
  'markets.get',
  'market_categories',
  'get_order_book',
  'price_history',
  'perp_market_list',
  'perp_market_get',
  'perp_open_orders',
  'perp_cancel_order',
  'perp_positions',

  // Intel tools
  'intel_search',
  'intel.search',
  'intel_recent',
  'twitter_search',
  'comments.get',

  // Memory tools
  'calibration_stats',
  'memory.query',

  // Web tools
  'web_search',
  'web.search',
  'web_fetch',

  // System tools
  'current_time',
  'get_wallet_info',
  'calculator',

  // Trading tools
  'get_portfolio',
  'get_predictions',
  'perp_place_order',
  'signal_price_vol_regime',
  'signal_cross_asset_divergence',
  'discovery_run',
];

/**
 * Trade mode configuration.
 * Note: maxIterations, temperature, requireConfirmation, minConfidence can be overridden in config.yaml under agent.modes.trade
 */
export const tradeMode: ModeConfig = {
  name: 'trade',
  description: 'Trading mode for executing market orders. Includes critic pass.',
  allowedTools: TRADE_TOOLS,
  maxIterations: 15, // Increased from 8 - full research → trade needs room
  requireCritic: true, // Critic required for trades
  requireConfirmation: true, // Confirmation required for trades
  minConfidence: 0.6, // Minimum confidence for trades
  temperature: 0.3, // Lower temperature for more deterministic trading
};
