import { describe, it, expect, vi, beforeEach } from 'vitest';

// IMPORTANT: vi.mock factories are hoisted. Avoid referencing top-level variables.

vi.mock('../../src/execution/hyperliquid/client.js', () => ({
  HyperliquidClient: class {
    constructor(_config: any) {}

    async getMetaAndAssetCtxs(): Promise<any> {
      return [
        { universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }] },
        [
          { funding: 0.00001, openInterest: 100_000 },
          { funding: 0.0002, openInterest: 900_000 }, // ETH crowded longs
          { funding: -0.00002, openInterest: 120_000 },
        ],
      ];
    }

    async getRecentTrades(_coin: string): Promise<any[]> {
      return [
        { px: 2000, sz: 10, side: 'B' },
        { px: 2001, sz: 8, side: 'B' },
        { px: 2000, sz: 2, side: 'A' },
      ];
    }

    async getL2Book(_coin: string): Promise<any> {
      return {
        levels: [
          [
            { px: 2000, sz: 100 },
            { px: 1999, sz: 80 },
          ],
          [
            { px: 2001, sz: 30 },
            { px: 2002, sz: 25 },
          ],
        ],
      };
    }
  },
}));

vi.mock('../../src/reflexivity/narrative.js', () => ({
  getNarrativeSnapshot: async (_params: any) => ({
    schemaVersion: '1',
    symbol: 'ETH',
    asofUtc: new Date().toISOString(),
    consensusNarrative: 'ETH is universally bullish and getting momentum-driven.',
    consensusClaims: ['ETH up only'],
    impliedAssumptions: ['Momentum continues'],
    dissentingViews: [],
    unanimityScore: 0.9,
    exhaustionScore: 0.7,
    evidenceIntelIds: ['intel_1', 'intel_2'],
  }),
}));

vi.mock('../../src/reflexivity/catalysts.js', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    loadCatalystRegistry: () => [
      {
        id: 'cpi',
        type: 'macro',
        symbols: ['ETH'],
        scheduledUtc: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        description: 'CPI',
      },
    ],
  };
});

let lastStatePayload: any = null;
const storeDecisionArtifact = vi.fn((input: any) => {
  if (input.kind === 'reflexivity_state_v1') {
    lastStatePayload = input.payload;
  }
});
const findReusableArtifact = vi.fn((_params: any) =>
  lastStatePayload ? { payload: lastStatePayload } : null
);

vi.mock('../../src/memory/decision_artifacts.js', () => ({
  storeDecisionArtifact: (input: any) => storeDecisionArtifact(input),
  findReusableArtifact: (params: any) => findReusableArtifact(params),
}));

import { buildReflexivitySetup } from '../../src/reflexivity/fragility.js';

beforeEach(() => {
  lastStatePayload = null;
  storeDecisionArtifact.mockClear();
  findReusableArtifact.mockClear();
});

describe('reflexivity/fragility setup', () => {
  it('emits a setup when crowded + fragile + catalyst within horizon', async () => {
    const config = {
      reflexivity: {
        enabled: true,
        horizonSeconds: 2 * 60 * 60,
        thresholds: { setupScoreMin: 0.2 },
        catalystsFile: 'config/catalysts.yaml',
      },
    } as any;

    const setup = await buildReflexivitySetup({ config, symbol: 'ETH/USDT' });
    expect(setup).not.toBeNull();
    expect(setup?.metrics.setupScore).toBeGreaterThan(0);
    expect(setup?.directionalBias).toBe('down');
    expect(storeDecisionArtifact).toHaveBeenCalled();
  });
});

