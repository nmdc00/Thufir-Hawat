import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PreparedStatement = {
  all: () => Array<{ name: string }>;
  run: (params: Record<string, unknown>) => void;
};

type FakeDatabase = {
  columns: Set<string>;
  execStatements: string[];
  insertedRows: Array<Record<string, unknown>>;
  exec: (sql: string) => void;
  prepare: (sql: string) => PreparedStatement;
};

function createLegacyColumns(): Set<string> {
  return new Set([
    'id',
    'created_at',
    'symbol',
    'side',
    'notional_usd',
    'verdict',
    'reasoning',
    'adjusted_size_usd',
    'used_fallback',
    'signal_class',
    'regime',
    'session',
    'edge',
  ]);
}

const fakeDb = vi.hoisted(() => {
  const state: FakeDatabase = {
    columns: createLegacyColumns(),
    execStatements: [],
    insertedRows: [],
    exec(sql: string): void {
      state.execStatements.push(sql);
      const alterMatch = sql.match(/ALTER TABLE llm_entry_gate_log ADD COLUMN ([a-z_]+)/i);
      if (alterMatch) {
        state.columns.add(alterMatch[1]);
      }
      if (/CREATE TABLE IF NOT EXISTS llm_entry_gate_log/i.test(sql)) {
        const expectedColumns = [
          'reason_code',
          'stop_level_price',
          'equity_at_risk_pct',
          'target_rr',
          'suggested_leverage',
          'mechanical_leverage_ceiling',
          'stop_distance_pct',
          'liquidity_score',
          'execution_score',
          'liquidity_bucket',
          'llm_consulted',
        ];
        for (const column of expectedColumns) {
          state.columns.add(column);
        }
      }
    },
    prepare(sql: string): PreparedStatement {
      if (/PRAGMA table_info\('llm_entry_gate_log'\)/i.test(sql)) {
        return {
          all: () => Array.from(state.columns).map((name) => ({ name })),
          run: () => {},
        };
      }

      if (/INSERT INTO llm_entry_gate_log/i.test(sql)) {
        return {
          all: () => [],
          run: (params) => {
            state.insertedRows.push(params);
          },
        };
      }

      throw new Error(`Unexpected SQL in fake db: ${sql}`);
    },
  };

  return state;
});
const openDatabaseMock = vi.hoisted(() => vi.fn(() => fakeDb));

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: openDatabaseMock,
}));

describe('recordEntryGateDecision schema migration', () => {
  beforeEach(() => {
    fakeDb.columns = createLegacyColumns();
    fakeDb.execStatements = [];
    fakeDb.insertedRows = [];
    openDatabaseMock.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('adds missing risk and observability columns before insert', async () => {
    const { recordEntryGateDecision } = await import('../../src/memory/llm_entry_gate_log.js');

    recordEntryGateDecision({
      symbol: 'BTC',
      side: 'long',
      notionalUsd: 100,
      verdict: 'approve',
      reasoning: 'ok',
      reasonCode: 'approve',
      usedFallback: false,
      stopLevelPrice: 95,
      equityAtRiskPct: 0.5,
      targetRR: 2,
    });

    expect(openDatabaseMock).toHaveBeenCalled();
    expect(fakeDb.columns.has('reason_code')).toBe(true);
    expect(fakeDb.columns.has('stop_level_price')).toBe(true);
    expect(fakeDb.columns.has('equity_at_risk_pct')).toBe(true);
    expect(fakeDb.columns.has('target_rr')).toBe(true);
    expect(fakeDb.columns.has('suggested_leverage')).toBe(true);
    expect(fakeDb.columns.has('mechanical_leverage_ceiling')).toBe(true);
    expect(fakeDb.columns.has('stop_distance_pct')).toBe(true);
    expect(fakeDb.columns.has('liquidity_score')).toBe(true);
    expect(fakeDb.columns.has('execution_score')).toBe(true);
    expect(fakeDb.columns.has('liquidity_bucket')).toBe(true);
    expect(fakeDb.columns.has('llm_consulted')).toBe(true);

    expect(fakeDb.insertedRows).toHaveLength(1);
    expect(fakeDb.insertedRows[0]).toMatchObject({
      symbol: 'BTC',
      side: 'long',
      notionalUsd: 100,
      verdict: 'approve',
      reasoning: 'ok',
      reasonCode: 'approve',
      usedFallback: 0,
      stopLevelPrice: 95,
      equityAtRiskPct: 0.5,
      targetRR: 2,
      suggestedLeverage: null,
      mechanicalLeverageCeiling: null,
      stopDistancePct: null,
      liquidityScore: null,
      executionScore: null,
      liquidityBucket: null,
      llmConsulted: 1,
    });
  });

  it('persists optional observability fields when provided', async () => {
    const { recordEntryGateDecision } = await import('../../src/memory/llm_entry_gate_log.js');

    recordEntryGateDecision({
      symbol: 'SOL',
      side: 'long',
      notionalUsd: 120,
      verdict: 'approve',
      reasoning: 'context-rich',
      reasonCode: 'approve',
      usedFallback: false,
      mechanicalLeverageCeiling: 12,
      stopDistancePct: 0.041,
      liquidityScore: 0.82,
      executionScore: 0.91,
      liquidityBucket: 'deep',
      llmConsulted: false,
    });

    expect(fakeDb.insertedRows).toHaveLength(1);
    expect(fakeDb.insertedRows[0]).toMatchObject({
      symbol: 'SOL',
      side: 'long',
      notionalUsd: 120,
      verdict: 'approve',
      reasoning: 'context-rich',
      reasonCode: 'approve',
      usedFallback: 0,
      mechanicalLeverageCeiling: 12,
      stopDistancePct: 0.041,
      liquidityScore: 0.82,
      executionScore: 0.91,
      liquidityBucket: 'deep',
      llmConsulted: 0,
    });
  });

  it('declares the new observability columns in schema.sql', () => {
    const schemaPath = join(process.cwd(), 'src/memory/schema.sql');
    const schemaSql = readFileSync(schemaPath, 'utf-8');

    expect(schemaSql).toContain('mechanical_leverage_ceiling REAL');
    expect(schemaSql).toContain('stop_distance_pct REAL');
    expect(schemaSql).toContain('liquidity_score   REAL');
    expect(schemaSql).toContain('execution_score   REAL');
    expect(schemaSql).toContain('liquidity_bucket  TEXT');
    expect(schemaSql).toContain('llm_consulted     INTEGER NOT NULL DEFAULT 1');
  });

  it('can mark deterministic gate decisions as not LLM-consulted', async () => {
    const { recordEntryGateDecision } = await import('../../src/memory/llm_entry_gate_log.js');

    recordEntryGateDecision({
      symbol: 'CL',
      side: 'sell',
      notionalUsd: 50,
      verdict: 'reject',
      reasoning: 'exposure',
      reasonCode: 'exposure_duplicate_underlying',
      usedFallback: false,
      llmConsulted: false,
    });

    expect(fakeDb.insertedRows).toHaveLength(1);
    expect(fakeDb.insertedRows[0]).toMatchObject({
      symbol: 'CL',
      side: 'sell',
      verdict: 'reject',
      reasonCode: 'exposure_duplicate_underlying',
      usedFallback: 0,
      llmConsulted: 0,
    });
  });
});
