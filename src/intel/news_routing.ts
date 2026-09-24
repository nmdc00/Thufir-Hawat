import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Market } from '../execution/markets.js';

import { openDatabase } from '../memory/db.js';

export interface RoutineNewsReference {
  intelId: string;
  source: string;
  title: string;
  content: string;
  receivedAt: string;
}

export interface RoutineNewsDigest {
  references: RoutineNewsReference[];
  ackIds: string[];
  text: string;
}

export type RoutineNewsBriefingHandler = (input: {
  digest: RoutineNewsDigest;
  scanResult: string;
}) => Promise<void>;

export function mapNewsToTradableMarket(headline: string, markets: Market[]): Market | null {
  const text = headline.toLowerCase();
  const isTokenMentioned = (value: string): boolean => {
    if (value.trim().length <= 2) {
      const shortTicker = value.trim().replace(/[^a-z0-9]/gi, '');
      return shortTicker.length > 0 && new RegExp(`\\$${shortTicker}(?:$|[^a-z0-9])`, 'i').test(headline);
    }
    const escaped = value.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escaped) return false;
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(text);
  };
  for (const market of markets) {
    if (market.kind !== 'perp' || !(market.symbol ?? '').trim()) continue;
    if (isTokenMentioned(market.symbol!) || isTokenMentioned(market.id)) return market;
    const question = market.question?.trim();
    if (question && question.length <= 80 && isTokenMentioned(question.replace(/^perp:\s*/i, ''))) return market;
  }
  return null;
}

type NewsRoutingDb = Database.Database;

function dbOrDefault(db?: NewsRoutingDb): NewsRoutingDb {
  return db ?? openDatabase();
}

