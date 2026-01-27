import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Market } from '../src/execution/polymarket/markets.js';
import type { ExecutionAdapter, TradeResult } from '../src/execution/executor.js';
import type { SpendingLimitEnforcer, LimitCheckResult } from '../src/execution/wallet/limits.js';

// Use vi.hoisted to create mocks that can be referenced in vi.mock factories
const { checkExposureLimitsMock, createPredictionMock } = vi.hoisted(() => ({
  checkExposureLimitsMock: vi.fn(),
  createPredictionMock: vi.fn().mockReturnValue('test-prediction-id'),
}));

// Mock modules before imports
vi.mock('../src/memory/predictions.js', () => ({
  createPrediction: createPredictionMock,
  listPredictions: vi.fn().mockReturnValue([]),
  listOpenPositions: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/core/exposure.js', () => ({
  checkExposureLimits: checkExposureLimitsMock,
}));

// Import after mocks
import { executeToolCall } from '../src/core/tool-executor.js';

const mockMarket: Market = {
  id: 'test-market-id',
  question: 'Will it rain tomorrow?',
  outcomes: ['Yes', 'No'],
  prices: { Yes: 0.65, No: 0.35 },
  volume: 10000,
  category: 'weather',
};

function createMockMarketClient() {
  return {
    getMarket: vi.fn().mockResolvedValue(mockMarket),
    searchMarkets: vi.fn(),
    listMarkets: vi.fn(),
  };
}

function createMockExecutor(executeResult: TradeResult): ExecutionAdapter {
  return {
    execute: vi.fn().mockResolvedValue(executeResult),
  };
}

function createMockLimiter(checkResult: LimitCheckResult): SpendingLimitEnforcer {
  return {
    checkAndReserve: vi.fn().mockResolvedValue(checkResult),
    confirm: vi.fn(),
    release: vi.fn(),
    getState: vi.fn(),
    getLimits: vi.fn(),
    setLimits: vi.fn(),
    getRemainingDaily: vi.fn().mockReturnValue(100),
  } as unknown as SpendingLimitEnforcer;
}

