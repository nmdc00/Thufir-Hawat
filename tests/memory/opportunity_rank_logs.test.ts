import { beforeEach, describe, expect, it, vi } from 'vitest';

let rows: Array<Record<string, unknown>> = [];

function sqliteNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const fakeDb = {
  exec: vi.fn(),
  transaction: (fn: () => void) => fn,
  prepare: (sql: string) => {
    if (sql.includes('INSERT INTO opportunity_rank_logs')) {
      return {
        run: (params: Record<string, unknown>) => {
          rows.push({
            id: rows.length + 1,
            created_at: sqliteNow(),
            scan_id: params.scanId,
            source: params.source ?? null,
            fingerprint: params.fingerprint ?? null,
            generated_at: params.generatedAt ?? null,
            trigger_reason: params.triggerReason ?? null,
            symbol: params.symbol ?? null,
            symbol_class: params.symbolClass ?? null,
            rank: params.rank ?? null,
            opportunity_score: params.opportunityScore ?? null,
            component_scores: params.componentScores ?? null,
            trigger_reasons: params.triggerReasons ?? null,
            failed_floors: params.failedFloors ?? null,
            selected_for_shortlist: params.selectedForShortlist ?? 0,
            total_candidates: params.totalCandidates ?? 0,
            eligible_candidates: params.eligibleCandidates ?? 0,
            selected_symbol: params.selectedSymbol ?? null,
            selection_reason: params.selectionReason ?? null,
            artifact: params.artifact ?? null,
            payload: params.payload ?? null,
            notes: params.notes ?? null,
          });
        },
      };
    }

    if (sql.includes('FROM opportunity_rank_logs') && sql.includes('WHERE scan_id = ?')) {
      return {
        all: (scanId: string) =>
          rows
            .filter((row) => row.scan_id === scanId)
            .sort((left, right) => Number(left.rank ?? 0) - Number(right.rank ?? 0)),
      };
    }

    if (sql.includes('GROUP BY scan_id') && sql.includes('ORDER BY MAX(id) DESC')) {
      return {
        all: (limit: number) => {
          const ordered = [...rows].sort((left, right) => Number(right.id) - Number(left.id));
          const seen = new Set<string>();
          const grouped: Array<{ scan_id: string }> = [];
          for (const row of ordered) {
            const scanId = String(row.scan_id ?? '');
            if (!scanId || seen.has(scanId)) continue;
            seen.add(scanId);
            grouped.push({ scan_id: scanId });
            if (grouped.length >= limit) break;
          }
          return grouped;
        },
        get: (params: Record<string, unknown>) => {
          const cutoff = params.cutoff as string | null | undefined;
          const filtered = [...rows]
            .filter((row) => {
              if (params.fingerprint && row.fingerprint !== params.fingerprint) return false;
              if (params.source && row.source !== params.source) return false;
              if (cutoff && String(row.created_at) < cutoff) return false;
              return true;
            })
            .sort((left, right) => Number(right.id) - Number(left.id));
          const first = filtered[0];
          return first ? { scan_id: first.scan_id } : undefined;
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
  it('records per-candidate rank rows and returns an aggregated scan record', () => {
    const stored = recordOpportunityRankScan({
      scanId: 'scan-1',
      source: 'autonomous_originator_scan',
      fingerprint: 'fingerprint-1',
      generatedAt: '2026-05-19T10:00:00.000Z',
      triggerReason: 'ta_alert',
      totalCandidates: 3,
      eligibleCandidates: 2,
      selectedSymbol: 'BTC',
      selectionReason: 'executed',
      rankedCandidates: [
        {
          scanId: 'scan-1',
          symbol: 'BTC',
          symbolClass: 'crypto',
          rank: 1,
          opportunityScore: 0.77,
          componentScores: {
            attentionScore: 0.7,
            structuralEdgeScore: 0.82,
            crowdingQualityScore: 0.71,
            regimeFitScore: 0.74,
            executionQualityScore: 0.83,
          },
          triggerReasons: ['oi_spike_1h'],
          failedFloors: [],
          selectedForShortlist: true,
          createdAt: '2026-05-19T10:00:00.000Z',
        },
        {
          scanId: 'scan-1',
          symbol: 'XYZ:SPY',
          symbolClass: 'xyz',
          rank: 2,
          opportunityScore: 0.58,
          componentScores: {
            attentionScore: 0.52,
            structuralEdgeScore: 0.61,
            crowdingQualityScore: 0.63,
            regimeFitScore: 0.55,
            executionQualityScore: 0.6,
          },
          triggerReasons: ['cadence_inclusion'],
          failedFloors: [],
          selectedForShortlist: true,
          createdAt: '2026-05-19T10:00:00.000Z',
        },
      ],
      notes: { redesignVersion: 'v2.3.6' },
    });

    expect(stored.scanId).toBe('scan-1');
    expect(stored.generatedAt).toBe('2026-05-19 10:00:00');
    expect(stored.totalCandidates).toBe(3);
    expect(stored.eligibleCandidates).toBe(2);
    expect(stored.selectedSymbol).toBe('BTC');
    expect(stored.candidates.map((candidate) => candidate.symbol)).toEqual(['BTC', 'XYZ:SPY']);
    expect(stored.candidates[0]?.componentScores.structuralEdgeScore).toBe(0.82);
    expect(stored.notes).toEqual({ redesignVersion: 'v2.3.6' });
  });

  it('fetches the stored scan and finds the latest reusable scan by fingerprint/source', () => {
    recordOpportunityRankScan({
      scanId: 'scan-old',
      source: 'autonomous_originator_scan',
      fingerprint: 'fp-reuse',
      totalCandidates: 1,
      eligibleCandidates: 1,
      rankedCandidates: [
        {
          scanId: 'scan-old',
          symbol: 'ETH',
          symbolClass: 'crypto',
          rank: 1,
          opportunityScore: 0.6,
          componentScores: {
            attentionScore: 0.6,
            structuralEdgeScore: 0.6,
            crowdingQualityScore: 0.6,
            regimeFitScore: 0.6,
            executionQualityScore: 0.6,
          },
          triggerReasons: ['cadence_inclusion'],
          failedFloors: [],
          selectedForShortlist: true,
          createdAt: '2026-05-19T09:00:00.000Z',
        },
      ],
    });
    recordOpportunityRankScan({
      scanId: 'scan-new',
      source: 'autonomous_originator_scan',
      fingerprint: 'fp-reuse',
      totalCandidates: 2,
      eligibleCandidates: 1,
      rankedCandidates: [
        {
          scanId: 'scan-new',
          symbol: 'BTC',
          symbolClass: 'crypto',
          rank: 1,
          opportunityScore: 0.8,
          componentScores: {
            attentionScore: 0.75,
            structuralEdgeScore: 0.82,
            crowdingQualityScore: 0.76,
            regimeFitScore: 0.72,
            executionQualityScore: 0.8,
          },
          triggerReasons: ['oi_spike_1h'],
          failedFloors: [],
          selectedForShortlist: true,
          createdAt: '2026-05-19T10:00:00.000Z',
        },
      ],
    });

    const byId = getOpportunityRankScan('scan-new');
    const latest = findLatestOpportunityRankScan({
      fingerprint: 'fp-reuse',
      source: 'autonomous_originator_scan',
    });
    const recent = listRecentOpportunityRankScans(2);

    expect(byId?.scanId).toBe('scan-new');
    expect(latest?.scanId).toBe('scan-new');
    expect(recent.map((entry) => entry.scanId)).toEqual(['scan-new', 'scan-old']);
  });
});
