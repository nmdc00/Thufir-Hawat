import { z } from 'zod';

import type { LlmClient } from './llm.js';
import type { Logger } from './logger.js';
import type { Market } from '../execution/markets.js';
import { listCalibrationSummaries, type CalibrationSummary } from '../memory/calibration.js';
import { listPredictions } from '../memory/predictions.js';
import { withExecutionContextIfMissing } from './llm_infra.js';
import { computeFingerprint } from './execution_mode.js';
import { findReusableArtifact, storeDecisionArtifact } from '../memory/decision_artifacts.js';

const DecisionSchema = z.object({
  action: z.enum(['buy', 'sell', 'hold']),
  outcome: z.enum(['YES', 'NO']).optional(),
  amount: z.number().optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  reasoning: z.string().optional(),
});

export type Decision = z.infer<typeof DecisionSchema>;

function buildDecisionFingerprint(market: Market, remainingDaily: number): string {
  return computeFingerprint({
    market: {
      id: market.id,
      question: market.question ?? null,
      prices: market.prices ?? null,
      volume: market.volume ?? null,
      liquidity: market.liquidity ?? null,
      category: market.category ?? null,
      resolved: market.resolved ?? null,
    },
    remainingDaily: Math.round(remainingDaily * 100) / 100,
  });
}

function extractJsonCandidate(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return text.trim();
}

function parseDecision(text: string): Decision | null {
  const candidate = extractJsonCandidate(text);
  const parsed = tryParseDecision(candidate);
  if (parsed) {
    return parsed;
  }

  const repaired = repairJson(candidate);
  return repaired ? tryParseDecision(repaired) : null;
}

