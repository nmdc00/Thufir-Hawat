import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/memory/db.js';
import {
  cleanupSyntheticPerpComparableRows,
  cleanupSyntheticPerpComparableLearningCases,
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

    expect(learningCasesExists).toBeTruthy();
    expect(comparableViewExists).toBeTruthy();
    expect(executionViewExists).toBeTruthy();
    for (const table of [
      'trade_close_events',
      'close_finalization_jobs',
      'trade_closes',
      'trade_reflections',
      'regret_learning_cases',
      'trade_policy_adjustments',
      'policy_promotion_events',
    ]) {
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table)
      ).toBeTruthy();
    }
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

  it('demotes synthetic perp comparable learning cases', () => {
    const db = openDatabase();
    db.exec(`
      INSERT INTO learning_cases (
        id,
        case_type,
        domain,
        entity_type,
        entity_id,
        comparable,
        comparator_kind,
        baseline_payload,
        exclusion_reason
      ) VALUES
      (
        'target-case',
        'comparable_forecast',
        'perp',
        'symbol',
        'BTC',
        1,
        'market_price',
        '{"marketProbability":0.5}',
        NULL
      ),
      (
        'keep-real-market',
        'comparable_forecast',
        'perp',
        'symbol',
        'ETH',
        1,
        'market_price',
        '{"marketProbability":0.42}',
        NULL
      ),
      (
        'keep-execution',
        'execution_quality',
        'perp',
        'symbol',
        'SOL',
        0,
        NULL,
        '{"marketProbability":0.5}',
        'execution_quality_case'
      );
    `);

    const changed = cleanupSyntheticPerpComparableLearningCases(db);
    expect(changed).toBe(1);

    const rows = db
      .prepare(
        'SELECT id, comparable, comparator_kind AS comparatorKind, exclusion_reason AS exclusionReason FROM learning_cases WHERE id IN (?, ?, ?) ORDER BY id'
      )
      .all('target-case', 'keep-real-market', 'keep-execution') as Array<{
      id: string;
      comparable: number;
      comparatorKind: string | null;
      exclusionReason: string | null;
    }>;

    expect(rows).toEqual([
      {
        id: 'keep-execution',
        comparable: 0,
        comparatorKind: null,
        exclusionReason: 'execution_quality_case',
      },
      {
        id: 'keep-real-market',
        comparable: 1,
        comparatorKind: 'market_price',
        exclusionReason: null,
      },
      {
        id: 'target-case',
        comparable: 0,
        comparatorKind: null,
        exclusionReason: 'missing_comparator',
      },
    ]);
  });
});
