import { describe, it, expect, vi, beforeEach } from 'vitest';

const listRecentIntel = vi.fn();
vi.mock('../../src/intel/store.js', () => ({
  listRecentIntel: (limit: number) => listRecentIntel(limit),
}));

const findReusableArtifact = vi.fn();
const storeDecisionArtifact = vi.fn();
vi.mock('../../src/memory/decision_artifacts.js', () => ({
  findReusableArtifact: (params: any) => findReusableArtifact(params),
  storeDecisionArtifact: (input: any) => storeDecisionArtifact(input),
}));

import { getNarrativeSnapshot } from '../../src/reflexivity/narrative.js';

beforeEach(() => {
  listRecentIntel.mockReset();
  findReusableArtifact.mockReset();
  storeDecisionArtifact.mockReset();
});

describe('reflexivity/narrative', () => {
  it('builds deterministic snapshot when LLM is disabled', async () => {
    findReusableArtifact.mockReturnValue(null);
    listRecentIntel.mockReturnValue([
      {
        id: 'intel_1',
        title: 'ETH rally continues, up only',
        content: 'ETH is going up because it is going up. ATH soon.',
        source: 'social',
        sourceType: 'social',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'intel_2',
        title: 'Ethereum upgrade narrative still bullish',
        content: 'Strong growth and bullish sentiment.',
        source: 'news',
        sourceType: 'news',
        timestamp: new Date().toISOString(),
      },
    ]);

    const config = {
      reflexivity: {
        narrative: {
          llm: { enabled: false },
          maxIntelItems: 50,
          cacheTtlSeconds: 60,
        },
      },
    } as any;

    const snapshot = await getNarrativeSnapshot({ config, symbol: 'ETH/USDT' });
    expect(snapshot.schemaVersion).toBe('1');
    expect(snapshot.symbol).toBe('ETH');
    expect(snapshot.unanimityScore).toBeGreaterThanOrEqual(0);
    expect(snapshot.unanimityScore).toBeLessThanOrEqual(1);
    expect(snapshot.exhaustionScore).toBeGreaterThan(0);
    expect(snapshot.evidenceIntelIds.length).toBeGreaterThan(0);
    expect(storeDecisionArtifact).toHaveBeenCalled();
  });
});

