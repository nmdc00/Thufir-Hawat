import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { openDatabase } from '../../src/memory/db.js';
import { placePaperPerpOrder } from '../../src/memory/paper_perps.js';

const getAllMidsMock = vi.fn<() => Promise<Record<string, number>>>();

vi.mock('../../src/execution/hyperliquid/client.js', () => {
  class HyperliquidClient {
    constructor(_config: unknown) {}

    async getAllMids() {
      return getAllMidsMock();
    }
  }

  return { HyperliquidClient };
});

describe('dashboard api paper cache', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;
  let dbDir: string | null = null;
  let dbPath: string | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T10:00:00.000Z'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { clearDashboardCache } = await import('../../src/gateway/dashboard_cache.js');
    clearDashboardCache();
    vi.useRealTimers();
    process.env.THUFIR_DB_PATH = originalDbPath;
    if (dbPath) {
      rmSync(dbPath, { force: true });
      dbPath = null;
    }
    if (dbDir) {
      rmSync(dbDir, { recursive: true, force: true });
      dbDir = null;
    }
  });

  it('keeps the last good paper dashboard snapshot when fresh mids fail with open positions', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-paper-cache-'));
    dbPath = join(dbDir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    openDatabase(dbPath);

    placePaperPerpOrder(
      { symbol: 'BTC', side: 'buy', size: 2, orderType: 'market', markPrice: 100 },
      { initialCashUsdc: 200 }
    );
    placePaperPerpOrder(
      { symbol: 'BTC', side: 'sell', size: 1, orderType: 'market', markPrice: 110, reduceOnly: true },
      { initialCashUsdc: 200 }
    );

    getAllMidsMock
      .mockResolvedValueOnce({ BTC: 120 })
      .mockRejectedValueOnce(new Error('mid fetch failed'));

    const { handleDashboardApiRequest } = await import('../../src/gateway/dashboard_api.js');
    const req = {
      method: 'GET',
      url: '/api/dashboard?mode=paper&timeframe=all',
      headers: { host: 'localhost:18789' },
      thufirConfig: {
        execution: { mode: 'paper', provider: 'hyperliquid' },
        hyperliquid: { enabled: true },
      },
    } as any;

    const firstState: { status?: number; body?: string } = {};
    const firstRes = {
      writeHead: (status: number) => {
        firstState.status = status;
      },
      end: (body?: string) => {
        firstState.body = body;
      },
    } as any;

    expect(handleDashboardApiRequest(req, firstRes)).toBe(true);
    await vi.runAllTimersAsync();

    const firstPayload = JSON.parse(String(firstState.body)) as any;
    expect(firstState.status).toBe(200);
    expect(firstPayload.sections.openPositions.rows[0].currentPrice).toBe(120);
    expect(firstPayload.sections.openPositions.summary.totalUnrealizedPnlUsd).toBeCloseTo(19.95, 6);

    vi.advanceTimersByTime(6_000);

    const secondState: { status?: number; body?: string } = {};
    const secondRes = {
      writeHead: (status: number) => {
        secondState.status = status;
      },
      end: (body?: string) => {
        secondState.body = body;
      },
    } as any;

    expect(handleDashboardApiRequest(req, secondRes)).toBe(true);
    await vi.runAllTimersAsync();

    const secondPayload = JSON.parse(String(secondState.body)) as any;
    expect(secondState.status).toBe(200);
    expect(secondPayload.sections.openPositions.rows[0].currentPrice).toBe(120);
    expect(secondPayload.sections.openPositions.summary.totalUnrealizedPnlUsd).toBeCloseTo(19.95, 6);
    expect(getAllMidsMock).toHaveBeenCalledTimes(2);
  });
});
