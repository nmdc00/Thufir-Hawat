/**
 * Agent Critic
 *
 * Validates high-stakes outputs before delivery.
 */

import type { LlmClient, ChatMessage } from '../../core/llm.js';
import type {
  CriticResult,
  CriticContext,
  CriticConfig,
  CriticIssue,
  CriticIssueType,
  CriticSeverity,
  TradeFragilityContext,
} from './types.js';
import { DEFAULT_CRITIC_CONFIG } from './types.js';

/**
 * System prompt for the critic.
 */
const CRITIC_SYSTEM_PROMPT = `You are a critical reviewer for a mentat-style perp market analyst.

Your job is to identify issues in the agent's output before it's delivered to the user.

## Review Criteria

1. **Tool-First Compliance**: Did the agent call tools before making claims about external state?
2. **Assumption Tracking**: Are assumptions explicit? Are critical ones validated?
3. **Falsifier Reporting**: Did the agent consider what could prove them wrong?
4. **Evidence Support**: Are claims backed by tool results, not guesses?
5. **Risk Awareness**: For trades, are tail risks addressed?
6. **Confidence Calibration**: Does stated confidence match the evidence?

## Trade-Specific Criteria (when fragility analysis is present)

7. **Fragility Awareness**: Did the agent acknowledge high fragility scores?
8. **Tail Risk Coverage**: Are stressed assumptions and falsifiers addressed?
9. **Position Sizing**: Does position size reflect fragility level?
10. **Exit Strategy**: For high-fragility trades, is there a clear exit plan?

## Issue Types

- unsupported_claim: Claim made without tool evidence
- missing_tool_call: Should have called a tool but didn't
- assumption_gap: Unvalidated critical assumption
- risk_warning: Identified risk not addressed
- confidence_mismatch: Stated confidence doesn't match evidence
- missing_falsifier: Didn't consider what could go wrong
- narrative_bias: Over-reliance on narrative vs data
- fragility_ignored: High fragility score not acknowledged
- tail_risk_ignored: Stressed assumptions or falsifiers not addressed

## Response Format

Respond with a JSON object:
{
  "issues": [
    {
      "type": "issue_type",
      "description": "What's wrong",
      "severity": "low|medium|high|critical",
      "suggestion": "How to fix"
    }
  ],
  "approved": true/false,
  "assessment": "Overall assessment",
  "confidence": 0.8
}

Be rigorous but fair. Not every response needs issues.
For trades with fragility score > 0.6, require explicit risk acknowledgment.`;

/**
 * Run the critic on a response.
 */
