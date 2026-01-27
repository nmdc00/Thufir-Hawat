import { z } from 'zod';

import type { LlmClient } from './llm.js';
import type { Market } from '../execution/polymarket/markets.js';
import { listCalibrationSummaries, type CalibrationSummary } from '../memory/calibration.js';
import { listPredictions } from '../memory/predictions.js';

const DecisionSchema = z.object({
  action: z.enum(['buy', 'sell', 'hold']),
  outcome: z.enum(['YES', 'NO']).optional(),
  amount: z.number().optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  reasoning: z.string().optional(),
});

export type Decision = z.infer<typeof DecisionSchema>;

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

const EXECUTOR_PROMPT = `You are Bijaz, an autonomous prediction market trader.

Your key principles:
1. Be CALIBRATED - adjust confidence based on your historical accuracy
2. Be CONSERVATIVE - only trade when you see clear edge (probability differs from price by >5%)
3. TRACK REASONING - explain why you expect this outcome
4. RESPECT LIMITS - stay within suggested position sizes

Return ONLY valid JSON in this schema:
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

export async function decideTrade(
  plannerLlm: LlmClient,
  executorLlm: LlmClient,
  market: Market,
  remainingDaily: number
): Promise<Decision> {
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

  const executorPrompt = `${marketContext}

## Planner Guidance
${plan || '(none)'}

## Task
Analyze this market. If you see edge ≥5% (your probability estimate differs from market price by ≥0.05), consider trading. Otherwise, hold.

Remember: Your calibration data shows your historical accuracy. If you've been overconfident or wrong in this domain, adjust accordingly.`;

  const response = await executorLlm.complete(
    [
      { role: 'system', content: EXECUTOR_PROMPT },
      { role: 'user', content: executorPrompt },
    ],
    { temperature: 0.1 }
  );

  const trimmed = response.content.trim();
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');
  const json = jsonStart >= 0 && jsonEnd >= 0 ? trimmed.slice(jsonStart, jsonEnd + 1) : trimmed;

  try {
    const parsed = DecisionSchema.safeParse(JSON.parse(json));
    if (!parsed.success) {
      return { action: 'hold', reasoning: 'Failed to parse decision' };
    }
    return parsed.data;
  } catch {
    return { action: 'hold', reasoning: 'Failed to parse decision JSON' };
  }
}
