import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { evaluateExposure, type PortfolioExposureConfig } from '../../src/core/portfolio_exposure.js';
import { runOriginatorScorecardJob } from '../../src/core/originator_scorecard_job.js';
import type { BookEntry } from '../../src/core/position_book.js';
import { closeDatabase, openDatabase } from '../../src/memory/db.js';
import { recordEntryGateDecision } from '../../src/memory/llm_entry_gate_log.js';
import { recordTradeProposal } from '../../src/memory/llm_trade_proposals.js';

const previousDbPath = process.env.THUFIR_DB_PATH;
let dbPath = '';

function columns(tableName: string): Record<string, { notnull: number; dflt_value: string | null; pk: number }> {
  const rows = openDatabase()
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all() as Array<{ name: string; notnull: number; dflt_value: string | null; pk: number }>;
  return Object.fromEntries(rows.map((row) => [row.name, row]));
}

function entry(symbol: string, side: 'long' | 'short', notionalUsd: number): BookEntry {
  return {
    symbol,
    side,
    size: notionalUsd,
    entryPrice: 1,
    currentMarkPrice: 1,
    unrealizedPnlUsd: null,
    entryReasoningText: '',
    thesisExpiresAtMs: 0,
    exitContract: null,
    exitContractSummary: null,
    lastConsultAtMs: null,
    lastConsultDecision: null,
    entryAtMs: null,
  };
}

function setCreatedAt(table: string, id: number | string, createdAt: string): void {
  openDatabase().prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(createdAt, id);
}

function insertTrade(id: number, createdAt: string): void {
  openDatabase()
    .prepare(
      `
        INSERT INTO perp_trades (id, symbol, side, size, execution_mode, price, status, created_at)
        VALUES (?, 'BTC', 'buy', 1, 'paper', 100, 'executed', ?)
      `
    )
    .run(id, createdAt);
}

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'thufir-v25-contract-')), 'thufir.sqlite');
  process.env.THUFIR_DB_PATH = dbPath;
  openDatabase(dbPath);
});

afterEach(() => {
  closeDatabase(dbPath);
  rmSync(dbPath, { force: true });
  rmSync(dirname(dbPath), { recursive: true, force: true });
  if (previousDbPath === undefined) {
    delete process.env.THUFIR_DB_PATH;
  } else {
    process.env.THUFIR_DB_PATH = previousDbPath;
  }
});

describe('v2.5 release contract coverage', () => {
  it('declares the integrated v2.5 persistence surfaces in the bootstrapped schema', () => {
    const gateLog = columns('llm_entry_gate_log');
    expect(gateLog.llm_consulted).toMatchObject({ notnull: 1, dflt_value: '1' });
    expect(gateLog.reason_code).toBeDefined();

    const cooldowns = columns('gate_verdict_cooldowns');
    expect(cooldowns.symbol.pk).toBeGreaterThan(0);
    expect(cooldowns.side.pk).toBeGreaterThan(0);
    expect(cooldowns.last_reject_at.notnull).toBe(1);
    expect(cooldowns.last_edge.notnull).toBe(1);

    const scorecard = columns('originator_scorecard');
    expect(scorecard.scorecard_date.pk).toBeGreaterThan(0);
    expect(scorecard.window_days.pk).toBeGreaterThan(0);
    expect(scorecard.clean_data_cutoff.notnull).toBe(1);
    expect(scorecard.linkage_gap_count).toMatchObject({ notnull: 1, dflt_value: '0' });
  });

  it('persists exposure-guard deterministic rejects with llm_consulted=0 in SQLite', () => {
    const cfg: PortfolioExposureConfig = {
      enabled: true,
      maxGrossLeverage: 3,
      maxNetLeverage: 2,
      maxClusterPercent: 75,
      clusters: {
        'crypto-majors': ['BTC', 'ETH', 'SOL'],
        energy: { oil: ['XYZ:CL', 'XYZ:BRENTOIL'] },
      },
    };
    const book = [
      entry('XYZ:CL', 'short', 300),
      ...Array.from({ length: 9 }, (_, index) => entry(`SHORT${index}`, 'short', 50)),
      entry('BTC', 'long', 60),
      entry('ETH', 'long', 40),
    ];

    const verdict = evaluateExposure(
      book,
      { symbol: 'XYZ:BRENTOIL', side: 'sell', notionalUsd: 50 },
      283,
      cfg
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('exposure_duplicate_underlying');

    recordEntryGateDecision({
      symbol: 'XYZ:BRENTOIL',
      side: 'sell',
      notionalUsd: 50,
      verdict: 'reject',
      reasoning: JSON.stringify(verdict.detail),
      reasonCode: verdict.reason,
      usedFallback: false,
      llmConsulted: false,
    });

    const row = openDatabase()
      .prepare(
        `
          SELECT symbol, verdict, reason_code AS reasonCode, llm_consulted AS llmConsulted, reasoning
          FROM llm_entry_gate_log
          ORDER BY id DESC
          LIMIT 1
        `
      )
      .get() as {
      symbol: string;
      verdict: string;
      reasonCode: string;
      llmConsulted: number;
      reasoning: string;
    };

    expect(row).toMatchObject({
      symbol: 'XYZ:BRENTOIL',
      verdict: 'reject',
      reasonCode: 'exposure_duplicate_underlying',
      llmConsulted: 0,
    });
    expect(JSON.parse(row.reasoning)).toMatchObject({
      duplicateUnderlying: {
        symbol: 'XYZ:CL',
        cluster: 'energy',
        underlying: 'OIL',
      },
    });
  });

  it('records originator linkage gaps without crediting unlinked executions as originated', () => {
    const createdAt = '2026-06-19T12:00:00.000Z';
    insertTrade(101, createdAt);
    insertTrade(102, createdAt);

    const linkedProposalId = recordTradeProposal({
      triggerReason: 'cadence',
      proposed: true,
      executed: true,
      tradeId: '101',
    });
    setCreatedAt('llm_trade_proposals', linkedProposalId, createdAt);
    const gapProposalId = recordTradeProposal({
      triggerReason: 'cadence',
      proposed: true,
      executed: true,
    });
    setCreatedAt('llm_trade_proposals', gapProposalId, createdAt);
    const nullProposalId = recordTradeProposal({ triggerReason: 'cadence', proposed: false });
    setCreatedAt('llm_trade_proposals', nullProposalId, createdAt);

    const result = runOriginatorScorecardJob({
      now: new Date('2026-06-20T00:00:00.000Z'),
      config: { cleanDataCutoff: '2026-06-13T00:00:00.000Z' },
    });
    const seven = result.rows.find((row) => row.windowDays === 7);

    expect(seven).toMatchObject({
      scanCycles: 3,
      executedTrades: 2,
      originatedTrades: 1,
      quantTrades: 1,
      linkageGapCount: 1,
    });
    expect(seven?.originatedShare).toBeCloseTo(0.5);

    const persisted = openDatabase()
      .prepare(
        `
          SELECT linkage_gap_count AS linkageGapCount, originated_trades AS originatedTrades
          FROM originator_scorecard
          WHERE scorecard_date = '2026-06-20' AND window_days = 7
        `
      )
      .get() as { linkageGapCount: number; originatedTrades: number };
    expect(persisted).toEqual({ linkageGapCount: 1, originatedTrades: 1 });
  });
});
