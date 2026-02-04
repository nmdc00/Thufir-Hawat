/**
 * Mentat Tools Adapter
 *
 * Tools for the mentat fragility analysis system.
 * Stores and queries assumptions, mechanisms, and fragility cards.
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
 * Store an assumption in the mentat knowledge base.
 */
export const mentatStoreAssumptionTool: ToolDefinition = {
  name: 'mentat_store_assumption',
  description:
    'Store an assumption for mentat fragility analysis. Assumptions underpin positions and can be stress-tested.',
  category: 'memory',
  schema: z.object({
    statement: z.string().describe('The assumption statement'),
    system: z.string().describe('System or domain this assumption relates to'),
    evidence_for: z.array(z.string()).optional().describe('Evidence supporting this assumption'),
    evidence_against: z.array(z.string()).optional().describe('Evidence contradicting this assumption'),
    dependencies: z.array(z.string()).optional().describe('Dependencies this assumption relies on'),
    stress_score: z.number().optional().describe('Stress score 0-1 (higher = more fragile)'),
    last_tested: z.string().optional().describe('Last time tested (ISO timestamp)'),
    criticality: z.enum(['low', 'medium', 'high']).optional().describe('How critical to current positions'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('mentat_store_assumption', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: true,
  requiresConfirmation: false,
  cacheTtlMs: 0,
};

/**
 * Store a fragility card in the mentat knowledge base.
 */
export const mentatStoreFragilityTool: ToolDefinition = {
  name: 'mentat_store_fragility',
  description:
    'Store a fragility card identifying tail-risk exposure. Tracks structural vulnerabilities, not event forecasts.',
  category: 'memory',
  schema: z.object({
    system: z.string().describe('The system being analyzed'),
    mechanism: z.string().describe('The causal mechanism that could trigger fragility'),
    exposure_surface: z.string().describe('What is exposed to this fragility'),
    early_signals: z.array(z.string()).optional().describe('Observable warning signals'),
    falsifiers: z.array(z.string()).optional().describe('Conditions that would invalidate this assessment'),
    downside: z.string().optional().describe('Potential downside if fragility materializes'),
    convexity: z.string().optional().describe('Convexity profile (nonlinear downside)'),
    recovery_capacity: z.string().optional().describe('Ability to recover once fragility triggers'),
    score: z.number().optional().describe('Fragility score 0-1'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('mentat_store_fragility', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: true,
  requiresConfirmation: false,
  cacheTtlMs: 0,
};

/**
 * Query the mentat knowledge base.
 */
export const mentatQueryTool: ToolDefinition = {
  name: 'mentat_query',
  description:
    'Query the mentat knowledge base for assumptions, fragility cards, or mechanisms.',
  category: 'memory',
  schema: z.object({
    query: z.string().describe('Search query for mentat knowledge'),
    type: z.enum(['assumption', 'fragility', 'mechanism', 'all']).optional().describe('Type to search'),
    system: z.string().optional().describe('Filter by system/domain'),
    limit: z.number().optional().describe('Maximum results (default: 10)'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('mentat_query', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: false,
  requiresConfirmation: false,
  cacheTtlMs: DEFAULT_CACHE_TTL,
};

/**
 * Store a mechanism in the mentat knowledge base.
 */
export const mentatStoreMechanismTool: ToolDefinition = {
  name: 'mentat_store_mechanism',
  description: 'Store a causal mechanism for mentat fragility analysis.',
  category: 'memory',
  schema: z.object({
    name: z.string().describe('Mechanism name'),
    system: z.string().describe('System or domain this mechanism relates to'),
    causal_chain: z.array(z.string()).optional().describe('Ordered causal chain'),
    trigger_class: z.string().optional().describe('Trigger class'),
    propagation_path: z.array(z.string()).optional().describe('Propagation path'),
  }),
  execute: async (input, ctx): Promise<ToolResult> => {
    return executeToolCall('mentat_store_mechanism', input as Record<string, unknown>, toExecutorContext(ctx));
  },
  sideEffects: true,
  requiresConfirmation: false,
  cacheTtlMs: 0,
};

/**
 * All mentat tools.
 */
export const mentatTools: ToolDefinition[] = [
  mentatStoreAssumptionTool,
  mentatStoreFragilityTool,
  mentatStoreMechanismTool,
  mentatQueryTool,
];
