import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordOutcome } from '../../src/memory/calibration.js';
import { openDatabase } from '../../src/memory/db.js';
import { createLearningCase, listLearningCases } from '../../src/memory/learning_cases.js';
import { createPrediction } from '../../src/memory/predictions.js';
import {
  buildPerpExecutionLearningCase,
  toPerpExecutionLearningCaseInput,
} from '../../src/core/perp_lifecycle.js';

function useTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-learning-cases-'));
  const path = join(dir, 'thufir.sqlite');
  process.env.THUFIR_DB_PATH = path;
  return path;
}

describe('learning cases', () => {
  beforeEach(() => {
    useTempDb();
  });

  it('syncs comparable forecast cases when a prediction resolves', () => {
    const predictionId = createPrediction({
      marketId: 'poly:1',
      marketTitle: 'Test market',
      predictedOutcome: 'YES',
      predictedProbability: 0.7,
      modelProbability: 0.7,
      marketProbability: 0.58,
      domain: 'prediction_market',
      learningComparable: true,
    });

    createLearningCase({
      caseType: 'comparable_forecast',
      domain: 'prediction_market',
      entityType: 'market',
      entityId: 'poly:1',
      comparable: true,
      comparatorKind: 'market_price',
      sourcePredictionId: predictionId,
    });

    recordOutcome({ id: predictionId, outcome: 'NO', outcomeBasis: 'estimated', pnl: -4 });

    const learningCase = listLearningCases({
      caseType: 'comparable_forecast',
      sourcePredictionId: predictionId,
      limit: 1,
    })[0];

    expect(learningCase).toBeTruthy();
    expect(learningCase.comparable).toBe(false);
    expect(learningCase.exclusionReason).toBe('estimated_outcome_only');
    expect(learningCase.outcome?.outcome).toBe('NO');
    expect(learningCase.outcome?.outcomeBasis).toBe('estimated');
    expect(learningCase.outcome?.pnl).toBe(-4);
  });

  it('persists perp execution-quality cases', () => {
    const learningCase = buildPerpExecutionLearningCase({
      symbol: 'ETH',
      executionMode: 'paper',
      tradeId: 42,
      hypothesisId: 'eth_breakout',
      capturedAtMs: 1_700_000_000_000,
      side: 'sell',
      size: 2,
      leverage: 3,
      direction: 'short',
      signalClass: 'momentum_breakout',
      triggerReason: 'breakout_retest',
      symbolClass: 'liquid_alt',
      session: 'london',
      strategySource: 'discovery_quant',
      marketRegime: 'trending',
      volatilityBucket: 'high',
      liquidityBucket: 'deep',
      tradeArchetype: 'intraday',
      entryTrigger: 'technical',
      expectedEdge: 0.08,
      invalidationPrice: 2550,
      timeStopAtMs: 1_700_000_360_000,
      entryPrice: 2500,
      exitPrice: 2450,
      pricePathHigh: 2520,
      pricePathLow: 2440,
      thesisCorrect: true,
      thesisInvalidationHit: false,
      exitMode: 'take_profit',
      realizedPnlUsd: 100,
      netRealizedPnlUsd: 96,
      realizedFeeUsd: 4,
      directionScore: 0.9,
      timingScore: 0.8,
      sizingScore: 0.7,
      exitScore: 0.85,
      capturedR: 1.5,
      leftOnTableR: 0.3,
      wouldHit2R: false,
      wouldHit3R: false,
      maeProxy: null,
      mfeProxy: null,
      reasoning: 'Breakout continuation',
      planContext: { source: 'test' },
      snapshot: { createdAtMs: 1_700_000_000_000, entryPrice: 2500, exitPrice: 2450 },
    });

    createLearningCase(toPerpExecutionLearningCaseInput(learningCase));

    const stored = listLearningCases({
      caseType: 'execution_quality',
      sourceTradeId: 42,
      limit: 1,
    })[0];

    expect(stored).toBeTruthy();
    expect(stored.entityId).toBe('ETH');
    expect(stored.comparable).toBe(false);
    expect(stored.exclusionReason).toBe('execution_quality_case');
    expect(stored.outcome?.thesisCorrect).toBe(true);
    expect(stored.qualityScores?.capturedR).toBe(1.5);
  });

  it('does not fabricate weight updates when signal scores are missing', () => {
    const predictionId = createPrediction({
      marketId: 'perp:SOL',
      marketTitle: 'SOL long',
      predictedOutcome: 'YES',
      predictedProbability: 0.66,
      modelProbability: 0.66,
      domain: 'perp',
      executed: true,
    });

    recordOutcome({ id: predictionId, outcome: 'YES', outcomeBasis: 'final', pnl: 5 });

    const db = openDatabase();
    const row = db.prepare('SELECT COUNT(*) AS c FROM weight_updates').get() as { c: number };
    expect(row.c).toBe(0);
  });
});
