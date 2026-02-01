/**
 * Mode Types
 *
 * Defines the interface for agent operating modes.
 */

/**
 * Available agent modes.
 */
export type AgentMode = 'chat' | 'trade' | 'mentat';

/**
 * Configuration for an operating mode.
 */
export interface ModeConfig {
  /** Mode identifier */
  name: AgentMode;

  /** Human-readable description */
  description: string;

  /** Tools allowed in this mode */
  allowedTools: string[];

  /** Maximum iterations (LLM round-trips) */
  maxIterations: number;

  /** Whether critic pass is required */
  requireCritic: boolean;

  /** Whether user confirmation is required for side effects */
  requireConfirmation: boolean;

  /** Minimum confidence threshold for actions */
  minConfidence: number;

  /** Temperature for LLM calls */
  temperature: number;
}

/**
 * Result of mode detection.
 */
export interface ModeDetectionResult {
  /** Detected mode */
  mode: AgentMode;

  /** Confidence in detection (0-1) */
  confidence: number;

  /** Signals that led to this detection */
  signals: string[];
}
