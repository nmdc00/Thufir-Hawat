/**
 * Agent Module
 *
 * Agentic Thufir Hawat - Mentat-style perp market analyst.
 *
 * This module provides the agent orchestrator that transforms Thufir from
 * chat-first to agentic-first architecture.
 *
 * @example
 * ```typescript
 * import { runOrchestrator, loadThufirIdentity, AgentToolRegistry } from './agent/index.js';
 *
 * const { identity } = loadThufirIdentity();
 * const toolRegistry = new AgentToolRegistry();
 *
 * const result = await runOrchestrator('What is the current price of Bitcoin?', {
 *   llm: llmClient,
 *   toolRegistry,
 *   identity,
 *   toolContext: { config, marketClient },
 * });
 *
 * console.log(result.response);
 * ```
 */

// === Orchestrator (main entry point) ===
export {
  runOrchestrator,
  createOrchestrator,
} from './orchestrator/orchestrator.js';

// === Identity ===
export {
  loadThufirIdentity,
  buildIdentityPrompt,
  buildMinimalIdentityPrompt,
  getIdentityPrompt,
  clearIdentityCache,
  loadIdentityPrelude,
  injectIdentity,
} from './identity/identity.js';

// === Modes ===
export {
  detectMode,
  getModeConfig,
  isToolAllowed,
  getAllowedTools,
  listModes,
} from './modes/registry.js';

export { chatMode } from './modes/chat.js';
export { tradeMode } from './modes/trade.js';
export { mentatMode } from './modes/mentat.js';

// === Tools ===
export {
  AgentToolRegistry,
  createToolRegistry,
  DEFAULT_CACHE_TTL_MS,
} from './tools/registry.js';


export { intelTools } from './tools/adapters/intel-tools.js';

export { tradingTools } from './tools/adapters/trading-tools.js';

export { memoryTools } from './tools/adapters/memory-tools.js';

export { webTools } from './tools/adapters/web-tools.js';

export { systemTools } from './tools/adapters/system-tools.js';

export { qmdTools } from './tools/adapters/qmd-tools.js';

export { mentatTools } from './tools/adapters/mentat-tools.js';

export {
  createAllTools,
  registerAllTools,
} from './tools/adapters/index.js';

// === Planning ===
export {
  createPlan,
  revisePlan,
  getNextStep,
  completeStep,
  failStep,
  isPlanActionable,
} from './planning/planner.js';

// === Reflection ===
export {
  reflect,
  createReflectionState,
  applyReflection,
  addHypothesis,
  addAssumption,
} from './reflection/reflector.js';

// === Critic ===
export {
  runCritic,
  shouldRunCritic,
  formatCriticResult,
} from './critic/critic.js';

// === State Management ===
export {
  createAgentState,
  updatePlan,
  addToolExecution,
  applyReflectionToState,
  setMemoryContext,
  incrementIteration,
  completeState,
  addWarning,
  addError,
  setPlan,
  shouldContinue,
  toToolExecutionContext,
  getStateSummary,
} from './orchestrator/state.js';

// === Types ===
export * from './types.js';
