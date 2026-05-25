import { beforeEach, describe, expect, it, vi } from 'vitest';

const logWalletOperation = vi.fn();
const recordPerpTrade = vi.fn();
const placePaperPerpOrder = vi.fn(() => ({
  orderId: 'paper-order-1',
  message: 'paper fill ok',
  fillPrice: 50_000,
  realizedPnlUsd: 0,
  feeUsd: 0.1,
}));

vi.mock('../../src/memory/audit.js', () => ({
  logWalletOperation,
}));

vi.mock('../../src/memory/perp_trades.js', () => ({
  recordPerpTrade,
}));

vi.mock('../../src/memory/paper_perps.js', () => ({
  placePaperPerpOrder,
  listPaperPerpOpenOrders: vi.fn(() => []),
  cancelPaperPerpOrder: vi.fn(),
}));

describe('PaperExecutor perp parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not persist perp trades or wallet audit directly for perp fills', async () => {
    const { PaperExecutor } = await import('../../src/execution/modes/paper.js');

    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const result = await executor.execute(
      {
        id: 'BTC',
        question: 'BTC perp',
        outcomes: ['LONG', 'SHORT'],
        prices: {},
        platform: 'hyperliquid',
        kind: 'perp',
        symbol: 'BTC',
        markPrice: 50_000,
      },
      {
        action: 'buy',
        side: 'buy',
        symbol: 'BTC',
        size: 0.01,
        orderType: 'market',
      }
    );

    expect(result.executed).toBe(true);
    expect(placePaperPerpOrder).toHaveBeenCalledTimes(1);
    expect(recordPerpTrade).not.toHaveBeenCalled();
    expect(logWalletOperation).not.toHaveBeenCalled();
  });
});
