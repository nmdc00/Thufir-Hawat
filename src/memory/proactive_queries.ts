import { openDatabase } from './db.js';

export interface ProactiveQueryOutcomeInput {
  query: string;
  storedItems?: number;
  webResults?: number;
  fetchedPages?: number;
  succeeded?: boolean;
  error?: string;
}

export interface ProactiveQueryStat {
  query: string;
  runs: number;
  successes: number;
  totalNewItems: number;
  totalWebResults: number;
  totalWebFetches: number;
  score: number;
  lastError: string | null;
  lastRunAt: string;
}

function asNonNegativeInt(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value ?? 0));
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

export function recordProactiveQueryOutcome(input: ProactiveQueryOutcomeInput): void {
  const query = normalizeQuery(input.query);
  if (!query) {
    return;
  }

  const storedItems = asNonNegativeInt(input.storedItems);
  const webResults = asNonNegativeInt(input.webResults);
  const fetchedPages = asNonNegativeInt(input.fetchedPages);
  const successInc = input.succeeded ? 1 : 0;
  const error = (input.error ?? '').trim();

  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO proactive_query_stats (
        query,
        runs,
        successes,
        total_new_items,
        total_web_results,
        total_web_fetches,
        score,
        last_error,
        created_at,
        last_run_at
      ) VALUES (
        @query,
        1,
        @successInc,
        @storedItems,
        @webResults,
        @fetchedPages,
        @initialScore,
        @error,
        datetime('now'),
        datetime('now')
      )
      ON CONFLICT(query) DO UPDATE SET
        runs = proactive_query_stats.runs + 1,
        successes = proactive_query_stats.successes + @successInc,
        total_new_items = proactive_query_stats.total_new_items + @storedItems,
        total_web_results = proactive_query_stats.total_web_results + @webResults,
        total_web_fetches = proactive_query_stats.total_web_fetches + @fetchedPages,
        score = (
          (
            (proactive_query_stats.total_new_items + @storedItems) * 3.0 +
            (proactive_query_stats.total_web_results + @webResults) * 0.8 +
            (proactive_query_stats.total_web_fetches + @fetchedPages) * 0.4 +
            (proactive_query_stats.successes + @successInc) * 1.2
          ) / (proactive_query_stats.runs + 1)
        ),
        last_error = CASE
          WHEN @error = '' THEN proactive_query_stats.last_error
          ELSE @error
        END,
        last_run_at = datetime('now')
    `
  ).run({
    query,
    successInc,
    storedItems,
    webResults,
    fetchedPages,
    initialScore: storedItems * 3 + webResults * 0.8 + fetchedPages * 0.4 + successInc * 1.2,
    error,
  });
}

export function listLearnedProactiveQueries(limit = 8): string[] {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT query
        FROM proactive_query_stats
        WHERE runs > 0
        ORDER BY score DESC, successes DESC, last_run_at DESC
        LIMIT ?
      `
    )
    .all(safeLimit) as Array<{ query: string }>;
  return rows
    .map((row) => normalizeQuery(row.query))
    .filter((query) => query.length > 0);
}

export function listProactiveQueryStats(limit = 20): ProactiveQueryStat[] {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          query,
          runs,
          successes,
          total_new_items as totalNewItems,
          total_web_results as totalWebResults,
          total_web_fetches as totalWebFetches,
          score,
          last_error as lastError,
          last_run_at as lastRunAt
        FROM proactive_query_stats
        ORDER BY score DESC, runs DESC, last_run_at DESC
        LIMIT ?
      `
    )
    .all(safeLimit) as Array<{
    query: string;
    runs: number;
    successes: number;
    totalNewItems: number;
    totalWebResults: number;
    totalWebFetches: number;
    score: number;
    lastError: string | null;
    lastRunAt: string;
  }>;

  return rows.map((row) => ({
    query: row.query,
    runs: Number(row.runs ?? 0),
    successes: Number(row.successes ?? 0),
    totalNewItems: Number(row.totalNewItems ?? 0),
    totalWebResults: Number(row.totalWebResults ?? 0),
    totalWebFetches: Number(row.totalWebFetches ?? 0),
    score: Number(row.score ?? 0),
    lastError: row.lastError ?? null,
    lastRunAt: row.lastRunAt,
  }));
}
