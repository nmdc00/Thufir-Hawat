import { describe, expect, it, vi } from 'vitest';

let mockState = {
  crossMarginSummary: { accountValue: 200 },
  assetPositions: [] as Array<{ position: Record<string, unknown> }>,
};

vi.mock('../../src/execution/hyperliquid/client.js', () => ({
  HyperliquidClient: class {
    async getAllMids() {
      return {
        BTC: 100,
        SOL: 100,
        HYPE: 100,
        DOGE: 100,
      };
    }

    async getClearinghouseState() {
      return mockState;
    }
  },
}));

import { checkPerpRiskLimits } from '../../src/execution/perp-risk.js';

describe('checkPerpRiskLimits autonomous defaults', () => {
  it('returns total margin account equity, never withdrawable or cross-only cash substitutes', async () => {
    const input = { config: { wallet: { perps: { maxTotalNotionalUsd: 1000 } } } as any,
      symbol: 'BTC', side: 'buy' as const, size: 0.1, markPrice: 100, notionalUsd: 10 };
    mockState = { crossMarginSummary: { accountValue: 200 }, marginSummary: { accountValue: '350' },
      withdrawable: '80', assetPositions: [] } as any;
    expect(await checkPerpRiskLimits(input)).toMatchObject({ allowed: true, accountEquityUsd: 350 });
    mockState = { crossMarginSummary: { accountValue: 200 }, withdrawable: '80', assetPositions: [] } as any;
    expect(await checkPerpRiskLimits(input)).toMatchObject({ allowed: true, accountEquityUsd: null });
  });
  it('blocks autonomous entries that would exceed fallback gross notional caps', async () => {
    mockState = {
      crossMarginSummary: { accountValue: 200 },
      assetPositions: [
        { position: { coin: 'BTC', szi: -1, positionValue: 130 } },
        { position: { coin: 'SOL', szi: 1, positionValue: 120 } },
        { position: { coin: 'HYPE', szi: 1, positionValue: 100 } },
      ],
    };
    const result = await checkPerpRiskLimits({
      config: {
        wallet: {
          perps: {},
        },
      } as any,
      symbol: 'DOGE',
      side: 'sell',
      size: 1,
      markPrice: 100,
      notionalUsd: 100,
      enforceAutonomousDefaults: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/total perp notional/i);
  });

  it('blocks autonomous entries that would exceed fallback same-side position caps', async () => {
    mockState = {
      crossMarginSummary: { accountValue: 500 },
      assetPositions: [
        { position: { coin: 'BTC', szi: -1, positionValue: 120 } },
        { position: { coin: 'SOL', szi: -1, positionValue: 110 } },
        { position: { coin: 'FARTCOIN', szi: -1, positionValue: 100 } },
      ],
    };
    const result = await checkPerpRiskLimits({
      config: {
        wallet: {
          perps: {},
        },
      } as any,
      symbol: 'DOGE',
      side: 'sell',
      size: 1,
      markPrice: 100,
      notionalUsd: 40,
      enforceAutonomousDefaults: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/same-side exposure cap exceeded/i);
  });
});
