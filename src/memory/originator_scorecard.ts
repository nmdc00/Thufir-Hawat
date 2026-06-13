import type Database from 'better-sqlite3';

import { openDatabase } from './db.js';

export type OriginatorScorecardWindowDays = 7 | 30;

export type OriginatorScorecardRow = {
  scorecardDate: string;
  windowDays: OriginatorScorecardWindowDays;
  cleanDataCutoff: string;
  windowStartedAt: string;
  windowEndedAt: string;
  scanCycles: number;
  nullProposalRate: number | null;
  executedTrades: number;
  originatedTrades: number;
  quantTrades: number;
  originatedShare: number | null;
  originatedWinRate: number | null;
  originatedExpectancyUsd: number | null;
  quantWinRate: number | null;
  quantExpectancyUsd: number | null;
  linkageGapCount: number;
  notes: string | null;
  computedAt: string;
};

export type OriginatorScorecardInput = Omit<OriginatorScorecardRow, 'computedAt'> & {
  computedAt?: string;
};

export function ensureOriginatorScorecardSchema(db: Database.Database = openDatabase()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS originator_scorecard (
      scorecard_date TEXT NOT NULL,
      window_days INTEGER NOT NULL CHECK(window_days IN (7, 30)),
      clean_data_cutoff TEXT NOT NULL,
      window_started_at TEXT NOT NULL,
      window_ended_at TEXT NOT NULL,
      scan_cycles INTEGER NOT NULL,
      null_proposal_rate REAL,
      executed_trades INTEGER NOT NULL,
      originated_trades INTEGER NOT NULL,
      quant_trades INTEGER NOT NULL,
      originated_share REAL,
      originated_win_rate REAL,
      originated_expectancy_usd REAL,
      quant_win_rate REAL,
      quant_expectancy_usd REAL,
      linkage_gap_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      computed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scorecard_date, window_days)
    );

    CREATE INDEX IF NOT EXISTS idx_originator_scorecard_computed
    ON originator_scorecard(computed_at);
  `);
}

export function upsertOriginatorScorecard(
  row: OriginatorScorecardInput,
  db: Database.Database = openDatabase()
): void {
  ensureOriginatorScorecardSchema(db);
  db.prepare(
    `
      INSERT INTO originator_scorecard (
        scorecard_date, window_days, clean_data_cutoff, window_started_at, window_ended_at,
        scan_cycles, null_proposal_rate, executed_trades, originated_trades, quant_trades,
        originated_share, originated_win_rate, originated_expectancy_usd,
        quant_win_rate, quant_expectancy_usd, linkage_gap_count, notes, computed_at
      ) VALUES (
        @scorecardDate, @windowDays, @cleanDataCutoff, @windowStartedAt, @windowEndedAt,
        @scanCycles, @nullProposalRate, @executedTrades, @originatedTrades, @quantTrades,
        @originatedShare, @originatedWinRate, @originatedExpectancyUsd,
        @quantWinRate, @quantExpectancyUsd, @linkageGapCount, @notes, @computedAt
      )
      ON CONFLICT(scorecard_date, window_days) DO UPDATE SET
        clean_data_cutoff = excluded.clean_data_cutoff,
        window_started_at = excluded.window_started_at,
        window_ended_at = excluded.window_ended_at,
        scan_cycles = excluded.scan_cycles,
        null_proposal_rate = excluded.null_proposal_rate,
        executed_trades = excluded.executed_trades,
        originated_trades = excluded.originated_trades,
        quant_trades = excluded.quant_trades,
        originated_share = excluded.originated_share,
        originated_win_rate = excluded.originated_win_rate,
        originated_expectancy_usd = excluded.originated_expectancy_usd,
        quant_win_rate = excluded.quant_win_rate,
        quant_expectancy_usd = excluded.quant_expectancy_usd,
        linkage_gap_count = excluded.linkage_gap_count,
        notes = excluded.notes,
        computed_at = excluded.computed_at
    `
  ).run({
    ...row,
    computedAt: row.computedAt ?? new Date().toISOString(),
  });
}

function mapRow(row: Record<string, unknown>): OriginatorScorecardRow {
  return {
    scorecardDate: String(row.scorecard_date ?? ''),
    windowDays: Number(row.window_days) === 7 ? 7 : 30,
    cleanDataCutoff: String(row.clean_data_cutoff ?? ''),
    windowStartedAt: String(row.window_started_at ?? ''),
    windowEndedAt: String(row.window_ended_at ?? ''),
    scanCycles: Number(row.scan_cycles ?? 0),
    nullProposalRate: row.null_proposal_rate == null ? null : Number(row.null_proposal_rate),
    executedTrades: Number(row.executed_trades ?? 0),
    originatedTrades: Number(row.originated_trades ?? 0),
    quantTrades: Number(row.quant_trades ?? 0),
    originatedShare: row.originated_share == null ? null : Number(row.originated_share),
    originatedWinRate: row.originated_win_rate == null ? null : Number(row.originated_win_rate),
    originatedExpectancyUsd:
      row.originated_expectancy_usd == null ? null : Number(row.originated_expectancy_usd),
    quantWinRate: row.quant_win_rate == null ? null : Number(row.quant_win_rate),
    quantExpectancyUsd:
      row.quant_expectancy_usd == null ? null : Number(row.quant_expectancy_usd),
    linkageGapCount: Number(row.linkage_gap_count ?? 0),
    notes: row.notes == null ? null : String(row.notes),
    computedAt: String(row.computed_at ?? ''),
  };
}

export function listLatestOriginatorScorecards(
  db: Database.Database = openDatabase()
): OriginatorScorecardRow[] {
  ensureOriginatorScorecardSchema(db);
  const rows = db.prepare(
    `
      SELECT *
      FROM originator_scorecard
      WHERE (scorecard_date, window_days) IN (
        SELECT scorecard_date, window_days
        FROM (
          SELECT scorecard_date, window_days,
                 ROW_NUMBER() OVER (PARTITION BY window_days ORDER BY scorecard_date DESC, computed_at DESC) AS rn
          FROM originator_scorecard
        )
        WHERE rn = 1
      )
      ORDER BY window_days ASC
    `
  ).all() as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}
