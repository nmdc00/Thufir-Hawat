import { createHash } from 'node:crypto';

import { openDatabase } from '../memory/db.js';

export interface StoredIntel {
  id: string;
  title: string;
  content?: string;
  source: string;
  sourceType: 'news' | 'social' | 'data' | 'custom';
  category?: string;
  url?: string;
  timestamp: string;
}

function hashIntel(title: string, url?: string): string {
  const hash = createHash('sha256');
  hash.update(title);
  if (url) {
    hash.update(url);
  }
  return hash.digest('hex');
}

function coerceString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function storeIntel(item: StoredIntel): boolean {
  const db = openDatabase();
  const title = coerceString(item.title) ?? 'Untitled';
  const content = coerceString(item.content);
  const source = coerceString(item.source) ?? 'unknown';
  const sourceType = item.sourceType;
  const category = coerceString(item.category);
  const url = coerceString(item.url);
  const timestamp = coerceString(item.timestamp) ?? new Date().toISOString();

  const digest = hashIntel(title, url ?? undefined);

  const exists = db
    .prepare(`SELECT 1 FROM intel_hashes WHERE hash = ? LIMIT 1`)
    .get(digest);
  if (exists) {
    return false;
  }

  const insertIntel = db.prepare(
    `
      INSERT INTO intel_items (
        id, title, content, source, source_type, category, url, timestamp
      ) VALUES (
        @id, @title, @content, @source, @sourceType, @category, @url, @timestamp
      )
    `
  );

  insertIntel.run({
    id: item.id,
    title,
    content,
    source,
    sourceType,
    category,
    url,
    timestamp,
  });

  db.prepare(`INSERT INTO intel_hashes (hash, intel_id) VALUES (?, ?)`).run(
    digest,
    item.id
  );

  return true;
}

export function listRecentIntel(limit = 20): StoredIntel[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT id, title, content, source, source_type as sourceType, category, url, timestamp
        FROM intel_items
        ORDER BY timestamp DESC
        LIMIT ?
      `
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    content: (row.content as string) ?? undefined,
    source: String(row.source),
    sourceType: row.sourceType as StoredIntel['sourceType'],
    category: (row.category as string) ?? undefined,
    url: (row.url as string) ?? undefined,
    timestamp: String(row.timestamp),
  }));
}

export function searchIntel(params: {
  query: string;
  limit?: number;
  fromDays?: number;
}): StoredIntel[] {
  const db = openDatabase();
  const limit = params.limit ?? 10;
  const like = `%${params.query}%`;

  let rows: Array<Record<string, unknown>>;
  if (params.fromDays && params.fromDays > 0) {
    rows = db
      .prepare(
        `
          SELECT id, title, content, source, source_type as sourceType, category, url, timestamp
          FROM intel_items
          WHERE (title LIKE ? OR content LIKE ?)
            AND timestamp >= datetime('now', ?)
          ORDER BY timestamp DESC
          LIMIT ?
        `
      )
      .all(like, like, `-${params.fromDays} days`, limit) as Array<
        Record<string, unknown>
      >;
  } else {
    rows = db
      .prepare(
        `
          SELECT id, title, content, source, source_type as sourceType, category, url, timestamp
          FROM intel_items
          WHERE title LIKE ? OR content LIKE ?
          ORDER BY timestamp DESC
          LIMIT ?
        `
      )
      .all(like, like, limit) as Array<Record<string, unknown>>;
  }

  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    content: (row.content as string) ?? undefined,
    source: String(row.source),
    sourceType: row.sourceType as StoredIntel['sourceType'],
    category: (row.category as string) ?? undefined,
    url: (row.url as string) ?? undefined,
    timestamp: String(row.timestamp),
  }));
}

export function listIntelByIds(ids: string[]): StoredIntel[] {
  if (ids.length === 0) {
    return [];
  }
  const db = openDatabase();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
        SELECT id, title, content, source, source_type as sourceType, category, url, timestamp
        FROM intel_items
        WHERE id IN (${placeholders})
      `
    )
    .all(...ids) as Array<Record<string, unknown>>;

  const map = new Map(rows.map((row) => [String(row.id), row]));
  return ids
    .map((id) => map.get(id))
    .filter(Boolean)
    .map((row) => ({
      id: String(row!.id),
      title: String(row!.title),
      content: (row!.content as string) ?? undefined,
      source: String(row!.source),
      sourceType: row!.sourceType as StoredIntel['sourceType'],
      category: (row!.category as string) ?? undefined,
      url: (row!.url as string) ?? undefined,
      timestamp: String(row!.timestamp),
    }));
}

export function pruneIntel(retentionDays: number): number {
  const days = Math.max(1, Math.floor(retentionDays));
  const db = openDatabase();
  const cutoff = `-${days} days`;

  const toDelete = db
    .prepare(
      `
        SELECT id FROM intel_items
        WHERE timestamp < datetime('now', ?)
      `
    )
    .all(cutoff) as Array<{ id: string }>;

  if (toDelete.length === 0) {
    return 0;
  }

  const ids = toDelete.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM intel_embeddings WHERE intel_id IN (${placeholders})`
  ).run(...ids);
  const result = db
    .prepare(`DELETE FROM intel_items WHERE id IN (${placeholders})`)
    .run(...ids);

  return result.changes ?? 0;
}
