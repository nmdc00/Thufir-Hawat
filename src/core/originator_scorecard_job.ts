import type Database from 'better-sqlite3';

import { openDatabase } from '../memory/db.js';
import {
  ensureOriginatorScorecardSchema,
  upsertOriginatorScorecard,
  type OriginatorScorecardInput,
  type OriginatorScorecardWindowDays,
} from '../memory/originator_scorecard.js';

export type OriginatorScorecardJobConfig = {
  cleanDataCutoff?: string | null;
};

export type OriginatorScorecardJobResult = {
  rows: OriginatorScorecardInput[];
};

const WINDOW_DAYS: OriginatorScorecardWindowDays[] = [7, 30];
const DEFAULT_CUTOFF = '2026-06-13';
const LINKAGE_NOTE =
  'Originator attribution uses llm_trade_proposals.trade_id -> perp_trades.id. Perp trades without that link are counted as quant-path; legacy/missed proposal updates can undercount originator rows.';

function normalizeCutoff(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return DEFAULT_CUTOFF;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return DEFAULT_CUTOFF;
  return new Date(ms).toISOString();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function countTable(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName);
  return Boolean(row);
}

function computeWindow(params: {
  db: Database.Database;
  windowDays: OriginatorScorecardWindowDays;
  now: Date;
  cleanDataCutoff: string;
}): OriginatorScorecardInput {
  const { db, windowDays, now, cleanDataCutoff } = params;
  const windowEndedAt = now.toISOString();
  const windowStartedAt = iso(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const lowerBound = new Date(Math.max(Date.parse(cleanDataCutoff), Date.parse(windowStartedAt))).toISOString();
  const hasProposalTable = countTable(db, 'llm_trade_proposals');
  const hasPerpTradesTable = countTable(db, 'perp_trades');
  const hasTradeClosesTable = countTable(db, 'trade_closes');

  const proposalStats = hasProposalTable
    ? (db.prepare(
        `
          SELECT COUNT(*) AS scanCycles,
                 SUM(CASE WHEN proposed = 0 THEN 1 ELSE 0 END) AS nullProposals
          FROM llm_trade_proposals
          WHERE datetime(created_at) >= datetime(@lowerBound)
            AND datetime(created_at) < datetime(@windowEndedAt)
        `
      ).get({ lowerBound, windowEndedAt }) as { scanCycles?: number; nullProposals?: number | null })
    : { scanCycles: 0, nullProposals: 0 };
  const scanCycles = Number(proposalStats.scanCycles ?? 0);
  const nullProposals = Number(proposalStats.nullProposals ?? 0);

  const tradeStats = hasPerpTradesTable
    ? (hasProposalTable
        ? (db.prepare(
            `
              SELECT COUNT(*) AS executedTrades,
                     SUM(CASE WHEN EXISTS (
                       SELECT 1
                       FROM llm_trade_proposals p
                       WHERE p.trade_id IS NOT NULL
                         AND CAST(p.trade_id AS TEXT) = CAST(pt.id AS TEXT)
                         AND p.proposed = 1
                     ) THEN 1 ELSE 0 END) AS originatedTrades
              FROM perp_trades pt
              WHERE LOWER(COALESCE(pt.status, '')) IN ('executed', 'position_open')
                AND datetime(pt.created_at) >= datetime(@lowerBound)
                AND datetime(pt.created_at) < datetime(@windowEndedAt)
            `
          ).get({ lowerBound, windowEndedAt }) as { executedTrades?: number; originatedTrades?: number | null })
        : (db.prepare(
            `
              SELECT COUNT(*) AS executedTrades,
                     0 AS originatedTrades
              FROM perp_trades pt
              WHERE LOWER(COALESCE(pt.status, '')) IN ('executed', 'position_open')
                AND datetime(pt.created_at) >= datetime(@lowerBound)
                AND datetime(pt.created_at) < datetime(@windowEndedAt)
            `
          ).get({ lowerBound, windowEndedAt }) as { executedTrades?: number; originatedTrades?: number | null }))
    : { executedTrades: 0, originatedTrades: 0 };
  const executedTrades = Number(tradeStats.executedTrades ?? 0);
  const originatedTrades = Number(tradeStats.originatedTrades ?? 0);
  const quantTrades = Math.max(0, executedTrades - originatedTrades);

  const outcomeRows = hasTradeClosesTable && hasPerpTradesTable
    ? (hasProposalTable
        ? (db.prepare(
            `
              SELECT CASE WHEN EXISTS (
                       SELECT 1
                       FROM llm_trade_proposals p
                       WHERE p.trade_id IS NOT NULL
                         AND CAST(p.trade_id AS TEXT) = CAST(tc.trade_id AS TEXT)
                         AND p.proposed = 1
                     ) THEN 'originator' ELSE 'quant' END AS path,
                     COUNT(*) AS closes,
                     SUM(CASE WHEN COALESCE(tc.net_realized_pnl_usd, tc.gross_realized_pnl_usd, 0) > 0 THEN 1 ELSE 0 END) AS wins,
                     AVG(COALESCE(tc.net_realized_pnl_usd, tc.gross_realized_pnl_usd)) AS expectancy
              FROM trade_closes tc
              LEFT JOIN perp_trades pt ON pt.id = tc.trade_id
              WHERE datetime(COALESCE(tc.created_at, tc.closed_at)) >= datetime(@lowerBound)
                AND datetime(COALESCE(tc.created_at, tc.closed_at)) < datetime(@windowEndedAt)
                AND datetime(COALESCE(pt.created_at, tc.created_at, tc.closed_at)) >= datetime(@cleanDataCutoff)
                AND COALESCE(tc.net_realized_pnl_usd, tc.gross_realized_pnl_usd) IS NOT NULL
              GROUP BY path
            `
          ).all({ lowerBound, windowEndedAt, cleanDataCutoff }) as Array<{
            path?: string;
            closes?: number;
            wins?: number | null;
            expectancy?: number | null;
          }>)
        : (db.prepare(
            `
              SELECT 'quant' AS path,
                     COUNT(*) AS closes,
                     SUM(CASE WHEN COALESCE(tc.net_realized_pnl_usd, tc.gross_realized_pnl_usd, 0) > 0 THEN 1 ELSE 0 END) AS wins,
                     AVG(COALESCE(tc.net_realized_pnl_usd, tc.gross_realized_pnl_usd)) AS expectancy
              FROM trade_closes tc
              LEFT JOIN perp_trades pt ON pt.id = tc.trade_id
              WHERE datetime(COALESCE(tc.created_at, tc.closed_at)) >= datetime(@lowerBound)
                AND datetime(COALESCE(tc.created_at, tc.closed_at)) < datetime(@windowEndedAt)
                AND datetime(COALESCE(pt.created_at, tc.created_at, tc.closed_at)) >= datetime(@cleanDataCutoff)
                AND COALESCE(tc.net_realized_pnl_usd, tc.gross_realized_pnl_usd) IS NOT NULL
            `
          ).all({ lowerBound, windowEndedAt, cleanDataCutoff }) as Array<{
            path?: string;
            closes?: number;
            wins?: number | null;
            expectancy?: number | null;
          }>))
    : [];

  let originatedCloses = 0;
  let originatedWins = 0;
  let originatedExpectancyUsd: number | null = null;
  let quantCloses = 0;
  let quantWins = 0;
  let quantExpectancyUsd: number | null = null;
  for (const row of outcomeRows) {
    if (row.path === 'originator') {
      originatedCloses = Number(row.closes ?? 0);
      originatedWins = Number(row.wins ?? 0);
      originatedExpectancyUsd = nullableNumber(row.expectancy);
    } else {
      quantCloses = Number(row.closes ?? 0);
      quantWins = Number(row.wins ?? 0);
      quantExpectancyUsd = nullableNumber(row.expectancy);
    }
  }

  const linkageGapCount = hasProposalTable
    ? Number(
        (db.prepare(
          `
            SELECT COUNT(*) AS c
            FROM llm_trade_proposals
            WHERE proposed = 1
              AND executed = 1
              AND (trade_id IS NULL OR TRIM(CAST(trade_id AS TEXT)) = '')
              AND datetime(created_at) >= datetime(@lowerBound)
              AND datetime(created_at) < datetime(@windowEndedAt)
          `
        ).get({ lowerBound, windowEndedAt }) as { c?: number }).c ?? 0
      )
    : 0;

  return {
    scorecardDate: windowEndedAt.slice(0, 10),
    windowDays,
    cleanDataCutoff,
    windowStartedAt,
    windowEndedAt,
    scanCycles,
    nullProposalRate: ratio(nullProposals, scanCycles),
    executedTrades,
    originatedTrades,
    quantTrades,
    originatedShare: ratio(originatedTrades, executedTrades),
    originatedWinRate: ratio(originatedWins, originatedCloses),
    originatedExpectancyUsd,
    quantWinRate: ratio(quantWins, quantCloses),
    quantExpectancyUsd,
    linkageGapCount,
    notes: LINKAGE_NOTE,
    computedAt: windowEndedAt,
  };
}

export function runOriginatorScorecardJob(params?: {
  db?: Database.Database;
  config?: OriginatorScorecardJobConfig;
  now?: Date;
}): OriginatorScorecardJobResult {
  const db = params?.db ?? openDatabase();
  ensureOriginatorScorecardSchema(db);
  const now = params?.now ?? new Date();
  const cleanDataCutoff = normalizeCutoff(params?.config?.cleanDataCutoff);
  const rows = WINDOW_DAYS.map((windowDays) =>
    computeWindow({ db, windowDays, now, cleanDataCutoff })
  );
  for (const row of rows) {
    upsertOriginatorScorecard(row, db);
  }
  return { rows };
}
