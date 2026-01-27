import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/memory/predictions.js', () => ({
  getPrediction: (id: string) => {
    if (id === 'missing') return null;
    return {
      id,
      marketTitle: 'Test market',
      predictedOutcome: 'YES',
      predictedProbability: 0.6,
      confidenceLevel: 'medium',
      executed: true,
      executionPrice: 0.5,
      positionSize: 100,
      outcome: null,
      pnl: null,
      intelIds: ['i1'],
      domain: 'politics',
      reasoning: 'Test reasoning',
    };
  },
}));

vi.mock('../src/intel/store.js', () => ({
  listIntelByIds: () => [
    { id: 'i1', title: 'Intel headline', source: 'NewsAPI', timestamp: '2026-01-01T00:00:00Z' },
  ],
}));

vi.mock('../src/memory/calibration.js', () => ({
  listCalibrationSummaries: () => [
    { domain: 'politics', accuracy: 0.7, avgBrier: 0.2, resolvedPredictions: 10 },
  ],
}));

describe('explainPrediction', () => {
  it('returns not-found message when missing prediction', async () => {
    const { explainPrediction } = await import('../src/core/explain.js');
    const result = await explainPrediction({
      predictionId: 'missing',
      config: {} as any,
      llm: { complete: async () => ({ content: 'n/a', model: 'test' }) } as any,
    });
    expect(result).toContain('Prediction not found');
  });

  it('uses LLM to generate explanation', async () => {
    const { explainPrediction } = await import('../src/core/explain.js');
    const result = await explainPrediction({
      predictionId: 'p1',
      config: {} as any,
      llm: { complete: async () => ({ content: 'Explanation output', model: 'test' }) } as any,
    });
    expect(result).toBe('Explanation output');
  });
});
