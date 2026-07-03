import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/memory/db.js';
import { storeDecisionArtifact } from '../../src/memory/decision_artifacts.js';
import { placePaperPerpOrder } from '../../src/memory/paper_perps.js';
import { recordPerpTradeJournal } from '../../src/memory/perp_trade_journal.js';
import {
  buildDashboardApiPayload,
  handleDashboardApiRequest,
  parseDashboardFilters,
} from '../../src/gateway/dashboard_api.js';
import { recordOutcome } from '../../src/memory/calibration.js';
import { createPrediction } from '../../src/memory/predictions.js';

function seedComparableFinalPredictions(count: number): void {
  for (let index = 0; index < count; index += 1) {
    const createdAt = new Date(Date.UTC(2026, 5, 1, 10, index, 0)).toISOString();
    const id = createPrediction({
      marketId: `perp:BTC:${index}`,
      marketTitle: `BTC comparable ${index}`,
      predictedOutcome: 'YES',
      predictedProbability: 0.65,
      modelProbability: 0.65,
      marketProbability: 0.55,
      domain: 'perp',
      symbol: 'BTC',
      createdAt,
      executed: true,
    });
    openDatabase()
      .prepare(
        `
          UPDATE predictions
          SET comparator_kind = 'exogenous_price_climatology',
              comparator_source = 'price_climatology',
              forecast_target_kind = 'price_reaches_directional_threshold_before_horizon',
              learning_comparable = 1
          WHERE id = ?
        `
      )
      .run(id);
    recordOutcome({
      id,
      outcome: index % 5 === 0 ? 'NO' : 'YES',
      outcomeBasis: 'final',
      outcomeTimestamp: new Date(Date.UTC(2026, 5, 1, 11, index, 0)).toISOString(),
      pnl: index % 5 === 0 ? -5 : 8,
    });
  }
}

describe('dashboard api filters', () => {
  it('defaults to combined/all when query values are absent or invalid', () => {
    const url = new URL('http://localhost/api/dashboard?mode=bad&timeframe=weird');
    const filters = parseDashboardFilters(url);
    expect(filters).toEqual({
      mode: 'combined',
      timeframe: 'all',
      period: null,
      from: null,
      to: null,
    });
  });

  it('normalizes day timeframe into explicit UTC start/end bounds', () => {
    const now = new Date('2026-02-25T18:31:00.000Z');
    const url = new URL('http://localhost/api/dashboard?mode=paper&timeframe=day');
    const filters = parseDashboardFilters(url, now);
    expect(filters.mode).toBe('paper');
    expect(filters.timeframe).toBe('day');
    expect(filters.from).toBe('2026-02-25T00:00:00.000Z');
    expect(filters.to).toBe('2026-02-25T18:31:00.000Z');
  });
});

