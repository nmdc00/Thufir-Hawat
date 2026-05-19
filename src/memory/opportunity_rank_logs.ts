import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export interface OpportunityRankArtifact {
  marketId: string;
  rank: number;
  score: number;
  edge: number;
  direction: string;
  confidence: string;
  marketPrice: number;
  myEstimate: number;
  suggestedAmount?: number | null;
  reasoning?: string | null;
  relevantNews?: string[];
  metadata?: Record<string, unknown> | null;
}

export interface OpportunityRankScanContext {
  mode?: string | null;
  provider?: string | null;
  model?: string | null;
}

export interface OpportunityRankScanSummaryInput {
  marketsScanned: number;
  newsItemsAnalyzed: number;
  opportunitiesFound?: number;
}

export interface OpportunityRankScanInput {
  scanId?: string | null;
  source?: string;
  fingerprint?: string | null;
  generatedAt?: string | null;
  expiresAt?: string | null;
  context?: OpportunityRankScanContext | null;
  summary: OpportunityRankScanSummaryInput;
  opportunities: OpportunityRankArtifact[];
  payload?: Record<string, unknown> | null;
  notes?: Record<string, unknown> | null;
}

export interface OpportunityRankScanSummary {
  marketsScanned: number;
  newsItemsAnalyzed: number;
  opportunitiesFound: number;
  topOpportunity: OpportunityRankArtifact | null;
}

export interface OpportunityRankScanArtifact {
  scanId: string;
  generatedAt: string | null;
  expiresAt: string | null;
  context: OpportunityRankScanContext;
  summary: OpportunityRankScanSummary;
  opportunities: OpportunityRankArtifact[];
  payload: Record<string, unknown> | null;
}

export interface OpportunityRankScanRecord {
  id: number;
  createdAt: string;
  scanId: string;
  source: string | null;
  fingerprint: string | null;
  generatedAt: string | null;
  expiresAt: string | null;
  mode: string | null;
  provider: string | null;
  model: string | null;
  marketsScanned: number;
  newsItemsAnalyzed: number;
  opportunitiesFound: number;
  topMarketId: string | null;
  topRank: number | null;
  topScore: number | null;
  artifact: OpportunityRankScanArtifact | null;
  notes: Record<string, unknown> | null;
}

function ensureSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS opportunity_rank_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      scan_id TEXT,
      source TEXT,
      fingerprint TEXT,
      generated_at TEXT,
      expires_at TEXT,
      mode TEXT,
      provider TEXT,
      model TEXT,
      markets_scanned INTEGER NOT NULL DEFAULT 0,
      news_items_analyzed INTEGER NOT NULL DEFAULT 0,
      opportunities_found INTEGER NOT NULL DEFAULT 0,
      top_market_id TEXT,
      top_rank INTEGER,
      top_score REAL,
      artifact TEXT,
      notes TEXT
    )
  `);

  const columns = db.prepare("PRAGMA table_info('opportunity_rank_logs')").all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => String(column.name ?? '')));
  const addColumnIfMissing = (name: string, definition: string): void => {
    if (columnNames.has(name)) {
      return;
    }
    db.exec(`ALTER TABLE opportunity_rank_logs ADD COLUMN ${definition}`);
    columnNames.add(name);
  };

  addColumnIfMissing('scan_id', 'scan_id TEXT');
  addColumnIfMissing('source', 'source TEXT');
  addColumnIfMissing('fingerprint', 'fingerprint TEXT');
  addColumnIfMissing('generated_at', 'generated_at TEXT');
  addColumnIfMissing('expires_at', 'expires_at TEXT');
  addColumnIfMissing('mode', 'mode TEXT');
  addColumnIfMissing('provider', 'provider TEXT');
  addColumnIfMissing('model', 'model TEXT');
  addColumnIfMissing('markets_scanned', 'markets_scanned INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('news_items_analyzed', 'news_items_analyzed INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('opportunities_found', 'opportunities_found INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('top_market_id', 'top_market_id TEXT');
  addColumnIfMissing('top_rank', 'top_rank INTEGER');
  addColumnIfMissing('top_score', 'top_score REAL');
  addColumnIfMissing('artifact', 'artifact TEXT');
  addColumnIfMissing('notes', 'notes TEXT');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunity_rank_logs_scan_id
      ON opportunity_rank_logs(scan_id);
    CREATE INDEX IF NOT EXISTS idx_opportunity_rank_logs_created
      ON opportunity_rank_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_opportunity_rank_logs_fingerprint
      ON opportunity_rank_logs(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_opportunity_rank_logs_generated
      ON opportunity_rank_logs(generated_at);
    CREATE INDEX IF NOT EXISTS idx_opportunity_rank_logs_expires
      ON opportunity_rank_logs(expires_at);
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

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeDatetime(value?: string | null): string | null {
  if (!value) return null;
  if (value.includes('T')) {
    return value.replace('T', ' ').slice(0, 19);
  }
  return value;
}

function toSqliteDatetime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function normalizeOpportunity(entry: OpportunityRankArtifact): OpportunityRankArtifact {
  return {
    marketId: entry.marketId,
    rank: entry.rank,
    score: entry.score,
    edge: entry.edge,
    direction: entry.direction,
    confidence: entry.confidence,
    marketPrice: entry.marketPrice,
    myEstimate: entry.myEstimate,
    suggestedAmount: entry.suggestedAmount ?? null,
    reasoning: entry.reasoning ?? null,
    relevantNews: entry.relevantNews ?? [],
    metadata: entry.metadata ?? null,
  };
}

function selectTopOpportunity(opportunities: OpportunityRankArtifact[]): OpportunityRankArtifact | null {
  if (opportunities.length === 0) {
    return null;
  }

  const sorted = [...opportunities].sort((a, b) => {
    if (a.rank !== b.rank) {
      return a.rank - b.rank;
    }
    return b.score - a.score;
  });

  return sorted[0] ?? null;
}

function normalizeArtifact(input: OpportunityRankScanInput): OpportunityRankScanArtifact {
  const scanId = input.scanId?.trim() || `opportunity_rank_scan_${randomUUID()}`;
  const opportunities = input.opportunities.map(normalizeOpportunity);
  const topOpportunity = selectTopOpportunity(opportunities);

  return {
    scanId,
    generatedAt: input.generatedAt ?? null,
    expiresAt: input.expiresAt ?? null,
    context: {
      mode: input.context?.mode ?? null,
      provider: input.context?.provider ?? null,
      model: input.context?.model ?? null,
    },
    summary: {
      marketsScanned: input.summary.marketsScanned,
      newsItemsAnalyzed: input.summary.newsItemsAnalyzed,
      opportunitiesFound: input.summary.opportunitiesFound ?? opportunities.length,
      topOpportunity,
    },
    opportunities,
    payload: input.payload ?? null,
  };
}

function rowToRecord(row: Record<string, unknown> | undefined): OpportunityRankScanRecord | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    createdAt: String(row.created_at ?? ''),
    scanId: String(row.scan_id ?? ''),
    source: row.source == null ? null : String(row.source),
    fingerprint: row.fingerprint == null ? null : String(row.fingerprint),
    generatedAt: row.generated_at == null ? null : String(row.generated_at),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    mode: row.mode == null ? null : String(row.mode),
    provider: row.provider == null ? null : String(row.provider),
    model: row.model == null ? null : String(row.model),
    marketsScanned: Number(row.markets_scanned ?? 0),
    newsItemsAnalyzed: Number(row.news_items_analyzed ?? 0),
    opportunitiesFound: Number(row.opportunities_found ?? 0),
    topMarketId: row.top_market_id == null ? null : String(row.top_market_id),
    topRank: row.top_rank == null ? null : Number(row.top_rank),
    topScore: row.top_score == null ? null : Number(row.top_score),
    artifact: parseJson<OpportunityRankScanArtifact>(row.artifact),
    notes: parseJson<Record<string, unknown>>(row.notes),
  };
}

export function recordOpportunityRankScan(input: OpportunityRankScanInput): OpportunityRankScanRecord {
  ensureSchema();
  const db = openDatabase();
  const artifact = normalizeArtifact(input);
  const topOpportunity = artifact.summary.topOpportunity;

  db.prepare(
    `
      INSERT INTO opportunity_rank_logs (
        scan_id,
        source,
        fingerprint,
        generated_at,
        expires_at,
        mode,
        provider,
        model,
        markets_scanned,
        news_items_analyzed,
        opportunities_found,
        top_market_id,
        top_rank,
        top_score,
        artifact,
        notes
      ) VALUES (
        @scanId,
        @source,
        @fingerprint,
        @generatedAt,
        @expiresAt,
        @mode,
        @provider,
        @model,
        @marketsScanned,
        @newsItemsAnalyzed,
        @opportunitiesFound,
        @topMarketId,
        @topRank,
        @topScore,
        @artifact,
        @notes
      )
    `
  ).run({
    scanId: artifact.scanId,
    source: input.source ?? 'opportunities',
    fingerprint: input.fingerprint ?? null,
    generatedAt: normalizeDatetime(artifact.generatedAt),
    expiresAt: normalizeDatetime(artifact.expiresAt),
    mode: artifact.context.mode ?? null,
    provider: artifact.context.provider ?? null,
    model: artifact.context.model ?? null,
    marketsScanned: artifact.summary.marketsScanned,
    newsItemsAnalyzed: artifact.summary.newsItemsAnalyzed,
    opportunitiesFound: artifact.summary.opportunitiesFound,
    topMarketId: topOpportunity?.marketId ?? null,
    topRank: topOpportunity?.rank ?? null,
    topScore: topOpportunity?.score ?? null,
    artifact: serializeJson(artifact),
    notes: serializeJson(input.notes ?? null),
  });

  const row = db
    .prepare(
      `
        SELECT *
        FROM opportunity_rank_logs
        WHERE scan_id = ?
        LIMIT 1
      `
    )
    .get(artifact.scanId) as Record<string, unknown> | undefined;

  const record = rowToRecord(row);
  if (!record) {
    throw new Error(`Failed to persist opportunity rank scan ${artifact.scanId}`);
  }
  return record;
}

export function getOpportunityRankScan(scanId: string): OpportunityRankScanRecord | null {
  ensureSchema();
  const db = openDatabase();
  const row = db
    .prepare(
      `
        SELECT *
        FROM opportunity_rank_logs
        WHERE scan_id = ?
        LIMIT 1
      `
    )
    .get(scanId) as Record<string, unknown> | undefined;
  return rowToRecord(row);
}

export function listRecentOpportunityRankScans(limit = 20): OpportunityRankScanRecord[] {
  ensureSchema();
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM opportunity_rank_logs
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `
    )
    .all(limit) as Record<string, unknown>[];

  return rows.map((row) => rowToRecord(row)).filter((row): row is OpportunityRankScanRecord => !!row);
}

export function findLatestOpportunityRankScan(params: {
  fingerprint?: string | null;
  source?: string | null;
  maxAgeMs?: number;
  requireNotExpired?: boolean;
}): OpportunityRankScanRecord | null {
  ensureSchema();
  const db = openDatabase();
  const now = new Date();
  const cutoff = params.maxAgeMs ? toSqliteDatetime(new Date(now.getTime() - params.maxAgeMs)) : null;
  const requireNotExpired = params.requireNotExpired ?? true;
  const row = db
    .prepare(
      `
        SELECT *
        FROM opportunity_rank_logs
        WHERE (@fingerprint IS NULL OR fingerprint = @fingerprint)
          AND (@source IS NULL OR source = @source)
          AND (@cutoff IS NULL OR created_at >= @cutoff)
          AND (${requireNotExpired ? "(expires_at IS NULL OR expires_at > datetime('now'))" : '1=1'})
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
    )
    .get({
      fingerprint: params.fingerprint ?? null,
      source: params.source ?? null,
      cutoff,
    }) as Record<string, unknown> | undefined;

  return rowToRecord(row);
}
