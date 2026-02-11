import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  query: string;
  runs: number;
  successes: number;
  totalNewItems: number;
  totalWebResults: number;
  totalWebFetches: number;
  score: number;
  lastError: string | null;
  lastRunAt: string;
};

let rows = new Map<string, Row>();

const fakeDb = {
  prepare: (sql: string) => {
    if (sql.includes('INSERT INTO proactive_query_stats')) {
      return {
        run: (params: Record<string, unknown>) => {
          const query = String(params.query);
          const existing = rows.get(query);
          const successInc = Number(params.successInc ?? 0);
          const storedItems = Number(params.storedItems ?? 0);
          const webResults = Number(params.webResults ?? 0);
          const fetchedPages = Number(params.fetchedPages ?? 0);
          const error = String(params.error ?? '');

          if (!existing) {
            rows.set(query, {
              query,
              runs: 1,
              successes: successInc,
              totalNewItems: storedItems,
              totalWebResults: webResults,
              totalWebFetches: fetchedPages,
              score: Number(params.initialScore ?? 0),
              lastError: error || null,
              lastRunAt: 'now',
            });
            return;
          }

          const runs = existing.runs + 1;
          const successes = existing.successes + successInc;
          const totalNewItems = existing.totalNewItems + storedItems;
          const totalWebResults = existing.totalWebResults + webResults;
          const totalWebFetches = existing.totalWebFetches + fetchedPages;
          const score =
            (totalNewItems * 3 + totalWebResults * 0.8 + totalWebFetches * 0.4 + successes * 1.2) /
            runs;

          rows.set(query, {
            ...existing,
            runs,
            successes,
            totalNewItems,
            totalWebResults,
            totalWebFetches,
            score,
            lastError: error ? error : existing.lastError,
            lastRunAt: 'now',
          });
        },
      };
    }

    if (sql.includes('SELECT query') && sql.includes('FROM proactive_query_stats')) {
      return {
        all: (limit: number) => {
          const ordered = Array.from(rows.values())
            .sort((a, b) => b.score - a.score || b.successes - a.successes)
            .slice(0, Number(limit));
          return ordered.map((row) => ({ query: row.query }));
        },
      };
    }

    if (sql.includes('SELECT') && sql.includes('total_new_items as totalNewItems')) {
      return {
        all: (limit: number) => {
          return Array.from(rows.values())
            .sort((a, b) => b.score - a.score || b.runs - a.runs)
            .slice(0, Number(limit))
            .map((row) => ({
              query: row.query,
              runs: row.runs,
              successes: row.successes,
              totalNewItems: row.totalNewItems,
              totalWebResults: row.totalWebResults,
              totalWebFetches: row.totalWebFetches,
              score: row.score,
              lastError: row.lastError,
              lastRunAt: row.lastRunAt,
            }));
        },
      };
    }

    return {
      run: () => undefined,
      all: () => [],
    };
  },
};

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => fakeDb,
}));

import {
  listLearnedProactiveQueries,
  listProactiveQueryStats,
  recordProactiveQueryOutcome,
} from '../../src/memory/proactive_queries.js';

beforeEach(() => {
  rows = new Map<string, Row>();
});

describe('proactive query learning memory', () => {
  it('records outcomes and ranks learned queries', () => {
    recordProactiveQueryOutcome({
      query: 'fed cuts rates 2026',
      storedItems: 3,
      webResults: 5,
      fetchedPages: 1,
      succeeded: true,
    });
    recordProactiveQueryOutcome({
      query: 'fed cuts rates 2026',
      storedItems: 1,
      webResults: 2,
      fetchedPages: 0,
      succeeded: true,
    });
    recordProactiveQueryOutcome({
      query: 'btc funding squeeze',
      storedItems: 0,
      webResults: 1,
      fetchedPages: 0,
      succeeded: false,
      error: 'provider timeout',
    });

    const learned = listLearnedProactiveQueries(5);
    expect(learned[0]).toBe('fed cuts rates 2026');
    expect(learned).toContain('btc funding squeeze');

    const stats = listProactiveQueryStats(5);
    const top = stats.find((entry) => entry.query === 'fed cuts rates 2026');
    expect(top).toBeTruthy();
    expect(top?.runs).toBe(2);
    expect(top?.successes).toBe(2);
    expect(top?.totalNewItems).toBe(4);
  });
});
