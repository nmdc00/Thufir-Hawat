import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  claimNewsDispatch,
  countNewsDispatchesSince,
  consumeScheduledNewsDigest,
  ensureNewsRoutingSchema,
  mapNewsToTradableMarket,
  recordNewsRoute,
} from '../../src/intel/news_routing.js';

describe('news routing persistence seam', () => {
  let db: Database.Database | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function makeDb(): Database.Database {
    db = new Database(':memory:');
    db.exec('CREATE TABLE intel_items (id TEXT PRIMARY KEY, title TEXT, content TEXT, source TEXT)');
    ensureNewsRoutingSchema(db);
    return db;
  }

  function insertIntel(database: Database.Database, intelId: string, title: string): void {
    database.prepare('INSERT INTO intel_items (id, title, content, source) VALUES (?, ?, ?, ?)')
      .run(intelId, title.slice(0, 120), title, '@marketfeed');
  }

  it('builds one deduplicated scheduled digest with no more than five items or 1000 characters', () => {
    const database = makeDb();
    for (let i = 0; i < 8; i += 1) {
      const title = i === 1 ? 'Gold futures fall sharply as dollar rebounds' : `Distinct headline ${i} on ACME markets`;
      insertIntel(database, `intel-${i}`, title);
      recordNewsRoute({
        intelId: `intel-${i}`,
        relevance: 'relevant',
        urgency: 'routine',
        rolloutMode: 'active',
        routeOutcome: 'routine_pending',
      }, database);
    }

    const digest = consumeScheduledNewsDigest({
      now: new Date(Date.now() + 10_000),
      db: database,
      maxItems: 5,
      maxChars: 1000,
    });
    expect(digest.references.length).toBeLessThanOrEqual(5);
    expect(digest.text.length).toBeLessThanOrEqual(1000);
    expect(digest.text).toContain('intel-0');
  });

  it('uses a durable dispatch key to prevent scan retries from initiating twice', () => {
    const database = makeDb();
    insertIntel(database, 'intel-1', 'headline');
    expect(claimNewsDispatch('intel-1', 'event_scan', database)).toMatch(/^[a-f0-9]{64}$/);
    expect(countNewsDispatchesSince('event_scan', new Date(Date.now() - 60 * 60_000).toISOString(), database)).toBe(1);
    expect(claimNewsDispatch('intel-1', 'event_scan', database)).toBeNull();
    expect(claimNewsDispatch('intel-1', 'briefing', database)).not.toBeNull();
  });

  it('maps urgent news only through supplied tradable market metadata', () => {
    const market = {
      id: 'hyper:ACME',
      symbol: 'ACME',
      question: 'Perp: ACME',
      outcomes: ['LONG', 'SHORT'],
      prices: {},
      platform: 'hyperliquid',
      kind: 'perp' as const,
    };
    expect(mapNewsToTradableMarket('ACME jumps 4% after results', [market])).toBe(market);
    expect(mapNewsToTradableMarket('Gold falls 1% after dollar rebounds', [market])).toBeNull();
    const shortSymbolMarket = { ...market, id: 'hyper:IN', symbol: 'IN', question: 'Perp: IN' };
    expect(mapNewsToTradableMarket('Oil prices rise as supply tightens', [shortSymbolMarket])).toBeNull();
    expect(mapNewsToTradableMarket('The $IN contract jumps 3%', [shortSymbolMarket])).toBe(shortSymbolMarket);
  });
});
