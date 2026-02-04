/**
 * Mentat Mode Configuration
 *
 * Deep analysis mode for comprehensive market research and fragility analysis.
 * Extended iterations, full tool access (except trading), requires critic.
 */

import type { ModeConfig } from './types.js';

/**
 * All analysis tools allowed in mentat mode (no trading).
 */
const MENTAT_TOOLS = [
  // Perp market tools (read-only)
  'perp_market_list',
  'perp_market_get',
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

  // Portfolio analysis (no trading)
  'get_portfolio',
  'get_positions',
  'signal_price_vol_regime',
  'signal_cross_asset_divergence',
  'signal_hyperliquid_funding_oi_skew',
  'signal_hyperliquid_orderflow_imbalance',

  // No trade.place - mentat mode is analysis only
];

/**
 * Mentat mode configuration.
 * Note: maxIterations and temperature can be overridden in config.yaml under agent.modes.mentat
 */
export const mentatMode: ModeConfig = {
  name: 'mentat',
  description: 'Deep analysis mode for comprehensive research and fragility analysis. No trading.',
  allowedTools: MENTAT_TOOLS,
  maxIterations: 20, // Increased from 12 - deep analysis shouldn't be constrained
  requireCritic: true, // Critic for analysis quality
  requireConfirmation: false, // No trades, no confirmation needed
  minConfidence: 0.0, // Analysis can proceed at any confidence
  temperature: 0.5, // Balanced for thoughtful analysis
};
