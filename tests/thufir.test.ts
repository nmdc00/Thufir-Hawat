import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { Thufir } from '../src/index.js';

let openPositions: Array<{
  marketId: string;
  marketTitle: string;
  predictedOutcome?: 'YES' | 'NO';
  executionPrice?: number | null;
  positionSize?: number | null;
  currentPrices?: Record<string, number> | number[] | null;
}> = [];

vi.mock('../src/memory/db.js', () => {
  const stub = {
    prepare: () => ({
      get: () => undefined,
      all: () => [],
      run: () => ({}),
    }),
    exec: () => undefined,
    pragma: () => undefined,
  };

  return {
    openDatabase: () => stub,
  };
});

vi.mock('../src/memory/predictions.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../src/memory/predictions.js'
  );
  return {
    ...actual,
    listOpenPositions: () => openPositions,
  };
});

vi.mock('../src/memory/chat.js', () => ({
  pruneChatMessages: () => 0,
}));

vi.mock('../src/core/conversation.js', () => ({
  ConversationHandler: class {
    async analyzeMarket() {
      return 'analysis';
    }
    async analyzeMarketStructured() {
      return { marketId: 'm1', question: 'Test market', plan: { steps: [] }, analysis: {} };
    }
    async chat() {
      return 'chat reply';
    }
  },
}));

vi.mock('../src/execution/polymarket/markets.js', () => ({
  PolymarketMarketClient: class {
    async getMarket() {
      return {
        id: 'm1',
        question: 'Test market',
        outcomes: ['YES', 'NO'],
        prices: { YES: 0.5, NO: 0.5 },
      };
    }
  },
}));

vi.mock('../src/execution/modes/paper.js', () => ({
  PaperExecutor: class {
    async execute() {
      return { executed: true, message: 'ok' };
    }
  },
}));

function writeTempConfig(): { configPath: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-test-'));
  const dbPath = join(dir, 'thufir.sqlite');
  const configPath = join(dir, 'config.yaml');

  const contents = `
gateway:
  port: 18789
agent:
  model: "test-model"
  provider: "local"
polymarket:
  api:
    gamma: "https://example.com"
    clob: "https://example.com"
execution:
  mode: "paper"
wallet:
  limits:
    daily: 100
    perTrade: 25
    confirmationThreshold: 10
memory:
  dbPath: "${dbPath}"
`;

  writeFileSync(configPath, contents);
  return { configPath, dbPath };
}

describe('Thufir programmatic API', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    openPositions = [];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('starts and stops cleanly, exposes calibration and portfolio', async () => {
    const { configPath, dbPath } = writeTempConfig();
    process.env.THUFIR_DB_PATH = dbPath;
    openPositions = [];

    const thufir = new Thufir({ configPath, userId: 'test-user' });
    await thufir.start();

    const calibration = await thufir.getCalibration();
    expect(calibration).toEqual([]);

    const portfolio = await thufir.getPortfolio();
    expect(portfolio).toMatchObject({
      positions: [],
      totalValue: 0,
      totalCost: 0,
      totalPnl: 0,
      totalPnlPercent: 0,
      cashBalance: 0,
    });

    await thufir.stop();

    await expect(thufir.getCalibration()).rejects.toThrow('Thufir not started');
  });

  it('throws when starting twice', async () => {
    const { configPath, dbPath } = writeTempConfig();
    process.env.THUFIR_DB_PATH = dbPath;

    const thufir = new Thufir({ configPath });
    await thufir.start();

    await expect(thufir.start()).rejects.toThrow('Thufir already started');
  });

  it('computes portfolio PnL from open positions', async () => {
    const { configPath, dbPath } = writeTempConfig();
    process.env.THUFIR_DB_PATH = dbPath;
    openPositions = [
      {
        marketId: 'm1',
        marketTitle: 'Test market',
        predictedOutcome: 'YES',
        executionPrice: 0.5,
        positionSize: 100,
        currentPrices: { YES: 0.6 },
      },
    ];

    const thufir = new Thufir({ configPath, userId: 'test-user' });
    await thufir.start();

    const portfolio = await thufir.getPortfolio();
    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.totalValue).toBeCloseTo(120, 6);
    expect(portfolio.totalPnl).toBeCloseTo(20, 6);

    await thufir.stop();
  });

  it('analyze delegates to conversation handler', async () => {
    const { configPath, dbPath } = writeTempConfig();
    process.env.THUFIR_DB_PATH = dbPath;
    const thufir = new Thufir({ configPath, userId: 'test-user' });
    await thufir.start();

    const result = await thufir.analyze('m1');
    expect(result).toBe('analysis');

    await thufir.stop();
  });

  it('structured analyze delegates to conversation handler', async () => {
    const { configPath, dbPath } = writeTempConfig();
    process.env.THUFIR_DB_PATH = dbPath;
    const thufir = new Thufir({ configPath, userId: 'test-user' });
    await thufir.start();

    const result = await thufir.analyzeStructured('m1');
    expect(result).toMatchObject({ marketId: 'm1', question: 'Test market' });

    await thufir.stop();
  });

  it('trade executes and returns result', async () => {
    const { configPath, dbPath } = writeTempConfig();
    process.env.THUFIR_DB_PATH = dbPath;
    const thufir = new Thufir({ configPath, userId: 'test-user' });
    await thufir.start();

    const result = await thufir.trade({ marketId: 'm1', outcome: 'YES', amount: 10 });
    expect(result).toEqual({ executed: true, message: 'ok' });

    await thufir.stop();
  });
});
