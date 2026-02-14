import { openDatabase } from '../memory/db.js';

export function buildTradeJournalSummary(params?: { limit?: number }): string {
  const db = openDatabase();
  const limit = Math.min(Math.max(params?.limit ?? 20, 1), 200);

  const closes = db
    .prepare(
      `
        SELECT trade_id as tradeId,
               symbol,
               exit_reason as exitReason,
               pnl_usd as pnlUsd,
               hold_duration_seconds as holdSeconds,
               closed_at as closedAt
        FROM trade_closes
        ORDER BY closed_at DESC
        LIMIT ?
      `
    )
    .all(limit) as Array<{
    tradeId: string;
    symbol: string;
    exitReason: string;
    pnlUsd: number;
    holdSeconds: number;
    closedAt: string;
  }>;

  if (closes.length === 0) {
    return 'TRADE JOURNAL SUMMARY (no closed trades yet)';
  }

  const wins = closes.filter((c) => (c.pnlUsd ?? 0) > 0);
  const losses = closes.filter((c) => (c.pnlUsd ?? 0) <= 0);
  const avgWin = wins.length ? wins.reduce((a, b) => a + (b.pnlUsd ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + (b.pnlUsd ?? 0), 0) / losses.length : 0;
  const avgHoldHrs =
    closes.length
      ? closes.reduce((a, b) => a + (Number(b.holdSeconds ?? 0) || 0), 0) / closes.length / 3600
      : 0;

  const reasonCounts = new Map<string, number>();
  for (const c of closes) {
    const key = String(c.exitReason ?? 'unknown');
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }
  const reasonSummary = Array.from(reasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

  const last5 = closes.slice(0, 5).map((c) => ((c.pnlUsd ?? 0) > 0 ? 'W' : 'L')).join(' ');

  const lessons = db
    .prepare(
      `
        SELECT lesson_for_next_trade as lesson
        FROM trade_reflections
        ORDER BY created_at DESC
        LIMIT 5
      `
    )
    .all() as Array<{ lesson?: string | null }>;
  const lessonLines = lessons
    .map((row) => (row.lesson ? String(row.lesson).trim() : ''))
    .filter(Boolean)
    .slice(0, 5);

  // Signal effectiveness (by kind) across all closed trades.
  const signalStats = db
    .prepare(
      `
        SELECT
          ts.signal_kind as signalKind,
          COUNT(*) as total,
          SUM(CASE WHEN tc.pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
          AVG(tc.pnl_usd) as avgPnlUsd
        FROM trade_signals ts
        JOIN trade_closes tc ON ts.trade_id = tc.trade_id
        GROUP BY ts.signal_kind
        ORDER BY avgPnlUsd DESC
        LIMIT 8
      `
    )
    .all() as Array<{ signalKind: string; total: number; wins: number; avgPnlUsd: number }>;

  const lines: string[] = [];
  lines.push(`TRADE JOURNAL SUMMARY (last ${closes.length} closed trades):`);
  lines.push(`- Win rate: ${Math.round((wins.length / closes.length) * 100)}% (${wins.length}/${closes.length})`);
  lines.push(`- Average win: ${formatUsd(avgWin)} | Average loss: ${formatUsd(avgLoss)}`);
  lines.push(`- Average hold: ${avgHoldHrs.toFixed(1)} hours`);
  lines.push(`- Exits: ${reasonSummary || 'n/a'}`);
  lines.push(`- Last 5 trades: ${last5 || 'n/a'}`);

  if (signalStats.length) {
    lines.push(`- Top signals (avg PnL):`);
    for (const row of signalStats) {
      const total = Number(row.total ?? 0);
      const winsCount = Number(row.wins ?? 0);
      const winRate = total > 0 ? Math.round((winsCount / total) * 100) : 0;
      lines.push(
        `  - ${String(row.signalKind)}: ${formatUsd(Number(row.avgPnlUsd ?? 0))} (win ${winRate}%, n=${total})`
      );
    }
  }

  if (lessonLines.length) {
    lines.push(`- Recent lessons:`);
    for (const lesson of lessonLines) {
      lines.push(`  - ${lesson}`);
    }
  }

  return lines.join('\n');
}

function formatUsd(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}$${value.toFixed(2)}`;
}

