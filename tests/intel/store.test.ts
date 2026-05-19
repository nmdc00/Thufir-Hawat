import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const previousDbPath = process.env.THUFIR_DB_PATH;

function createTempDbPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return join(dir, 'thufir.sqlite');
}

describe('pruneIntel', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.THUFIR_DB_PATH = createTempDbPath('thufir-intel-store-');
  });

  afterEach(() => {
    vi.resetModules();
    const dbPath = process.env.THUFIR_DB_PATH;
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(dirname(dbPath), { recursive: true, force: true });
    }
    if (previousDbPath === undefined) {
      delete process.env.THUFIR_DB_PATH;
    } else {
      process.env.THUFIR_DB_PATH = previousDbPath;
    }
  });

  it('returns 0 when nothing to prune', async () => {
    const { openDatabase } = await import('../../src/memory/db.js');
    const { pruneIntel } = await import('../../src/intel/store.js');
    openDatabase();

    expect(pruneIntel(30)).toBe(0);
  });

  it('deletes old intel hashes, embeddings, and items together', async () => {
    const { openDatabase } = await import('../../src/memory/db.js');
    const { pruneIntel } = await import('../../src/intel/store.js');
    const db = openDatabase();

    db.exec(`
      INSERT INTO intel_items (id, title, content, source, source_type, timestamp)
      VALUES
        ('old', 'Old item', 'old', 'test', 'news', '2026-01-01T00:00:00.000Z'),
        ('new', 'New item', 'new', 'test', 'news', '2026-05-19T00:00:00.000Z');
      INSERT INTO intel_hashes (hash, intel_id)
      VALUES
        ('hash-old', 'old'),
        ('hash-new', 'new');
      INSERT INTO intel_embeddings (intel_id, embedding)
      VALUES
        ('old', '[0.1,0.2]'),
        ('new', '[0.3,0.4]');
    `);

    expect(pruneIntel(30)).toBe(1);

    const remainingItems = db.prepare('SELECT id FROM intel_items ORDER BY id').all() as Array<{ id: string }>;
    const remainingHashes = db.prepare('SELECT intel_id FROM intel_hashes ORDER BY intel_id').all() as Array<{ intel_id: string }>;
    const remainingEmbeddings = db
      .prepare('SELECT intel_id FROM intel_embeddings ORDER BY intel_id')
      .all() as Array<{ intel_id: string }>;

    expect(remainingItems).toEqual([{ id: 'new' }]);
    expect(remainingHashes).toEqual([{ intel_id: 'new' }]);
    expect(remainingEmbeddings).toEqual([{ intel_id: 'new' }]);
  });

  it('migrates legacy intel dependencies to cascade-backed tables and drops orphaned rows', async () => {
    const dbPath = createTempDbPath('thufir-intel-legacy-');
    const raw = new Database(dbPath);
    raw.pragma('foreign_keys = OFF');
    raw.exec(`
      CREATE TABLE intel_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT,
        source TEXT NOT NULL,
        source_type TEXT,
        category TEXT,
        url TEXT,
        timestamp TEXT NOT NULL,
        entities TEXT,
        sentiment REAL,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE intel_hashes (
        hash TEXT PRIMARY KEY,
        intel_id TEXT REFERENCES intel_items(id),
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE intel_embeddings (
        intel_id TEXT PRIMARY KEY,
        embedding TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO intel_items (id, title, source, source_type, timestamp)
      VALUES ('keep', 'Keep', 'test', 'news', '2026-05-19T00:00:00.000Z');
      INSERT INTO intel_hashes (hash, intel_id) VALUES ('hash-keep', 'keep');
      INSERT INTO intel_hashes (hash, intel_id) VALUES ('hash-orphan', 'ghost');
      INSERT INTO intel_embeddings (intel_id, embedding) VALUES ('keep', '[1]');
      INSERT INTO intel_embeddings (intel_id, embedding) VALUES ('ghost', '[9]');
    `);
    raw.close();

    process.env.THUFIR_DB_PATH = dbPath;
    const { openDatabase } = await import('../../src/memory/db.js');
    const db = openDatabase();

    const hashesSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'intel_hashes'")
      .get() as { sql: string };
    const embeddingsSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'intel_embeddings'")
      .get() as { sql: string };

    expect(hashesSql.sql).toContain('ON DELETE CASCADE');
    expect(embeddingsSql.sql).toContain('ON DELETE CASCADE');

    const hashes = db.prepare('SELECT hash, intel_id FROM intel_hashes ORDER BY hash').all() as Array<{ hash: string; intel_id: string }>;
    const embeddings = db
      .prepare('SELECT intel_id FROM intel_embeddings ORDER BY intel_id')
      .all() as Array<{ intel_id: string }>;

    expect(hashes).toEqual([{ hash: 'hash-keep', intel_id: 'keep' }]);
    expect(embeddings).toEqual([{ intel_id: 'keep' }]);

    db.prepare("DELETE FROM intel_items WHERE id = 'keep'").run();

    const remainingHashes = (db.prepare('SELECT COUNT(*) AS c FROM intel_hashes').get() as { c: number }).c;
    const remainingEmbeddings = (db.prepare('SELECT COUNT(*) AS c FROM intel_embeddings').get() as { c: number }).c;

    expect(remainingHashes).toBe(0);
    expect(remainingEmbeddings).toBe(0);
  });
});
