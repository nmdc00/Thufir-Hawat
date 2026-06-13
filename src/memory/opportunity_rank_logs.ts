import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';
import { registerRetentionPolicy } from './retention.js';
import type { OpportunityRankRecord } from '../core/opportunity_types.js';

export interface OpportunityRankScanInput {
  scanId?: string | null;
  source?: string | null;
  fingerprint?: string | null;
  generatedAt?: string | null;
  triggerReason?: string | null;
  totalCandidates: number;
  eligibleCandidates: number;
  selectedSymbol?: string | null;
  selectionReason?: string | null;
  rankedCandidates: OpportunityRankRecord[];
  payload?: Record<string, unknown> | null;
  notes?: Record<string, unknown> | null;
}

export interface OpportunityRankScanCandidate extends OpportunityRankRecord {
  artifact: Record<string, unknown> | null;
}

export interface OpportunityRankScanRecord {
  scanId: string;
  createdAt: string;
  source: string | null;
  fingerprint: string | null;
  generatedAt: string | null;
  triggerReason: string | null;
  totalCandidates: number;
  eligibleCandidates: number;
  selectedSymbol: string | null;
  selectionReason: string | null;
  candidates: OpportunityRankScanCandidate[];
  payload: Record<string, unknown> | null;
  notes: Record<string, unknown> | null;
}

registerRetentionPolicy({
  table: 'opportunity_rank_logs',
  timestampColumn: 'created_at',
  retainDays: 30,
});

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
  return value.includes('T') ? value.replace('T', ' ').slice(0, 19) : value.slice(0, 19);
}

function toSqliteDatetime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
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
      trigger_reason TEXT,
      symbol TEXT,
      symbol_class TEXT,
      rank INTEGER,
      opportunity_score REAL,
      component_scores TEXT,
      trigger_reasons TEXT,
      failed_floors TEXT,
      selected_for_shortlist INTEGER NOT NULL DEFAULT 0,
      total_candidates INTEGER NOT NULL DEFAULT 0,
      eligible_candidates INTEGER NOT NULL DEFAULT 0,
      selected_symbol TEXT,
      selection_reason TEXT,
      artifact TEXT,
      payload TEXT,
      notes TEXT
    )
  `);

  const columns = db.prepare("PRAGMA table_info('opportunity_rank_logs')").all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => String(column.name ?? '')));
  const addColumnIfMissing = (name: string, definition: string): void => {
    if (columnNames.has(name)) return;
    db.exec(`ALTER TABLE opportunity_rank_logs ADD COLUMN ${definition}`);
    columnNames.add(name);
  };

  addColumnIfMissing('scan_id', 'scan_id TEXT');
  addColumnIfMissing('source', 'source TEXT');
  addColumnIfMissing('fingerprint', 'fingerprint TEXT');
  addColumnIfMissing('generated_at', 'generated_at TEXT');
  addColumnIfMissing('trigger_reason', 'trigger_reason TEXT');
  addColumnIfMissing('symbol', 'symbol TEXT');
  addColumnIfMissing('symbol_class', 'symbol_class TEXT');
  addColumnIfMissing('rank', 'rank INTEGER');
  addColumnIfMissing('opportunity_score', 'opportunity_score REAL');
  addColumnIfMissing('component_scores', 'component_scores TEXT');
  addColumnIfMissing('trigger_reasons', 'trigger_reasons TEXT');
  addColumnIfMissing('failed_floors', 'failed_floors TEXT');
  addColumnIfMissing(
    'selected_for_shortlist',
    'selected_for_shortlist INTEGER NOT NULL DEFAULT 0'
  );
  addColumnIfMissing('total_candidates', 'total_candidates INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('eligible_candidates', 'eligible_candidates INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('selected_symbol', 'selected_symbol TEXT');
  addColumnIfMissing('selection_reason', 'selection_reason TEXT');
  addColumnIfMissing('artifact', 'artifact TEXT');
  addColumnIfMissing('payload', 'payload TEXT');
  addColumnIfMissing('notes', 'notes TEXT');

  db.exec(`DROP INDEX IF EXISTS idx_opportunity_rank_logs_scan_id`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_opportunity_rank_logs_scan_id
      ON opportunity_rank_logs(scan_id);
    CREATE INDEX IF NOT EXISTS idx_opportunity_rank_logs_created
      ON opportunity_rank_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_opportunity_rank_logs_fingerprint
      ON opportunity_rank_logs(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_opportunity_rank_logs_rank
      ON opportunity_rank_logs(scan_id, rank);
  `);
}

