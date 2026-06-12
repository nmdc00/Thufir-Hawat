import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildDashboardApiPayload } from '../../src/gateway/dashboard_api.js';
import { openDatabase } from '../../src/memory/db.js';

type CountRow = {
  c: number;
};

describe('prediction comparator contamination guard', () => {
  let dbPath: string | null = null;
  let dbDir: string | null = null;
  const originalDbPath = process.env.THUFIR_DB_PATH;

  afterEach(() => {
    process.env.THUFIR_DB_PATH = originalDbPath;
    if (dbPath) {
      rmSync(dbPath, { force: true });
      dbPath = null;
    }
    if (dbDir) {
      rmSync(dbDir, { recursive: true, force: true });
      dbDir = null;
    }
  });

  it('keeps internal, exogenous, synthetic, and missing comparator families isolated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-comparator-contamination-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    db.prepare(
      `
        INSERT INTO predictions (
          id, market_id, market_title, predicted_outcome, domain, symbol, created_at,
          model_probability, market_probability, learning_comparable,
          comparator_kind, comparator_source, forecast_target_kind,
          outcome_basis, outcome, outcome_timestamp, pnl
        ) VALUES
          (
            'internal-final', 'perp:BTC:internal', 'BTC internal segment history', 'YES', 'perp', 'BTC',
            '2026-06-01T10:00:00.000Z', 0.64, 0.52, 1,
            'internal_segment_history', 'segment_history_blended', 'positive_net_pnl_before_ttl_or_invalidation',
            'final', 'YES', '2026-06-01T11:00:00.000Z', 8
          ),
          (
            'exogenous-final', 'perp:ETH:exogenous', 'ETH price climatology', 'YES', 'perp', 'ETH',
            '2026-06-01T10:01:00.000Z', 0.71, 0.57, 1,
            'exogenous_price_climatology', 'price_climatology', 'price_reaches_directional_threshold_before_horizon',
            'final', 'NO', '2026-06-01T11:01:00.000Z', -5
          ),
          (
            'synthetic-final', 'perp:SOL:synthetic', 'SOL synthetic comparator', 'YES', 'perp', 'SOL',
            '2026-06-01T10:02:00.000Z', 0.68, 0.5, 0,
            'synthetic', 'synthetic_0_5', NULL,
            'final', 'YES', '2026-06-01T11:02:00.000Z', 4
          ),
          (
            'missing-final', 'perp:DOGE:missing', 'DOGE missing comparator', 'YES', 'perp', 'DOGE',
            '2026-06-01T10:03:00.000Z', 0.62, NULL, 0,
            'missing', 'missing', NULL,
            'final', 'NO', '2026-06-01T11:03:00.000Z', -3
          )
      `
    ).run();

    db.prepare(
      `
        INSERT INTO learning_cases (
          id, case_type, domain, entity_type, entity_id, comparable,
          comparator_kind, exclusion_reason, created_at
        ) VALUES
          ('case-internal', 'comparable_forecast', 'perp', 'symbol', 'BTC', 1, 'internal_segment_history', NULL, '2026-06-01T10:00:00.000Z'),
          ('case-exogenous', 'comparable_forecast', 'perp', 'symbol', 'ETH', 1, 'exogenous_price_climatology', NULL, '2026-06-01T10:01:00.000Z'),
          ('case-synthetic', 'comparable_forecast', 'perp', 'symbol', 'SOL', 0, 'synthetic', 'synthetic_comparator', '2026-06-01T10:02:00.000Z'),
          ('case-missing', 'comparable_forecast', 'perp', 'symbol', 'DOGE', 0, 'missing', 'missing_comparator', '2026-06-01T10:03:00.000Z')
      `
    ).run();

    const marketRows = db
      .prepare('SELECT id FROM market_comparable_learning_examples ORDER BY id ASC')
      .all() as Array<{ id: string }>;
    const internalRows = db
      .prepare('SELECT id FROM internal_comparable_learning_examples ORDER BY id ASC')
      .all() as Array<{ id: string }>;
    const contaminatedMarketRows = db
      .prepare(
        `
          SELECT COUNT(*) AS c
          FROM market_comparable_learning_examples
          WHERE comparator_kind NOT IN ('exogenous_price_climatology', 'exogenous_options_implied')
             OR market_probability = 0.5
             OR comparator_kind IN ('internal_segment_history', 'synthetic', 'missing')
             OR comparator_source IN ('segment_history_blended', 'synthetic_0_5', 'missing')
        `
      )
      .get() as CountRow;
    const contaminatedInternalRows = db
      .prepare(
        `
          SELECT COUNT(*) AS c
          FROM internal_comparable_learning_examples
          WHERE comparator_kind != 'internal_segment_history'
             OR comparator_kind LIKE 'exogenous_%'
             OR market_probability = 0.5
             OR comparator_source IN ('price_climatology', 'synthetic_0_5', 'missing')
        `
      )
      .get() as CountRow;

    expect(marketRows).toEqual([{ id: 'exogenous-final' }]);
    expect(internalRows).toEqual([{ id: 'internal-final' }]);
    expect(contaminatedMarketRows.c).toBe(0);
    expect(contaminatedInternalRows.c).toBe(0);

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });
    const predictionAccuracy = payload.sections.predictionAccuracy as typeof payload.sections.predictionAccuracy & {
      marketComparable: { totalFinalPredictions: number };
      internalComparable: { totalFinalPredictions: number };
    };

    expect(predictionAccuracy.marketComparable.totalFinalPredictions).toBe(1);
    expect(predictionAccuracy.internalComparable.totalFinalPredictions).toBe(1);
    expect(predictionAccuracy.diagnostics).toMatchObject({
      finalOutcomePredictions: 4,
      marketComparableEligible: 1,
      internalComparableEligible: 1,
      internalOnlyFinalPredictions: 1,
      syntheticComparatorBlocked: 1,
      missingComparator: 1,
      byComparatorKind: [
        { comparatorKind: 'exogenous_price_climatology', count: 1 },
        { comparatorKind: 'internal_segment_history', count: 1 },
        { comparatorKind: 'missing', count: 1 },
        { comparatorKind: 'synthetic', count: 1 },
      ],
      byComparatorSource: [
        { comparatorSource: 'missing', count: 1 },
        { comparatorSource: 'price_climatology', count: 1 },
        { comparatorSource: 'segment_history_blended', count: 1 },
        { comparatorSource: 'synthetic_0_5', count: 1 },
      ],
    });
  });
});
