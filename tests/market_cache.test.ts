import { describe, it, expect, beforeEach, vi } from 'vitest';

type CacheRow = {
  id: string;
  question: string;
  outcomes?: string | null;
  prices?: string | null;
  updatedAt?: string | null;
};

const state = vi.hoisted(() => ({
  rows: new Map<string, CacheRow>(),
}));

vi.mock('../src/memory/db.js', () => {
  return {
    openDatabase: () => ({
      prepare: (sql: string) => {
        if (sql.includes('INSERT INTO market_cache')) {
          return {
            run: (params: Record<string, unknown>) => {
              state.rows.set(String(params.id), {
                id: String(params.id),
                question: String(params.question),
                description: (params.description as string | null) ?? null,
                outcomes: (params.outcomes as string | null) ?? null,
                prices: (params.prices as string | null) ?? null,
                updatedAt: new Date().toISOString(),
              });
              return {};
            },
          };
        }
        if (sql.includes('FROM market_cache') && sql.includes('WHERE id = ?')) {
          return {
            get: (id: string) => {
              const row = state.rows.get(String(id));
              if (!row) return undefined;
              return {
                id: row.id,
                question: row.question,
                description: row.description,
                outcomes: row.outcomes,
                prices: row.prices,
                endDate: null,
                category: null,
                resolved: 0,
                resolution: null,
                createdAt: null,
                updatedAt: row.updatedAt,
              };
            },
          };
        }
        if (sql.includes('FROM market_cache') && sql.includes('ORDER BY volume DESC')) {
          return {
            all: (...args: Array<string | number>) => {
              const limit = args.find((arg) => typeof arg === 'number') as number | undefined;
              const stringArgs = args.filter((arg) => typeof arg === 'string') as string[];
              const hasQuery = stringArgs.length > 0;
              const needle = hasQuery ? String(stringArgs[0]).replace(/%/g, '') : '';
              const filtered = Array.from(state.rows.values()).filter((row) => {
                if (!hasQuery) return true;
                const hay = `${row.question} ${row.description ?? ''}`.toLowerCase();
                return hay.includes(needle.toLowerCase());
              });
              return filtered.slice(0, limit ?? 50).map((row) => ({
                id: row.id,
                question: row.question,
                description: row.description,
                outcomes: row.outcomes,
                prices: row.prices,
                endDate: null,
                category: null,
                resolved: 0,
                resolution: null,
                createdAt: null,
                updatedAt: row.updatedAt,
              }));
            },
          };
        }
        if (sql.includes('MAX(updated_at)')) {
          return {
            get: () => ({
              count: state.rows.size,
              latestUpdatedAt:
                state.rows.size > 0
                  ? Array.from(state.rows.values())[0]?.updatedAt ?? null
                  : null,
            }),
          };
        }
        return {
          get: () => undefined,
          run: () => ({}),
        };
      },
      exec: () => undefined,
      pragma: () => undefined,
    }),
  };
});

import {
  getMarketCache,
  getMarketCacheStats,
  listMarketCache,
  searchMarketCache,
  upsertMarketCache,
} from '../src/memory/market_cache.js';

describe('market cache', () => {
  beforeEach(() => {
    state.rows.clear();
  });

  it('upserts and reads cached markets', () => {
    upsertMarketCache({
      id: 'm1',
      question: 'Test market',
      description: 'Test description',
      outcomes: ['YES', 'NO'],
      prices: { YES: 0.42, NO: 0.58 },
    });

    const cached = getMarketCache('m1');
    expect(cached?.question).toBe('Test market');
    expect(cached?.outcomes).toEqual(['YES', 'NO']);
    expect(cached?.prices).toEqual({ YES: 0.42, NO: 0.58 });
  });

  it('lists cached markets', () => {
    upsertMarketCache({ id: 'm1', question: 'Alpha market' });
    upsertMarketCache({ id: 'm2', question: 'Beta market' });
    const list = listMarketCache(10);
    expect(list.length).toBe(2);
  });

  it('searches cached markets', () => {
    upsertMarketCache({ id: 'm1', question: 'Bitcoin price market' });
    upsertMarketCache({ id: 'm2', question: 'Election market' });
    const list = searchMarketCache('bitcoin', 10);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe('m1');
  });

  it('returns cache stats', () => {
    upsertMarketCache({ id: 'm1', question: 'Stats market' });
    const stats = getMarketCacheStats();
    expect(stats.count).toBe(1);
    expect(stats.latestUpdatedAt).toBeTruthy();
  });
});
