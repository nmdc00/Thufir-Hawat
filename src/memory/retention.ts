import type Database from 'better-sqlite3';

export type RetentionKindRule =
  | { mode: 'all' }
  | { mode: 'include'; values: string[] }
  | { mode: 'exclude'; values: string[]; prefixes?: string[] };

export interface RetentionPolicy {
  table: string;
  timestampColumn?: string;
  expirationColumn?: string;
  retainDays: number;
  batchSize?: number;
  kindColumn?: string;
  kindRule?: RetentionKindRule;
  whereSql?: string;
}

export interface RetentionPolicyResult {
  table: string;
  deleted: number;
  batches: number;
  skipped: boolean;
  reason?: string;
}

export interface RetentionVacuumResult {
  autoVacuum: number;
  beforeFreePages: number;
  afterFreePages: number;
  reclaimedPages: number;
  ranIncrementalVacuum: boolean;
  message: string;
}

export interface RetentionApplyResult {
  policies: RetentionPolicyResult[];
  countsByTable: Record<string, number>;
  vacuum: RetentionVacuumResult;
}

const DEFAULT_BATCH_SIZE = 5_000;
const MAX_INCREMENTAL_VACUUM_PAGES = 1_000;
const policies = new Map<string, RetentionPolicy>();

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid retention ${label}: ${value}`);
  }
}

function normalizePolicy(policy: RetentionPolicy): RetentionPolicy {
  assertIdentifier(policy.table, 'table');
  const timestampColumn = policy.timestampColumn ?? 'created_at';
  assertIdentifier(timestampColumn, 'timestampColumn');
  if (policy.expirationColumn) {
    assertIdentifier(policy.expirationColumn, 'expirationColumn');
  }
  if (policy.kindColumn) {
    assertIdentifier(policy.kindColumn, 'kindColumn');
  }
  if (!Number.isFinite(policy.retainDays) || policy.retainDays <= 0) {
    throw new Error(`Retention policy for ${policy.table} must have retainDays > 0`);
  }
  const batchSize = Math.max(1, Math.floor(policy.batchSize ?? DEFAULT_BATCH_SIZE));
  return { ...policy, timestampColumn, batchSize };
}

export function registerRetentionPolicy(policy: RetentionPolicy): void {
  const normalized = normalizePolicy(policy);
  policies.set(normalized.table, normalized);
}

export function listRetentionPolicies(): RetentionPolicy[] {
  return Array.from(policies.values());
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(table);
  return !!row;
}

function buildKindPredicate(policy: RetentionPolicy, params: Record<string, unknown>): string {
  const { kindColumn, kindRule } = policy;
  if (!kindColumn || !kindRule || kindRule.mode === 'all') {
    return '1=1';
  }

  if (kindRule.mode === 'include') {
    const placeholders = kindRule.values.map((value, index) => {
      const key = `kindInclude${index}`;
      params[key] = value;
      return `@${key}`;
    });
    return `${kindColumn} IN (${placeholders.join(', ')})`;
  }

  const clauses: string[] = [];
  if (kindRule.values.length > 0) {
    const placeholders = kindRule.values.map((value, index) => {
      const key = `kindExclude${index}`;
      params[key] = value;
      return `@${key}`;
    });
    clauses.push(`${kindColumn} NOT IN (${placeholders.join(', ')})`);
  }
  for (const [index, prefix] of (kindRule.prefixes ?? []).entries()) {
    const key = `kindExcludePrefix${index}`;
    params[key] = `${prefix}%`;
    clauses.push(`${kindColumn} NOT LIKE @${key}`);
  }
  return clauses.length > 0 ? clauses.join(' AND ') : '1=1';
}

function applyPolicy(db: Database.Database, policy: RetentionPolicy, now: Date): RetentionPolicyResult {
  if (!tableExists(db, policy.table)) {
    return { table: policy.table, deleted: 0, batches: 0, skipped: true, reason: 'table_missing' };
  }

  const cutoff = new Date(now.getTime() - policy.retainDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const nowSql = now.toISOString().replace('T', ' ').slice(0, 19);
  let deleted = 0;
  let batches = 0;
  const batchSize = policy.batchSize ?? DEFAULT_BATCH_SIZE;

  for (;;) {
    const params: Record<string, unknown> = { cutoff, nowSql, batchSize };
    const kindPredicate = buildKindPredicate(policy, params);
    const extraPredicate = policy.whereSql ? ` AND (${policy.whereSql})` : '';
    const agePredicate = `datetime(${policy.timestampColumn}) < datetime(@cutoff)`;
    const expiryPredicate = policy.expirationColumn
      ? ` OR (${policy.expirationColumn} IS NOT NULL AND datetime(${policy.expirationColumn}) <= datetime(@nowSql))`
      : '';
    const statement = db.prepare(`
      DELETE FROM ${policy.table}
      WHERE rowid IN (
        SELECT rowid
        FROM ${policy.table}
        WHERE ${policy.timestampColumn} IS NOT NULL
          AND (${agePredicate}${expiryPredicate})
          AND ${kindPredicate}
          ${extraPredicate}
        LIMIT @batchSize
      )
    `);
    const result = statement.run(params);
    const changes = Number(result.changes ?? 0);
    if (changes <= 0) {
      break;
    }
    deleted += changes;
    batches += 1;
    if (changes < batchSize) {
      break;
    }
  }

  return { table: policy.table, deleted, batches, skipped: false };
}

function readPragmaNumber(db: Database.Database, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : 0;
  return Number(value ?? 0);
}

function runIncrementalVacuum(db: Database.Database): RetentionVacuumResult {
  const autoVacuum = readPragmaNumber(db, 'auto_vacuum');
  const beforeFreePages = readPragmaNumber(db, 'freelist_count');
  if (autoVacuum !== 2) {
    return {
      autoVacuum,
      beforeFreePages,
      afterFreePages: beforeFreePages,
      reclaimedPages: 0,
      ranIncrementalVacuum: false,
      message: `incremental_vacuum cannot reclaim pages because auto_vacuum=${autoVacuum}; run manual VACUUM during maintenance if file shrink is required`,
    };
  }
  if (beforeFreePages <= 0) {
    return {
      autoVacuum,
      beforeFreePages,
      afterFreePages: beforeFreePages,
      reclaimedPages: 0,
      ranIncrementalVacuum: false,
      message: 'incremental_vacuum skipped because freelist_count is 0',
    };
  }

  db.exec(`PRAGMA incremental_vacuum(${Math.min(beforeFreePages, MAX_INCREMENTAL_VACUUM_PAGES)})`);
  const afterFreePages = readPragmaNumber(db, 'freelist_count');
  return {
    autoVacuum,
    beforeFreePages,
    afterFreePages,
    reclaimedPages: Math.max(0, beforeFreePages - afterFreePages),
    ranIncrementalVacuum: true,
    message:
      afterFreePages < beforeFreePages
        ? `incremental_vacuum reclaimed ${beforeFreePages - afterFreePages} page(s)`
        : 'incremental_vacuum ran but did not reclaim pages',
  };
}

export function applyRetentionPolicies(db: Database.Database, options?: { now?: Date }): RetentionApplyResult {
  const now = options?.now ?? new Date();
  const results = Array.from(policies.values()).map((policy) => applyPolicy(db, policy, now));
  const countsByTable: Record<string, number> = {};
  for (const result of results) {
    countsByTable[result.table] = (countsByTable[result.table] ?? 0) + result.deleted;
  }
  return {
    policies: results,
    countsByTable,
    vacuum: runIncrementalVacuum(db),
  };
}
