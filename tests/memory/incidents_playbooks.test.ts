import { describe, it, expect, vi, beforeEach } from 'vitest';

let incidentRows: Array<Record<string, unknown>> = [];
let playbookRows: Record<string, Record<string, unknown>> = {};

function sqliteNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const fakeDb = {
  exec: vi.fn(),
  prepare: (sql: string) => {
    if (sql.includes('INSERT INTO agent_incidents')) {
      return {
        run: (params: Record<string, unknown>) => {
          const now = sqliteNow();
          const id = incidentRows.length + 1;
          incidentRows.push({
            id,
            created_at: now,
            goal: params.goal ?? null,
            mode: params.mode ?? null,
            tool_name: params.toolName ?? null,
            error: params.error ?? null,
            blocker_kind: params.blockerKind ?? 'unknown',
            details_json: params.detailsJson ?? null,
            resolved_at: null,
          });
          return { lastInsertRowid: id };
        },
      };
    }

    if (sql.includes('FROM agent_incidents') && sql.includes('ORDER BY created_at')) {
      return {
        all: (limit: number) =>
          incidentRows
            .slice()
            .reverse()
            .slice(0, limit)
            .map((row) => ({
              id: row.id,
              createdAt: row.created_at,
              goal: row.goal,
              mode: row.mode,
              toolName: row.tool_name,
              error: row.error,
              blockerKind: row.blocker_kind,
              detailsJson: row.details_json,
              resolvedAt: row.resolved_at,
            })),
      };
    }

    if (sql.includes('INSERT INTO agent_playbooks') && sql.includes('ON CONFLICT')) {
      return {
        run: (params: Record<string, unknown>) => {
          const now = sqliteNow();
          playbookRows[String(params.key)] = {
            key: params.key,
            title: params.title,
            content: params.content,
            tags_json: params.tagsJson ?? '[]',
            created_at: playbookRows[String(params.key)]?.created_at ?? now,
            updated_at: now,
          };
        },
      };
    }

    if (sql.includes('FROM agent_playbooks') && sql.includes('WHERE key')) {
      return {
        get: (key: string) => playbookRows[key],
      };
    }

    if (sql.includes('FROM agent_playbooks') && sql.includes('WHERE title LIKE')) {
      return {
        all: (params: { like: string; limit: number }) => {
          const needle = String(params.like).replace(/%/g, '').toLowerCase();
          const all = Object.values(playbookRows).filter((row) => {
            return (
              String(row.title ?? '').toLowerCase().includes(needle) ||
              String(row.content ?? '').toLowerCase().includes(needle)
            );
          });
          return all.slice(0, params.limit);
        },
      };
    }

    return { run: () => ({ lastInsertRowid: 0 }), get: () => undefined, all: () => [] };
  },
};

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => fakeDb,
}));

import { recordAgentIncident, listRecentAgentIncidents } from '../../src/memory/incidents.js';
import { upsertPlaybook, getPlaybook, searchPlaybooks } from '../../src/memory/playbooks.js';

beforeEach(() => {
  incidentRows = [];
  playbookRows = {};
});

describe('incidents + playbooks', () => {
  it('records and lists incidents', () => {
    const id = recordAgentIncident({
      goal: 'place a trade',
      mode: 'trade',
      toolName: 'perp_place_order',
      error: 'insufficient collateral',
      blockerKind: 'hyperliquid_insufficient_collateral',
      details: { symbol: 'BTC' },
    });
    expect(id).toBe(1);

    const list = listRecentAgentIncidents(10);
    expect(list.length).toBe(1);
    expect(list[0]?.toolName).toBe('perp_place_order');
    expect(list[0]?.blockerKind).toBe('hyperliquid_insufficient_collateral');
  });

  it('upserts, gets, and searches playbooks', () => {
    upsertPlaybook({
      key: 'hyperliquid/funding',
      title: 'Funding Hyperliquid',
      content: 'Deposit USDC then verify clearinghouse state.',
      tags: ['hyperliquid', 'funding'],
    });

    const pb = getPlaybook('hyperliquid/funding');
    expect(pb).not.toBeNull();
    expect(pb?.title).toBe('Funding Hyperliquid');

    const results = searchPlaybooks({ query: 'deposit', limit: 5 });
    expect(results.length).toBe(1);
    expect(results[0]?.key).toBe('hyperliquid/funding');
  });
});
