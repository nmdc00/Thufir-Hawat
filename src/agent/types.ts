/**
 * Agent Types
 *
 * Shared types re-exported for external consumers.
 */

// Identity types
export type {
  AgentIdentity,
  BehavioralTrait,
  IdentityConfig,
  IdentityLoadResult,
} from './identity/types.js';
export { THUFIR_TRAITS, IDENTITY_MARKER } from './identity/types.js';

// Mode types
export type {
  AgentMode,
  ModeConfig,
  ModeDetectionResult,
} from './modes/types.js';

// Tool types
export type {
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolExecution,
  ToolCategory,
  LlmToolSchema,
} from './tools/types.js';

// Planning types
export type {
  AgentPlan,
  PlanStep,
  StepStatus,
  PlanningContext,
  PlanCreationResult,
  RevisionReason,
  PlanRevisionRequest,
  PlanRevisionResult,
} from './planning/types.js';

// Reflection types
export type {
  Hypothesis,
  Assumption,
  Reflection,
  ReflectionState,
  ConfidenceLevel,
  ToolExecutionContext,
} from './reflection/types.js';

// Critic types
export type {
  CriticResult,
  CriticIssue,
  CriticIssueType,
  CriticSeverity,
  CriticContext,
  CriticConfig,
} from './critic/types.js';
export { DEFAULT_CRITIC_CONFIG } from './critic/types.js';

// Orchestrator types
export type {
  AgentState,
  OrchestratorContext,
  OrchestratorResult,
  OrchestratorOptions,
  IterationResult,
  SynthesisRequest,
} from './orchestrator/types.js';
