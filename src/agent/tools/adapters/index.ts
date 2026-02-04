/**
 * Tool Adapters Index
 *
 * Re-exports all tool adapters and provides a combined tool list.
 */

export { intelTools } from './intel-tools.js';
export { tradingTools } from './trading-tools.js';
export { memoryTools } from './memory-tools.js';
export { webTools } from './web-tools.js';
export { systemTools } from './system-tools.js';
export { qmdTools } from './qmd-tools.js';
export { mentatTools } from './mentat-tools.js';
export { discoveryTools } from './discovery-tools.js';

import { intelTools } from './intel-tools.js';
import { tradingTools } from './trading-tools.js';
import { memoryTools } from './memory-tools.js';
import { webTools } from './web-tools.js';
import { systemTools } from './system-tools.js';
import { qmdTools } from './qmd-tools.js';
import { mentatTools } from './mentat-tools.js';
import { discoveryTools } from './discovery-tools.js';
import type { ToolDefinition } from '../types.js';
import type { AgentToolRegistry } from '../registry.js';

/**
 * All available tools.
 */
export const allTools: ToolDefinition[] = [
  ...intelTools,
  ...tradingTools,
  ...memoryTools,
  ...webTools,
  ...systemTools,
  ...qmdTools,
  ...mentatTools,
  ...discoveryTools,
];

/**
 * Read-only tools (no side effects).
 */
export const readOnlyTools: ToolDefinition[] = allTools.filter(
  (tool) => !tool.sideEffects
);

/**
 * Tools with side effects (writes, trades).
 */
export const sideEffectTools: ToolDefinition[] = allTools.filter(
  (tool) => tool.sideEffects
);

/**
 * Tools that require confirmation.
 */
export const confirmationTools: ToolDefinition[] = allTools.filter(
  (tool) => tool.requiresConfirmation
);

/**
 * Create a fresh tool list (defensive copy).
 */
export function createAllTools(): ToolDefinition[] {
  return [...allTools];
}

/**
 * Register all tools into a registry.
 */
export function registerAllTools(registry: AgentToolRegistry): void {
  registry.registerAll(allTools);
}
