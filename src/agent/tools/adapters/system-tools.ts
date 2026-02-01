/**
 * System Tools Adapter
 *
 * Wraps existing system/utility tools from tool-executor.ts.
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
 * Current time tool - get the current date/time.
 */
export const currentTimeTool: ToolDefinition = {
  name: 'current_time',
  description: 'Get the current date and time. Use to understand temporal context for markets and news.',
  category: 'system',
  schema: z.object({
    timezone: z.string().optional().describe('Timezone (default: UTC). Examples: "America/New_York", "Europe/London"'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('current_time', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 1_000, // Very short cache for time
};

/**
 * Get wallet info tool - get wallet address and details.
 */
export const getWalletInfoTool: ToolDefinition = {
  name: 'get_wallet_info',
  description: 'Get wallet address, chain, and token for funding. Use when asking where to deposit funds.',
  category: 'system',
  schema: z.object({}),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('get_wallet_info', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 60_000, // Wallet info rarely changes
};

/**
 * Calculator tool - evaluate simple arithmetic expressions.
 */
export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: 'Evaluate a simple arithmetic expression. Supports + - * / % and parentheses.',
  category: 'system',
  schema: z.object({
    expression: z.string().describe('Arithmetic expression (e.g., "12 * (3 + 4)")'),
  }),
  execute: async (input, _ctx): Promise<ToolResult> => {
    const expression = String((input as { expression?: string }).expression ?? '').trim();
    if (!expression) {
      return { success: false, error: 'Missing expression' };
    }
    if (expression.length > 200) {
      return { success: false, error: 'Expression too long' };
    }
    const safePattern = /^[0-9+\-*/%().\s]+$/;
    if (!safePattern.test(expression)) {
      return { success: false, error: 'Expression contains invalid characters' };
    }
    try {
      // eslint-disable-next-line no-new-func
      const result = Function(`"use strict"; return (${expression});`)();
      if (typeof result !== 'number' || Number.isNaN(result)) {
        return { success: false, error: 'Expression did not produce a valid number' };
      }
      return { success: true, data: { expression, result } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Invalid expression' };
    }
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: 0,
};

/**
 * All system tools.
 */
export const systemTools: ToolDefinition[] = [
  currentTimeTool,
  getWalletInfoTool,
  calculatorTool,
];
