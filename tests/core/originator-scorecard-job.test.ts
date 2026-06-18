import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runOriginatorScorecardJob } from '../../src/core/originator_scorecard_job.js';
import { closeDatabase, openDatabase } from '../../src/memory/db.js';
import { recordTradeProposal } from '../../src/memory/llm_trade_proposals.js';

const previousDbPath = process.env.THUFIR_DB_PATH;
let dbPath = '';

function setCreatedAt(table: string, id: number | string, createdAt: string): void {
  openDatabase().prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(createdAt, id);
}

function insertProposal(params: {
  createdAt: string;
  proposed: boolean;
  tradeId?: number;
  executed?: boolean;
}): number {
  const id = recordTradeProposal({
    triggerReason: 'cadence',
    proposed: params.proposed,
    symbol: params.proposed ? 'BTC' : undefined,
    side: params.proposed ? 'long' : undefined,
    executed: params.executed ?? false,
    tradeId: params.tradeId == null ? undefined : String(params.tradeId),
  });
  setCreatedAt('llm_trade_proposals', id, params.createdAt);
  return id;
}

function insertTrade(params: {
  id: number;
  createdAt: string;
  status?: string;
  pnl?: number;
}): void {
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO perp_trades (id, symbol, side, size, execution_mode, price, status, created_at)
      VALUES (?, 'BTC', 'buy', 1, 'paper', 100, ?, ?)
    `
  ).run(params.id, params.status ?? 'executed', params.createdAt);

  if (params.pnl != null) {
    db.prepare(
      `
        INSERT INTO trade_closes (
          id, close_event_id, lifecycle_id, trade_id, symbol, closed_side, execution_mode,
          opened_at, closed_at, net_realized_pnl_usd, gross_realized_pnl_usd, deterministic_status
        ) VALUES (?, ?, ?, ?, 'BTC', 'long', 'paper', ?, ?, ?, ?, 'finalized')
      `
    ).run(
      `close-${params.id}`,
      `event-${params.id}`,
      `life-${params.id}`,
      params.id,
      params.createdAt,
      params.createdAt,
      params.pnl,
      params.pnl
    );
  }
}

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'thufir-originator-scorecard-')), 'thufir.sqlite');
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

describe('originator scorecard job', () => {
  it('computes exact rates and expectancy from proposal-linked originator trades', () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    const inWindow = '2026-06-19T12:00:00.000Z';

    insertTrade({ id: 1, createdAt: inWindow, pnl: 10 });
    insertTrade({ id: 2, createdAt: inWindow, pnl: -4 });
    insertTrade({ id: 3, createdAt: inWindow, pnl: 2 });
    insertTrade({ id: 4, createdAt: inWindow, pnl: -6 });

    insertProposal({ createdAt: inWindow, proposed: true, executed: true, tradeId: 1 });
    insertProposal({ createdAt: inWindow, proposed: true, executed: true, tradeId: 2 });
    insertProposal({ createdAt: inWindow, proposed: true, executed: false });
    for (let index = 0; index < 7; index += 1) {
      insertProposal({ createdAt: inWindow, proposed: false });
    }

    const result = runOriginatorScorecardJob({
      now,
      config: { cleanDataCutoff: '2026-06-13T00:00:00.000Z' },
    });
    const seven = result.rows.find((row) => row.windowDays === 7)!;

    expect(seven.scanCycles).toBe(10);
    expect(seven.nullProposalRate).toBeCloseTo(0.7);
    expect(seven.executedTrades).toBe(4);
    expect(seven.originatedTrades).toBe(2);
    expect(seven.quantTrades).toBe(2);
    expect(seven.originatedShare).toBeCloseTo(0.5);
    expect(seven.originatedWinRate).toBeCloseTo(0.5);
    expect(seven.originatedExpectancyUsd).toBeCloseTo(3);
    expect(seven.quantWinRate).toBeCloseTo(0.5);
    expect(seven.quantExpectancyUsd).toBeCloseTo(-2);

    const persisted = openDatabase()
      .prepare('SELECT COUNT(*) AS c FROM originator_scorecard')
      .get() as { c: number };
    expect(persisted.c).toBe(2);
  });

  it('counts open position rows as successful executed opens for originator share', () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    const inWindow = '2026-06-19T12:00:00.000Z';

    insertTrade({ id: 21, createdAt: inWindow, status: 'position_open' });
    insertTrade({ id: 22, createdAt: inWindow, status: 'position_open' });
    insertProposal({ createdAt: inWindow, proposed: true, executed: true, tradeId: 21 });
    insertProposal({ createdAt: inWindow, proposed: false });

    const result = runOriginatorScorecardJob({
      now,
      config: { cleanDataCutoff: '2026-06-13T00:00:00.000Z' },
    });
    const seven = result.rows.find((row) => row.windowDays === 7)!;

    expect(seven.executedTrades).toBe(2);
    expect(seven.originatedTrades).toBe(1);
    expect(seven.quantTrades).toBe(1);
    expect(seven.originatedShare).toBeCloseTo(0.5);
  });

  it('excludes proposal, trade, and close rows before the clean data cutoff', () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    insertTrade({ id: 10, createdAt: '2026-06-12T12:00:00.000Z', pnl: 100 });
    insertProposal({
      createdAt: '2026-06-12T12:00:00.000Z',
      proposed: true,
      executed: true,
      tradeId: 10,
    });
    insertProposal({ createdAt: '2026-06-12T13:00:00.000Z', proposed: false });

    const { rows } = runOriginatorScorecardJob({
      now,
      config: { cleanDataCutoff: '2026-06-13T00:00:00.000Z' },
    });

    for (const row of rows) {
      expect(row.scanCycles).toBe(0);
      expect(row.executedTrades).toBe(0);
      expect(row.originatedWinRate).toBeNull();
      expect(row.originatedExpectancyUsd).toBeNull();
    }
  });

  it('persists null metrics for empty windows without crashing', () => {
    const { rows } = runOriginatorScorecardJob({
      now: new Date('2026-06-20T00:00:00.000Z'),
      config: { cleanDataCutoff: '2026-06-13T00:00:00.000Z' },
    });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.scanCycles).toBe(0);
      expect(row.nullProposalRate).toBeNull();
      expect(row.executedTrades).toBe(0);
      expect(row.originatedShare).toBeNull();
      expect(row.quantWinRate).toBeNull();
    }
  });

  it('upserts the same scorecard date and window instead of duplicating rows', () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    runOriginatorScorecardJob({ now, config: { cleanDataCutoff: '2026-06-13' } });
    runOriginatorScorecardJob({ now, config: { cleanDataCutoff: '2026-06-13' } });

    const rows = openDatabase()
      .prepare(
        `
          SELECT scorecard_date AS scorecardDate, window_days AS windowDays, COUNT(*) AS c
          FROM originator_scorecard
          GROUP BY scorecard_date, window_days
          ORDER BY window_days
        `
      )
      .all() as Array<{ scorecardDate: string; windowDays: number; c: number }>;

    expect(rows).toEqual([
      { scorecardDate: '2026-06-20', windowDays: 7, c: 1 },
      { scorecardDate: '2026-06-20', windowDays: 30, c: 1 },
    ]);
  });
});
