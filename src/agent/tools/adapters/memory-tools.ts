/**
 * Memory Tools Adapter
 *
 * Wraps existing memory/calibration-related tools from tool-executor.ts.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { executeToolCall, type ToolExecutorContext } from '../../../core/tool-executor.js';
import type { ThufirConfig } from '../../../core/config.js';
import { ChatVectorStore } from '../../../memory/chat_vectorstore.js';
import { listChatMessagesByIds } from '../../../memory/chat.js';

const DEFAULT_CACHE_TTL = 30_000; // 30 seconds

/**
 * Convert ToolContext to ToolExecutorContext.
 */
function toExecutorContext(ctx: ToolContext): ToolExecutorContext {
  return ctx as unknown as ToolExecutorContext;
}

/**
 * Calibration stats tool - get trade track record.
 */
export const calibrationStatsTool: ToolDefinition = {
  name: 'calibration_stats',
  description: "Get the user's trade calibration stats (accuracy, track record).",
  category: 'memory',
  schema: z.object({
    domain: z.string().optional().describe('Filter by domain (e.g., "politics", "crypto")'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('calibration_stats', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * Memory query tool - semantic search over chat history.
 */
export const memoryQueryTool: ToolDefinition = {
  name: 'memory.query',
  description: 'Query chat memory using semantic search. Returns relevant past messages.',
  category: 'memory',
  schema: z.object({
    query: z.string().describe('What to search for in chat memory'),
    limit: z.number().optional().describe('Maximum messages to return (default: 5)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    const config = ctx.config as ThufirConfig;
    const query = String((input as { query?: string }).query ?? '').trim();
    const limit = Math.min(Math.max(Number((input as { limit?: number }).limit ?? 5), 1), 20);

    if (!query) {
      return { success: false, error: 'Missing query' };
    }

    const store = new ChatVectorStore(config);
    const hits = await store.query(query, limit);
    const messages = listChatMessagesByIds(hits.map((hit) => hit.id));

    const scored = messages.map((message) => {
      const score = hits.find((hit) => hit.id === message.id)?.score ?? 0;
      return { ...message, score };
    });

    return { success: true, data: scored };
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * Evaluation summary tool - live performance and calibration snapshot.
 */
export const evaluationSummaryTool: ToolDefinition = {
  name: 'evaluation.summary',
  description: 'Get evaluation summary metrics (PnL, calibration, edge, domain performance).',
  category: 'memory',
  schema: z.object({
    window_days: z.number().optional().describe('Window length in days (omit for all-time).'),
    domain: z.string().optional().describe('Optional domain filter (e.g., politics, crypto).'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('evaluation_summary', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * All memory tools.
 */
export const memoryTools: ToolDefinition[] = [
  calibrationStatsTool,
  memoryQueryTool,
  evaluationSummaryTool,
];
