import { describe, it, expect } from 'vitest';

import { createMarketClient, NullMarketClient } from '../../src/execution/market-client.js';
import { HyperliquidMarketClient } from '../../src/execution/hyperliquid/markets.js';

describe('createMarketClient', () => {
  it('returns HyperliquidMarketClient when provider is hyperliquid', () => {
    const client = createMarketClient({
      execution: { provider: 'hyperliquid', mode: 'paper' },
      hyperliquid: { enabled: true },
    } as any);
    expect(client).toBeInstanceOf(HyperliquidMarketClient);
  });

  it('returns NullMarketClient when hyperliquid disabled', () => {
    const client = createMarketClient({
      execution: { provider: 'hyperliquid', mode: 'paper' },
      hyperliquid: { enabled: false },
    } as any);
    expect(client).toBeInstanceOf(NullMarketClient);
  });
});
