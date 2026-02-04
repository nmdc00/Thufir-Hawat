import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ThufirConfig } from '../../src/core/config.js';
import type { Market } from '../../src/execution/markets.js';

const orderMock = vi.fn();
const updateLeverageMock = vi.fn();

vi.mock('../../src/execution/hyperliquid/client.js', () => ({
  HyperliquidClient: class {
    getExchangeClient() {
      return { order: orderMock, updateLeverage: updateLeverageMock };
    }
    async listPerpMarkets() {
      return [{ symbol: 'BTC', assetId: 0, szDecimals: 3, maxLeverage: 10 }];
    }
    async getAllMids() {
      return { BTC: 100 };
    }
  },
}));

import { HyperliquidLiveExecutor } from '../../src/execution/modes/hyperliquid-live.js';

const market: Market = { id: 'BTC', symbol: 'BTC', platform: 'hyperliquid' };

describe('HyperliquidLiveExecutor', () => {
  beforeEach(() => {
    orderMock.mockReset();
    updateLeverageMock.mockReset();
    orderMock.mockResolvedValue({
      response: { data: { statuses: [{ resting: { oid: 123 } }] } },
    });
  });

  it('builds order payload that matches SDK schema', async () => {
    const config: ThufirConfig = {
      hyperliquid: { defaultSlippageBps: 50, maxLeverage: 5 },
    } as ThufirConfig;
    const executor = new HyperliquidLiveExecutor({ config });

    const result = await executor.execute(market, {
      action: 'buy',
      size: 1,
      leverage: 3,
      orderType: 'market',
    });

    expect(result.executed).toBe(true);
    expect(updateLeverageMock).toHaveBeenCalledWith({
      asset: 0,
      isCross: true,
      leverage: 3,
    });
    expect(orderMock).toHaveBeenCalledWith({
      orders: [
        {
          a: 0,
          b: true,
          p: '100.5',
          s: '1',
          r: false,
          t: { limit: { tif: 'Ioc' } },
        },
      ],
      grouping: 'na',
    });
  });

  it('rejects limit orders without a price', async () => {
    const config: ThufirConfig = {
      hyperliquid: { defaultSlippageBps: 10 },
    } as ThufirConfig;
    const executor = new HyperliquidLiveExecutor({ config });

    const result = await executor.execute(market, {
      action: 'sell',
      size: 0.5,
      orderType: 'limit',
    });

    expect(result.executed).toBe(false);
    expect(orderMock).not.toHaveBeenCalled();
  });

  it('surfaces exchange error status', async () => {
    orderMock.mockResolvedValueOnce({
      response: { data: { statuses: [{ error: 'bad request' }] } },
    });
    const config: ThufirConfig = {
      hyperliquid: { defaultSlippageBps: 10 },
    } as ThufirConfig;
    const executor = new HyperliquidLiveExecutor({ config });

    const result = await executor.execute(market, {
      action: 'sell',
      size: 1,
      orderType: 'market',
    });

    expect(result.executed).toBe(false);
    expect(result.message).toContain('bad request');
  });
});
