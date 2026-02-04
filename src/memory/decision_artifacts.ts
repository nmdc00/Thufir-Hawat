import { openDatabase } from './db.js';

export interface DecisionArtifact {
  id: number;
  createdAt: string;
  updatedAt: string | null;
  source: string | null;
  kind: string;
  marketId: string | null;
  fingerprint: string | null;
  outcome: string | null;
  confidence: number | null;
  expiresAt: string | null;
  payload: unknown | null;
  notes: Record<string, unknown> | null;
}

export interface DecisionArtifactInput {
  source?: string;
  kind: string;
  marketId?: string | null;
  fingerprint?: string | null;
  outcome?: string | null;
  confidence?: number | null;
  expiresAt?: string | null;
  payload?: unknown | null;
  notes?: Record<string, unknown> | null;
}

function ensureDecisionArtifactsTable(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT,
      source TEXT,
      kind TEXT NOT NULL,
      market_id TEXT,
      fingerprint TEXT,
      outcome TEXT,
      confidence REAL,
      expires_at TEXT,
      payload TEXT,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_decision_artifacts_created ON decision_artifacts(created_at);
    CREATE INDEX IF NOT EXISTS idx_decision_artifacts_kind ON decision_artifacts(kind);
    CREATE INDEX IF NOT EXISTS idx_decision_artifacts_market ON decision_artifacts(market_id);
    CREATE INDEX IF NOT EXISTS idx_decision_artifacts_fingerprint ON decision_artifacts(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_decision_artifacts_expires ON decision_artifacts(expires_at);
  `);
}

function serializeJson(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJson<T = unknown>(value: unknown): T | null {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toSqliteDatetime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function normalizeDatetime(value?: string | null): string | null {
  if (!value) return null;
  if (value.includes('T')) {
    return value.replace('T', ' ').slice(0, 19);
  }
  return value;
}

function rowToArtifact(row: Record<string, unknown> | undefined): DecisionArtifact | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    createdAt: String(row.created_at ?? ''),
    updatedAt: row.updated_at == null ? null : String(row.updated_at),
    source: row.source == null ? null : String(row.source),
    kind: String(row.kind ?? ''),
    marketId: row.market_id == null ? null : String(row.market_id),
    fingerprint: row.fingerprint == null ? null : String(row.fingerprint),
    outcome: row.outcome == null ? null : String(row.outcome),
    confidence: row.confidence == null ? null : Number(row.confidence),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    payload: parseJson(row.payload),
    notes: parseJson<Record<string, unknown>>(row.notes),
  };
}

export function storeDecisionArtifact(input: DecisionArtifactInput): void {
  ensureDecisionArtifactsTable();
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO decision_artifacts (
        source,
        kind,
        market_id,
        fingerprint,
        outcome,
        confidence,
        expires_at,
        payload,
        notes
      ) VALUES (
        @source,
        @kind,
        @marketId,
        @fingerprint,
        @outcome,
        @confidence,
        @expiresAt,
        @payload,
        @notes
      )
    `
  ).run({
    source: input.source ?? null,
    kind: input.kind,
    marketId: input.marketId ?? null,
    fingerprint: input.fingerprint ?? null,
    outcome: input.outcome ?? null,
    confidence: input.confidence ?? null,
    expiresAt: normalizeDatetime(input.expiresAt ?? null),
    payload: serializeJson(input.payload ?? null),
    notes: serializeJson(input.notes ?? null),
  });
}

export function findReusableArtifact(params: {
  kind: string;
  marketId?: string | null;
  fingerprint?: string | null;
  maxAgeMs?: number;
  requireNotExpired?: boolean;
}): DecisionArtifact | null {
  ensureDecisionArtifactsTable();
  const db = openDatabase();
  const now = new Date();
  const cutoff = params.maxAgeMs ? toSqliteDatetime(new Date(now.getTime() - params.maxAgeMs)) : null;
  const requireNotExpired = params.requireNotExpired ?? true;

  const row = db
    .prepare(
      `
        SELECT *
        FROM decision_artifacts
        WHERE kind = @kind
          AND (@marketId IS NULL OR market_id = @marketId)
          AND (@fingerprint IS NULL OR fingerprint = @fingerprint)
          AND (@cutoff IS NULL OR created_at >= @cutoff)
          AND (${requireNotExpired ? '(expires_at IS NULL OR expires_at > datetime(\'now\'))' : '1=1'})
        ORDER BY created_at DESC
        LIMIT 1
      `
    )
    .get({
      kind: params.kind,
      marketId: params.marketId ?? null,
      fingerprint: params.fingerprint ?? null,
      cutoff,
    }) as Record<string, unknown> | undefined;

  return rowToArtifact(row);
}

export function listDecisionArtifactsByMarket(marketId: string, limit = 10): DecisionArtifact[] {
  ensureDecisionArtifactsTable();
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM decision_artifacts
        WHERE market_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(marketId, limit) as Record<string, unknown>[];
  return rows.map((row) => rowToArtifact(row)).filter((row): row is DecisionArtifact => !!row);
}
