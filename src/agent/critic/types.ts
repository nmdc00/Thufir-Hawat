/**
 * Critic Types
 *
 * Defines structures for the critic pass that validates high-stakes outputs.
 */

/**
 * Types of issues the critic can identify.
 */
export type CriticIssueType =
  | 'unsupported_claim'    // Claim made without tool evidence
  | 'missing_tool_call'    // Should have called a tool but didn't
  | 'assumption_gap'       // Unvalidated critical assumption
  | 'risk_warning'         // Identified risk not addressed
  | 'confidence_mismatch'  // Stated confidence doesn't match evidence
  | 'missing_falsifier'    // Didn't consider what could go wrong
  | 'narrative_bias'       // Over-reliance on narrative vs data
  | 'fragility_ignored'    // High fragility score not acknowledged
  | 'tail_risk_ignored';   // Stressed assumptions or falsifiers not addressed

/**
 * Severity of a critic issue.
 */
export type CriticSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * An issue identified by the critic.
 */
export interface CriticIssue {
  /** Type of issue */
  type: CriticIssueType;

  /** Human-readable description */
  description: string;

  /** Severity level */
  severity: CriticSeverity;

  /** Location in response (if applicable) */
  location?: string;

  /** Suggested fix */
  suggestion?: string;
}

/**
 * Result of a critic pass.
 */
export interface CriticResult {
  /** Issues found */
  issues: CriticIssue[];

  /** Whether the output is approved */
  approved: boolean;

  /** Revised response if changes needed */
  revisedResponse?: string;

  /** Overall assessment */
  assessment: string;

  /** Confidence in the critic's assessment */
  confidence: number;

  /** Timestamp of critique */
  timestamp: string;
}

/**
 * Fragility context for trade decisions.
 */
export interface TradeFragilityContext {
  /** Overall fragility score (0-1) */
  fragilityScore: number;

  /** Key risk signals identified */
  riskSignals: string[];

  /** Top fragility cards (mechanism + exposure) */
  fragilityCards: Array<{
    mechanism: string;
    exposure: string;
    score: number | null;
    downside: string | null;
  }>;

  /** Stressed assumptions relevant to this trade */
  stressedAssumptions: Array<{
    statement: string;
    stressScore: number | null;
  }>;

  /** What could prove the trade thesis wrong */
  falsifiers: string[];

  /** Detector scores breakdown */
  detectors?: {
    leverage: number;
    coupling: number;
    illiquidity: number;
    consensus: number;
    irreversibility: number;
  };
}

/**
 * Context for critic evaluation.
 */
export interface CriticContext {
  /** The goal being achieved */
  goal: string;

  /** The response being critiqued */
  response: string;

  /** Tool calls that were made */
  toolCalls: Array<{
    name: string;
    input: unknown;
    result: unknown;
    success: boolean;
  }>;

  /** Current assumptions */
  assumptions: string[];

  /** Current hypotheses */
  hypotheses: string[];

  /** Operating mode */
  mode: string;

  /** Whether trading was involved */
  involvesTrade: boolean;

  /** Fragility analysis for trade decisions (optional) */
  fragility?: TradeFragilityContext;
}

/**
 * Configuration for the critic.
 */
export interface CriticConfig {
  /** Minimum issues to trigger rejection */
  minIssuesForRejection: number;

  /** Severity threshold for auto-rejection */
  autoRejectSeverity: CriticSeverity;

  /** Whether to attempt revision */
  attemptRevision: boolean;

  /** Maximum revision attempts */
  maxRevisionAttempts: number;
}

/**
 * Default critic configuration.
 */
export const DEFAULT_CRITIC_CONFIG: CriticConfig = {
  minIssuesForRejection: 2,
  autoRejectSeverity: 'critical',
  attemptRevision: true,
  maxRevisionAttempts: 2,
};
