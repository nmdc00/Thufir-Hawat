import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('../../src/execution/hyperliquid/client.js', () => {
  class HyperliquidClient {
    constructor(_config: unknown) {}

    async getUserDexAbstraction() {
      return false;
    }

    async getClearinghouseState() {
      return {
        assetPositions: [
          {
            position: {
              coin: 'BTC',
              szi: '0.1',
              entryPx: '65000',
              unrealizedPnl: '120',
            },
          },
        ],
        marginSummary: {
          accountValue: '1020',
        },
        withdrawable: '0',
      };
    }

    async getSpotClearinghouseState() {
      return {
        balances: [{ coin: 'USDC', total: '12.841434', hold: '0' }],
      };
    }
  }
  return { HyperliquidClient };
});

describe('dashboard api live wallet overlay', () => {
  it('overlays live open positions and equity in mode=live', async () => {
    const originalDbPath = process.env.THUFIR_DB_PATH;
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-live-wallet-'));
    process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');
    try {
      const { handleDashboardApiRequest } = await import('../../src/gateway/dashboard_api.js');
      const req = {
        method: 'GET',
        url: '/api/dashboard?mode=live&timeframe=all',
        headers: { host: 'localhost:18789' },
        thufirConfig: {
          execution: { mode: 'live', provider: 'hyperliquid' },
          hyperliquid: { enabled: true },
        },
      } as any;

      const state: { status?: number; body?: string } = {};
      const res = {
        writeHead: (status: number) => {
          state.status = status;
        },
        end: (body?: string) => {
          state.body = body;
        },
      } as any;

      const handled = handleDashboardApiRequest(req, res);
      expect(handled).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.status).toBe(200);
      const payload = JSON.parse(String(state.body)) as any;
      expect(payload.meta.mode).toBe('live');
      expect(payload.sections.openPositions.rows.length).toBe(1);
      expect(payload.sections.openPositions.rows[0].symbol).toBe('BTC');
      expect(payload.sections.openPositions.summary.totalUnrealizedPnlUsd).toBeCloseTo(120, 8);
      expect(payload.sections.equityCurve.points[0].cashBalance).toBeCloseTo(900, 8);
      expect(payload.sections.equityCurve.summary.endEquity).toBeCloseTo(1020, 8);
    } finally {
      if (process.env.THUFIR_DB_PATH) {
        rmSync(process.env.THUFIR_DB_PATH, { force: true });
        rmSync(dirname(process.env.THUFIR_DB_PATH), { recursive: true, force: true });
      }
      if (originalDbPath === undefined) {
        delete process.env.THUFIR_DB_PATH;
      } else {
        process.env.THUFIR_DB_PATH = originalDbPath;
      }
    }
  });
});
