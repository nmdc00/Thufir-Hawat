import { openDatabase } from './db.js';

export interface ExecutionState {
  source: string;
  fingerprint: string | null;
  updatedAt: string;
  lastMode: string | null;
  lastReason: string | null;
}

function ensureExecutionStateTable(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_state (
      source TEXT PRIMARY KEY,
      fingerprint TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      last_mode TEXT,
      last_reason TEXT
    );
  `);
}

function rowToState(row: Record<string, unknown> | undefined): ExecutionState | null {
  if (!row) return null;
  return {
    source: String(row.source ?? ''),
    fingerprint: row.fingerprint == null ? null : String(row.fingerprint),
    updatedAt: String(row.updated_at ?? ''),
    lastMode: row.last_mode == null ? null : String(row.last_mode),
    lastReason: row.last_reason == null ? null : String(row.last_reason),
  };
}

export function getExecutionState(source: string): ExecutionState | null {
  ensureExecutionStateTable();
  const db = openDatabase();
  const row = db
    .prepare(
      `
        SELECT source, fingerprint, updated_at, last_mode, last_reason
        FROM execution_state
        WHERE source = ?
      `
    )
    .get(source) as Record<string, unknown> | undefined;
  return rowToState(row);
}

export function upsertExecutionState(input: {
  source: string;
  fingerprint?: string | null;
  lastMode?: string | null;
  lastReason?: string | null;
}): void {
  ensureExecutionStateTable();
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO execution_state (source, fingerprint, updated_at, last_mode, last_reason)
      VALUES (@source, @fingerprint, datetime('now'), @lastMode, @lastReason)
      ON CONFLICT(source) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        updated_at = excluded.updated_at,
        last_mode = excluded.last_mode,
        last_reason = excluded.last_reason
    `
  ).run({
    source: input.source,
    fingerprint: input.fingerprint ?? null,
    lastMode: input.lastMode ?? null,
    lastReason: input.lastReason ?? null,
  });
}
