import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows = new Map<string, Record<string, unknown>>();

const fakeDb = {
  exec: vi.fn(),
  prepare: (sql: string) => {
    if (sql.includes('SELECT source')) {
      return {
        get: (source: string) => rows.get(source),
      };
    }
    if (sql.includes('INSERT INTO execution_state')) {
      return {
        run: (params: Record<string, unknown>) => {
          rows.set(String(params.source), {
            source: params.source,
            fingerprint: params.fingerprint,
            updated_at: '2026-02-04 00:00:00',
            last_mode: params.lastMode ?? null,
            last_reason: params.lastReason ?? null,
          });
        },
      };
    }
    return { run: () => undefined, get: () => undefined };
  },
};

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => fakeDb,
}));

import { getExecutionState, upsertExecutionState } from '../../src/memory/execution_state.js';

beforeEach(() => {
  rows = new Map();
});

describe('execution_state', () => {
  it('upserts and reads execution state', () => {
    upsertExecutionState({
      source: 'opportunities',
      fingerprint: 'abc',
      lastMode: 'FULL_AGENT',
      lastReason: 'opportunity_scan',
    });

    const state = getExecutionState('opportunities');
    expect(state).not.toBeNull();
    expect(state?.fingerprint).toBe('abc');
    expect(state?.lastMode).toBe('FULL_AGENT');
  });
});
