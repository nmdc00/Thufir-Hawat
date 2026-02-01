/**
 * Planning Types
 *
 * Defines the structures for agent plans and planning.
 */

/**
 * Status of a plan step.
 */
export type StepStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'skipped';

/**
 * A single step in an agent plan.
 */
export interface PlanStep {
  /** Unique step identifier */
  id: string;

  /** Human-readable description */
  description: string;

  /** Whether this step requires a tool call */
  requiresTool: boolean;

  /** Tool name if requiresTool is true */
  toolName?: string;

  /** Tool input if requiresTool is true */
  toolInput?: Record<string, unknown>;

  /** Current status */
  status: StepStatus;

  /** Result if completed */
  result?: unknown;

  /** Error message if failed */
  error?: string;

  /** Dependencies on other step IDs */
  dependsOn?: string[];
}

/**
 * An agent plan for achieving a goal.
 */
export interface AgentPlan {
  /** Plan identifier */
  id: string;

  /** The goal this plan achieves */
  goal: string;

  /** Steps to execute */
  steps: PlanStep[];

  /** Whether the plan is complete */
  complete: boolean;

  /** Blockers preventing completion */
  blockers: string[];

  /** Confidence in the plan (0-1) */
  confidence: number;

  /** When the plan was created */
  createdAt: string;

  /** When the plan was last updated */
  updatedAt: string;

  /** Number of times the plan has been revised */
  revisionCount: number;
}

/**
 * Context provided for planning.
 */
export interface PlanningContext {
  /** Goal to achieve */
  goal: string;

  /** Available tools */
  availableTools: string[];

  /** Memory context (past interactions, predictions, etc.) */
  memoryContext?: string;

  /** Current assumptions */
  assumptions?: string[];

  /** Current hypotheses */
  hypotheses?: string[];
}

/**
 * Result of plan creation.
 */
export interface PlanCreationResult {
  /** The created plan */
  plan: AgentPlan;

  /** Reasoning for the plan */
  reasoning: string;

  /** Warnings or concerns */
  warnings: string[];
}

/**
 * Reason for plan revision.
 */
export type RevisionReason =
  | 'tool_failed'
  | 'tool_result_unexpected'
  | 'new_information'
  | 'assumption_violated'
  | 'user_feedback'
  | 'confidence_drop';

/**
 * Request to revise a plan.
 */
export interface PlanRevisionRequest {
  /** Current plan */
  plan: AgentPlan;

  /** Reason for revision */
  reason: RevisionReason;

  /** Additional context */
  context?: string;

  /** Tool result that triggered revision */
  toolResult?: unknown;

  /** Step that triggered revision */
  triggerStepId?: string;
}

/**
 * Result of plan revision.
 */
export interface PlanRevisionResult {
  /** The revised plan */
  plan: AgentPlan;

  /** What changed */
  changes: string[];

  /** New confidence level */
  confidence: number;
}
