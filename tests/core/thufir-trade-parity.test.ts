import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeToolCall = vi.fn();
const getMarket = vi.fn(async () => ({
  symbol: 'BTC',
  markPrice: 50_000,
  metadata: { maxLeverage: 10 },
}));

vi.mock('../../src/core/config.js', () => ({
  loadConfig: vi.fn(() => ({
    execution: { mode: 'paper', provider: 'hyperliquid' },
    paper: { initialCashUsdc: 200 },
    wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
  })),
}));

vi.mock('../../src/core/llm.js', () => ({
  createLlmClient: vi.fn(() => ({})),
  createTrivialTaskClient: vi.fn(() => undefined),
}));

vi.mock('../../src/core/conversation.js', () => ({
  ConversationHandler: vi.fn().mockImplementation(() => ({
    analyzeMarket: vi.fn(),
    analyzeMarketStructured: vi.fn(),
  })),
}));

vi.mock('../../src/execution/market-client.js', () => ({
  createMarketClient: vi.fn(() => ({
    getMarket,
  })),
}));

vi.mock('../../src/execution/modes/paper.js', () => ({
  PaperExecutor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/execution/modes/webhook.js', () => ({
  WebhookExecutor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/execution/modes/hyperliquid-live.js', () => ({
  HyperliquidLiveExecutor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/execution/modes/unsupported-live.js', () => ({
  UnsupportedLiveExecutor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/execution/wallet/limits_db.js', () => ({
  DbSpendingLimitEnforcer: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/core/tool-executor.js', () => ({
  executeToolCall,
}));

describe('Thufir.trade parity routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes programmatic perp trades through perp_place_order', async () => {
    executeToolCall.mockResolvedValueOnce({
      success: true,
      data: { executed: true, message: 'ok', trade_id: 17 },
    });

    const { Thufir } = await import('../../src/index.js');
    const thufir = new Thufir();
    await thufir.start();

    const result = await thufir.trade({
      symbol: 'BTC',
      side: 'buy',
      sizeUsd: 25,
      leverage: 3,
    });

    expect(executeToolCall).toHaveBeenCalledWith(
      'perp_place_order',
      expect.objectContaining({
        symbol: 'BTC',
        side: 'buy',
        size: 25 / 50_000,
        leverage: 3,
        order_type: 'market',
        reasoning: 'Programmatic trade for programmatic',
      }),
      expect.any(Object)
    );
    expect(result).toEqual({ executed: true, message: 'ok', trade_id: 17 });
  });

  it('maps shared lifecycle failures back to programmatic callers', async () => {
    executeToolCall.mockResolvedValueOnce({
      success: false,
      error: 'blocked by lifecycle',
    });

    const { Thufir } = await import('../../src/index.js');
    const thufir = new Thufir();
    await thufir.start();

    const result = await thufir.trade({
      symbol: 'BTC',
      side: 'sell',
      sizeUsd: 10,
    });

    expect(result).toEqual({ executed: false, message: 'blocked by lifecycle' });
  });
});