describe('place_bet tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: exposure check passes
    checkExposureLimitsMock.mockReturnValue({ allowed: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when market_id is missing', async () => {
    const marketClient = createMockMarketClient();
    const executor = createMockExecutor({ executed: true, message: 'Success' });
    const limiter = createMockLimiter({ allowed: true, requiresConfirmation: false });

    const result = await executeToolCall(
      'place_bet',
      { outcome: 'YES', amount: 10 },
      { config: {} as any, marketClient: marketClient as any, executor, limiter }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Missing market_id');
    }
  });

  it('returns error when outcome is invalid', async () => {
    const marketClient = createMockMarketClient();
    const executor = createMockExecutor({ executed: true, message: 'Success' });
    const limiter = createMockLimiter({ allowed: true, requiresConfirmation: false });

    const result = await executeToolCall(
      'place_bet',
      { market_id: 'test-id', outcome: 'MAYBE', amount: 10 },
      { config: {} as any, marketClient: marketClient as any, executor, limiter }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Outcome must be YES or NO');
    }
  });

  it('returns error when amount is zero or negative', async () => {
    const marketClient = createMockMarketClient();
    const executor = createMockExecutor({ executed: true, message: 'Success' });
    const limiter = createMockLimiter({ allowed: true, requiresConfirmation: false });

    const result = await executeToolCall(
      'place_bet',
      { market_id: 'test-id', outcome: 'YES', amount: 0 },
      { config: {} as any, marketClient: marketClient as any, executor, limiter }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Amount must be positive');
    }
  });

  it('returns error when executor is not configured', async () => {
    const marketClient = createMockMarketClient();
    const limiter = createMockLimiter({ allowed: true, requiresConfirmation: false });

    const result = await executeToolCall(
      'place_bet',
      { market_id: 'test-id', outcome: 'YES', amount: 10 },
      { config: {} as any, marketClient: marketClient as any, limiter }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('no executor configured');
    }
  });

  it('returns error when limiter is not configured', async () => {
    const marketClient = createMockMarketClient();
    const executor = createMockExecutor({ executed: true, message: 'Success' });

    const result = await executeToolCall(
      'place_bet',
      { market_id: 'test-id', outcome: 'YES', amount: 10 },
      { config: {} as any, marketClient: marketClient as any, executor }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('no spending limiter configured');
    }
  });

  it('returns error when spending limit is exceeded', async () => {
    const marketClient = createMockMarketClient();
    const executor = createMockExecutor({ executed: true, message: 'Success' });
    const limiter = createMockLimiter({
      allowed: false,
      requiresConfirmation: false,
      reason: 'Daily limit exceeded',
    });

    const result = await executeToolCall(
      'place_bet',
      { market_id: 'test-id', outcome: 'YES', amount: 10 },
      { config: {} as any, marketClient: marketClient as any, executor, limiter }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Daily limit exceeded');
    }
  });

  it('returns error when exposure limit is exceeded', async () => {
    checkExposureLimitsMock.mockReturnValue({
      allowed: false,
      reason: 'Position exposure 50% exceeds limit 10%',
    });

    const marketClient = createMockMarketClient();
    const executor = createMockExecutor({ executed: true, message: 'Success' });
    const limiter = createMockLimiter({ allowed: true, requiresConfirmation: false });

    const result = await executeToolCall(
      'place_bet',
      { market_id: 'test-id', outcome: 'YES', amount: 10 },
      {
        config: {} as any,
        marketClient: marketClient as any,
        executor,
        limiter,
      }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('exposure');
    }
  });

  it('successfully executes a trade', async () => {
    const marketClient = createMockMarketClient();
    const executor = createMockExecutor({ executed: true, message: 'Trade executed successfully' });
    const limiter = createMockLimiter({ allowed: true, requiresConfirmation: false });

    const result = await executeToolCall(
      'place_bet',
      {
        market_id: 'test-market-id',
        outcome: 'YES',
        amount: 10,
        reasoning: 'I think it will rain',
      },
      { config: {} as any, marketClient: marketClient as any, executor, limiter }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        executed: boolean;
        market_id: string;
        outcome: string;
        amount: number;
      };
      expect(data.executed).toBe(true);
      expect(data.market_id).toBe('test-market-id');
      expect(data.outcome).toBe('YES');
      expect(data.amount).toBe(10);
    }

    // Verify limiter.confirm was called
    expect(limiter.confirm).toHaveBeenCalledWith(10);
    // Verify limiter.release was NOT called
    expect(limiter.release).not.toHaveBeenCalled();
  });

  it('releases reserved amount when trade fails', async () => {
    const marketClient = createMockMarketClient();
    const executor = createMockExecutor({ executed: false, message: 'Insufficient liquidity' });
    const limiter = createMockLimiter({ allowed: true, requiresConfirmation: false });

    const result = await executeToolCall(
      'place_bet',
      { market_id: 'test-market-id', outcome: 'NO', amount: 25 },
      { config: {} as any, marketClient: marketClient as any, executor, limiter }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Insufficient liquidity');
    }

    // Verify limiter.release was called
    expect(limiter.release).toHaveBeenCalledWith(25);
    // Verify limiter.confirm was NOT called
    expect(limiter.confirm).not.toHaveBeenCalled();
  });

  it('handles market fetch errors', async () => {
    const marketClient = {
      getMarket: vi.fn().mockRejectedValue(new Error('Market not found')),
      searchMarkets: vi.fn(),
      listMarkets: vi.fn(),
    };
    const executor = createMockExecutor({ executed: true, message: 'Success' });
    const limiter = createMockLimiter({ allowed: true, requiresConfirmation: false });

    const result = await executeToolCall(
      'place_bet',
      { market_id: 'nonexistent-market', outcome: 'YES', amount: 10 },
      { config: {} as any, marketClient: marketClient as any, executor, limiter }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Failed to fetch market');
      expect(result.error).toContain('Market not found');
    }
  });

  it('normalizes outcome to uppercase', async () => {
    const marketClient = createMockMarketClient();
    const executor = createMockExecutor({ executed: true, message: 'Success' });
    const limiter = createMockLimiter({ allowed: true, requiresConfirmation: false });

    const result = await executeToolCall(
      'place_bet',
      { market_id: 'test-market-id', outcome: 'yes', amount: 10 },
      { config: {} as any, marketClient: marketClient as any, executor, limiter }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { outcome: string };
      expect(data.outcome).toBe('YES');
    }
  });
});
