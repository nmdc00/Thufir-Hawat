/**
 * Tool Types
 *
 * Defines the interface for agent tools and the tool registry.
 */

import type { z } from 'zod';

/**
 * Tool categories for organization and filtering.
 */
export type ToolCategory =
  | 'markets'   // Market data and trading
  | 'intel'     // News and information
  | 'memory'    // Calibration and history
  | 'trading'   // Trade execution
  | 'web'       // Web access
  | 'system';   // Utilities

/**
 * Result of a tool execution.
 */
export type ToolResult =
  | { success: true; data: unknown }
  | { success: false; error: string };

/**
 * Context passed to tool execution.
 */
export interface ToolContext {
  /** Configuration */
  config: unknown;
  /** Market client for API calls */
  marketClient?: unknown;
  /** Executor for trades */
  executor?: unknown;
  /** Spending limiter */
  limiter?: unknown;
}

/**
 * Definition of a tool that the agent can use.
 */
export interface ToolDefinition<TInput = unknown> {
  /** Unique tool name */
  name: string;

  /** Human-readable description */
  description: string;

  /** Category for filtering */
  category: ToolCategory;

  /** Zod schema for input validation */
  schema: z.ZodSchema<TInput>;

  /** Execute the tool */
  execute: (input: TInput, ctx: ToolContext) => Promise<ToolResult>;

  /** Whether this tool has side effects (writes, trades, etc.) */
  sideEffects: boolean;

  /** Whether this tool requires user confirmation before execution */
  requiresConfirmation: boolean;

  /** Cache TTL in milliseconds (0 = no caching) */
  cacheTtlMs: number;
}

/**
 * Record of a tool execution for state tracking.
 */
export interface ToolExecution {
  /** Tool name */
  toolName: string;

  /** Input provided */
  input: unknown;

  /** Result returned */
  result: ToolResult;

  /** Timestamp of execution */
  timestamp: string;

  /** Execution duration in ms */
  durationMs: number;

  /** Whether result was from cache */
  cached: boolean;
}

/**
 * Cache entry for tool results.
 */
export interface ToolCacheEntry {
  /** Cached result */
  result: ToolResult;

  /** When the cache entry was created */
  cachedAt: number;

  /** Cache key (tool name + input hash) */
  key: string;
}

/**
 * Options for listing tools.
 */
export interface ListToolsOptions {
  /** Filter by category */
  category?: ToolCategory;

  /** Only include tools without side effects */
  readOnly?: boolean;

  /** Only include tools that don't require confirmation */
  noConfirmation?: boolean;
}

/**
 * Tool schema for LLM tool calling (Anthropic format).
 */
export interface LlmToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}
