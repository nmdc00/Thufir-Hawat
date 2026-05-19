import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

const previousDbPath = process.env.THUFIR_DB_PATH;

function createLegacyDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-opportunity-flow-'));
  const dbPath = join(dir, 'thufir.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE opportunity_rank_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      scan_id TEXT,
      artifact TEXT
    )
  `);
  db.close();
  return dbPath;
}

afterEach(() => {
  vi.resetModules();
  const dbPath = process.env.THUFIR_DB_PATH;
  if (dbPath) {
    rmSync(dbPath, { force: true });
    rmSync(dirname(dbPath), { recursive: true, force: true });
  }
  if (previousDbPath === undefined) {
    delete process.env.THUFIR_DB_PATH;
  } else {
    process.env.THUFIR_DB_PATH = previousDbPath;
  }
});

describe('opportunity ranking observability flow', () => {
  it('migrates legacy opportunity_rank_logs tables and persists a full ranked scan artifact', async () => {
    const dbPath = createLegacyDb();
    process.env.THUFIR_DB_PATH = dbPath;

    const {
      getOpportunityRankScan,
      listRecentOpportunityRankScans,
      recordOpportunityRankScan,
    } = await import('../../src/memory/opportunity_rank_logs.js');

    const stored = recordOpportunityRankScan({
      scanId: 'scan_observability_001',
      source: 'opportunities',
      fingerprint: 'fp-opportunity-001',
      generatedAt: '2026-05-19T10:00:00.000Z',
      expiresAt: '2026-05-19T12:00:00.000Z',
      context: {
        mode: 'FULL_AGENT',
        provider: 'openai',
        model: 'gpt-5',
      },
      summary: {
        marketsScanned: 14,
        newsItemsAnalyzed: 6,
      },
      opportunities: [
        {
          marketId: 'm-eth',
          rank: 1,
          score: 0.36,
          edge: 0.12,
          direction: 'LONG_YES',
          confidence: 'high',
          marketPrice: 0.41,
          myEstimate: 0.53,
          suggestedAmount: 30,
          reasoning: 'Catalyst and momentum support repricing',
          relevantNews: ['Pectra deployment'],
        },
        {
          marketId: 'm-sol',
          rank: 2,
          score: 0.22,
          edge: 0.08,
          direction: 'SHORT_YES',
          confidence: 'medium',
          marketPrice: 0.67,
          myEstimate: 0.59,
          suggestedAmount: 15,
          reasoning: 'Stretch versus recent information set',
          relevantNews: ['Funding still rich'],
        },
      ],
      payload: {
        analyses: [
          { marketId: 'm-eth', myEstimate: 0.53, confidence: 'high' },
          { marketId: 'm-sol', myEstimate: 0.59, confidence: 'medium' },
        ],
      },
      notes: {
        trigger: 'daily_report',
        redesignVersion: 'v2.3.6',
      },
    });

    const fetched = getOpportunityRankScan('scan_observability_001');
    const recent = listRecentOpportunityRankScans(1);

    expect(stored.scanId).toBe('scan_observability_001');
    expect(fetched?.artifact?.summary.opportunitiesFound).toBe(2);
    expect(fetched?.artifact?.summary.topOpportunity?.marketId).toBe('m-eth');
    expect(fetched?.artifact?.opportunities.map((item) => item.marketId)).toEqual(['m-eth', 'm-sol']);
    expect(recent[0]?.scanId).toBe('scan_observability_001');
    expect(fetched?.notes).toEqual({
      trigger: 'daily_report',
      redesignVersion: 'v2.3.6',
    });

    const db = new Database(dbPath, { readonly: true });
    const columns = db.prepare("PRAGMA table_info('opportunity_rank_logs')").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    expect(columnNames.has('fingerprint')).toBe(true);
    expect(columnNames.has('markets_scanned')).toBe(true);
    expect(columnNames.has('news_items_analyzed')).toBe(true);
    expect(columnNames.has('opportunities_found')).toBe(true);
    expect(columnNames.has('top_market_id')).toBe(true);
    expect(columnNames.has('top_rank')).toBe(true);
    expect(columnNames.has('top_score')).toBe(true);
    expect(columnNames.has('notes')).toBe(true);

    const row = db
      .prepare(
        `SELECT
           source,
           fingerprint,
           generated_at,
           expires_at,
           mode,
           provider,
           model,
           markets_scanned,
           news_items_analyzed,
           opportunities_found,
           top_market_id,
           top_rank,
           top_score
         FROM opportunity_rank_logs
         WHERE scan_id = ?`
      )
      .get('scan_observability_001') as {
        source: string;
        fingerprint: string;
        generated_at: string;
        expires_at: string;
        mode: string;
        provider: string;
        model: string;
        markets_scanned: number;
        news_items_analyzed: number;
        opportunities_found: number;
        top_market_id: string;
        top_rank: number;
        top_score: number;
      };

    expect(row).toEqual({
      source: 'opportunities',
      fingerprint: 'fp-opportunity-001',
      generated_at: '2026-05-19 10:00:00',
      expires_at: '2026-05-19 12:00:00',
      mode: 'FULL_AGENT',
      provider: 'openai',
      model: 'gpt-5',
      markets_scanned: 14,
      news_items_analyzed: 6,
      opportunities_found: 2,
      top_market_id: 'm-eth',
      top_rank: 1,
      top_score: 0.36,
    });

    db.close();
  });
});