function rowToCandidate(row: Record<string, unknown>): OpportunityRankScanCandidate {
  return {
    scanId: String(row.scan_id ?? ''),
    symbol: String(row.symbol ?? ''),
    symbolClass: (row.symbol_class ?? 'unknown') as OpportunityRankScanCandidate['symbolClass'],
    rank: Number(row.rank ?? 0),
    opportunityScore: Number(row.opportunity_score ?? 0),
    componentScores:
      parseJson<OpportunityRankScanCandidate['componentScores']>(row.component_scores) ?? {
        attentionScore: 0,
        structuralEdgeScore: 0,
        crowdingQualityScore: 0,
        regimeFitScore: 0,
        executionQualityScore: 0,
      },
    triggerReasons: parseJson<string[]>(row.trigger_reasons) ?? [],
    failedFloors: parseJson<OpportunityRankScanCandidate['failedFloors']>(row.failed_floors) ?? [],
    selectedForShortlist: Number(row.selected_for_shortlist ?? 0) === 1,
    createdAt: String(row.created_at ?? ''),
    artifact: parseJson<Record<string, unknown>>(row.artifact),
  };
}

function rowsToRecord(rows: Record<string, unknown>[]): OpportunityRankScanRecord | null {
  if (rows.length === 0) return null;
  const first = rows[0]!;
  return {
    scanId: String(first.scan_id ?? ''),
    createdAt: String(first.created_at ?? ''),
    source: first.source == null ? null : String(first.source),
    fingerprint: first.fingerprint == null ? null : String(first.fingerprint),
    generatedAt: first.generated_at == null ? null : String(first.generated_at),
    triggerReason: first.trigger_reason == null ? null : String(first.trigger_reason),
    totalCandidates: Number(first.total_candidates ?? 0),
    eligibleCandidates: Number(first.eligible_candidates ?? 0),
    selectedSymbol: first.selected_symbol == null ? null : String(first.selected_symbol),
    selectionReason: first.selection_reason == null ? null : String(first.selection_reason),
    candidates: rows.map(rowToCandidate),
    payload: parseJson<Record<string, unknown>>(first.payload),
    notes: parseJson<Record<string, unknown>>(first.notes),
  };
}

