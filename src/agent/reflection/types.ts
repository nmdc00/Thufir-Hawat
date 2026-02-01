/**
 * Reflection Types
 *
 * Defines structures for agent reflection after tool execution.
 */

/**
 * Confidence level for hypotheses and assumptions.
 */
export type ConfidenceLevel = 'low' | 'medium' | 'high';

/**
 * A hypothesis the agent is tracking.
 */
export interface Hypothesis {
  /** Unique identifier */
  id: string;

  /** The hypothesis statement */
  statement: string;

  /** Current confidence level */
  confidence: ConfidenceLevel;

  /** Evidence supporting the hypothesis */
  supporting: string[];

  /** Evidence against the hypothesis */
  contradicting: string[];

  /** When the hypothesis was formed */
  createdAt: string;

  /** When last updated */
  updatedAt: string;
}

/**
 * An assumption the agent is making.
 */
export interface Assumption {
  /** Unique identifier */
  id: string;

  /** The assumption statement */
  statement: string;

  /** How critical this assumption is */
  criticality: 'low' | 'medium' | 'high';

  /** What would falsify this assumption */
  falsifier?: string;

  /** Whether it's been validated */
  validated: boolean;

  /** When the assumption was made */
  createdAt: string;
}

/**
 * Result of a tool execution for reflection.
 */
export interface ToolExecutionContext {
  /** Tool that was called */
  toolName: string;

  /** Input provided */
  input: unknown;

  /** Result returned */
  result: unknown;

  /** Whether the call succeeded */
  success: boolean;

  /** How long the call took */
  durationMs: number;
}

/**
 * Result of reflection on a tool execution.
 */
export interface Reflection {
  /** Updated hypotheses */
  updatedHypotheses: Hypothesis[];

  /** Updated assumptions */
  updatedAssumptions: Assumption[];

  /** Change in overall confidence (-1 to 1) */
  confidenceChange: number;

  /** Suggested next step */
  nextStep?: string;

  /** Whether the plan should be revised */
  suggestRevision: boolean;

  /** Reason for revision if suggested */
  revisionReason?: string;

  /** New information learned */
  newInformation: string[];

  /** Timestamp of reflection */
  timestamp: string;
}

/**
 * State for reflection context.
 */
export interface ReflectionState {
  /** Current hypotheses */
  hypotheses: Hypothesis[];

  /** Current assumptions */
  assumptions: Assumption[];

  /** Overall confidence (0-1) */
  confidence: number;

  /** Tool executions so far */
  toolExecutions: ToolExecutionContext[];
}
