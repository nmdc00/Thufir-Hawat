import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock ethers before importing LiveExecutor
vi.mock('ethers', () => {
  const mockWallet = {
    address: '0x1234567890abcdef1234567890abcdef12345678',
    signTypedData: vi.fn().mockResolvedValue('0xsignature'),
  };

  return {
    ethers: {
      Wallet: class {
        address = mockWallet.address;
        signTypedData = mockWallet.signTypedData;
      },
      utils: {
        SupportedAlgorithm: { sha256: 'sha256' },
        computeHmac: vi.fn().mockReturnValue('0xhmac'),
        toUtf8Bytes: vi.fn((str: string) => Buffer.from(str)),
        formatEther: vi.fn((val: bigint) => String(Number(val) / 1e18)),
      },
    },
  };
});

// Mock wallet manager
vi.mock('../../src/execution/wallet/manager.js', () => ({
  loadWallet: vi.fn(() => ({
    address: '0x1234567890abcdef1234567890abcdef12345678',
    signTypedData: vi.fn().mockResolvedValue('0xsignature'),
  })),
}));

// Mock CLOB client
const mockPostOrder = vi.fn();
const mockDeriveApiKey = vi.fn();
vi.mock('../../src/execution/polymarket/clob.js', () => ({
  PolymarketCLOBClient: class {
    private authenticated = false;
    setWallet() {}
    setCredentials() {
      this.authenticated = true;
    }
    isAuthenticated() {
      return this.authenticated;
    }
    deriveApiKey = mockDeriveApiKey;
    postOrder = mockPostOrder;
  },
  CLOBError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CLOBError';
    }
  },
}));

// Mock order signer
vi.mock('../../src/execution/polymarket/signer.js', () => ({
  PolymarketOrderSigner: class {
    buildCLOBOrder = vi.fn().mockResolvedValue({ order: 'mock' });
  },
  usdToShares: (usd: number, price: number) => usd / price,
  EXCHANGE_ADDRESSES: {
    CTF_EXCHANGE: '0xCTFExchange',
    NEG_RISK_CTF_EXCHANGE: '0xNegRiskExchange',
  },
}));

// Mock spending limits
const mockCheckAndReserve = vi.fn();
const mockConfirm = vi.fn();
const mockRelease = vi.fn();
vi.mock('../../src/execution/wallet/limits.js', () => ({
  SpendingLimitEnforcer: class {
    on() {}
    checkAndReserve = mockCheckAndReserve;
    confirm = mockConfirm;
    release = mockRelease;
    getRemainingDaily() {
      return 75;
    }
    getState() {
      return { todaySpent: 25, reserved: 0 };
    }
    getLimits() {
      return { daily: 100, perTrade: 25 };
    }
  },
  LimitExceededError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'LimitExceededError';
    }
  },
}));

// Mock whitelist
vi.mock('../../src/execution/wallet/whitelist.js', () => ({
  assertWhitelisted: vi.fn(),
  WhitelistError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WhitelistError';
    }
  },
}));

// Mock memory modules
vi.mock('../../src/memory/predictions.js', () => ({
  createPrediction: vi.fn(() => 'pred-123'),
  recordExecution: vi.fn(),
}));

vi.mock('../../src/memory/trades.js', () => ({
  recordTrade: vi.fn(),
}));

vi.mock('../../src/memory/audit.js', () => ({
  logWalletOperation: vi.fn(),
}));

import { LiveExecutor } from '../../src/execution/modes/live.js';
import type { Market } from '../../src/execution/polymarket/markets.js';

