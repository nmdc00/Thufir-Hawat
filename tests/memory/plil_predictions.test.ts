import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createPrediction, getPrediction } from '../../src/memory/predictions.js';
import { countFinalPredictions, recordOutcome } from '../../src/memory/calibration.js';
import { openDatabase } from '../../src/memory/db.js';
import { getSignalWeights } from '../../src/memory/learning.js';
import { createLearningCase, listLearningCases } from '../../src/memory/learning_cases.js';

function useTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-plil-'));
  const path = join(dir, 'thufir.sqlite');
  process.env.THUFIR_DB_PATH = path;
  return path;
}

describe('PLIL predictions — data integrity', () => {
  beforeEach(() => {
    useTempDb();
  });

  it('migration handles legacy predictions table without predicted_outcome column', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'thufir-legacy-')), 'thufir.sqlite');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE predictions (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        market_title TEXT NOT NULL
      )
    `);
    raw.exec(`INSERT INTO predictions VALUES ('test-1', 'm1', 'Title 1')`);
    raw.close();

    process.env.THUFIR_DB_PATH = dbPath;
    expect(() => openDatabase()).not.toThrow();

    const db = openDatabase();
    const cols = db.prepare("PRAGMA table_info('predictions')").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('model_probability')).toBe(true);
    expect(names.has('market_probability')).toBe(true);
    expect(names.has('learning_comparable')).toBe(true);
    expect(names.has('outcome_basis')).toBe(true);

    const row = db.prepare("SELECT * FROM predictions WHERE id = 'test-1'").get() as any;
    expect(row.learning_comparable).toBe(0);
    expect(row.outcome_basis).toBe('legacy');
  });

  it('perp prediction stores execution fields but remains non-comparable by default', () => {
    const id = createPrediction({
      marketId: 'perp:SOL',
      marketTitle: 'SOL long: breakout thesis',
      predictedOutcome: 'YES',
      predictedProbability: 0.74,
      modelProbability: 0.74,
      symbol: 'SOL',
      domain: 'perp',
      horizonMinutes: 90,
      executed: true,
      executionPrice: 150.5,
      positionSize: 0.667,
    });

    const pred = getPrediction(id);
    expect(pred).not.toBeNull();
    expect(pred!.modelProbability).toBeCloseTo(0.74, 6);
    expect(pred!.marketProbability).toBeNull();
    expect(pred!.learningComparable).toBe(false);
    expect(pred!.executed).toBe(true);
    expect(pred!.executionPrice).toBeCloseTo(150.5, 4);
    expect(pred!.positionSize).toBeCloseTo(0.667, 4);
    expect(pred!.outcomeBasis).toBe('legacy');
    expect(pred!.resolutionStatus).toBe('open');
  });

  it('synthetic perp prediction is never marked learning-comparable', () => {
    const id = createPrediction({
      marketId: 'perp:SOL',
      marketTitle: 'SOL long: synthetic comparator thesis',
      predictedOutcome: 'YES',
      predictedProbability: 0.74,
      modelProbability: 0.74,
      marketProbability: 0.5,
      symbol: 'SOL',
      domain: 'perp',
      learningComparable: true,
      executed: true,
    });

    const pred = getPrediction(id);
    expect(pred).not.toBeNull();
    expect(pred!.marketProbability).toBeCloseTo(0.5, 6);
    expect(pred!.learningComparable).toBe(false);
  });

  it('keeps comparable rows when perp predictions carry a real comparator', () => {
    const id = createPrediction({
      marketId: 'perp:SOL',
      marketTitle: 'SOL long: real comparator thesis',
      predictedOutcome: 'YES',
      predictedProbability: 0.74,
      modelProbability: 0.74,
      marketProbability: 0.47,
      symbol: 'SOL',
      domain: 'perp',
      learningComparable: true,
      comparatorKind: 'exogenous_price_climatology',
      comparatorSource: 'price_climatology',
      forecastTargetKind: 'price_reaches_directional_threshold_before_horizon',
    });

    const pred = getPrediction(id);
    expect(pred).not.toBeNull();
    expect(pred!.marketProbability).toBeCloseTo(0.47, 6);
    expect(pred!.learningComparable).toBe(true);
  });

  it('recordOutcome with explicit pnl writes that value directly (not Polymarket computation)', () => {
    const id = createPrediction({
      marketId: 'perp:ETH',
      marketTitle: 'ETH long test',
      predictedOutcome: 'YES',
      predictedProbability: 0.65,
      modelProbability: 0.65,
      symbol: 'ETH',
      domain: 'perp',
      executed: true,
      executionPrice: 3000,
      positionSize: 0.1,
    });

    recordOutcome({ id, outcome: 'YES', outcomeBasis: 'final', pnl: 12.5 });

    const db = openDatabase();
    const row = db.prepare('SELECT pnl, outcome_basis FROM predictions WHERE id = ?').get(id) as any;
    expect(row.pnl).toBeCloseTo(12.5, 4);
    expect(row.outcome_basis).toBe('final');
    expect(countFinalPredictions()).toBe(0);
  });

  it('recordOutcome demotes synthetic perp comparable rows on final resolution', () => {
    const id = createPrediction({
      marketId: 'perp:ETH',
      marketTitle: 'ETH short test',
      predictedOutcome: 'NO',
      predictedProbability: 0.65,
      modelProbability: 0.65,
      marketProbability: 0.47,
      symbol: 'ETH',
      domain: 'perp',
      learningComparable: true,
      executed: true,
    });

    const db = openDatabase();
    db.prepare('UPDATE predictions SET market_probability = 0.5, learning_comparable = 1 WHERE id = ?').run(id);

    recordOutcome({ id, outcome: 'YES', outcomeBasis: 'final', pnl: -12.5 });

    const row = db
      .prepare('SELECT learning_comparable AS learningComparable, outcome_basis AS outcomeBasis FROM predictions WHERE id = ?')
      .get(id) as { learningComparable: number; outcomeBasis: string };
    expect(row.learningComparable).toBe(0);
    expect(row.outcomeBasis).toBe('final');
  });

  it('recordOutcome with negative pnl (loss) stores the correct negative value', () => {
    const id = createPrediction({
      marketId: 'perp:BTC',
      marketTitle: 'BTC short test',
      predictedOutcome: 'NO',
      predictedProbability: 0.6,
      modelProbability: 0.6,
      symbol: 'BTC',
      domain: 'perp',
      executed: true,
    });

    recordOutcome({ id, outcome: 'YES', outcomeBasis: 'final', pnl: -8.25 });

    const db = openDatabase();
    const row = db.prepare('SELECT pnl, outcome FROM predictions WHERE id = ?').get(id) as any;
    expect(row.pnl).toBeCloseTo(-8.25, 4);
    expect(row.outcome).toBe('YES');
  });

  it('recordOutcome without explicit pnl falls back to positionSize-based computation', () => {
    const id = createPrediction({
      marketId: 'perp:SOL',
      marketTitle: 'SOL long fallback',
      predictedOutcome: 'YES',
      predictedProbability: 0.65,
      modelProbability: 0.65,
      symbol: 'SOL',
      domain: 'perp',
      executed: true,
      executionPrice: 150,
      positionSize: 0.1,
    });

    recordOutcome({ id, outcome: 'NO', outcomeBasis: 'estimated' });

    const db = openDatabase();
    const row = db.prepare('SELECT pnl FROM predictions WHERE id = ?').get(id) as any;
    expect(row.pnl).toBeCloseTo(-0.1, 4);
  });

  it('recordOutcome prefers model_probability over predicted_probability for Brier and learning events', () => {
    const id = createPrediction({
      marketId: 'm-plil-brier',
      marketTitle: 'Comparable prediction',
      predictedOutcome: 'YES',
      predictedProbability: 0.91,
      modelProbability: 0.63,
      marketProbability: 0.52,
      learningComparable: true,
    });

    recordOutcome({ id, outcome: 'YES', outcomeBasis: 'final' });

    const db = openDatabase();
    const predictionRow = db
      .prepare('SELECT brier_contribution FROM predictions WHERE id = ?')
      .get(id) as { brier_contribution: number };
    const learningEventRow = db
      .prepare(
        'SELECT predicted_probability as predictedProbability, notes FROM learning_events WHERE prediction_id = ?'
      )
      .get(id) as { predictedProbability: number; notes: string | null };

    expect(predictionRow.brier_contribution).toBeCloseTo(Math.pow(0.63 - 1, 2), 6);
    expect(learningEventRow.predictedProbability).toBeCloseTo(0.63, 6);
    expect(JSON.parse(learningEventRow.notes ?? '{}')).toMatchObject({
      comparable: true,
      marketProbability: 0.52,
      modelProbability: 0.63,
      outcomeBasis: 'final',
    });
  });

  it('recordOutcome updates canonical comparable learning cases', () => {
    const id = createPrediction({
      marketId: 'm-case-sync',
      marketTitle: 'Canonical comparable case',
      predictedOutcome: 'YES',
      predictedProbability: 0.7,
      modelProbability: 0.66,
      marketProbability: 0.57,
      learningComparable: true,
    });
    const learningCase = createLearningCase({
      caseType: 'comparable_forecast',
      domain: 'prediction_market',
      entityType: 'market',
      entityId: 'm-case-sync',
      comparable: true,
      comparatorKind: 'market_price',
      sourcePredictionId: id,
      belief: { modelProbability: 0.66, predictedOutcome: 'YES' },
      baseline: { marketProbability: 0.57 },
    });

    recordOutcome({
      id,
      outcome: 'YES',
      outcomeBasis: 'final',
      resolutionMetadata: { resolver: 'test' },
    });

    const synced = listLearningCases({ sourcePredictionId: id, limit: 1 })[0];
    expect(synced?.id).toBe(learningCase.id);
    expect(synced?.outcome).toMatchObject({
      outcome: 'YES',
      outcomeValue: 1,
      outcomeBasis: 'final',
      resolutionStatus: 'resolved_true',
      brier: Math.pow(0.66 - 1, 2),
      resolutionMetadata: { resolver: 'test' },
    });
    expect(synced?.policyInputs).toMatchObject({
      sourceTrack: 'comparable_forecast',
      comparableIncluded: true,
    });
  });

  it('recordOutcome updates signal weights when prediction signal scores are stored', () => {
    const before = getSignalWeights('global');
    const id = createPrediction({
      marketId: 'm-signal-weights',
      marketTitle: 'Comparable weighted learning',
      predictedOutcome: 'YES',
      predictedProbability: 0.7,
      modelProbability: 0.7,
      marketProbability: 0.5,
      learningComparable: true,
      signalScores: {
        technical: 0.9,
        news: 0.2,
        onChain: 0.1,
      },
      signalWeightsSnapshot: {
        technical: 0.5,
        news: 0.3,
        onChain: 0.2,
      },
    });

    recordOutcome({ id, outcome: 'YES', outcomeBasis: 'final', pnl: 5 });

    const after = getSignalWeights('global');
    expect(before).toBeNull();
    expect(after).not.toBeNull();
    expect(after!.technical).toBeGreaterThan(0.5);
    expect(after!.news).toBeLessThan(0.3);
    expect(after!.onChain).toBeLessThan(0.2);
  });
});
