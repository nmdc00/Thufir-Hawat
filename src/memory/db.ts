import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const DEFAULT_DB_PATH = join(homedir(), '.thufir', 'thufir.sqlite');
const INSTANCES = new Map<string, Database.Database>();

function getSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(here, 'schema.sql');
  return readFileSync(schemaPath, 'utf-8');
}

function ensureDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function applySchema(db: Database.Database): void {
  const schemaSql = getSchemaSql();
  db.exec(schemaSql);
}

export function openDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? process.env.THUFIR_DB_PATH ?? DEFAULT_DB_PATH;

  const existing = INSTANCES.get(resolvedPath);
  if (existing) {
    return existing;
  }

  ensureDirectory(resolvedPath);

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  applySchema(db);

  INSTANCES.set(resolvedPath, db);
  return db;
}
