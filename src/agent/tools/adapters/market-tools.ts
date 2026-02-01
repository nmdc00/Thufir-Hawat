/**
 * Market Tools Adapter
 *
 * Wraps existing market-related tools from tool-executor.ts.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { executeToolCall, type ToolExecutorContext } from '../../../core/tool-executor.js';

const DEFAULT_CACHE_TTL = 30_000; // 30 seconds

/**
 * Convert ToolContext to ToolExecutorContext.
 */
function toExecutorContext(ctx: ToolContext): ToolExecutorContext {
  return ctx as unknown as ToolExecutorContext;
}

/**
 * Market search tool - search for prediction markets.
 */
export const marketSearchTool: ToolDefinition = {
  name: 'market_search',
  description: 'Search for prediction markets on Polymarket by query. Use when the user asks about a topic and you want relevant markets.',
  category: 'markets',
  schema: z.object({
    query: z.string().describe('Search query (e.g., "Fed rates", "Bitcoin price")'),
    limit: z.number().optional().describe('Maximum number of results (default: 5, max: 20)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('market_search', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * Markets search tool (dot-notation alias).
 */
export const marketsSearchTool: ToolDefinition = {
  name: 'markets.search',
  description: 'Search for prediction markets on Polymarket by query. Use when the user asks about a topic and you want relevant markets.',
  category: 'markets',
  schema: z.object({
    query: z.string().describe('Search query (e.g., "Fed rates", "Bitcoin price")'),
    limit: z.number().optional().describe('Maximum number of results (default: 5, max: 20)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('market_search', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * Market get tool - get details for a specific market.
 */
export const marketGetTool: ToolDefinition = {
  name: 'market_get',
  description: 'Get detailed information about a specific prediction market by ID.',
  category: 'markets',
  schema: z.object({
    market_id: z.string().describe('Polymarket market ID'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('market_get', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * Markets get tool (dot-notation alias).
 */
export const marketsGetTool: ToolDefinition = {
  name: 'markets.get',
  description: 'Get detailed information about a specific prediction market by ID.',
  category: 'markets',
  schema: z.object({
    market_id: z.string().describe('Polymarket market ID'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('market_get', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * Market categories tool - list market categories.
 */
export const marketCategoriesTool: ToolDefinition = {
  name: 'market_categories',
  description: 'List market categories with counts. Useful for browsing and filtering.',
  category: 'markets',
  schema: z.object({
    limit: z.number().optional().describe('Maximum number of categories (default: 20)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('market_categories', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * Order book tool - get market order book.
 */
export const orderBookTool: ToolDefinition = {
  name: 'get_order_book',
  description: 'Get order book depth for a market. Shows bid/ask prices and liquidity at each level.',
  category: 'markets',
  schema: z.object({
    market_id: z.string().describe('The Polymarket market ID'),
    depth: z.number().optional().describe('Number of price levels to return (default: 5)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('get_order_book', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 10_000, // Shorter cache for order books
};

/**
 * Price history tool - get historical prices.
 */
export const priceHistoryTool: ToolDefinition = {
  name: 'price_history',
  description: 'Get historical price data for a market. Shows how odds have changed over time.',
  category: 'markets',
  schema: z.object({
    market_id: z.string().describe('The Polymarket market ID'),
    interval: z.enum(['1h', '4h', '1d', '1w']).optional().describe('Time interval between data points (default: 1d)'),
    limit: z.number().optional().describe('Number of data points (default: 30)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('price_history', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 60_000, // 1 minute for historical data
};

/**
 * All market tools.
 */
export const marketTools: ToolDefinition[] = [
  marketSearchTool,
  marketsSearchTool,
  marketGetTool,
  marketsGetTool,
  marketCategoriesTool,
  orderBookTool,
  priceHistoryTool,
];
