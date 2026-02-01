/**
 * QMD Tools Adapter
 *
 * Provides local hybrid search (BM25 + vector + LLM reranking) via QMD.
 * Use for building and querying a persistent knowledge base.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { executeToolCall, type ToolExecutorContext } from '../../../core/tool-executor.js';

const DEFAULT_CACHE_TTL = 30_000; // 30 seconds for knowledge queries

/**
 * Convert ToolContext to ToolExecutorContext.
 */
function toExecutorContext(ctx: ToolContext): ToolExecutorContext {
  return ctx as unknown as ToolExecutorContext;
}

/**
 * QMD query tool - search local knowledge base with hybrid search.
 */
export const qmdQueryTool: ToolDefinition = {
  name: 'qmd_query',
  description:
    'Search the local knowledge base using QMD hybrid search (BM25 + vector + LLM reranking). Use to recall past research, articles, and notes.',
  category: 'intel',
  schema: z.object({
    query: z.string().describe('Search query or question to find in knowledge base'),
    mode: z
      .enum(['query', 'search', 'vsearch'])
      .optional()
      .describe('Search mode: query=hybrid (best), search=BM25, vsearch=vector'),
    limit: z.number().optional().describe('Maximum results (default: 10, max: 50)'),
    collection: z
      .string()
      .optional()
      .describe('Collection to search (e.g., thufir-research, thufir-intel, thufir-markets)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('qmd_query', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * QMD query tool (dot-notation alias).
 */
export const qmdQueryAliasTool: ToolDefinition = {
  name: 'qmd.query',
  description:
    'Search the local knowledge base using QMD hybrid search (BM25 + vector + LLM reranking). Use to recall past research, articles, and notes.',
  category: 'intel',
  schema: z.object({
    query: z.string().describe('Search query or question to find in knowledge base'),
    mode: z
      .enum(['query', 'search', 'vsearch'])
      .optional()
      .describe('Search mode: query=hybrid (best), search=BM25, vsearch=vector'),
    limit: z.number().optional().describe('Maximum results (default: 10, max: 50)'),
    collection: z
      .string()
      .optional()
      .describe('Collection to search (e.g., thufir-research, thufir-intel, thufir-markets)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('qmd_query', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * QMD index tool - save content to knowledge base.
 */
export const qmdIndexTool: ToolDefinition = {
  name: 'qmd_index',
  description:
    'Index content into the local knowledge base for future recall. Use to save important research, articles, or notes.',
  category: 'intel',
  schema: z.object({
    content: z.string().describe('The content to index (markdown supported)'),
    title: z.string().describe('Title for the indexed content'),
    collection: z
      .enum(['thufir-research', 'thufir-intel', 'thufir-markets'])
      .optional()
      .describe('Collection to store in (default: thufir-research)'),
    source: z.string().optional().describe('Source URL or reference'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('qmd_index', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: true,
  requiresConfirmation: false,
  cacheTtlMs: 0, // No caching for writes
};

/**
 * QMD index tool (dot-notation alias).
 */
export const qmdIndexAliasTool: ToolDefinition = {
  name: 'qmd.index',
  description:
    'Index content into the local knowledge base for future recall. Use to save important research, articles, or notes.',
  category: 'intel',
  schema: z.object({
    content: z.string().describe('The content to index (markdown supported)'),
    title: z.string().describe('Title for the indexed content'),
    collection: z
      .enum(['thufir-research', 'thufir-intel', 'thufir-markets'])
      .optional()
      .describe('Collection to store in (default: thufir-research)'),
    source: z.string().optional().describe('Source URL or reference'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('qmd_index', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: true,
  requiresConfirmation: false,
  cacheTtlMs: 0,
};

/**
 * All QMD tools.
 */
export const qmdTools: ToolDefinition[] = [
  qmdQueryTool,
  qmdQueryAliasTool,
  qmdIndexTool,
  qmdIndexAliasTool,
];
