/**
 * Agent Identity Types
 *
 * Defines the identity structure for the Thufir Hawat mentat agent.
 */

/**
 * Behavioral traits that define how the agent reasons and acts.
 * These are the mentat-style cognitive patterns.
 */
export type BehavioralTrait =
  | 'mechanism-first'      // Focus on causal mechanisms, not narratives
  | 'tail-risk-awareness'  // Always consider extreme outcomes
  | 'assumption-tracking'  // Explicitly track and test assumptions
  | 'falsifier-reporting'  // Actively seek disconfirming evidence
  | 'low-narrative-trust'  // Skeptical of stories, prefer data
  | 'tool-first';          // Use tools before guessing external state

/**
 * The core identity of the agent.
 */
export interface AgentIdentity {
  /** Display name of the agent */
  name: string;

  /** Role description */
  role: string;

  /** Behavioral traits that guide reasoning */
  traits: BehavioralTrait[];

  /** Identity marker for enforcement (appears in prompts) */
  marker: string;

  /** Raw content from identity files */
  rawContent: {
    agents?: string;
    identity?: string;
    soul?: string;
    user?: string;
  };
}

/**
 * Configuration for loading identity.
 */
export interface IdentityConfig {
  /** Path to workspace directory containing identity files */
  workspacePath?: string;
  /** Prompt mode for identity injection */
  promptMode?: 'full' | 'minimal' | 'none';
}

/**
 * Result of identity loading.
 */
export interface IdentityLoadResult {
  identity: AgentIdentity;
  filesLoaded: string[];
  warnings: string[];
}

/**
 * Result of loading the identity prelude.
 */
export interface IdentityPreludeLoadResult {
  prelude: string;
  identity: AgentIdentity;
  filesLoaded: string[];
  warnings: string[];
}

/**
 * Default Thufir Hawat traits.
 */
export const THUFIR_TRAITS: BehavioralTrait[] = [
  'mechanism-first',
  'tail-risk-awareness',
  'assumption-tracking',
  'falsifier-reporting',
  'low-narrative-trust',
  'tool-first',
];

/**
 * Identity marker that must appear in all responses.
 * Used for identity enforcement.
 */
export const IDENTITY_MARKER = 'THUFIR_HAWAT';
