/**
 * Agent State Management
 *
 * Creates and updates the agent state during orchestration.
 */

import { randomUUID } from 'node:crypto';

import type { AgentMode, ModeConfig } from '../modes/types.js';
import type { AgentPlan } from '../planning/types.js';
import type { Hypothesis, Assumption, Reflection } from '../reflection/types.js';
import type { CriticResult } from '../critic/types.js';
import type { ToolExecution } from '../tools/types.js';
import type { AgentState, OrchestratorOptions } from './types.js';

/**
 * Create initial agent state for a new session.
 */
export function createAgentState(
  goal: string,
  mode: AgentMode,
  modeConfig: ModeConfig,
  options?: OrchestratorOptions
): AgentState {
  const now = new Date().toISOString();

  // Convert initial hypotheses to full objects
  const hypotheses: Hypothesis[] = (options?.initialHypotheses ?? []).map(
    (statement, index) => ({
      id: `h-${index + 1}`,
      statement,
      confidence: 'medium',
      supporting: [],
      contradicting: [],
      createdAt: now,
      updatedAt: now,
    })
  );

  // Convert initial assumptions to full objects
  const assumptions: Assumption[] = (options?.initialAssumptions ?? []).map(
    (statement, index) => ({
      id: `a-${index + 1}`,
      statement,
      criticality: 'medium',
      validated: false,
      createdAt: now,
    })
  );

  return {
    sessionId: randomUUID(),
    goal,
    mode,
    modeConfig,
    plan: null,
    planReasoning: '',
    hypotheses,
    assumptions,
    toolExecutions: [],
    confidence: 0.5,
    iteration: 0,
    complete: false,
    response: null,
    criticResult: null,
    memoryContext: null,
    startedAt: now,
    updatedAt: now,
    warnings: [],
    errors: [],
  };
}

/**
 * Update state with a new plan.
 */
export function updatePlan(
  state: AgentState,
  plan: AgentPlan,
  reasoning: string
): AgentState {
  return {
    ...state,
    plan,
    planReasoning: reasoning,
    confidence: plan.confidence,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Update state after a tool execution.
 */
export function addToolExecution(
  state: AgentState,
  execution: ToolExecution
): AgentState {
  return {
    ...state,
    toolExecutions: [...state.toolExecutions, execution],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Apply reflection results to state.
 */
export function applyReflectionToState(
  state: AgentState,
  reflection: Reflection
): AgentState {
  const newConfidence = Math.max(
    0,
    Math.min(1, state.confidence + reflection.confidenceChange)
  );

  return {
    ...state,
    hypotheses: reflection.updatedHypotheses,
    assumptions: reflection.updatedAssumptions,
    confidence: newConfidence,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Update state with memory context.
 */
export function setMemoryContext(
  state: AgentState,
  memoryContext: string | null
): AgentState {
  return {
    ...state,
    memoryContext,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Increment iteration counter.
 */
export function incrementIteration(state: AgentState): AgentState {
  return {
    ...state,
    iteration: state.iteration + 1,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Mark state as complete with response.
 */
export function completeState(
  state: AgentState,
  response: string,
  criticResult?: CriticResult
): AgentState {
  return {
    ...state,
    complete: true,
    response,
    criticResult: criticResult ?? null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Add a warning to state.
 */
export function addWarning(state: AgentState, warning: string): AgentState {
  return {
    ...state,
    warnings: [...state.warnings, warning],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Add an error to state.
 */
export function addError(state: AgentState, error: string): AgentState {
  return {
    ...state,
    errors: [...state.errors, error],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Update plan in state.
 */
export function setPlan(state: AgentState, plan: AgentPlan): AgentState {
  return {
    ...state,
    plan,
    confidence: plan.confidence,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Get a summary of the current state for logging.
 */
export function getStateSummary(state: AgentState): string {
  const lines: string[] = [];

  lines.push(`Session: ${state.sessionId.slice(0, 8)}`);
  lines.push(`Mode: ${state.mode}`);
  lines.push(`Iteration: ${state.iteration}/${state.modeConfig.maxIterations}`);
  lines.push(`Confidence: ${(state.confidence * 100).toFixed(0)}%`);
  lines.push(`Tool Calls: ${state.toolExecutions.length}`);
  lines.push(`Hypotheses: ${state.hypotheses.length}`);
  lines.push(`Assumptions: ${state.assumptions.length}`);

  if (state.plan) {
    const pending = state.plan.steps.filter((s) => s.status === 'pending').length;
    const complete = state.plan.steps.filter((s) => s.status === 'complete').length;
    lines.push(`Plan: ${complete}/${state.plan.steps.length} steps (${pending} pending)`);
  }

  if (state.warnings.length > 0) {
    lines.push(`Warnings: ${state.warnings.length}`);
  }

  if (state.errors.length > 0) {
    lines.push(`Errors: ${state.errors.length}`);
  }

  return lines.join('\n');
}

/**
 * Check if we should continue iterating.
 */
export function shouldContinue(state: AgentState): {
  continue: boolean;
  reason?: string;
} {
  // Check if already complete
  if (state.complete) {
    return { continue: false, reason: 'complete' };
  }

  // Check iteration limit
  if (state.iteration >= state.modeConfig.maxIterations) {
    return { continue: false, reason: 'max_iterations' };
  }

  // Check for fatal errors
  if (state.errors.length > 3) {
    return { continue: false, reason: 'too_many_errors' };
  }

  // Check plan status
  if (state.plan) {
    // Plan is complete
    if (state.plan.complete) {
      return { continue: false, reason: 'plan_complete' };
    }

    // Plan has unresolvable blockers
    if (state.plan.blockers.length > 2) {
      return { continue: false, reason: 'plan_blocked' };
    }
  }

  return { continue: true };
}

/**
 * Extract tool call context for reflection.
 */
export function toToolExecutionContext(
  execution: ToolExecution
): import('../reflection/types.js').ToolExecutionContext {
  return {
    toolName: execution.toolName,
    input: execution.input,
    result: execution.result,
    success: execution.result.success,
    durationMs: execution.durationMs,
  };
}
