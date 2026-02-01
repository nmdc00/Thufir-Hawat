/**
 * Trading Tools Adapter
 *
 * Wraps existing trading-related tools from tool-executor.ts.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { executeToolCall, type ToolExecutorContext } from '../../../core/tool-executor.js';

/**
 * Convert ToolContext to ToolExecutorContext.
 */
function toExecutorContext(ctx: ToolContext): ToolExecutorContext {
  return ctx as unknown as ToolExecutorContext;
}

/**
 * Place bet tool - execute a trade.
 */
export const placeBetTool: ToolDefinition = {
  name: 'place_bet',
  description: 'Place a bet on a prediction market. Use after researching a market to execute a trade. System spending/exposure limits apply automatically.',
  category: 'trading',
  schema: z.object({
    market_id: z.string().describe('The Polymarket market ID to bet on'),
    outcome: z.enum(['YES', 'NO']).describe('The outcome to bet on (YES or NO)'),
    amount: z.number().positive().describe('Amount in USD to bet'),
    reasoning: z.string().optional().describe('Your reasoning for this bet (stored for calibration tracking)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('place_bet', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: true,
  requiresConfirmation: true, // Trades always require confirmation
  cacheTtlMs: 0, // No caching for trades
};

/**
 * Trade place tool (dot-notation alias).
 */
export const tradePlaceTool: ToolDefinition = {
  name: 'trade.place',
  description: 'Place a bet on a prediction market. Use after researching a market to execute a trade. System spending/exposure limits apply automatically.',
  category: 'trading',
  schema: z.object({
    market_id: z.string().describe('The Polymarket market ID to bet on'),
    outcome: z.enum(['YES', 'NO']).describe('The outcome to bet on (YES or NO)'),
    amount: z.number().positive().describe('Amount in USD to bet'),
    reasoning: z.string().optional().describe('Your reasoning for this bet (stored for calibration tracking)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('place_bet', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: true,
  requiresConfirmation: true,
  cacheTtlMs: 0,
};

/**
 * Get portfolio tool - view current positions.
 */
export const getPortfolioTool: ToolDefinition = {
  name: 'get_portfolio',
  description: 'Get current portfolio: positions, balances, and P&L. Use before betting to understand available capital and exposure.',
  category: 'trading',
  schema: z.object({}),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('get_portfolio', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 10_000, // Short cache for portfolio
};

/**
 * Get predictions tool - view prediction history.
 */
export const getPredictionsTool: ToolDefinition = {
  name: 'get_predictions',
  description: 'Get past predictions and their outcomes. Use to review betting history, learn from mistakes, and improve calibration.',
  category: 'trading',
  schema: z.object({
    limit: z.number().optional().describe('Maximum predictions to return (default: 20)'),
    status: z.enum(['all', 'pending', 'resolved', 'won', 'lost']).optional().describe('Filter by status (default: all)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('get_predictions', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 30_000,
};

/**
 * All trading tools.
 */
export const tradingTools: ToolDefinition[] = [
  placeBetTool,
  tradePlaceTool,
  getPortfolioTool,
  getPredictionsTool,
];
