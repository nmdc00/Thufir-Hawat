import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: Array<Record<string, unknown>> = [];

function sqliteNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const fakeDb = {
  exec: vi.fn(),
  prepare: (sql: string) => {
    if (sql.includes('INSERT INTO decision_artifacts')) {
      return {
        run: (params: Record<string, unknown>) => {
          const now = sqliteNow();
          rows.push({
            id: rows.length + 1,
            created_at: now,
            updated_at: null,
            source: params.source ?? null,
            kind: params.kind,
            market_id: params.marketId ?? null,
            fingerprint: params.fingerprint ?? null,
            outcome: params.outcome ?? null,
            confidence: params.confidence ?? null,
            expires_at: params.expiresAt ?? null,
            payload: params.payload ?? null,
            notes: params.notes ?? null,
          });
        },
      };
    }

    if (sql.includes('FROM decision_artifacts') && sql.includes('WHERE kind')) {
      return {
        get: (params: Record<string, unknown>) => {
          const requireNotExpired = sql.includes('expires_at IS NULL') || sql.includes('expires_at >');
          const cutoff = params.cutoff as string | null | undefined;
          const filtered = rows.filter((row) => {
            if (row.kind !== params.kind) return false;
            if (params.marketId && row.market_id !== params.marketId) return false;
            if (params.fingerprint && row.fingerprint !== params.fingerprint) return false;
            if (cutoff && String(row.created_at) < cutoff) return false;
            if (requireNotExpired) {
              const expires = row.expires_at as string | null;
              if (expires && expires <= sqliteNow()) return false;
            }
            return true;
          });
          return filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
        },
      };
    }

    if (sql.includes('FROM decision_artifacts') && sql.includes('WHERE market_id')) {
      return {
        all: (marketId: string, limit: number) => {
          return rows.filter((row) => row.market_id === marketId).slice(0, limit);
        },
      };
    }

    return { run: () => undefined, get: () => undefined, all: () => [] };
  },
};

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => fakeDb,
}));

import {
  storeDecisionArtifact,
  findReusableArtifact,
  listDecisionArtifactsByMarket,
} from '../../src/memory/decision_artifacts.js';

beforeEach(() => {
  rows = [];
});

describe('decision_artifacts', () => {
  it('stores and retrieves a reusable artifact', () => {
    storeDecisionArtifact({
      kind: 'opportunity_scan',
      fingerprint: 'abc',
      payload: { analyses: [] },
    });

    const artifact = findReusableArtifact({
      kind: 'opportunity_scan',
      fingerprint: 'abc',
      maxAgeMs: 60_000,
    });

    expect(artifact).not.toBeNull();
    expect(artifact?.kind).toBe('opportunity_scan');
    expect(artifact?.payload).toEqual({ analyses: [] });
  });

  it('normalizes expiresAt to sqlite datetime', () => {
    storeDecisionArtifact({
      kind: 'trade_decision',
      fingerprint: 'xyz',
      expiresAt: '2026-02-05T10:00:00.000Z',
    });

    const row = rows[0];
    expect(row?.expires_at).toBe('2026-02-05 10:00:00');
  });

  it('lists artifacts by market', () => {
    storeDecisionArtifact({
      kind: 'trade_decision',
      marketId: '123',
      fingerprint: 'a',
    });
    storeDecisionArtifact({
      kind: 'trade_decision',
      marketId: '456',
      fingerprint: 'b',
    });

    const list = listDecisionArtifactsByMarket('123', 10);
    expect(list.length).toBe(1);
    expect(list[0]?.marketId).toBe('123');
  });
});
