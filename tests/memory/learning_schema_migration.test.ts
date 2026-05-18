import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/memory/db.js';
import {
  cleanupSyntheticPerpComparableRows,
  cleanupLegacyPerpComparableRows,
  summarizeLearningSchema,
} from '../../src/memory/learning_schema.js';

function useTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-learning-schema-'));
  const path = join(dir, 'thufir.sqlite');
  process.env.THUFIR_DB_PATH = path;
  return path;
}

describe('learning schema migration', () => {
  beforeEach(() => {
    useTempDb();
  });

  it('replaces a stale learning_examples view and creates v2.1 learning objects', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'thufir-stale-view-')), 'thufir.sqlite');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE predictions (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        market_title TEXT NOT NULL,
        predicted_outcome TEXT,
        domain TEXT,
        regime_tag TEXT,
        strategy_class TEXT,
        symbol TEXT,
        created_at TEXT,
        executed INTEGER DEFAULT 0,
        position_size REAL,
        outcome TEXT,
        outcome_timestamp TEXT,
        pnl REAL,
        model_probability REAL,
        market_probability REAL,
        learning_comparable INTEGER NOT NULL DEFAULT 0,
        outcome_basis TEXT DEFAULT 'legacy'
      );
      CREATE VIEW learning_examples AS
      SELECT
        id,
        domain,
        regime_tag AS regime,
        strategy_class,
        symbol,
        model_probability,
        market_probability,
        0 AS executed,
        NULL AS position_size,
        CASE WHEN outcome = 'YES' THEN 1 ELSE 0 END AS outcome_value,
        pnl,
        0.0 AS brier_model,
        0.0 AS brier_market,
        created_at,
        outcome_timestamp AS resolved_at
      FROM predictions
      WHERE outcome_basis = 'final'
        AND model_probability IS NOT NULL
        AND market_probability IS NOT NULL
        AND outcome IS NOT NULL;
      INSERT INTO predictions (
        id, market_id, market_title, predicted_outcome, domain, regime_tag, strategy_class, symbol,
        created_at, executed, position_size, outcome, outcome_timestamp, pnl, model_probability, market_probability,
        learning_comparable, outcome_basis
      ) VALUES (
        'stale-1', 'm1', 'Legacy row', 'YES', 'perp', 'r1', 's1', 'BTC',
        '2026-05-05T00:00:00.000Z', 0, NULL, 'YES', '2026-05-05T01:00:00.000Z', 1.25, 0.72, 0.5,
        0, 'final'
      );
    `);
    raw.close();

    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase();

    const viewSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'learning_examples'")
      .get() as { sql: string };
    expect(viewSql.sql).toContain('learning_comparable = 1');

    const rowCount = (db.prepare('SELECT COUNT(*) AS c FROM learning_examples').get() as { c: number }).c;
    expect(rowCount).toBe(0);

    const learningCasesExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'learning_cases' LIMIT 1")
      .get();
    const comparableViewExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'comparable_learning_cases' LIMIT 1")
      .get();
    const executionViewExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'execution_learning_cases' LIMIT 1")
      .get();
    const learningSignalAuditsExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'learning_signal_audits' LIMIT 1")
      .get();
    const tradePolicyAdjustmentsExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trade_policy_adjustments' LIMIT 1")
      .get();

    expect(learningCasesExists).toBeTruthy();
    expect(comparableViewExists).toBeTruthy();
    expect(executionViewExists).toBeTruthy();
    expect(learningSignalAuditsExists).toBeTruthy();
    expect(tradePolicyAdjustmentsExists).toBeTruthy();
  });

  it('startup repair demotes open synthetic perp comparable rows before they resolve', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'thufir-open-synth-')), 'thufir.sqlite');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE predictions (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        market_title TEXT NOT NULL,
        predicted_outcome TEXT,
        domain TEXT,
        created_at TEXT,
        model_probability REAL,
        market_probability REAL,
        learning_comparable INTEGER NOT NULL DEFAULT 0,
        outcome_basis TEXT DEFAULT 'legacy'
      );
      INSERT INTO predictions (
        id, market_id, market_title, predicted_outcome, domain, created_at,
        model_probability, market_probability, learning_comparable, outcome_basis
      ) VALUES (
        'open-synth', 'perp:JTO', 'JTO short: quant scan', 'NO', 'perp', '2026-05-08T11:56:31.345Z',
        0.67, 0.5, 1, 'legacy'
      );
    `);
    raw.close();

    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase();
    const row = db
      .prepare("SELECT learning_comparable AS learningComparable FROM predictions WHERE id = 'open-synth'")
      .get() as { learningComparable: number };

    expect(row.learningComparable).toBe(0);
  });

  it('demotes only contaminated legacy perp comparable rows', () => {
    const db = openDatabase();
    db.exec(`
      INSERT INTO predictions (
        id, market_id, market_title, predicted_outcome, domain, regime_tag, strategy_class, symbol,
        created_at, outcome, outcome_timestamp, pnl, model_probability, market_probability,
        learning_comparable, outcome_basis
      ) VALUES
      (
        'target-perp', 'p1', 'Target Perp', 'YES', 'perp', 'r1', 's1', 'BTC',
        '2026-05-05T00:00:00.000Z', 'YES', '2026-05-05T01:00:00.000Z', 2.0, 0.74, 0.5,
        1, 'final'
      ),
      (
        'keep-perp', 'p2', 'Keep Perp', 'YES', 'perp', 'r1', 's1', 'ETH',
        '2026-05-05T00:00:00.000Z', 'YES', '2026-05-05T01:00:00.000Z', 2.0, 0.74, 0.47,
        1, 'final'
      ),
      (
        'keep-binary', 'p3', 'Keep Binary', 'YES', 'global', 'r1', 's1', 'POLY',
        '2026-05-05T00:00:00.000Z', 'YES', '2026-05-05T01:00:00.000Z', 2.0, 0.74, 0.61,
        1, 'final'
      );
    `);

    const changed = cleanupLegacyPerpComparableRows(db);
    expect(changed).toBe(1);

    const rows = db
      .prepare(
        'SELECT id, learning_comparable FROM predictions WHERE id IN (?, ?, ?) ORDER BY id'
      )
      .all('target-perp', 'keep-perp', 'keep-binary') as Array<{ id: string; learning_comparable: number }>;

    expect(rows).toEqual([
      { id: 'keep-binary', learning_comparable: 1 },
      { id: 'keep-perp', learning_comparable: 1 },
      { id: 'target-perp', learning_comparable: 0 },
    ]);

    const summary = summarizeLearningSchema(db);
    expect(summary.contaminatedComparableCount).toBe(0);
    expect(summary.learningExamplesCount).toBe(2);
  });

  it('demotes open synthetic perp comparable rows', () => {
    const db = openDatabase();
    db.exec(`
      INSERT INTO predictions (
        id, market_id, market_title, predicted_outcome, domain, created_at,
        model_probability, market_probability, learning_comparable, outcome_basis
      ) VALUES (
        'open-synth', 'perp:JTO', 'JTO short: quant scan', 'NO', 'perp', '2026-05-08T11:56:31.345Z',
        0.67, 0.5, 1, 'legacy'
      );
    `);

    const changed = cleanupSyntheticPerpComparableRows(db);
    expect(changed).toBe(1);

    const row = db
      .prepare("SELECT learning_comparable AS learningComparable FROM predictions WHERE id = 'open-synth'")
      .get() as { learningComparable: number };
    expect(row.learningComparable).toBe(0);
  });

  it('adds and backfills trade policy scope_key for partially legacy adjustment tables', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'thufir-legacy-adjustments-')), 'thufir.sqlite');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE trade_policy_adjustments (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        signal_class TEXT,
        market_regime TEXT,
        volatility_bucket TEXT,
        liquidity_bucket TEXT,
        action TEXT NOT NULL,
        size_multiplier REAL NOT NULL,
        confidence REAL,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        thesis_failure_rate REAL,
        negative_pnl_rate REAL,
        average_quality_score REAL,
        source_learning_case_id TEXT,
        source_trade_id INTEGER,
        rationale TEXT,
        evidence_payload TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO trade_policy_adjustments (
        id, domain, signal_class, market_regime, volatility_bucket, liquidity_bucket,
        action, size_multiplier, confidence, evidence_count, active
      ) VALUES (
        'legacy-adjustment', 'perp', 'mean_reversion', 'trending', 'high', 'deep',
        'downweight', 0.4, 0.82, 3, 1
      );
    `);
    raw.close();

    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase();

    const columns = db.prepare("PRAGMA table_info('trade_policy_adjustments')").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    expect(names.has('scope_key')).toBe(true);

    const row = db
      .prepare("SELECT scope_key, policy_key FROM trade_policy_adjustments WHERE id = 'legacy-adjustment'")
      .get() as { scope_key: string; policy_key: string };

    expect(row.policy_key).toBe('size');
    expect(row.scope_key).toBe(
      'symbol=any|direction=any|strategySource=any|triggerReason=any|signalClass=mean_reversion|symbolClass=any|session=any|marketRegime=trending|volatilityBucket=high|liquidityBucket=deep'
    );
  });

  it('migrates the production legacy trade policy adjustment schema into the canonical shape', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'thufir-prod-legacy-adjustments-')), 'thufir.sqlite');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE trade_policy_adjustments (
        id TEXT PRIMARY KEY,
        policy_domain TEXT NOT NULL,
        policy_key TEXT NOT NULL,
        scope_payload TEXT,
        adjustment_type TEXT NOT NULL,
        old_value REAL,
        new_value REAL,
        delta REAL,
        evidence_count INTEGER,
        evidence_window_start TEXT,
        evidence_window_end TEXT,
        reason_summary TEXT,
        confidence REAL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT,
        old_value_payload TEXT,
        new_value_payload TEXT,
        symbol TEXT,
        direction TEXT,
        strategy_source TEXT,
        trigger_reason TEXT,
        symbol_class TEXT,
        session_tag TEXT,
        leverage_cap REAL,
        confirmation_required INTEGER,
        cooldown_minutes INTEGER,
        scope_key TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO trade_policy_adjustments (
        id, policy_domain, policy_key, scope_payload, adjustment_type, old_value, new_value, delta,
        evidence_count, reason_summary, confidence, active, created_at, symbol, direction,
        strategy_source, trigger_reason, symbol_class, session_tag, scope_key
      ) VALUES (
        'prod-legacy-adjustment',
        'perp',
        'size',
        '{"signalClass":"mean_reversion","marketRegime":"trending","volatilityBucket":"high","liquidityBucket":"deep"}',
        'scale',
        1.0,
        0.4,
        -0.6,
        4,
        'legacy adaptive downweight',
        0.88,
        1,
        '2026-05-18T17:00:00.000Z',
        'BTC',
        'long',
        'autonomous',
        'thesis_retry',
        'majors',
        'us_open',
        ''
      );
    `);
    raw.close();

    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase();

    const columns = db.prepare("PRAGMA table_info('trade_policy_adjustments')").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    for (const name of [
      'domain',
      'action',
      'size_multiplier',
      'signal_class',
      'market_regime',
      'volatility_bucket',
      'liquidity_bucket',
      'rationale',
      'evidence_payload',
      'updated_at',
    ]) {
      expect(names.has(name)).toBe(true);
    }

    const row = db
      .prepare(
        `SELECT domain, action, size_multiplier, signal_class, market_regime, volatility_bucket, liquidity_bucket,
                rationale, scope_key, updated_at
         FROM trade_policy_adjustments
         WHERE id = 'prod-legacy-adjustment'`
      )
      .get() as {
        domain: string;
        action: string;
        size_multiplier: number;
        signal_class: string;
        market_regime: string;
        volatility_bucket: string;
        liquidity_bucket: string;
        rationale: string;
        scope_key: string;
        updated_at: string;
      };

    expect(row.domain).toBe('perp');
    expect(row.action).toBe('downweight');
    expect(row.size_multiplier).toBe(0.4);
    expect(row.signal_class).toBe('mean_reversion');
    expect(row.market_regime).toBe('trending');
    expect(row.volatility_bucket).toBe('high');
    expect(row.liquidity_bucket).toBe('deep');
    expect(row.rationale).toBe('legacy adaptive downweight');
    expect(row.updated_at).toBeTruthy();
    expect(row.scope_key).toBe(
      'symbol=BTC|direction=long|strategySource=autonomous|triggerReason=thesis_retry|signalClass=mean_reversion|symbolClass=majors|session=us_open|marketRegime=trending|volatilityBucket=high|liquidityBucket=deep'
    );
  });
});
