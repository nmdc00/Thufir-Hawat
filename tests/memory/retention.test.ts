import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/memory/db.js';
import {
  applyRetentionPolicies,
  listRetentionPolicies,
  registerRetentionPolicy,
} from '../../src/memory/retention.js';
import '../../src/memory/decision_artifacts.js';
import '../../src/memory/opportunity_rank_logs.js';
import '../../src/memory/llm_entry_gate_log.js';

describe('memory retention registry', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;
  const now = new Date('2026-06-13T12:00:00.000Z');

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-retention-'));
    process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');
  });

  afterEach(() => {
    if (process.env.THUFIR_DB_PATH) {
      closeDatabase(process.env.THUFIR_DB_PATH);
      rmSync(process.env.THUFIR_DB_PATH, { force: true });
      rmSync(dirname(process.env.THUFIR_DB_PATH), { recursive: true, force: true });
    }
    if (originalDbPath === undefined) {
      delete process.env.THUFIR_DB_PATH;
    } else {
      process.env.THUFIR_DB_PATH = originalDbPath;
    }
  });

  it('applies default policies with protected kinds, explicit expirations, and per-table counts', () => {
    const db = openDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS opportunity_rank_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT DEFAULT (datetime('now')),
        total_candidates INTEGER NOT NULL DEFAULT 0,
        eligible_candidates INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO decision_artifacts (created_at, kind, expires_at)
      VALUES
        ('2026-05-01 00:00:00', 'position_heartbeat_journal', NULL),
        ('2026-06-12 00:00:00', 'signal_cluster', '2026-06-12 01:00:00'),
        ('2026-05-01 00:00:00', 'perp_trade_snapshot', '2026-05-02 00:00:00'),
        ('2026-06-12 00:00:00', 'expression', NULL);

      INSERT INTO opportunity_rank_logs (created_at, total_candidates, eligible_candidates)
      VALUES
        ('2026-05-01 00:00:00', 1, 1),
        ('2026-06-01 00:00:00', 1, 1);

      INSERT INTO llm_entry_gate_log
        (created_at, symbol, side, notional_usd, verdict, reasoning, used_fallback)
      VALUES
        ('2026-02-01 00:00:00', 'BTC', 'long', 100, 'reject', 'old reject', 0),
        ('2026-02-01 00:00:00', 'ETH', 'long', 100, 'approve', 'old approve', 0),
        ('2026-02-01 00:00:00', 'SOL', 'long', 100, 'resize', 'old resize', 0),
        ('2026-06-01 00:00:00', 'DOGE', 'long', 100, 'reject', 'recent reject', 0);
    `);

    const result = applyRetentionPolicies(db, { now });

    expect(result.countsByTable).toMatchObject({
      decision_artifacts: 2,
      opportunity_rank_logs: 1,
      llm_entry_gate_log: 1,
    });
    expect(
      db.prepare('SELECT kind FROM decision_artifacts ORDER BY id').all()
    ).toEqual([{ kind: 'perp_trade_snapshot' }, { kind: 'expression' }]);
    expect(
      db.prepare('SELECT verdict FROM llm_entry_gate_log ORDER BY id').all()
    ).toEqual([{ verdict: 'approve' }, { verdict: 'resize' }, { verdict: 'reject' }]);
    expect(result.vacuum.message).toContain('incremental_vacuum');
  });

  it('reports batch counts for bounded deletes', () => {
    const db = openDatabase();
    db.exec(`
      CREATE TABLE retention_batch_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL
      );
      INSERT INTO retention_batch_rows (created_at)
      VALUES
        ('2026-01-01 00:00:00'),
        ('2026-01-01 00:00:00'),
        ('2026-01-01 00:00:00'),
        ('2026-01-01 00:00:00'),
        ('2026-01-01 00:00:00');
    `);
    registerRetentionPolicy({
      table: 'retention_batch_rows',
      retainDays: 1,
      batchSize: 2,
    });

    const result = applyRetentionPolicies(db, { now });
    const policy = result.policies.find((entry) => entry.table === 'retention_batch_rows');

    expect(policy).toMatchObject({ deleted: 5, batches: 3, skipped: false });
    expect(result.countsByTable.retention_batch_rows).toBe(5);
  });

  it('keeps policy registration idempotent per table', () => {
    registerRetentionPolicy({ table: 'idempotent_retention_table', retainDays: 7 });
    registerRetentionPolicy({ table: 'idempotent_retention_table', retainDays: 14 });

    const policies = listRetentionPolicies().filter(
      (policy) => policy.table === 'idempotent_retention_table'
    );

    expect(policies).toHaveLength(1);
    expect(policies[0]?.retainDays).toBe(14);
  });

  it('does not touch unregistered tables', () => {
    const db = openDatabase();
    db.exec(`
      CREATE TABLE unregistered_retention_control (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL
      );
      INSERT INTO unregistered_retention_control (created_at)
      VALUES ('2020-01-01 00:00:00'), ('2020-01-02 00:00:00');
    `);

    applyRetentionPolicies(db, { now });

    const row = db
      .prepare('SELECT COUNT(*) AS count FROM unregistered_retention_control')
      .get() as { count: number };
    expect(row.count).toBe(2);
  });

  it('does not prune user chat tables through v2.5 retention policies', () => {
    const db = openDatabase();
    db.exec(`
      INSERT INTO chat_messages (id, session_id, role, content, created_at)
      VALUES
        ('old-user-chat', 'session-1', 'user', 'keep me', '2020-01-01 00:00:00'),
        ('old-assistant-chat', 'session-1', 'assistant', 'keep me too', '2020-01-01 00:01:00');
    `);

    const result = applyRetentionPolicies(db, { now });

    expect(result.countsByTable.chat_messages).toBeUndefined();
    expect(listRetentionPolicies().some((policy) => policy.table === 'chat_messages')).toBe(false);
    expect(
      db.prepare('SELECT id FROM chat_messages ORDER BY created_at').all()
    ).toEqual([{ id: 'old-user-chat' }, { id: 'old-assistant-chat' }]);
  });
});