export async function runCritic(
  llm: LlmClient,
  context: CriticContext,
  config: CriticConfig = DEFAULT_CRITIC_CONFIG
): Promise<CriticResult> {
  const userPrompt = buildCriticPrompt(context);

  const messages: ChatMessage[] = [
    { role: 'system', content: CRITIC_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  const response = await llm.complete(messages, { temperature: 0.2 });
  const result = parseCriticResponse(response.content, context, config);

  // If not approved and revision is enabled, attempt revision
  if (!result.approved && config.attemptRevision && result.issues.length > 0) {
    const revised = await attemptRevision(llm, context, result, config);
    if (revised) {
      return revised;
    }
  }

  return result;
}

/**
 * Build the prompt for the critic.
 */
function buildCriticPrompt(context: CriticContext): string {
  const sections: string[] = [];

  sections.push(`## Goal
${context.goal}`);

  sections.push(`## Response to Review
${context.response}`);

  sections.push(`## Mode: ${context.mode}
Involves Trade: ${context.involvesTrade}`);

  if (context.toolCalls.length > 0) {
    sections.push(`## Tool Calls Made
${context.toolCalls.map((tc) => `- ${tc.name}: ${tc.success ? 'success' : 'failed'}`).join('\n')}`);
  } else {
    sections.push('## Tool Calls Made\nNone');
  }

  if (context.assumptions.length > 0) {
    sections.push(`## Stated Assumptions
${context.assumptions.map((a) => `- ${a}`).join('\n')}`);
  }

  if (context.hypotheses.length > 0) {
    sections.push(`## Current Hypotheses
${context.hypotheses.map((h) => `- ${h}`).join('\n')}`);
  }

  // Include fragility analysis for trade decisions
  if (context.fragility && context.involvesTrade) {
    sections.push(buildFragilitySection(context.fragility));
  }

  sections.push('\nReview this response and identify any issues.');

  return sections.join('\n\n');
}

/**
 * Build the fragility section for the critic prompt.
 */
function buildFragilitySection(fragility: TradeFragilityContext): string {
  const lines: string[] = ['## Fragility Analysis (Pre-Trade)'];

  lines.push(`Overall Fragility Score: ${(fragility.fragilityScore * 100).toFixed(0)}%`);

  if (fragility.detectors) {
    lines.push('Detector Breakdown:');
    lines.push(`- Leverage: ${(fragility.detectors.leverage * 100).toFixed(0)}%`);
    lines.push(`- Coupling: ${(fragility.detectors.coupling * 100).toFixed(0)}%`);
    lines.push(`- Illiquidity: ${(fragility.detectors.illiquidity * 100).toFixed(0)}%`);
    lines.push(`- Consensus: ${(fragility.detectors.consensus * 100).toFixed(0)}%`);
    lines.push(`- Irreversibility: ${(fragility.detectors.irreversibility * 100).toFixed(0)}%`);
  }

  if (fragility.riskSignals.length > 0) {
    lines.push('');
    lines.push('Risk Signals:');
    for (const signal of fragility.riskSignals.slice(0, 5)) {
      lines.push(`- ${signal}`);
    }
  }

  if (fragility.fragilityCards.length > 0) {
    lines.push('');
    lines.push('Top Fragility Cards:');
    for (const card of fragility.fragilityCards.slice(0, 3)) {
      const score = card.score != null ? ` (score: ${(card.score * 100).toFixed(0)}%)` : '';
      lines.push(`- ${card.mechanism}: ${card.exposure}${score}`);
      if (card.downside) {
        lines.push(`  Downside: ${card.downside}`);
      }
    }
  }

  if (fragility.stressedAssumptions.length > 0) {
    lines.push('');
    lines.push('Stressed Assumptions:');
    for (const assumption of fragility.stressedAssumptions.slice(0, 3)) {
      const stress = assumption.stressScore != null ? ` (stress: ${(assumption.stressScore * 100).toFixed(0)}%)` : '';
      lines.push(`- ${assumption.statement}${stress}`);
    }
  }

  if (fragility.falsifiers.length > 0) {
    lines.push('');
    lines.push('Falsifiers (what could prove this wrong):');
    for (const falsifier of fragility.falsifiers.slice(0, 4)) {
      lines.push(`- ${falsifier}`);
    }
  }

  // Add guidance based on fragility level
  lines.push('');
  if (fragility.fragilityScore >= 0.7) {
    lines.push('⚠️ HIGH FRAGILITY: Require explicit risk acknowledgment and reduced position sizing.');
  } else if (fragility.fragilityScore >= 0.5) {
    lines.push('⚡ MODERATE FRAGILITY: Ensure key risks are addressed in response.');
  }

  return lines.join('\n');
}

/**
 * Parse the critic's response.
 */
function parseCriticResponse(
  content: string,
  context: CriticContext,
  config: CriticConfig
): CriticResult {
  const now = new Date().toISOString();

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      issues?: Array<{
        type?: string;
        description?: string;
        severity?: string;
        suggestion?: string;
        location?: string;
      }>;
      approved?: boolean;
      assessment?: string;
      confidence?: number;
    };

    const issues: CriticIssue[] = (parsed.issues ?? []).map((issue) => ({
      type: (issue.type as CriticIssueType) ?? 'unsupported_claim',
      description: issue.description ?? 'Unknown issue',
      severity: (issue.severity as CriticSeverity) ?? 'medium',
      location: issue.location,
      suggestion: issue.suggestion,
    }));

    // Determine approval based on issues and config
    let approved = parsed.approved ?? true;

    // Auto-reject on critical issues
    const hasCritical = issues.some((i) => i.severity === config.autoRejectSeverity);
    if (hasCritical) {
      approved = false;
    }

    // Reject on too many issues
    const highSeverityCount = issues.filter(
      (i) => i.severity === 'high' || i.severity === 'critical'
    ).length;
    if (highSeverityCount >= config.minIssuesForRejection) {
      approved = false;
    }

    // For trades, be extra strict
    if (context.involvesTrade && issues.length > 0) {
      const hasRiskIssue = issues.some(
        (i) => i.type === 'risk_warning' || i.type === 'missing_falsifier'
      );
      if (hasRiskIssue) {
        approved = false;
      }
    }

    // For high-fragility trades, be even stricter
    if (context.fragility && context.involvesTrade) {
      const hasFragilityIssue = issues.some(
        (i) => i.type === 'fragility_ignored' || i.type === 'tail_risk_ignored'
      );
      if (hasFragilityIssue && context.fragility.fragilityScore >= 0.5) {
        approved = false;
      }
      // Auto-reject high-fragility trades with any risk-related issues
      if (context.fragility.fragilityScore >= 0.7 && issues.length > 0) {
        const hasAnyRiskIssue = issues.some(
          (i) =>
            i.type === 'risk_warning' ||
            i.type === 'missing_falsifier' ||
            i.type === 'fragility_ignored' ||
            i.type === 'tail_risk_ignored' ||
            i.type === 'assumption_gap'
        );
        if (hasAnyRiskIssue) {
          approved = false;
        }
      }
    }

    return {
      issues,
      approved,
      assessment: parsed.assessment ?? 'Review complete',
      confidence: parsed.confidence ?? 0.7,
      timestamp: now,
    };
  } catch {
    // On parse failure, be conservative and approve with warning
    return {
      issues: [
        {
          type: 'unsupported_claim',
          description: 'Critic failed to parse response',
          severity: 'low',
        },
      ],
      approved: true, // Don't block on critic failure
      assessment: 'Critic parsing failed, approving with caution',
      confidence: 0.5,
      timestamp: now,
    };
  }
}