export function ensureNewsRoutingSchema(db: NewsRoutingDb = openDatabase()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_news_routes (
      intel_id TEXT PRIMARY KEY REFERENCES intel_items(id) ON DELETE CASCADE,
      relevance TEXT NOT NULL,
      urgency TEXT NOT NULL,
      rollout_mode TEXT NOT NULL,
      legacy_keyword_hit INTEGER NOT NULL DEFAULT 0,
      route_outcome TEXT NOT NULL,
      mapped_market TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      scheduled_cycle_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gateway_news_routes_pending
      ON gateway_news_routes(relevance, urgency, scheduled_cycle_at, created_at);
    CREATE TABLE IF NOT EXISTS gateway_news_dispatches (
      dispatch_key TEXT PRIMARY KEY,
      intel_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      outcome TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gateway_news_dispatches_hourly
      ON gateway_news_dispatches(kind, created_at);
  `);
}

export function recordNewsRoute(input: {
  intelId: string;
  relevance: 'irrelevant' | 'relevant';
  urgency: 'none' | 'routine' | 'urgent';
  rolloutMode: string;
  legacyKeywordHit?: boolean;
  routeOutcome: string;
  mappedMarket?: string;
}, db?: NewsRoutingDb): void {
  const target = dbOrDefault(db);
  ensureNewsRoutingSchema(target);
  target.prepare(`
    INSERT INTO gateway_news_routes (
      intel_id, relevance, urgency, rollout_mode, legacy_keyword_hit, route_outcome, mapped_market
    ) VALUES (@intelId, @relevance, @urgency, @rolloutMode, @legacyKeywordHit, @routeOutcome, @mappedMarket)
    ON CONFLICT(intel_id) DO UPDATE SET
      relevance = excluded.relevance,
      urgency = excluded.urgency,
      rollout_mode = excluded.rollout_mode,
      legacy_keyword_hit = excluded.legacy_keyword_hit,
      route_outcome = excluded.route_outcome,
      mapped_market = excluded.mapped_market
  `).run({ ...input, legacyKeywordHit: input.legacyKeywordHit ? 1 : 0, mappedMarket: input.mappedMarket ?? null });
}

export function setNewsRouteOutcome(intelId: string, outcome: string, mappedMarket?: string, db?: NewsRoutingDb): void {
  const target = dbOrDefault(db);
  ensureNewsRoutingSchema(target);
  target.prepare(`
    UPDATE gateway_news_routes SET route_outcome = ?, mapped_market = COALESCE(?, mapped_market)
    WHERE intel_id = ?
  `).run(outcome, mappedMarket ?? null, intelId);
}

export function listPendingUrgentNews(limit = 10, db?: NewsRoutingDb): Array<{
  intelId: string; source: string; title: string; content: string; receivedAt: string;
}> {
  const target = dbOrDefault(db);
  ensureNewsRoutingSchema(target);
  return target.prepare(`
    SELECT r.intel_id AS intelId, i.source, i.title, i.content, i.timestamp AS receivedAt
    FROM gateway_news_routes r JOIN intel_items i ON i.id = r.intel_id
    WHERE r.relevance = 'relevant' AND r.urgency = 'urgent'
      AND (r.rollout_mode = 'active' OR r.legacy_keyword_hit = 1)
      AND r.route_outcome = 'pending'
    ORDER BY r.created_at ASC LIMIT ?
  `).all(Math.max(1, Math.min(50, limit))) as Array<{
    intelId: string; source: string; title: string; content: string; receivedAt: string;
  }>;
}

export function claimNewsDispatch(intelId: string, kind: 'event_scan' | 'briefing', db?: NewsRoutingDb): string | null {
  const target = dbOrDefault(db);
  ensureNewsRoutingSchema(target);
  const dispatchKey = createHash('sha256').update(`${kind}:${intelId}`).digest('hex');
  const result = target.prepare(`
    INSERT OR IGNORE INTO gateway_news_dispatches (dispatch_key, intel_id, kind, status)
    VALUES (?, ?, ?, 'initiated')
  `).run(dispatchKey, intelId, kind);
  return result.changes === 1 ? dispatchKey : null;
}

export function finishNewsDispatch(dispatchKey: string, status: string, outcome: string, db?: NewsRoutingDb): void {
  const target = dbOrDefault(db);
  ensureNewsRoutingSchema(target);
  target.prepare(`
    UPDATE gateway_news_dispatches SET status = ?, outcome = ?, updated_at = datetime('now')
    WHERE dispatch_key = ?
  `).run(status, outcome.slice(0, 500), dispatchKey);
}

function normalizeHeadline(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

function isDuplicateHeadline(text: string, chosen: string[]): boolean {
  const tokens = normalizeHeadline(text);
  if (tokens.size === 0) return false;
  return chosen.some((other) => {
    const otherTokens = normalizeHeadline(other);
    const shared = [...tokens].filter((token) => otherTokens.has(token)).length;
    return shared / Math.min(tokens.size, otherTokens.size || 1) >= 0.8;
  });
}

export function hasRecentSimilarNewsScan(headline: string, windowMs = 30 * 60_000, db?: NewsRoutingDb): boolean {
  const target = dbOrDefault(db);
  ensureNewsRoutingSchema(target);
  const since = new Date(Date.now() - Math.max(1, windowMs)).toISOString().replace('T', ' ').slice(0, 19);
  const rows = target.prepare(`
    SELECT i.title FROM gateway_news_dispatches d
    JOIN intel_items i ON i.id = d.intel_id
    WHERE d.kind = 'event_scan' AND d.status IN ('initiated', 'completed', 'uncertain')
      AND d.created_at >= ?
    ORDER BY d.created_at DESC LIMIT 100
  `).all(since) as Array<{ title: string }>;
  const incoming = normalizeHeadline(headline);
  if (incoming.size < 4) return false;
  return rows.some(({ title }) => {
    const prior = normalizeHeadline(title);
    if (prior.size < 4) return false;
    const shared = [...incoming].filter((token) => prior.has(token)).length;
    const union = new Set([...incoming, ...prior]).size;
    return shared / union >= 0.6 || shared / Math.min(incoming.size, prior.size) >= 0.8;
  });
}

export function consumeScheduledNewsDigest(params: {
  maxItems?: number;
  maxChars?: number;
  now?: Date;
  db?: NewsRoutingDb;
} = {}): RoutineNewsDigest {
  const db = dbOrDefault(params.db);
  ensureNewsRoutingSchema(db);
  const maxItems = Math.max(1, Math.min(5, params.maxItems ?? 5));
  const maxChars = Math.max(1, Math.min(1000, params.maxChars ?? 1000));
  const rows = db.prepare(`
    SELECT r.intel_id AS intelId, i.source, i.title, i.content, r.created_at AS receivedAt
    FROM gateway_news_routes r JOIN intel_items i ON i.id = r.intel_id
    WHERE r.relevance = 'relevant' AND r.urgency = 'routine'
      AND (r.rollout_mode = 'active' OR r.legacy_keyword_hit = 1)
      AND r.scheduled_cycle_at IS NULL
    ORDER BY r.created_at ASC LIMIT 100
  `).all() as RoutineNewsReference[];
  const references: RoutineNewsReference[] = [];
  const ackIds: string[] = [];
  const lines: string[] = [];
  const duplicateTexts: string[] = [];
  let usedChars = 0;
  for (const row of rows) {
    const candidate = `[${row.intelId}] ${row.title} (${row.source})`;
    if (isDuplicateHeadline(row.title, duplicateTexts)) {
      ackIds.push(row.intelId);
      continue;
    }
    const remaining = maxChars - usedChars;
    if (remaining <= 0 || references.length >= maxItems) break;
    const clipped = candidate.slice(0, remaining);
    if (!clipped.trim()) break;
    lines.push(clipped);
    references.push(row);
    ackIds.push(row.intelId);
    duplicateTexts.push(row.title);
    usedChars += clipped.length + (references.length > 1 ? 1 : 0);
  }
  const text = lines.join('\n').slice(0, maxChars);
  return { references, ackIds, text };
}

export function acknowledgeScheduledNewsDigest(digest: RoutineNewsDigest, cycleId: string, db?: NewsRoutingDb): void {
  const target = dbOrDefault(db);
  ensureNewsRoutingSchema(target);
  const update = target.prepare(`
    UPDATE gateway_news_routes SET scheduled_cycle_at = ?
    WHERE intel_id = ? AND scheduled_cycle_at IS NULL
  `);
  const tx = target.transaction((ids: string[]) => ids.forEach((id) => update.run(cycleId, id)));
  tx(digest.ackIds);
}

export function countNewsDispatchesSince(kind: 'event_scan', sinceIso: string, db?: NewsRoutingDb): number {
  const target = dbOrDefault(db);
  ensureNewsRoutingSchema(target);
  const row = target.prepare(`
    SELECT COUNT(*) AS count FROM gateway_news_dispatches
    WHERE kind = ? AND created_at >= ? AND status NOT IN ('suppressed', 'failed')
  `).get(kind, sinceIso.replace('T', ' ').slice(0, 19)) as { count?: number };
  return Number(row?.count ?? 0);
}
