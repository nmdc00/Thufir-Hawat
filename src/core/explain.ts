import type { ThufirConfig } from './config.js';
import type { LlmClient } from './llm.js';
import { createLlmClient } from './llm.js';
import { getPrediction } from '../memory/predictions.js';
import { listIntelByIds } from '../intel/store.js';
import { listCalibrationSummaries } from '../memory/calibration.js';

export async function explainPrediction(params: {
  predictionId: string;
  config: ThufirConfig;
  llm?: LlmClient;
}): Promise<string> {
  const prediction = getPrediction(params.predictionId);
  if (!prediction) {
    return `Prediction not found: ${params.predictionId}`;
  }

  const intel = listIntelByIds(prediction.intelIds ?? []);
  const calibration = listCalibrationSummaries();
  const domainSummary = prediction.domain
    ? calibration.find((summary) => summary.domain === prediction.domain)
    : undefined;

  const contextLines: string[] = [];
  contextLines.push(`Market: ${prediction.marketTitle}`);
  contextLines.push(`Outcome: ${prediction.predictedOutcome ?? 'N/A'}`);
  contextLines.push(
    `Probability: ${
      prediction.predictedProbability !== undefined
        ? prediction.predictedProbability.toFixed(2)
        : 'N/A'
    }`
  );
  contextLines.push(`Confidence: ${prediction.confidenceLevel ?? 'N/A'}`);
  contextLines.push(`Executed: ${prediction.executed ? 'yes' : 'no'}`);
  if (prediction.executionPrice !== null && prediction.executionPrice !== undefined) {
    contextLines.push(`Execution price: ${prediction.executionPrice}`);
  }
  if (prediction.positionSize !== null && prediction.positionSize !== undefined) {
    contextLines.push(`Position size: ${prediction.positionSize}`);
  }
  if (prediction.outcome) {
    contextLines.push(`Resolved outcome: ${prediction.outcome}`);
  }
  if (prediction.pnl !== null && prediction.pnl !== undefined) {
    contextLines.push(`PnL: ${prediction.pnl.toFixed(2)}`);
  }
  if (prediction.reasoning) {
    contextLines.push(`Reasoning summary: ${prediction.reasoning}`);
  }

  if (domainSummary) {
    const accuracy =
      domainSummary.accuracy === null
        ? 'N/A'
        : `${(domainSummary.accuracy * 100).toFixed(1)}%`;
    const brier =
      domainSummary.avgBrier === null ? 'N/A' : domainSummary.avgBrier.toFixed(4);
    contextLines.push(
      `Calibration (${domainSummary.domain}): acc=${accuracy}, brier=${brier}`
    );
  }

  if (intel.length > 0) {
    contextLines.push('Intel used:');
    for (const item of intel.slice(0, 5)) {
      contextLines.push(`- ${item.title} (${item.source})`);
    }
  }

  const prompt = [
    'Explain why this prediction was made in a concise, structured way.',
    'Include: key evidence, assumptions, risks, and how calibration influenced confidence.',
    'If outcome exists, add a brief post‑mortem note.',
    '',
    contextLines.join('\n'),
  ].join('\n');

  const llm = params.llm ?? createLlmClient(params.config);
  const response = await llm.complete(
    [
      { role: 'system', content: 'You are a precise forecasting explainer.' },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.3 }
  );

  return response.content.trim();
}
