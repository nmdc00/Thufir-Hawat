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

describe('perp_trades schema', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.THUFIR_DB_PATH = createTempDbPath('thufir-perp-trades-');
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

  it('creates secondary indices for symbol, status, and created_at', async () => {
    const { openDatabase } = await import('../../src/memory/db.js');
    const db = openDatabase();

    const indices = db.prepare("PRAGMA index_list('perp_trades')").all() as Array<{ name: string }>;
    const names = new Set(indices.map((index) => index.name));

    expect(names.has('idx_perp_trades_symbol')).toBe(true);
    expect(names.has('idx_perp_trades_status')).toBe(true);
    expect(names.has('idx_perp_trades_created')).toBe(true);
  });

  it('migrates legacy lifecycle rows to cascade-backed schema and drops orphans', async () => {
    const dbPath = createTempDbPath('thufir-perp-trades-legacy-');
    const raw = new Database(dbPath);
    raw.pragma('foreign_keys = OFF');
    raw.exec(`
      CREATE TABLE perp_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hypothesis_id TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        size REAL NOT NULL,
        execution_mode TEXT,
        price REAL,
        leverage REAL,
        order_type TEXT,
        status TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE perp_position_lifecycles (
        symbol TEXT PRIMARY KEY,
        trade_id INTEGER NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('long', 'short')),
        opened_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (trade_id) REFERENCES perp_trades(id)
      );
      INSERT INTO perp_trades (id, symbol, side, size, execution_mode, status)
      VALUES (1, 'XYZ:CL', 'buy', 1.25, 'paper', 'position_open');
      INSERT INTO perp_position_lifecycles (symbol, trade_id, side)
      VALUES ('XYZ:CL', 1, 'long');
      INSERT INTO perp_position_lifecycles (symbol, trade_id, side)
      VALUES ('ORPHAN', 999, 'short');
    `);
    raw.close();

    process.env.THUFIR_DB_PATH = dbPath;
    vi.resetModules();
    const { openDatabase } = await import('../../src/memory/db.js');
    const db = openDatabase();

    const lifecycleSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'perp_position_lifecycles'")
      .get() as { sql: string };
    expect(lifecycleSql.sql).toContain('ON DELETE CASCADE');

    const lifecycleRows = db
      .prepare('SELECT symbol, trade_id FROM perp_position_lifecycles ORDER BY symbol')
      .all() as Array<{ symbol: string; trade_id: number }>;
    expect(lifecycleRows).toEqual([{ symbol: 'XYZ:CL', trade_id: 1 }]);

    db.prepare('DELETE FROM perp_trades WHERE id = 1').run();

    const remaining = (db.prepare('SELECT COUNT(*) AS c FROM perp_position_lifecycles').get() as { c: number }).c;
    expect(remaining).toBe(0);
  });

  it('scrubs orphaned lifecycle rows on read', async () => {
    const { openDatabase } = await import('../../src/memory/db.js');
    const { getActivePerpPositionTradeId } = await import('../../src/memory/perp_trades.js');
    const db = openDatabase();

    getActivePerpPositionTradeId('BOOTSTRAP');
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `
        INSERT INTO perp_position_lifecycles (symbol, trade_id, side, opened_at, updated_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
      `
    ).run('XYZ:CL', 999, 'long');
    db.pragma('foreign_keys = ON');

    expect(getActivePerpPositionTradeId('XYZ:CL')).toBeNull();

    const remaining = (db.prepare("SELECT COUNT(*) AS c FROM perp_position_lifecycles WHERE symbol = 'XYZ:CL'").get() as { c: number }).c;
    expect(remaining).toBe(0);
  });
});
