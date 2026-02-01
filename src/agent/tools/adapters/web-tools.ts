/**
 * Web Tools Adapter
 *
 * Wraps existing web-related tools from tool-executor.ts.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { executeToolCall, type ToolExecutorContext } from '../../../core/tool-executor.js';

const DEFAULT_CACHE_TTL = 60_000; // 1 minute for web content

/**
 * Convert ToolContext to ToolExecutorContext.
 */
function toExecutorContext(ctx: ToolContext): ToolExecutorContext {
  return ctx as unknown as ToolExecutorContext;
}

/**
 * Web search tool - search the web.
 */
export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web for information. Use for research, news, facts, or context not available in other tools.',
  category: 'web',
  schema: z.object({
    query: z.string().describe('Search query (e.g., "Fed interest rate decision January 2026")'),
    limit: z.number().optional().describe('Maximum results (default: 5, max: 10)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('web_search', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * Web search tool (dot-notation alias).
 */
export const webSearchAliasTool: ToolDefinition = {
  name: 'web.search',
  description: 'Search the web for information. Use for research, news, facts, or context not available in other tools.',
  category: 'web',
  schema: z.object({
    query: z.string().describe('Search query (e.g., "Fed interest rate decision January 2026")'),
    limit: z.number().optional().describe('Maximum results (default: 5, max: 10)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('web_search', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * Web fetch tool - fetch and extract content from a URL.
 */
export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch and extract content from a web page URL. Returns readable text/markdown.',
  category: 'web',
  schema: z.object({
    url: z.string().url().describe('The URL to fetch (must be http or https)'),
    max_chars: z.number().optional().describe('Maximum characters to return (default: 10000, max: 50000)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('web_fetch', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * All web tools.
 */
export const webTools: ToolDefinition[] = [
  webSearchTool,
  webSearchAliasTool,
  webFetchTool,
];
