import { describe, it, expect, vi } from 'vitest';

import type { ThufirConfig } from '../../src/core/config.js';

vi.mock('../../src/execution/hyperliquid/client.js', () => ({
  HyperliquidClient: class {
    async getMetaAndAssetCtxs() {
      return [
        { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
        [
          { funding: '0.0001', openInterest: '100000' },
          { funding: '-0.0002', openInterest: '50000' },
        ],
      ];
    }
    async getFundingHistory() {
      return [{ fundingRate: '0.0001' }, { fundingRate: '0.0002' }];
    }
    async getRecentTrades() {
      return [
        { px: '100', sz: '1', side: 'B' },
        { px: '101', sz: '1', side: 'A' },
        { px: '102', sz: '2', side: 'B' },
      ];
    }
  },
}));

import {
  signalHyperliquidFundingOISkew,
  signalHyperliquidOrderflowImbalance,
} from '../../src/discovery/signals.js';

const config = { hyperliquid: { enabled: true } } as ThufirConfig;

describe('hyperliquid signals', () => {
  it('computes funding/OI skew signal', async () => {
    const signal = await signalHyperliquidFundingOISkew(config, 'BTC/USDT');
    expect(signal).toBeTruthy();
    expect(signal?.kind).toBe('funding_oi_skew');
  });

  it('computes orderflow imbalance signal', async () => {
    const signal = await signalHyperliquidOrderflowImbalance(config, 'BTC/USDT');
    expect(signal).toBeTruthy();
    expect(signal?.kind).toBe('orderflow_imbalance');
  });
});