export function recordOpportunityRankScan(input: OpportunityRankScanInput): OpportunityRankScanRecord {
  ensureSchema();
  const db = openDatabase();
  const scanId = input.scanId?.trim() || `opportunity_rank_scan_${randomUUID()}`;
  const createdAt = normalizeDatetime(input.generatedAt) ?? toSqliteDatetime(new Date());
  const insert = db.prepare(`
    INSERT INTO opportunity_rank_logs (
      scan_id,
      source,
      fingerprint,
      generated_at,
      trigger_reason,
      symbol,
      symbol_class,
      rank,
      opportunity_score,
      component_scores,
      trigger_reasons,
      failed_floors,
      selected_for_shortlist,
      total_candidates,
      eligible_candidates,
      selected_symbol,
      selection_reason,
      artifact,
      payload,
      notes
    ) VALUES (
      @scanId,
      @source,
      @fingerprint,
      @generatedAt,
      @triggerReason,
      @symbol,
      @symbolClass,
      @rank,
      @opportunityScore,
      @componentScores,
      @triggerReasons,
      @failedFloors,
      @selectedForShortlist,
      @totalCandidates,
      @eligibleCandidates,
      @selectedSymbol,
      @selectionReason,
      @artifact,
      @payload,
      @notes
    )
  `);

  const tx = db.transaction(() => {
    const candidates = input.rankedCandidates.length > 0 ? input.rankedCandidates : [
      {
        scanId,
        symbol: '',
        symbolClass: 'unknown' as const,
        rank: 0,
        opportunityScore: 0,
        componentScores: {
          attentionScore: 0,
          structuralEdgeScore: 0,
          crowdingQualityScore: 0,
          regimeFitScore: 0,
          executionQualityScore: 0,
        },
        triggerReasons: [],
        failedFloors: [],
        selectedForShortlist: false,
        createdAt,
      },
    ];
    for (const candidate of candidates) {
      insert.run({
        scanId,
        source: input.source ?? 'autonomous_originator_scan',
        fingerprint: input.fingerprint ?? null,
        generatedAt: createdAt,
        triggerReason: input.triggerReason ?? null,
        symbol: candidate.symbol,
        symbolClass: candidate.symbolClass,
        rank: candidate.rank,
        opportunityScore: candidate.opportunityScore,
        componentScores: serializeJson(candidate.componentScores),
        triggerReasons: serializeJson(candidate.triggerReasons),
        failedFloors: serializeJson(candidate.failedFloors),
        selectedForShortlist: candidate.selectedForShortlist ? 1 : 0,
        totalCandidates: input.totalCandidates,
        eligibleCandidates: input.eligibleCandidates,
        selectedSymbol: input.selectedSymbol ?? null,
        selectionReason: input.selectionReason ?? null,
        artifact: serializeJson(candidate.symbol
          ? {
          ...candidate,
          createdAt: candidate.createdAt,
        }
          : {
            scanId,
            totalCandidates: input.totalCandidates,
            eligibleCandidates: input.eligibleCandidates,
          }),
        payload: serializeJson(input.payload ?? null),
        notes: serializeJson(input.notes ?? null),
      });
    }
  });
  tx();

  const record = getOpportunityRankScan(scanId);
  if (!record) {
    throw new Error(`Failed to persist opportunity rank scan ${scanId}`);
  }
  return record;
}

export function getOpportunityRankScan(scanId: string): OpportunityRankScanRecord | null {
  ensureSchema();
  const db = openDatabase();
  const rows = db
    .prepare(`
      SELECT *
      FROM opportunity_rank_logs
      WHERE scan_id = ?
      ORDER BY rank ASC, id ASC
    `)
    .all(scanId) as Record<string, unknown>[];
  return rowsToRecord(rows);
}

export function listRecentOpportunityRankScans(limit = 20): OpportunityRankScanRecord[] {
  ensureSchema();
  const db = openDatabase();
  const scanIds = db
    .prepare(`
      SELECT scan_id
      FROM opportunity_rank_logs
      GROUP BY scan_id
      ORDER BY MAX(id) DESC
      LIMIT ?
    `)
    .all(limit) as Array<{ scan_id: string }>;
  return scanIds
    .map((row) => getOpportunityRankScan(row.scan_id))
    .filter((row): row is OpportunityRankScanRecord => row !== null);
}

export function findLatestOpportunityRankScan(params: {
  fingerprint?: string | null;
  source?: string | null;
  maxAgeMs?: number;
}): OpportunityRankScanRecord | null {
  ensureSchema();
  const db = openDatabase();
  const cutoff = params.maxAgeMs ? toSqliteDatetime(new Date(Date.now() - params.maxAgeMs)) : null;
  const row = db
    .prepare(`
      SELECT scan_id
      FROM opportunity_rank_logs
      WHERE (@fingerprint IS NULL OR fingerprint = @fingerprint)
        AND (@source IS NULL OR source = @source)
        AND (@cutoff IS NULL OR created_at >= @cutoff)
      GROUP BY scan_id
      ORDER BY MAX(id) DESC
      LIMIT 1
    `)
    .get({
      fingerprint: params.fingerprint ?? null,
      source: params.source ?? null,
      cutoff,
    }) as { scan_id?: string } | undefined;

  return row?.scan_id ? getOpportunityRankScan(row.scan_id) : null;
}
