import { beforeEach, describe, expect, it, vi } from 'vitest';

let rows: Array<Record<string, unknown>> = [];

function sqliteNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const fakeDb = {
  exec: vi.fn(),
  prepare: (sql: string) => {
    if (sql.includes('INSERT INTO opportunity_rank_logs')) {
      return {
        run: (params: Record<string, unknown>) => {
          const now = sqliteNow();
          rows.push({
            id: rows.length + 1,
            created_at: now,
            scan_id: params.scanId,
            source: params.source,
            fingerprint: params.fingerprint ?? null,
            generated_at: params.generatedAt ?? null,
            expires_at: params.expiresAt ?? null,
            mode: params.mode ?? null,
            provider: params.provider ?? null,
            model: params.model ?? null,
            markets_scanned: params.marketsScanned ?? 0,
            news_items_analyzed: params.newsItemsAnalyzed ?? 0,
            opportunities_found: params.opportunitiesFound ?? 0,
            top_market_id: params.topMarketId ?? null,
            top_rank: params.topRank ?? null,
            top_score: params.topScore ?? null,
            artifact: params.artifact ?? null,
            notes: params.notes ?? null,
          });
        },
      };
    }

    if (sql.includes('FROM opportunity_rank_logs') && sql.includes('WHERE scan_id = ?')) {
      return {
        get: (scanId: string) => rows.find((row) => row.scan_id === scanId),
      };
    }

    if (sql.includes('FROM opportunity_rank_logs') && sql.includes('ORDER BY created_at DESC, id DESC')) {
      return {
        all: (limit: number) => [...rows].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, limit),
        get: (params: Record<string, unknown>) => {
          const requireNotExpired = sql.includes('expires_at IS NULL') || sql.includes('expires_at >');
          const cutoff = params.cutoff as string | null | undefined;
          const filtered = [...rows]
            .filter((row) => {
              if (params.fingerprint && row.fingerprint !== params.fingerprint) return false;
              if (params.source && row.source !== params.source) return false;
              if (cutoff && String(row.created_at) < cutoff) return false;
              if (requireNotExpired) {
                const expires = row.expires_at as string | null;
                if (expires && expires <= sqliteNow()) return false;
              }
              return true;
            })
            .sort((a, b) => Number(b.id) - Number(a.id));
          return filtered[0];
        },
      };
    }

    if (sql.includes("PRAGMA table_info('opportunity_rank_logs')")) {
      return {
        all: () => [],
      };
    }

    return { run: () => undefined, get: () => undefined, all: () => [] };
  },
};

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => fakeDb,
}));

import {
  findLatestOpportunityRankScan,
  getOpportunityRankScan,
  listRecentOpportunityRankScans,
  recordOpportunityRankScan,
} from '../../src/memory/opportunity_rank_logs.js';

beforeEach(() => {
  rows = [];
  vi.clearAllMocks();
});

describe('opportunity_rank_logs', () => {
  it('records a scan artifact with summary fields and ranked opportunities', () => {
    const stored = recordOpportunityRankScan({
      scanId: 'scan-1',
      fingerprint: 'fingerprint-1',
      generatedAt: '2026-05-19T10:00:00.000Z',
      expiresAt: '2026-05-19T12:00:00.000Z',
      context: { mode: 'FULL_AGENT', provider: 'openai', model: 'gpt-5' },
      summary: { marketsScanned: 12, newsItemsAnalyzed: 4 },
      opportunities: [
        {
          marketId: 'm-btc',
          rank: 1,
          score: 0.44,
          edge: 0.11,
          direction: 'LONG_YES',
          confidence: 'high',
          marketPrice: 0.48,
          myEstimate: 0.59,
          suggestedAmount: 25,
          reasoning: 'Momentum and catalyst alignment',
          relevantNews: ['ETF flows'],
        },
      ],
      notes: { trigger: 'daily_report' },
    });

    expect(stored.scanId).toBe('scan-1');
    expect(stored.generatedAt).toBe('2026-05-19 10:00:00');
    expect(stored.expiresAt).toBe('2026-05-19 12:00:00');
    expect(stored.opportunitiesFound).toBe(1);
    expect(stored.topMarketId).toBe('m-btc');
    expect(stored.topRank).toBe(1);
    expect(stored.topScore).toBe(0.44);
    expect(stored.artifact?.summary.topOpportunity?.marketId).toBe('m-btc');
    expect(stored.notes).toEqual({ trigger: 'daily_report' });
  });

  it('fetches a stored scan and the latest reusable scan', () => {
    recordOpportunityRankScan({
      scanId: 'scan-old',
      source: 'opportunities',
      fingerprint: 'fp-reuse',
      expiresAt: '2099-05-19T12:00:00.000Z',
      summary: { marketsScanned: 5, newsItemsAnalyzed: 2 },
      opportunities: [],
    });
    recordOpportunityRankScan({
      scanId: 'scan-new',
      source: 'opportunities',
      fingerprint: 'fp-reuse',
      expiresAt: '2099-05-19T12:30:00.000Z',
      summary: { marketsScanned: 8, newsItemsAnalyzed: 3 },
      opportunities: [
        {
          marketId: 'm-sol',
          rank: 1,
          score: 0.27,
          edge: 0.09,
          direction: 'SHORT_YES',
          confidence: 'medium',
          marketPrice: 0.63,
          myEstimate: 0.54,
        },
      ],
    });

    const byId = getOpportunityRankScan('scan-new');
    const latest = findLatestOpportunityRankScan({ fingerprint: 'fp-reuse', source: 'opportunities' });
    const recent = listRecentOpportunityRankScans(2);

    expect(byId?.scanId).toBe('scan-new');
    expect(latest?.scanId).toBe('scan-new');
    expect(recent.map((entry) => entry.scanId)).toEqual(['scan-new', 'scan-old']);
  });
});
