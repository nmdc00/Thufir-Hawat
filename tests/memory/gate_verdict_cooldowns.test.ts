import { beforeEach, describe, expect, it, vi } from 'vitest';

type CooldownRow = {
  symbol: string;
  side: string;
  lastRejectAt: string;
  lastEdge: number;
};

const fakeDb = vi.hoisted(() => {
  const rows = new Map<string, CooldownRow>();
  return {
    rows,
    execStatements: [] as string[],
    exec(sql: string): void {
      this.execStatements.push(sql);
    },
    prepare(sql: string) {
      if (/SELECT symbol, side, last_reject_at AS lastRejectAt/i.test(sql)) {
        return {
          get: (params: { symbol: string; side: string }) => rows.get(`${params.symbol}:${params.side}`),
        };
      }
      if (/INSERT INTO gate_verdict_cooldowns/i.test(sql)) {
        return {
          run: (params: { symbol: string; side: string; lastRejectAt: string; lastEdge: number }) => {
            rows.set(`${params.symbol}:${params.side}`, {
              symbol: params.symbol,
              side: params.side,
              lastRejectAt: params.lastRejectAt,
              lastEdge: params.lastEdge,
            });
          },
        };
      }
      throw new Error(`Unexpected SQL in fake db: ${sql}`);
    },
  };
});

const openDatabaseMock = vi.hoisted(() => vi.fn(() => fakeDb));

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: openDatabaseMock,
}));

describe('gate verdict cooldowns', () => {
  beforeEach(() => {
    fakeDb.rows.clear();
    fakeDb.execStatements = [];
    openDatabaseMock.mockClear();
    vi.resetModules();
  });

  it('creates the DB-backed cooldown table and upserts reject state by symbol and side', async () => {
    const { getGateVerdictCooldown, recordGateVerdictReject } = await import(
      '../../src/memory/gate_verdict_cooldowns.js'
    );

    recordGateVerdictReject({
      symbol: 'BTC',
      side: 'buy',
      edge: 0.08,
      rejectedAt: new Date('2026-06-13T10:00:00.000Z'),
    });
    recordGateVerdictReject({
      symbol: 'BTC',
      side: 'buy',
      edge: 0.09,
      rejectedAt: new Date('2026-06-13T10:05:00.000Z'),
    });

    expect(fakeDb.execStatements.some((sql) => /CREATE TABLE IF NOT EXISTS gate_verdict_cooldowns/i.test(sql))).toBe(true);
    expect(getGateVerdictCooldown('BTC', 'buy')).toEqual({
      symbol: 'BTC',
      side: 'buy',
      lastRejectAt: '2026-06-13T10:05:00.000Z',
      lastEdge: 0.09,
    });
    expect(getGateVerdictCooldown('ETH', 'buy')).toBeNull();
  });
});
