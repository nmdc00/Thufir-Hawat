/**
 * Chat Mode Configuration
 *
 * Default mode for general conversation about markets.
 * Read-only, no trading, quick responses.
 */

import type { ModeConfig } from './types.js';

/**
 * Read-only tools allowed in chat mode.
 */
const CHAT_TOOLS = [
  // Perp market tools (read-only)
  'perp_market_list',
  'perp_market_get',

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

  // Portfolio viewing (no trading)
  'get_portfolio',
  'get_positions',
];

/**
 * Chat mode configuration.
 * Note: maxIterations and temperature can be overridden in config.yaml under agent.modes.chat
 */
export const chatMode: ModeConfig = {
  name: 'chat',
  description: 'General conversation about markets. Read-only, no trading.',
  allowedTools: CHAT_TOOLS,
  maxIterations: 8, // Increased from 4 - simple queries exit early anyway
  requireCritic: false,
  requireConfirmation: false,
  minConfidence: 0.0, // No minimum for chat
  temperature: 0.7,
};
