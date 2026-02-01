/**
 * Orchestrator Types
 *
 * Defines the state and context structures for the agent orchestrator.
 */

import type { LlmClient } from '../../core/llm.js';
import type { AgentMode, ModeConfig } from '../modes/types.js';
import type { AgentPlan } from '../planning/types.js';
import type { Hypothesis, Assumption } from '../reflection/types.js';
import type { CriticResult } from '../critic/types.js';
import type { AgentIdentity } from '../identity/types.js';
import type { ToolContext, ListToolsOptions, LlmToolSchema } from '../tools/types.js';
import type { ToolExecution } from '../tools/types.js';

/**
 * The current state of an agent session.
 */
export interface AgentState {
  /** Unique session identifier */
  sessionId: string;

  /** The original goal/query */
  goal: string;

  /** Current operating mode */
  mode: AgentMode;

  /** Mode configuration */
  modeConfig: ModeConfig;

  /** Current plan */
  plan: AgentPlan | null;

  /** Planning reasoning */
  planReasoning: string;

  /** Current hypotheses */
  hypotheses: Hypothesis[];

  /** Current assumptions */
  assumptions: Assumption[];

  /** Tool executions in this session */
  toolExecutions: ToolExecution[];

  /** Overall confidence (0-1) */
  confidence: number;

  /** Current iteration */
  iteration: number;

  /** Whether the goal has been achieved */
  complete: boolean;

  /** Final response (if complete) */
  response: string | null;

  /** Critic result (if run) */
  criticResult: CriticResult | null;

  /** Memory context loaded */
  memoryContext: string | null;

  /** Timestamps */
  startedAt: string;
  updatedAt: string;

  /** Warnings accumulated during execution */
  warnings: string[];

  /** Errors encountered */
  errors: string[];
}

/**
 * Context needed to run the orchestrator.
 */
export interface OrchestratorContext {
  /** LLM client for completions */
  llm: LlmClient;

  /** Tool registry */
  toolRegistry: {
    execute: (
      name: string,
      input: unknown,
      ctx: ToolContext
    ) => Promise<ToolExecution>;
    listNames: (options?: ListToolsOptions) => string[];
    getLlmSchemas: (options?: ListToolsOptions) => LlmToolSchema[];
    get?: (name: string) => { requiresConfirmation?: boolean } | undefined;
  };

  /** Agent identity */
  identity: AgentIdentity;

  /** Tool execution context (config, marketClient, etc.) */
  toolContext: ToolContext;

  /** Memory system for context retrieval */
  memorySystem?: {
    getRelevantContext: (query: string) => Promise<string | null>;
  };

  /** Callback for streaming updates */
  onUpdate?: (state: AgentState) => void;

  /** Callback for confirmation prompts */
  onConfirmation?: (
    message: string,
    tool: string,
    input: unknown
  ) => Promise<boolean>;
}

/**
 * Fragility summary for trade decisions.
 */
export interface FragilitySummary {
  /** Overall fragility score (0-1) */
  fragilityScore: number;
  /** Number of risk signals identified */
  riskSignalCount: number;
  /** Number of fragility cards */
  fragilityCardCount: number;
  /** Top risk signals */
  topRiskSignals: string[];
  /** Whether this was high fragility (>0.6) */
  highFragility: boolean;
}

/**
 * Result of orchestrator execution.
 */
export interface OrchestratorResult {
  /** Final state */
  state: AgentState;

  /** Final response to user */
  response: string;

  /** Whether the goal was achieved */
  success: boolean;

  /** Summary of what happened */
  summary: {
    mode: AgentMode;
    iterations: number;
    toolCalls: number;
    planRevisions: number;
    criticApproved: boolean | null;
    confidence: number;
    /** Fragility analysis summary (for trades) */
    fragility?: FragilitySummary;
  };

  /** Metadata for debugging */
  metadata: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
  };
}

/**
 * Options for running the orchestrator.
 */
export interface OrchestratorOptions {
  /** Force a specific mode (skip detection) */
  forceMode?: AgentMode;

  /** Override max iterations */
  maxIterations?: number;

  /** Skip planning phase */
  skipPlanning?: boolean;

  /** Skip critic phase */
  skipCritic?: boolean;

  /** Override synthesis system prompt */
  synthesisSystemPrompt?: string;

  /** Initial hypotheses */
  initialHypotheses?: string[];

  /** Initial assumptions */
  initialAssumptions?: string[];
}

/**
 * Iteration result for the main loop.
 */
export interface IterationResult {
  /** Should continue iterating */
  continue: boolean;

  /** Reason for stopping (if not continuing) */
  stopReason?: 'complete' | 'max_iterations' | 'no_progress' | 'error' | 'blocked';

  /** Updated state */
  state: AgentState;
}

/**
 * Synthesis request for generating the final response.
 */
export interface SynthesisRequest {
  /** Original goal */
  goal: string;

  /** Tool results to incorporate */
  toolResults: ToolExecution[];

  /** Current hypotheses */
  hypotheses: Hypothesis[];

  /** Current assumptions */
  assumptions: Assumption[];

  /** Memory context */
  memoryContext: string | null;

  /** Agent identity */
  identity: AgentIdentity;

  /** Mode for response style */
  mode: AgentMode;
}
