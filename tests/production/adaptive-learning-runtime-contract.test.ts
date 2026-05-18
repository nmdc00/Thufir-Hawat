import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateGlobalTradeGate } from '../../src/core/autonomy_policy.js';
import { materializeTradePolicyAdjustmentFromLearningCase } from '../../src/core/trade_policy_materialization.js';
import { recordOutcome } from '../../src/memory/calibration.js';
import { openDatabase } from '../../src/memory/db.js';
import { createLearningCase } from '../../src/memory/learning_cases.js';
import { listLearningSignalAudits } from '../../src/memory/learning_observability.js';
import { createPrediction } from '../../src/memory/predictions.js';
import { listTradePolicyAdjustments } from '../../src/memory/trade_policy_adjustments.js';

function useTempDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-adaptive-learning-contract-'));
  process.env.THUFIR_DB_PATH = join(dir, 'thufir.sqlite');
  openDatabase();
}

function createExecutionLearningCase(tradeId: number) {
  return createLearningCase({
    caseType: 'execution_quality',
    domain: 'perp',
    entityType: 'symbol',
    entityId: 'BTC',
    comparable: false,
    exclusionReason: 'execution_quality_case',
    sourceTradeId: tradeId,
    context: {
      signalClass: 'mean_reversion',
      marketRegime: 'trending',
      volatilityBucket: 'high',
      liquidityBucket: 'deep',
    },
    outcome: {
      thesisCorrect: false,
      netRealizedPnlUsd: -10 - tradeId,
    },
    qualityScores: {
      compositeScore: 0.35,
    },
  });
}

describe('adaptive learning runtime contract', () => {
  beforeEach(() => {
    useTempDb();
  });

  it('persists learning surfaces and changes later policy decisions', () => {
    const predictionId = createPrediction({
      marketId: 'perp:BTC',
      marketTitle: 'BTC long contract test',
      predictedOutcome: 'YES',
      predictedProbability: 0.7,
      modelProbability: 0.7,
      domain: 'perp',
      symbol: 'BTC',
      executed: true,
      signalScores: {
        technical: 0.85,
        news: 0.25,
        onChain: 0.15,
      },
      signalWeightsSnapshot: {
        technical: 0.5,
        news: 0.3,
        onChain: 0.2,
      },
    });

    recordOutcome({ id: predictionId, outcome: 'YES', outcomeBasis: 'final', pnl: 8 });

    const learningCases = [
      createExecutionLearningCase(1),
      createExecutionLearningCase(2),
      createExecutionLearningCase(3),
    ];
    const adjustment = materializeTradePolicyAdjustmentFromLearningCase({
      config: {
        autonomy: {
          signalPerformance: { minSamples: 99 },
          calibrationRisk: { enabled: false },
          tradeQuality: { enabled: false },
          tradePolicyAdjustments: {
            enabled: true,
            minSamples: 3,
            blockOnThesisFailureRatio: 2,
            blockBelowScore: 0.2,
            downweightOnThesisFailureRatio: 0.5,
            downweightBelowScore: 0.5,
            downweightMultiplier: 0.4,
          },
        },
      } as any,
      learningCase: learningCases[2]!,
    });

    expect(listLearningSignalAudits('perp')).toHaveLength(1);
    expect(adjustment).not.toBeNull();
    expect(listTradePolicyAdjustments('perp').filter((row) => row.active)).toHaveLength(1);

    const gate = evaluateGlobalTradeGate(
      {
        autonomy: {
          enabled: true,
          fullAuto: true,
          signalPerformance: { minSamples: 99 },
          calibrationRisk: { enabled: false },
          tradeQuality: { enabled: false },
        },
      } as any,
      {
        signalClass: 'mean_reversion',
        marketRegime: 'trending',
        volatilityBucket: 'high',
        liquidityBucket: 'deep',
      }
    );

    expect(gate.allowed).toBe(true);
    expect(gate.reasonCode).toBe('policy:size:downweight');
    expect(gate.sizeMultiplier).toBeCloseTo(0.4, 6);
    expect(gate.activeAdjustmentIds.length).toBeGreaterThan(0);
  });
});
