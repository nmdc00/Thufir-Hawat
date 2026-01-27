import { describe, it, expect } from 'vitest';

import { parseMarketUpdate } from '../src/execution/polymarket/stream.js';

describe('market stream parsing', () => {
  it('parses marketId and prices', () => {
    const msg = JSON.stringify({ marketId: 'm1', prices: { YES: 0.6, NO: 0.4 } });
    const update = parseMarketUpdate(msg);
    expect(update?.marketId).toBe('m1');
    expect(update?.prices?.YES).toBe(0.6);
  });
});