/**
 * Attempt to revise the response to address critic issues.
 */
async function attemptRevision(
  llm: LlmClient,
  context: CriticContext,
  criticResult: CriticResult,
  config: CriticConfig
): Promise<CriticResult | null> {
  const revisionPrompt = `The following response was rejected by the critic:

${context.response}

Issues identified:
${criticResult.issues.map((i) => `- [${i.severity}] ${i.type}: ${i.description}${i.suggestion ? ` (Suggestion: ${i.suggestion})` : ''}`).join('\n')}

Please revise the response to address these issues while maintaining the same intent.
Keep the same format and information, but fix the identified problems.

Revised response:`;

  try {
    const response = await llm.complete(
      [
        { role: 'system', content: 'You are revising a response to address critic feedback.' },
        { role: 'user', content: revisionPrompt },
      ],
      { temperature: 0.3 }
    );

    const revisedResponse = response.content.trim();
    if (!revisedResponse) {
      return null;
    }

    // Re-run critic on revised response
    const revisedContext: CriticContext = {
      ...context,
      response: revisedResponse,
    };

    const recheck = await runCritic(llm, revisedContext, {
      ...config,
      attemptRevision: false, // Don't recurse
    });

    if (recheck.approved) {
      return {
        ...recheck,
        revisedResponse,
      };
    }

    // Revision didn't help
    return null;
  } catch {
    return null;
  }
}

/**
 * Quick check if critic is needed based on context.
 */
export function shouldRunCritic(context: {
  mode: string;
  involvesTrade: boolean;
  toolCalls?: Array<{ name: string }>;
}): boolean {
  // Always run critic for trades
  if (context.involvesTrade) {
    return true;
  }

  // Run critic for trade mode
  if (context.mode === 'trade') {
    return true;
  }

  // Run critic for mentat mode
  if (context.mode === 'mentat') {
    return true;
  }

  // Run critic if trade tool was called
  if (context.toolCalls?.some((tc) => tc.name === 'perp_place_order')) {
    return true;
  }

  return false;
}

/**
 * Format critic result for display.
 */
export function formatCriticResult(result: CriticResult): string {
  const lines: string[] = [];

  if (result.approved) {
    lines.push('Critic: Approved');
  } else {
    lines.push('Critic: Issues Found');
  }

  if (result.issues.length > 0) {
    lines.push('');
    for (const issue of result.issues) {
      lines.push(`- [${issue.severity.toUpperCase()}] ${issue.type}: ${issue.description}`);
      if (issue.suggestion) {
        lines.push(`  Suggestion: ${issue.suggestion}`);
      }
    }
  }

  lines.push('');
  lines.push(`Assessment: ${result.assessment}`);

  return lines.join('\n');
}
