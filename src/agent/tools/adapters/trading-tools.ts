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

export const getPortfolioTool: ToolDefinition = {
  name: 'get_portfolio',
  description:
    'Get current portfolio: positions, balances, P&L, and (if configured) perp positions. Use before trading to understand available capital and exposure.',
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
 * Get positions tool - view live Hyperliquid positions.
 */
export const getPositionsTool: ToolDefinition = {
  name: 'get_positions',
  description: 'Get current Hyperliquid positions and account summary.',
  category: 'trading',
  schema: z.object({}),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('get_positions', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 10_000,
};


/**
 * Get open orders tool - view open orders from the executor.
 */
export const getOpenOrdersTool: ToolDefinition = {
  name: 'get_open_orders',
  description: 'Get currently open orders.',
  category: 'trading',
  schema: z.object({}),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('get_open_orders', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 10_000,
};

/**
 * All trading tools.
 */
export const tradingTools: ToolDefinition[] = [
  getPortfolioTool,
  getPositionsTool,
  getOpenOrdersTool,
];