describe('dashboard api payload', () => {
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

  it('returns stable empty-state sections for a fresh db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-api-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    const db = openDatabase(dbPath);
    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'combined',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.meta.mode).toBe('combined');
    expect(payload.sections.equityCurve.points.length).toBe(1);
    expect(payload.sections.equityCurve.summary.startEquity).not.toBeNull();
    expect(payload.sections.openPositions.rows).toEqual([]);
    expect(payload.sections.tradeLog.rows).toEqual([]);
    expect(payload.sections.promotionGates.rows).toEqual([]);
    expect(payload.sections.performanceBreakdown.bySignalClass).toEqual([]);
    expect(payload.sections.learningObservability.activeWeights).toEqual([]);
    expect(payload.sections.learningAudit.execution.totalCaseCount).toBe(0);
    expect(payload.sections.predictionAccuracy.totalFinalPredictions).toBe(0);
    expect(payload.sections.closeLearning.finalizer.totalJobs).toBe(0);
    expect(payload.sections.closeLearning.tradeCloses.recent).toEqual([]);
    expect(payload.sections.originatorScorecard.latest).toEqual([]);
    expect(typeof payload.meta.recordCounts.perpTrades).toBe('number');
    expect(typeof payload.meta.recordCounts.journals).toBe('number');
  });

  it('surfaces runtime learning rows even when final comparable predictions are empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-learning-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    db.prepare(
      `
        INSERT INTO signal_weights (domain, weights, samples, updated_at)
        VALUES (?, ?, ?, ?)
      `
    ).run(
      'perp',
      JSON.stringify({ technical: 0.36, news: 0.35, onChain: 0.29 }),
      114,
      '2026-06-01 15:48:21'
    );
    db.prepare(
      `
        INSERT INTO learning_cases (
          id, case_type, domain, entity_type, entity_id, comparable, exclusion_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      'case-excluded',
      'comparable_forecast',
      'perp',
      'symbol',
      'XYZ:XYZ100',
      0,
      'missing_comparator',
      '2026-06-01 17:11:15'
    );
    db.prepare(
      `
        INSERT INTO learning_cases (
          id, case_type, domain, entity_type, entity_id, comparable, source_trade_id, exclusion_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      'case-execution',
      'execution_quality',
      'perp',
      'symbol',
      'XYZ:SKHX',
      0,
      2612,
      'execution_quality_case',
      '2026-06-01 15:48:21'
    );

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

    expect(payload.sections.predictionAccuracy.totalFinalPredictions).toBe(0);
    expect(payload.sections.learningObservability.runtimeContext.source).toBe('signal_weights');
    expect(payload.sections.learningObservability.runtimeContext.updatedAt).toBe('2026-06-01 15:48:21');
    expect(payload.sections.learningObservability.activeWeights).toEqual([
      {
        domain: 'perp',
        weights: { technical: 0.36, news: 0.35, onChain: 0.29 },
        samples: 114,
        updatedAt: '2026-06-01 15:48:21',
      },
    ]);
    expect(payload.sections.learningAudit.exclusions.totalCaseCount).toBe(1);
    expect(payload.sections.learningAudit.exclusions.byReason).toEqual([
      { reason: 'missing_comparator', count: 1 },
    ]);
    expect(payload.sections.learningAudit.execution.totalCaseCount).toBe(1);
    expect(payload.sections.learningAudit.execution.byDomain).toEqual([
      { domain: 'perp', count: 1 },
    ]);
  });

  it('reports comparator diagnostics for blocked and eligible perp prediction rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-comparator-diagnostics-'));
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
          ('eligible-final', 'perp:BTC:eligible', 'BTC eligible', 'YES', 'perp', 'BTC', '2026-06-01T10:00:00.000Z', 0.74, 0.61, 1, 'exogenous_price_climatology', 'price_climatology', 'price_reaches_directional_threshold_before_horizon', 'final', 'YES', '2026-06-01T11:00:00.000Z', 12.5),
          ('missing-final', 'perp:ETH:missing', 'ETH missing', 'YES', 'perp', 'ETH', '2026-06-01T10:01:00.000Z', 0.72, NULL, 0, 'missing', 'missing', NULL, 'final', 'NO', '2026-06-01T11:01:00.000Z', -8.0),
          ('synthetic-final', 'perp:SOL:synthetic', 'SOL synthetic', 'YES', 'perp', 'SOL', '2026-06-01T10:02:00.000Z', 0.73, 0.5, 0, 'synthetic', 'synthetic_0_5', NULL, 'final', 'NO', '2026-06-01T11:02:00.000Z', -4.0),
          ('insufficient-open', 'perp:DOGE:insufficient', 'DOGE insufficient', 'YES', 'perp', 'DOGE', '2026-06-01T10:03:00.000Z', 0.69, NULL, 0, 'missing', 'missing', NULL, 'legacy', NULL, NULL, NULL),
          ('binary-ignore', 'binary:ignore', 'Binary ignore', 'YES', 'binary', 'IGN', '2026-06-01T10:04:00.000Z', 0.64, 0.55, 0, 'exogenous_price_climatology', 'price_climatology', 'price_reaches_directional_threshold_before_horizon', 'final', 'YES', '2026-06-01T11:04:00.000Z', 1.0)
      `
    ).run();
    db.prepare(
      `
        INSERT INTO learning_cases (
          id, case_type, domain, entity_type, entity_id, comparable, comparator_kind, exclusion_reason, created_at
        ) VALUES
          ('case-missing', 'comparable_forecast', 'perp', 'symbol', 'ETH', 0, 'missing', 'missing_comparator', '2026-06-01T10:01:00.000Z'),
          ('case-insufficient', 'comparable_forecast', 'perp', 'symbol', 'DOGE', 0, 'missing', 'insufficient_samples', '2026-06-01T10:03:00.000Z'),
          ('case-eligible', 'comparable_forecast', 'perp', 'symbol', 'BTC', 1, 'exogenous_price_climatology', NULL, '2026-06-01T10:00:00.000Z')
      `
    ).run();

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

    expect(payload.sections.predictionAccuracy.totalFinalPredictions).toBe(1);
    expect(payload.sections.predictionAccuracy.global).toEqual([]);
    expect(payload.sections.predictionAccuracy.diagnostics).toMatchObject({
      totalPredictionsConsidered: 4,
      finalOutcomePredictions: 3,
      comparableEligible: 1,
      marketComparableEligible: 1,
      internalComparableEligible: 0,
      internalOnlyFinalPredictions: 0,
      missingComparator: 1,
      syntheticComparatorBlocked: 1,
      insufficientSamples: 1,
      byComparatorKind: [
        { comparatorKind: 'exogenous_price_climatology', count: 1 },
        { comparatorKind: 'missing', count: 1 },
        { comparatorKind: 'synthetic', count: 1 },
      ],
      byComparatorSource: [
        { comparatorSource: 'missing', count: 1 },
        { comparatorSource: 'price_climatology', count: 1 },
        { comparatorSource: 'synthetic_0_5', count: 1 },
      ],
      byExclusionReason: [
        { reason: 'insufficient_samples', count: 1 },
        { reason: 'missing_comparator', count: 1 },
      ],
    });
  });

  it('separates market-comparable and internal baseline prediction accuracy families', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-comparator-families-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    for (let index = 0; index < 25; index += 1) {
      db.prepare(
        `
          INSERT INTO predictions (
            id, market_id, market_title, predicted_outcome, domain, symbol, created_at,
            model_probability, market_probability, learning_comparable,
            comparator_kind, comparator_source, forecast_target_kind,
            outcome_basis, outcome, outcome_timestamp, pnl
          ) VALUES (?, ?, ?, 'YES', 'perp', ?, ?, ?, ?, 1, ?, ?, ?, 'final', ?, ?, ?)
        `
      ).run(
        `exo-${index}`,
        `perp:BTC:exo:${index}`,
        `BTC exogenous ${index}`,
        'BTC',
        new Date(Date.UTC(2026, 5, 1, 10, index, 0)).toISOString(),
        0.7,
        0.58,
        'exogenous_price_climatology',
        'price_climatology',
        'price_reaches_directional_threshold_before_horizon',
        index % 4 === 0 ? 'NO' : 'YES',
        new Date(Date.UTC(2026, 5, 1, 11, index, 0)).toISOString(),
        index % 4 === 0 ? -4 : 6
      );
      db.prepare(
        `
          INSERT INTO predictions (
            id, market_id, market_title, predicted_outcome, domain, symbol, created_at,
            model_probability, market_probability, learning_comparable,
            comparator_kind, comparator_source, forecast_target_kind,
            outcome_basis, outcome, outcome_timestamp, pnl
          ) VALUES (?, ?, ?, 'YES', 'perp', ?, ?, ?, ?, 1, ?, ?, ?, 'final', ?, ?, ?)
        `
      ).run(
        `internal-${index}`,
        `perp:ETH:internal:${index}`,
        `ETH internal ${index}`,
        'ETH',
        new Date(Date.UTC(2026, 5, 2, 10, index, 0)).toISOString(),
        0.62,
        0.51,
        'internal_segment_history',
        'segment_history_blended',
        'positive_net_pnl_before_ttl_or_invalidation',
        index % 5 === 0 ? 'NO' : 'YES',
        new Date(Date.UTC(2026, 5, 2, 11, index, 0)).toISOString(),
        index % 5 === 0 ? -3 : 5
      );
    }

    db.prepare(
      `
        INSERT INTO predictions (
          id, market_id, market_title, predicted_outcome, domain, symbol, created_at,
          model_probability, market_probability, learning_comparable,
          comparator_kind, comparator_source, outcome_basis, outcome, outcome_timestamp, pnl
        ) VALUES
          ('synthetic-final', 'perp:SOL:synthetic', 'SOL synthetic', 'YES', 'perp', 'SOL', '2026-06-03T10:00:00.000Z', 0.66, 0.5, 0, 'synthetic', 'synthetic_0_5', 'final', 'NO', '2026-06-03T11:00:00.000Z', -2),
          ('missing-final', 'perp:DOGE:missing', 'DOGE missing', 'YES', 'perp', 'DOGE', '2026-06-03T10:01:00.000Z', 0.64, NULL, 0, 'missing', 'missing', 'final', 'YES', '2026-06-03T11:01:00.000Z', 1),
          ('legacy-internal-final', 'perp:XMR:legacy-internal', 'XMR legacy internal', 'YES', 'perp', 'XMR', '2026-06-03T10:02:00.000Z', 0.64, 0.52, 0, 'internal_segment_history', 'segment_history_blended', 'final', 'YES', '2026-06-03T11:02:00.000Z', 1)
      `
    ).run();

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
      marketComparable: { totalFinalPredictions: number; global: Array<{ sampleCount: number; comparatorKind?: string; comparatorSource?: string; label?: string }> };
      internalComparable: { totalFinalPredictions: number; global: Array<{ sampleCount: number; comparatorKind?: string; comparatorSource?: string; label?: string }> };
    };

    expect(predictionAccuracy.marketComparable.totalFinalPredictions).toBe(25);
    expect(predictionAccuracy.marketComparable.global.map((row) => row.sampleCount)).toEqual([25]);
    expect(predictionAccuracy.marketComparable.global[0]).toMatchObject({
      comparatorKind: 'exogenous_price_climatology',
      comparatorSource: 'price_climatology',
      label: 'Market-comparable forecast accuracy',
    });
    expect(predictionAccuracy.internalComparable.totalFinalPredictions).toBe(25);
    expect(predictionAccuracy.internalComparable.global.map((row) => row.sampleCount)).toEqual([25]);
    expect(predictionAccuracy.internalComparable.global[0]).toMatchObject({
      comparatorKind: 'internal_segment_history',
      comparatorSource: 'segment_history_blended',
      label: 'Internal baseline forecast accuracy',
    });
    expect(predictionAccuracy.diagnostics).toMatchObject({
      finalOutcomePredictions: 53,
      marketComparableEligible: 25,
      internalComparableEligible: 25,
      syntheticComparatorBlocked: 1,
      missingComparator: 1,
    });
    expect(JSON.stringify(predictionAccuracy.marketComparable)).not.toContain('internal_segment_history');
    expect(JSON.stringify(predictionAccuracy.marketComparable)).not.toContain('segment_history_blended');
    expect(JSON.stringify(predictionAccuracy.internalComparable)).not.toContain('exogenous_price_climatology');
    expect(JSON.stringify(predictionAccuracy)).not.toContain('market_price');
  });

  it('reports only complete 25-sample prediction accuracy windows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-accuracy-windows-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    seedComparableFinalPredictions(75);
    db.prepare(
      `
        UPDATE predictions
        SET outcome = CASE
          WHEN CAST(substr(market_id, length('perp:BTC:') + 1) AS INTEGER) BETWEEN 25 AND 49 THEN 'NO'
          ELSE 'YES'
        END,
        pnl = CASE
          WHEN CAST(substr(market_id, length('perp:BTC:') + 1) AS INTEGER) BETWEEN 25 AND 49 THEN -5
          ELSE 8
        END
        WHERE market_id LIKE 'perp:BTC:%'
      `
    ).run();

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

    expect(payload.sections.predictionAccuracy.totalFinalPredictions).toBe(75);
    expect(payload.sections.predictionAccuracy.global.map((row) => row.windowSize)).toEqual([
      25,
      50,
      75,
    ]);
    expect(payload.sections.predictionAccuracy.global.map((row) => row.sampleCount)).toEqual([
      25,
      25,
      25,
    ]);
    expect(payload.sections.predictionAccuracy.global.map((row) => row.accuracy)).toEqual([
      1,
      0,
      1,
    ]);
  });

  it('surfaces close finalizer, canonical close, regret, and learned policy rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-close-learning-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    db.prepare(
      `
        INSERT INTO trade_close_events (
          id, lifecycle_id, trade_id, symbol, execution_mode, side, close_kind,
          size_reduced, remaining_size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run('event-full', 'perp:BTC:1', 1, 'BTC', 'paper', 'sell', 'full_close', 0.1, 0, '2026-06-01T10:00:00.000Z');
    db.prepare(
      `
        INSERT INTO close_finalization_jobs (
          id, close_event_id, lifecycle_id, trade_id, symbol, status, attempts, created_at, updated_at, finalized_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run('job-1', 'event-full', 'perp:BTC:1', 1, 'BTC', 'finalized', 1, '2026-06-01T10:00:00.000Z', '2026-06-01T10:00:01.000Z', '2026-06-01T10:00:01.000Z');
    db.prepare(
      `
        INSERT INTO trade_closes (
          id, close_event_id, lifecycle_id, trade_id, symbol, closed_side, execution_mode,
          closed_at, net_realized_pnl_usd, captured_r, thesis_correct, composite_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run('close-1', 'event-full', 'perp:BTC:1', 1, 'BTC', 'long', 'paper', '2026-06-01T10:00:01.000Z', 12.5, 1.2, 1, 0.82);
    db.prepare(
      `
        INSERT INTO trade_reflections (id, trade_close_id, thesis_correct, confidence)
        VALUES (?, ?, ?, ?)
      `
    ).run('reflection-1', 'close-1', 1, 0.82);
    db.prepare(
      `
        INSERT INTO regret_learning_cases (
          id, trade_close_id, lifecycle_id, symbol, regret_type, severity
        ) VALUES (?, ?, ?, ?, ?, ?)
      `
    ).run('regret-1', 'close-1', 'perp:BTC:1', 'BTC', 'closed_too_early', 0.4);
    db.prepare(
      `
        INSERT INTO trade_policy_adjustments (
          id, domain, scope_key, symbol, signal_class, action, size_multiplier,
          sample_count, source_trade_close_id, reason, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run('adj-1', 'perp', 'symbol=BTC|signalClass=momentum_breakout', 'BTC', 'momentum_breakout', 'downweight', 0.5, 3, 'close-1', 'test learned policy', 1);
    db.prepare(
      `
        INSERT INTO policy_promotion_events (
          id, adjustment_id, trade_close_id, scope_key, action, sample_count, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).run('promo-1', 'adj-1', 'close-1', 'symbol=BTC|signalClass=momentum_breakout', 'downweight', 3, 'test learned policy');

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

    expect(payload.sections.closeLearning.finalizer.finalized).toBe(1);
    expect(payload.sections.closeLearning.closeEvents.fullCloses).toBe(1);
    expect(payload.sections.closeLearning.tradeCloses.total).toBe(1);
    expect(payload.sections.closeLearning.tradeCloses.recent[0]?.symbol).toBe('BTC');
    expect(payload.sections.closeLearning.reflections.total).toBe(1);
    expect(payload.sections.closeLearning.regretCases.byType).toEqual([
      { type: 'closed_too_early', count: 1 },
    ]);
    expect(payload.sections.closeLearning.policyLearning.activeAdjustments[0]?.action).toBe('downweight');
    expect(payload.sections.closeLearning.policyLearning.promotionEvents[0]?.action).toBe('downweight');
  });

  it('computes equity curve points and summary from paper fills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-equity-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    placePaperPerpOrder(
      { symbol: 'BTC', side: 'buy', size: 1, orderType: 'market', markPrice: 100 },
      { initialCashUsdc: 200 }
    );
    placePaperPerpOrder(
      { symbol: 'BTC', side: 'sell', size: 1, orderType: 'market', markPrice: 110, reduceOnly: true },
      { initialCashUsdc: 200 }
    );

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

    expect(payload.sections.equityCurve.points.length).toBeGreaterThanOrEqual(2);
    const startPoint = payload.sections.equityCurve.points[0]!;
    expect(startPoint.cashBalance).toBeCloseTo(200, 8);
    expect(startPoint.equity).toBeCloseTo(200, 8);
    expect(startPoint.cumulativeFees).toBeCloseTo(0, 8);
    expect(payload.sections.equityCurve.summary.startEquity).toBeCloseTo(200, 8);
    const endEquity = payload.sections.equityCurve.summary.endEquity;
    expect(endEquity).not.toBeNull();
    expect(Number(endEquity)).toBeGreaterThan(200);
    expect(Number(payload.sections.equityCurve.summary.returnPct)).toBeGreaterThan(0);
  });

  it('returns open paper positions with current mark and unrealized pnl summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-open-pos-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    placePaperPerpOrder(
      { symbol: 'BTC', side: 'buy', size: 2, orderType: 'market', markPrice: 100 },
      { initialCashUsdc: 200 }
    );
    placePaperPerpOrder(
      { symbol: 'BTC', side: 'sell', size: 1, orderType: 'market', markPrice: 110, reduceOnly: true },
      { initialCashUsdc: 200 }
    );

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

    expect(payload.sections.openPositions.rows.length).toBe(1);
    const row = payload.sections.openPositions.rows[0]!;
    expect(row.symbol).toBe('BTC');
    expect(row.side).toBe('long');
    expect(row.entryPrice).toBeCloseTo(100.05, 6);
    expect(row.currentPrice).toBe(110);
    expect(row.unrealizedPnlUsd).toBeCloseTo(9.95, 6);
    expect(payload.sections.openPositions.summary.longCount).toBe(1);
    expect(payload.sections.openPositions.summary.shortCount).toBe(0);
    expect(payload.sections.openPositions.summary.totalUnrealizedPnlUsd).toBeCloseTo(9.95, 6);
  });

  it('marks paper equity to the same current mids as open positions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-paper-equity-mark-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    placePaperPerpOrder(
      { symbol: 'BTC', side: 'buy', size: 2, orderType: 'market', markPrice: 100 },
      { initialCashUsdc: 200 }
    );
    placePaperPerpOrder(
      { symbol: 'BTC', side: 'sell', size: 1, orderType: 'market', markPrice: 110, reduceOnly: true },
      { initialCashUsdc: 200 }
    );

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
      mids: { BTC: 120 },
    });

    const endPoint = payload.sections.equityCurve.points[payload.sections.equityCurve.points.length - 1]!;
    expect(payload.sections.openPositions.rows[0]?.currentPrice).toBe(120);
    expect(payload.sections.openPositions.summary.totalUnrealizedPnlUsd).toBeCloseTo(19.95, 6);
    expect(endPoint.unrealizedPnl).toBeCloseTo(19.95, 6);
    expect(payload.sections.equityCurve.summary.endEquity).toBeCloseTo(endPoint.cashBalance + 19.95, 6);
  });

  it('returns recent trade-log rows with component quality bands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-trade-log-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'BTC',
      side: 'buy',
      signalClass: 'breakout_15m',
      outcome: 'executed',
      realizedPnlUsd: 120.5,
      directionScore: 0.9,
      timingScore: 0.8,
      sizingScore: 0.75,
      exitScore: 0.7,
      capturedR: 1.2,
      thesisCorrect: true,
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'ETH',
      side: 'sell',
      signalClass: 'mean_reversion_5m',
      outcome: 'failed',
      realizedPnlUsd: -90.25,
      directionScore: 0.2,
      timingScore: 0.25,
      sizingScore: 0.3,
      exitScore: 0.2,
      capturedR: -0.9,
      thesisCorrect: false,
    });

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

    expect(payload.sections.tradeLog.rows.length).toBe(2);
    const bySymbol = new Map(payload.sections.tradeLog.rows.map((row) => [row.symbol, row]));
    expect(bySymbol.get('BTC')?.qualityBand).toBe('good');
    expect(bySymbol.get('ETH')?.qualityBand).toBe('poor');
    expect(bySymbol.get('BTC')?.realizedPnlUsd).toBe(120.5);
    expect(bySymbol.get('ETH')?.realizedPnlUsd).toBe(-90.25);
    expect(bySymbol.get('BTC')?.rCaptured).toBe(1.2);
    expect(bySymbol.get('ETH')?.rCaptured).toBe(-0.9);
  });

  it('builds non-empty signal/regime/session performance breakdown from journals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-performance-breakdown-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    // Real pattern: entry journal carries signalClass/regime, close journal carries outcome.
    // Entry and close are linked temporally (close recorded shortly after entry).
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      execution_mode: 'paper',
      symbol: 'BTC',
      side: 'sell',
      signalClass: 'momentum_breakout',
      marketRegime: 'trending',
      outcome: 'executed',
      reduceOnly: false,
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      execution_mode: 'paper',
      symbol: 'BTC',
      side: 'buy',
      reduceOnly: true,
      outcome: 'executed',
      capturedR: 1.25,
      captured_r: 1.25,
      thesisCorrect: true,
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      execution_mode: 'paper',
      symbol: 'ETH',
      side: 'buy',
      signalClass: 'mean_reversion',
      marketRegime: 'choppy',
      outcome: 'executed',
      reduceOnly: false,
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      execution_mode: 'paper',
      symbol: 'ETH',
      side: 'sell',
      reduceOnly: true,
      outcome: 'executed',
      capturedR: -0.75,
      captured_r: -0.75,
      thesisCorrect: false,
    });

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

    expect(payload.sections.performanceBreakdown.bySignalClass.length).toBeGreaterThan(0);
    expect(payload.sections.performanceBreakdown.byRegime.length).toBeGreaterThan(0);
    expect(payload.sections.performanceBreakdown.bySession.length).toBeGreaterThan(0);

    const scMap = new Map(payload.sections.performanceBreakdown.bySignalClass.map((r) => [r.key, r]));
    expect(scMap.get('momentum_breakout')?.winRate).toBe(1);
    expect(scMap.get('momentum_breakout')?.expectancyR).toBeCloseTo(1.25);
    expect(scMap.get('mean_reversion')?.winRate).toBe(0);
    expect(scMap.get('mean_reversion')?.expectancyR).toBeCloseTo(-0.75);
  });

  it('returns promotion gate rows keyed by symbol:signalClass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-promo-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'BTC',
      signalClass: 'breakout_15m',
      outcome: 'executed',
      capturedR: 1.2,
      thesisCorrect: true,
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'BTC',
      signalClass: 'breakout_15m',
      outcome: 'failed',
      capturedR: -0.5,
      thesisCorrect: false,
    });

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

    const rows = payload.sections.promotionGates.rows as Array<any>;
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find((item) => item.setupKey === 'BTC:breakout_15m');
    expect(row).toBeDefined();
    expect(row?.sampleCount).toBe(2);
    expect(row?.gates.minTrades.pass).toBe(false);
    expect(row?.gates.minTrades.missing).toBe(23);
  });

  it('counts one trade per unique tradeId even when multiple journals exist for the lifecycle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-unique-trade-count-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      tradeId: 42,
      execution_mode: 'paper',
      symbol: 'BTC',
      side: 'buy',
      outcome: 'executed',
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      tradeId: 42,
      execution_mode: 'paper',
      symbol: 'BTC',
      side: 'buy',
      outcome: 'executed',
    });
    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      tradeId: 42,
      execution_mode: 'paper',
      symbol: 'BTC',
      side: 'sell',
      outcome: 'executed',
    });

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

    expect(payload.meta.recordCounts.journals).toBe(3);
    expect(payload.meta.recordCounts.perpTrades).toBe(1);
  });

  it('separates paper and live slices across sections when mode filter changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-mode-split-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    placePaperPerpOrder(
      { symbol: 'BTC', side: 'buy', size: 1, orderType: 'market', markPrice: 100 },
      { initialCashUsdc: 200 }
    );

    recordPerpTradeJournal({
      kind: 'perp_trade_journal',
      symbol: 'BTC',
      side: 'buy',
      signalClass: 'breakout_15m',
      outcome: 'executed',
      directionScore: 0.8,
      timingScore: 0.8,
      sizingScore: 0.8,
      exitScore: 0.8,
      capturedR: 1,
      thesisCorrect: true,
    });

    storeDecisionArtifact({
      source: 'perps',
      kind: 'perp_trade_journal',
      marketId: 'ETH',
      outcome: 'executed',
      payload: {
        kind: 'perp_trade_journal',
        symbol: 'ETH',
        side: 'sell',
        signalClass: 'momentum_5m',
        outcome: 'executed',
        directionScore: 0.7,
        timingScore: 0.75,
        sizingScore: 0.8,
        exitScore: 0.85,
        capturedR: 1.1,
        thesisCorrect: true,
        mode: 'live',
      },
    });

    const paperPayload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    const livePayload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'live',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(paperPayload.meta.recordCounts.journals).toBe(1);
    expect(livePayload.meta.recordCounts.journals).toBe(1);

    expect(paperPayload.sections.equityCurve.points.length).toBeGreaterThan(0);
    expect(livePayload.sections.equityCurve.points).toEqual([]);
    expect(livePayload.sections.equityCurve.summary.startEquity).toBeNull();
    expect(livePayload.sections.openPositions.rows).toEqual([]);
    expect(livePayload.meta.recordCounts.openPaperPositions).toBe(0);

    expect(paperPayload.sections.openPositions.rows.length).toBe(1);
    expect(paperPayload.sections.tradeLog.rows.some((row) => row.symbol === 'BTC')).toBe(true);
    expect(paperPayload.sections.tradeLog.rows.some((row) => row.symbol === 'ETH')).toBe(false);
    expect(livePayload.sections.tradeLog.rows.some((row) => row.symbol === 'ETH')).toBe(true);
    expect(livePayload.sections.tradeLog.rows.some((row) => row.symbol === 'BTC')).toBe(false);

    expect(
      paperPayload.sections.promotionGates.rows.some((row) => row.setupKey === 'BTC:breakout_15m')
    ).toBe(true);
    expect(
      paperPayload.sections.promotionGates.rows.some((row) => row.setupKey === 'ETH:momentum_5m')
    ).toBe(false);
    expect(
      livePayload.sections.promotionGates.rows.some((row) => row.setupKey === 'ETH:momentum_5m')
    ).toBe(true);
    expect(
      livePayload.sections.promotionGates.rows.some((row) => row.setupKey === 'BTC:breakout_15m')
    ).toBe(false);
  });

  it('filters perp_trades fallback trade log by execution_mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-perp-trades-mode-filter-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    const db = openDatabase(dbPath);

    db.prepare(
      `
        INSERT INTO perp_trades (symbol, side, size, execution_mode, status)
        VALUES (?, ?, ?, ?, ?)
      `
    ).run('BTC', 'buy', 0.01, 'paper', 'executed');
    db.prepare(
      `
        INSERT INTO perp_trades (symbol, side, size, execution_mode, status)
        VALUES (?, ?, ?, ?, ?)
      `
    ).run('ETH', 'sell', 0.02, 'live', 'executed');

    const paperPayload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'paper',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });
    const livePayload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'live',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(paperPayload.sections.tradeLog.rows.some((row) => row.symbol === 'BTC')).toBe(true);
    expect(paperPayload.sections.tradeLog.rows.some((row) => row.symbol === 'ETH')).toBe(false);
    expect(livePayload.sections.tradeLog.rows.some((row) => row.symbol === 'ETH')).toBe(true);
    expect(livePayload.sections.tradeLog.rows.some((row) => row.symbol === 'BTC')).toBe(false);
  });

  it('returns policy state from autonomy policy table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-policy-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    process.env.THUFIR_DASHBOARD_MAX_TRADES_PER_DAY = '5';
    const db = openDatabase(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_policy_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_date TEXT NOT NULL,
        observation_only_until_ms INTEGER,
        leverage_cap_override REAL,
        updated_at TEXT NOT NULL
      );
    `);

    db.exec(`
      INSERT INTO autonomy_policy_state (
        session_date, observation_only_until_ms, leverage_cap_override, updated_at
      )
      VALUES (
        '2026-02-25',
        ${Date.now() + 60_000},
        1.25,
        '2026-02-25T18:30:00.000Z'
      );
    `);

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'combined',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.policyState.observationMode).toBe(true);
    expect(payload.sections.policyState.leverageCap).toBe(1.25);
    expect(payload.sections.policyState.tradesRemainingToday).toBe(5);
    expect(payload.sections.policyState.updatedAt).toBe('2026-02-25T18:30:00.000Z');
    delete process.env.THUFIR_DASHBOARD_MAX_TRADES_PER_DAY;
  });

  it('returns policy state from payload-based autonomy policy schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-policy-payload-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    process.env.THUFIR_DASHBOARD_MAX_TRADES_PER_DAY = '4';
    const db = openDatabase(dbPath);

    db.exec(`
      DROP TABLE IF EXISTS autonomy_policy_state;
      CREATE TABLE autonomy_policy_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        updated_at TEXT
      );
    `);

    db.prepare(
      `
        INSERT INTO autonomy_policy_state (payload, updated_at)
        VALUES (?, ?)
      `
    ).run(
      JSON.stringify({
        observationOnlyUntilMs: Date.now() + 120_000,
        leverageCapOverride: 1.5,
      }),
      '2026-02-25T19:00:00.000Z'
    );

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'combined',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.policyState.observationMode).toBe(true);
    expect(payload.sections.policyState.leverageCap).toBe(1.5);
    expect(payload.sections.policyState.tradesRemainingToday).toBe(4);
    expect(payload.sections.policyState.updatedAt).toBe('2026-02-25T19:00:00.000Z');
    delete process.env.THUFIR_DASHBOARD_MAX_TRADES_PER_DAY;
  });

  it('derives drawdown cap remaining from configured daily cap and todays pnl rollup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-policy-drawdown-'));
    dbDir = dir;
    dbPath = join(dir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    process.env.THUFIR_DASHBOARD_DAILY_DRAWDOWN_CAP_USD = '100';
    const db = openDatabase(dbPath);

    db.exec(`
      DROP TABLE IF EXISTS autonomy_policy_state;
      CREATE TABLE autonomy_policy_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        updated_at TEXT
      );
    `);

    db.prepare(
      `
        INSERT INTO autonomy_policy_state (payload, updated_at)
        VALUES (?, ?)
      `
    ).run(
      JSON.stringify({
        observationOnlyUntilMs: Date.now() + 120_000,
        leverageCapOverride: 1.5,
      }),
      '2026-02-25T19:00:00.000Z'
    );

    const payload = buildDashboardApiPayload({
      db,
      filters: {
        mode: 'combined',
        timeframe: 'all',
        period: null,
        from: null,
        to: null,
      },
    });

    expect(payload.sections.policyState.drawdownCapRemainingUsd).toBe(100);
    delete process.env.THUFIR_DASHBOARD_DAILY_DRAWDOWN_CAP_USD;
  });
});

describe('dashboard api route handler', () => {
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

  it('handles dashboard requests and returns json', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'thufir-dashboard-api-handler-'));
    dbPath = join(dbDir, 'thufir.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    openDatabase(dbPath);

    const req = {
      method: 'GET',
      url: '/api/dashboard?mode=paper&timeframe=all',
      headers: { host: 'localhost:18789' },
    } as any;

    const state: { status?: number; body?: string } = {};
    const res = {
      writeHead: (status: number) => {
        state.status = status;
      },
      end: (body?: string) => {
        state.body = body;
      },
    } as any;

    const handled = handleDashboardApiRequest(req, res);
    expect(handled).toBe(true);
    expect(state.status).toBe(200);
    const parsed = JSON.parse(String(state.body)) as {
      meta: { mode: string };
    };
    expect(parsed.meta.mode).toBe('paper');
  });

  it('ignores non-dashboard paths', () => {
    const req = {
      method: 'GET',
      url: '/health',
      headers: { host: 'localhost:18789' },
    } as any;
    const res = {
      writeHead: () => undefined,
      end: () => undefined,
    } as any;
    expect(handleDashboardApiRequest(req, res)).toBe(false);
  });
});