function tryParseDecision(candidate: string): Decision | null {
  try {
    const parsed = DecisionSchema.safeParse(JSON.parse(candidate));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function repairJson(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  let repaired = trimmed;
  if (repaired.startsWith('{') && !repaired.endsWith('}')) {
    repaired = repaired + '}';
  }
  repaired = repaired.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
  return repaired === trimmed ? null : repaired;
}

/**
 * Build calibration context string for LLM prompt.
 * Shows historical accuracy by domain to help calibrate confidence.
 */
function buildCalibrationContext(domain: string | undefined): string {
  const summaries = listCalibrationSummaries();

  if (summaries.length === 0) {
    return `\n## Calibration Data
No historical predictions yet. This is early - be conservative with position sizes.`;
  }

  const lines: string[] = ['\n## Your Historical Calibration'];

  // Find the relevant domain's calibration
  const domainSummary = domain
    ? summaries.find(s => s.domain?.toLowerCase() === domain.toLowerCase())
    : null;

  // Overall stats
  const totalPredictions = summaries.reduce((sum, s) => sum + s.totalPredictions, 0);
  const totalResolved = summaries.reduce((sum, s) => sum + s.resolvedPredictions, 0);

  if (totalResolved === 0) {
    lines.push(`You have ${totalPredictions} predictions, but none have resolved yet.`);
    lines.push('Be conservative until you have calibration data.');
    return lines.join('\n');
  }

  // Calculate weighted average Brier score
  const weightedBrier = summaries
    .filter(s => s.avgBrier !== null && s.resolvedPredictions > 0)
    .reduce((sum, s) => sum + (s.avgBrier! * s.resolvedPredictions), 0) / totalResolved;

  lines.push(`Overall: ${totalResolved} resolved predictions, Brier score: ${weightedBrier.toFixed(3)}`);
  lines.push('');
  lines.push('By domain:');

  for (const summary of summaries) {
    if (summary.resolvedPredictions === 0) continue;

    const accuracyPct = summary.accuracy !== null ? (summary.accuracy * 100).toFixed(0) : 'N/A';
    const brierStr = summary.avgBrier !== null ? summary.avgBrier.toFixed(3) : 'N/A';
    const marker = domain && summary.domain?.toLowerCase() === domain.toLowerCase() ? ' ← this market' : '';

    lines.push(`  ${summary.domain ?? 'unknown'}: ${accuracyPct}% accuracy, Brier ${brierStr} (${summary.resolvedPredictions} resolved)${marker}`);
  }

  // Add specific guidance based on calibration
  if (domainSummary && domainSummary.avgBrier !== null && domainSummary.resolvedPredictions >= 5) {
    lines.push('');
    if (domainSummary.avgBrier > 0.25) {
      lines.push(`⚠️ Your ${domain} predictions have been poorly calibrated (Brier > 0.25).`);
      lines.push('Consider: smaller positions, or acknowledge high uncertainty.');
    } else if (domainSummary.avgBrier < 0.15 && domainSummary.accuracy !== null && domainSummary.accuracy > 0.65) {
      lines.push(`✓ Your ${domain} predictions have been well-calibrated.`);
    }

    if (domainSummary.accuracy !== null) {
      if (domainSummary.accuracy < 0.5) {
        lines.push(`Your ${domain} accuracy is below 50% - you may be systematically wrong in this domain.`);
      } else if (domainSummary.accuracy > 0.75) {
        lines.push(`Strong accuracy in ${domain} - you can be more confident here.`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Build context from recent predictions in this domain.
 */
function buildRecentPredictionsContext(domain: string | undefined): string {
  const recent = listPredictions({ domain: domain ?? undefined, limit: 5 });

  if (recent.length === 0) {
    return '';
  }

  const lines: string[] = ['\n## Recent Predictions in This Domain'];

  for (const pred of recent) {
    const outcomeStr = pred.outcome
      ? `→ ${pred.outcome} (${pred.predictedOutcome === pred.outcome ? '✓' : '✗'})`
      : '(pending)';
    const probStr = pred.predictedProbability
      ? `${(pred.predictedProbability * 100).toFixed(0)}%`
      : '?';

    lines.push(`- "${pred.marketTitle.slice(0, 50)}..." predicted ${pred.predictedOutcome} @ ${probStr} ${outcomeStr}`);
  }

  return lines.join('\n');
}

/**
 * Calculate suggested position size based on calibration and Kelly criterion.
 */
function suggestPositionSize(
  edge: number,
  calibrationSummary: CalibrationSummary | undefined,
  remainingDaily: number
): { suggested: number; reasoning: string } {
  // Base position: 1/4 Kelly criterion (conservative)
  // Kelly = edge / (1 - price), but we use 1/4 Kelly for safety
  const baseKelly = Math.max(0, edge) * 0.25;

  // Adjust based on calibration confidence
  let calibrationMultiplier = 0.5; // Default: conservative until we have data
  let reasoning = 'conservative (no calibration data)';

  if (calibrationSummary && calibrationSummary.resolvedPredictions >= 10) {
    if (calibrationSummary.avgBrier !== null) {
      if (calibrationSummary.avgBrier < 0.15) {
        calibrationMultiplier = 1.0;
        reasoning = 'full size (well-calibrated in this domain)';
      } else if (calibrationSummary.avgBrier < 0.20) {
        calibrationMultiplier = 0.75;
        reasoning = 'reduced (moderate calibration)';
      } else if (calibrationSummary.avgBrier < 0.25) {
        calibrationMultiplier = 0.5;
        reasoning = 'half size (poor calibration)';
      } else {
        calibrationMultiplier = 0.25;
        reasoning = 'minimal (very poor calibration in this domain)';
      }
    }
  } else if (calibrationSummary && calibrationSummary.resolvedPredictions >= 5) {
    calibrationMultiplier = 0.5;
    reasoning = 'reduced (limited calibration data)';
  }

  // Calculate suggested amount
  const kellyAmount = baseKelly * remainingDaily;
  const adjusted = kellyAmount * calibrationMultiplier;
  const suggested = Math.min(adjusted, remainingDaily * 0.2); // Never more than 20% of daily budget

  return { suggested: Math.round(suggested * 100) / 100, reasoning };
}

export const EXECUTOR_PROMPT = `You are Thufir, an autonomous perp market trader.

Your key principles:
1. Be CALIBRATED - adjust confidence based on your historical accuracy
2. Be CONSERVATIVE - only trade when you see clear edge (probability differs from price by >5%)
3. TRACK REASONING - explain why you expect this outcome
4. RESPECT LIMITS - stay within suggested position sizes

Return ONLY valid JSON in this schema (no markdown, no commentary):
{
  "action": "buy" | "sell" | "hold",
  "outcome": "YES" | "NO" (required if action is buy/sell),
  "amount": number (USD, should respect suggested position size),
  "confidence": "low" | "medium" | "high",
  "reasoning": string (explain key factors and uncertainties)
}

If you do not see edge ≥5%, return {"action":"hold","reasoning":"No clear edge"}.
If your calibration in this domain is poor, be extra conservative or hold.
`;

export function buildDecisionPrompts(
  market: Market,
  remainingDaily: number,
  plannerGuidance?: string
): {
  plannerPrompt: string;
  executorPrompt: string;
  positionSuggestion: { suggested: number; reasoning: string };
} {
  const domain = market.category ?? undefined;

  // Fetch calibration data
  const calibrationContext = buildCalibrationContext(domain);
  const recentPredictions = buildRecentPredictionsContext(domain);

  // Get domain-specific calibration for position sizing suggestion
  const summaries = listCalibrationSummaries();
  const domainCalibration = domain
    ? summaries.find(s => s.domain?.toLowerCase() === domain.toLowerCase())
    : undefined;

  // Estimate potential edge and suggest position size
  // For now, assume max 10% edge for suggestion purposes
  const positionSuggestion = suggestPositionSize(0.10, domainCalibration, remainingDaily);

  const marketContext = `## Market
Question: ${market.question}
Outcomes: ${market.outcomes.join(', ')}
Current Prices: ${JSON.stringify(market.prices)}
Category: ${market.category ?? 'unknown'}
Volume: ${market.volume ?? 'unknown'}
Liquidity: ${market.liquidity ?? 'unknown'}

## Budget
Remaining daily budget: $${remainingDaily.toFixed(2)}
Suggested max position: $${positionSuggestion.suggested.toFixed(2)} (${positionSuggestion.reasoning})
${calibrationContext}
${recentPredictions}
`.trim();

  const plannerPrompt = `${marketContext}

## Task
Provide a concise trade plan (max 120 words). Include:
- recommended action: buy/sell/hold
- outcome: YES/NO if buy/sell
- confidence: low/medium/high
- suggested amount in USD (respect remaining budget + suggested max position)
- key factors and key risks

Do NOT return JSON. Do NOT include chain-of-thought. Keep it short and factual.`;

  const executorPrompt = `${marketContext}

## Planner Guidance
${plannerGuidance?.trim() ? plannerGuidance.trim() : '(none)'}

## Task
Analyze this market. If you see edge ≥5% (your probability estimate differs from market price by ≥0.05), consider trading. Otherwise, hold.

Remember: Your calibration data shows your historical accuracy. If you've been overconfident or wrong in this domain, adjust accordingly.`;

  return { plannerPrompt, executorPrompt, positionSuggestion };
}

export function parseDecisionFromText(text: string): Decision | null {
  return parseDecision(text);
}

export async function decideTrade(
  plannerLlm: LlmClient,
  executorLlm: LlmClient,
  market: Market,
  remainingDaily: number,
  logger?: Logger
): Promise<Decision> {
  return withExecutionContextIfMissing(
    { mode: 'FULL_AGENT', critical: true, reason: 'trade_decision', source: 'decision' },
    async () => {
      const fingerprint = buildDecisionFingerprint(market, remainingDaily);
      const cached = findReusableArtifact({
        kind: 'trade_decision',
        marketId: market.id,
        fingerprint,
        maxAgeMs: 6 * 60 * 60 * 1000,
      });
      const cachedDecision = cached?.payload && (cached.payload as { decision?: Decision }).decision;
      if (cachedDecision) {
        return cachedDecision;
      }

      const { plannerPrompt, positionSuggestion } = buildDecisionPrompts(
        market,
        remainingDaily
      );
      let plan = '';
      try {
        const plannerResponse = await plannerLlm.complete(
          [
            { role: 'system', content: 'You are a concise trading planner.' },
            { role: 'user', content: plannerPrompt },
          ],
          { temperature: 0.2 }
        );
        plan = plannerResponse.content.trim();
      } catch {
        plan = '';
      }
      const { executorPrompt: finalExecutorPrompt } = buildDecisionPrompts(
        market,
        remainingDaily,
        plan
      );

      let responseContent = '';
      try {
        const response = await executorLlm.complete(
          [
            { role: 'system', content: EXECUTOR_PROMPT },
            { role: 'user', content: finalExecutorPrompt },
          ],
          { temperature: 0.1 }
        );
        responseContent = response.content;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger?.warn('Decision executor failed; returning hold', {
          marketId: market.id,
          error: message,
        });
        return { action: 'hold', reasoning: `Decision executor failed: ${message}` };
      }

      let decision = parseDecision(responseContent);

      if (!decision) {
        logger?.warn('Decision parse failed, attempting repair', {
          marketId: market.id,
          preview: responseContent.slice(0, 400),
        });
        const repairPrompt = `Convert the following content into ONLY valid JSON matching this schema:
{
  "action": "buy" | "sell" | "hold",
  "outcome": "YES" | "NO" (required if action is buy/sell),
  "amount": number,
  "confidence": "low" | "medium" | "high",
  "reasoning": string
}

Content:
${responseContent}`.trim();
        try {
          const repaired = await executorLlm.complete(
            [
              { role: 'system', content: 'Return ONLY valid JSON. No markdown, no commentary.' },
              { role: 'user', content: repairPrompt },
            ],
            { temperature: 0 }
          );
          decision = parseDecision(repaired.content);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          logger?.warn('Decision repair failed; returning hold', {
            marketId: market.id,
            error: message,
          });
          return { action: 'hold', reasoning: `Decision repair failed: ${message}` };
        }
      }

      if (!decision) {
        return { action: 'hold', reasoning: 'Failed to parse decision JSON' };
      }

      if (decision.action !== 'hold') {
        if (!decision.outcome) {
          return { action: 'hold', reasoning: 'Missing outcome in decision' };
        }
        if (!decision.amount || Number.isNaN(decision.amount) || decision.amount <= 0) {
          const fallbackAmount = Math.max(1, positionSuggestion.suggested || 1);
          return {
            ...decision,
            amount: Math.min(fallbackAmount, remainingDaily),
            reasoning: `${decision.reasoning ?? ''} (amount auto-filled)`.trim(),
          };
        }
      }

      const expires = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
      storeDecisionArtifact({
        source: 'decision',
        kind: 'trade_decision',
        marketId: market.id,
        fingerprint,
        outcome: decision.outcome ?? null,
        expiresAt: expires,
        payload: {
          decision,
          marketSnapshot: {
            id: market.id,
            question: market.question ?? null,
            prices: market.prices ?? null,
            volume: market.volume ?? null,
            category: market.category ?? null,
          },
          remainingDaily,
          generatedAt: new Date().toISOString(),
        },
      });

      return decision;
    }
  );
}
