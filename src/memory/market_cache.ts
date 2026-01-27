import { openDatabase } from './db.js';

export interface MarketCacheRecord {
  id: string;
  question: string;
  description?: string | null;
  outcomes?: string[] | null;
  prices?: Record<string, number> | null;
  volume?: number | null;
  liquidity?: number | null;
  endDate?: string | null;
  category?: string | null;
  resolved?: boolean | null;
  resolution?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

function serialize(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

function parseObject<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function upsertMarketCache(market: MarketCacheRecord): void {
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO market_cache (
        id,
        question,
        description,
        outcomes,
        prices,
        volume,
        liquidity,
        end_date,
        category,
        resolved,
        resolution,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @question,
        @description,
        @outcomes,
        @prices,
        @volume,
        @liquidity,
        @endDate,
        @category,
        @resolved,
        @resolution,
        @createdAt,
        datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        question = excluded.question,
        description = excluded.description,
        outcomes = excluded.outcomes,
        prices = excluded.prices,
        volume = excluded.volume,
        liquidity = excluded.liquidity,
        end_date = excluded.end_date,
        category = excluded.category,
        resolved = excluded.resolved,
        resolution = excluded.resolution,
        updated_at = datetime('now')
    `
  ).run({
    id: market.id,
    question: market.question,
    description: market.description ?? null,
    outcomes: serialize(market.outcomes ?? null),
    prices: serialize(market.prices ?? null),
    volume: market.volume ?? null,
    liquidity: market.liquidity ?? null,
    endDate: market.endDate ?? null,
    category: market.category ?? null,
    resolved: market.resolved ? 1 : 0,
    resolution: market.resolution ?? null,
    createdAt: market.createdAt ?? null,
  });
}

export function upsertMarketCacheBatch(markets: MarketCacheRecord[]): void {
  for (const market of markets) {
    upsertMarketCache(market);
  }
}

export function getMarketCache(id: string): MarketCacheRecord | null {
  const db = openDatabase();
  const row = db
    .prepare(
      `
        SELECT
          id,
          question,
          description,
          outcomes,
          prices,
          volume,
          liquidity,
          end_date as endDate,
          category,
          resolved,
          resolution,
          created_at as createdAt,
          updated_at as updatedAt
        FROM market_cache
        WHERE id = ?
      `
    )
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: String(row.id),
    question: String(row.question),
    description: (row.description as string | null) ?? null,
    outcomes: parseObject<string[]>((row.outcomes as string | null) ?? null),
    prices: parseObject<Record<string, number>>((row.prices as string | null) ?? null),
    volume: row.volume as number | null,
    liquidity: row.liquidity as number | null,
    endDate: (row.endDate as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    resolved: row.resolved === null ? null : Boolean(row.resolved),
    resolution: (row.resolution as string | null) ?? null,
    createdAt: (row.createdAt as string | null) ?? null,
    updatedAt: (row.updatedAt as string | null) ?? null,
  };
}

export function listMarketCache(limit = 50): MarketCacheRecord[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          question,
          description,
          outcomes,
          prices,
          volume,
          liquidity,
          end_date as endDate,
          category,
          resolved,
          resolution,
          created_at as createdAt,
          updated_at as updatedAt
        FROM market_cache
        WHERE resolved = 0
        ORDER BY volume DESC
        LIMIT ?
      `
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    question: String(row.question),
    description: (row.description as string | null) ?? null,
    outcomes: parseObject<string[]>((row.outcomes as string | null) ?? null),
    prices: parseObject<Record<string, number>>((row.prices as string | null) ?? null),
    volume: row.volume as number | null,
    liquidity: row.liquidity as number | null,
    endDate: (row.endDate as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    resolved: row.resolved === null ? null : Boolean(row.resolved),
    resolution: (row.resolution as string | null) ?? null,
    createdAt: (row.createdAt as string | null) ?? null,
    updatedAt: (row.updatedAt as string | null) ?? null,
  }));
}

export function searchMarketCache(query: string, limit = 50): MarketCacheRecord[] {
  const db = openDatabase();
  const needle = `%${query.toLowerCase()}%`;
  const rows = db
    .prepare(
      `
        SELECT
          id,
          question,
          description,
          outcomes,
          prices,
          volume,
          liquidity,
          end_date as endDate,
          category,
          resolved,
          resolution,
          created_at as createdAt,
          updated_at as updatedAt
        FROM market_cache
        WHERE resolved = 0
          AND (LOWER(question) LIKE ? OR LOWER(description) LIKE ?)
        ORDER BY volume DESC
        LIMIT ?
      `
    )
    .all(needle, needle, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    question: String(row.question),
    description: (row.description as string | null) ?? null,
    outcomes: parseObject<string[]>((row.outcomes as string | null) ?? null),
    prices: parseObject<Record<string, number>>((row.prices as string | null) ?? null),
    volume: row.volume as number | null,
    liquidity: row.liquidity as number | null,
    endDate: (row.endDate as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    resolved: row.resolved === null ? null : Boolean(row.resolved),
    resolution: (row.resolution as string | null) ?? null,
    createdAt: (row.createdAt as string | null) ?? null,
    updatedAt: (row.updatedAt as string | null) ?? null,
  }));
}

export function getMarketCacheStats(): { count: number; latestUpdatedAt: string | null } {
  const db = openDatabase();
  const row = db
    .prepare(
      `
        SELECT COUNT(*) as count, MAX(updated_at) as latestUpdatedAt
        FROM market_cache
      `
    )
    .get() as Record<string, unknown> | undefined;

  return {
    count: Number(row?.count ?? 0),
    latestUpdatedAt: (row?.latestUpdatedAt as string | null) ?? null,
  };
}