describe('LiveExecutor', () => {
  const mockConfig = {
    polymarket: {
      api: { gamma: 'https://gamma', clob: 'https://clob' },
    },
    wallet: {
      keystorePath: '/tmp/keystore.json',
      limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 },
    },
  };

  const mockMarket: Market = {
    id: 'market-123',
    question: 'Will X happen?',
    outcomes: ['YES', 'NO'],
    prices: { YES: 0.6, NO: 0.4 },
    tokens: [
      { token_id: 'token-yes', outcome: 'YES' },
      { token_id: 'token-no', outcome: 'NO' },
    ],
  } as Market;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAndReserve.mockResolvedValue({ allowed: true });
    mockDeriveApiKey.mockResolvedValue({
      key: 'api-key',
      secret: 'api-secret',
      passphrase: 'passphrase',
    });
    mockPostOrder.mockResolvedValue({
      success: true,
      orderID: 'order-456',
      transactionsHashes: ['0xhash'],
    });
  });

  it('returns hold message for hold decisions', async () => {
    const executor = new LiveExecutor({
      config: mockConfig as any,
      password: 'test-password',
    });

    const result = await executor.execute(mockMarket, { action: 'hold' });

    expect(result.executed).toBe(false);
    expect(result.message).toContain('Hold');
  });

  it('rejects invalid decisions without amount or outcome', async () => {
    const executor = new LiveExecutor({
      config: mockConfig as any,
      password: 'test-password',
    });

    const result = await executor.execute(mockMarket, {
      action: 'buy',
      // missing amount and outcome
    });

    expect(result.executed).toBe(false);
    expect(result.message).toContain('Invalid decision');
  });

  it('executes buy orders successfully', async () => {
    const executor = new LiveExecutor({
      config: mockConfig as any,
      password: 'test-password',
    });

    const result = await executor.execute(mockMarket, {
      action: 'buy',
      outcome: 'YES',
      amount: 10,
      confidence: 'medium',
      reasoning: 'Test reasoning',
    });

    expect(result.executed).toBe(true);
    expect(result.message).toContain('Order submitted');
    expect(result.message).toContain('BUY');
    expect(result.message).toContain('order-456');
    expect(mockConfirm).toHaveBeenCalledWith(10);
  });

  it('rejects when spending limit exceeded', async () => {
    mockCheckAndReserve.mockResolvedValue({
      allowed: false,
      reason: 'Daily limit exceeded',
    });

    const executor = new LiveExecutor({
      config: mockConfig as any,
      password: 'test-password',
    });

    const result = await executor.execute(mockMarket, {
      action: 'buy',
      outcome: 'YES',
      amount: 200, // exceeds limit
      confidence: 'high',
    });

    expect(result.executed).toBe(false);
    expect(result.message).toContain('limit exceeded');
  });

  it('releases reserved amount on order failure', async () => {
    mockPostOrder.mockResolvedValue({
      success: false,
      errorMsg: 'Insufficient funds',
    });

    const executor = new LiveExecutor({
      config: mockConfig as any,
      password: 'test-password',
    });

    const result = await executor.execute(mockMarket, {
      action: 'buy',
      outcome: 'YES',
      amount: 10,
    });

    expect(result.executed).toBe(false);
    expect(result.message).toContain('Insufficient funds');
    expect(mockRelease).toHaveBeenCalledWith(10);
  });

  it('provides spending state', () => {
    const executor = new LiveExecutor({
      config: mockConfig as any,
      password: 'test-password',
    });

    const state = executor.getSpendingState();

    expect(state.todaySpent).toBe(25);
    expect(state.remaining).toBe(75);
    expect(state.limits.daily).toBe(100);
  });

  it('returns wallet address', () => {
    const executor = new LiveExecutor({
      config: mockConfig as any,
      password: 'test-password',
    });

    expect(executor.getAddress()).toBe('0x1234567890abcdef1234567890abcdef12345678');
  });
});

describe('Execution mode factory', () => {
  it('creates LiveExecutor when mode is live and password provided', async () => {
    // Set environment variable
    const originalPassword = process.env.THUFIR_WALLET_PASSWORD;
    process.env.THUFIR_WALLET_PASSWORD = 'test-password';

    try {
      // This is tested indirectly through the agent - just verify the LiveExecutor can be instantiated
      const executor = new LiveExecutor({
        config: {
          polymarket: {
            api: { gamma: 'https://gamma', clob: 'https://clob' },
          },
          wallet: {
            keystorePath: '/tmp/keystore.json',
            limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 },
          },
        } as any,
        password: process.env.THUFIR_WALLET_PASSWORD,
      });

      expect(executor).toBeInstanceOf(LiveExecutor);
    } finally {
      // Restore original value
      if (originalPassword !== undefined) {
        process.env.THUFIR_WALLET_PASSWORD = originalPassword;
      } else {
        delete process.env.THUFIR_WALLET_PASSWORD;
      }
    }
  });
});
