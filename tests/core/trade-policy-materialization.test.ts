import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLearningCase } from '../../src/memory/learning_cases.js';
import { openDatabase } from '../../src/memory/db.js';
import { listTradePolicyAdjustments } from '../../src/memory/trade_policy_adjustments.js';
import {
  deriveTradePolicyAdjustments,
  materializeTradePolicyAdjustmentFromLearningCase,
} from '../../src/core/trade_policy_materialization.js';

function useTempDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-trade-policy-materialization-'));
  process.env.THUFIR_DB_PATH = join(dir, 'thufir.sqlite');
  openDatabase();
}

function createExecutionLearningCase(params: {
  tradeId: number;
  signalClass: string;
  marketRegime?: string;
  thesisCorrect: boolean;
  netPnl: number;
  compositeScore: number;
  leverage?: number;
  triggerReason?: string;
  symbolClass?: string;
  session?: string;
  strategySource?: string;
  confirmationHelpful?: boolean;
  cooldownHelpful?: boolean;
  cooldownMinutes?: number;
  failureMode?: string;
}) {
  return createLearningCase({
    caseType: 'execution_quality',
    domain: 'perp',
    entityType: 'symbol',
    entityId: 'BTC',
    comparable: false,
    exclusionReason: 'execution_quality_case',
    sourceTradeId: params.tradeId,
    context: {
      triggerReason: params.triggerReason ?? 'news',
      signalClass: params.signalClass,
      symbolClass: params.symbolClass ?? 'major',
      session: params.session ?? 'us_open',
      strategySource: params.strategySource ?? 'discovery_news',
      marketRegime: params.marketRegime ?? 'trending',
      volatilityBucket: 'high',
      liquidityBucket: 'deep',
      confirmationHelpful: params.confirmationHelpful ?? false,
      cooldownHelpful: params.cooldownHelpful ?? false,
      cooldownMinutes: params.cooldownMinutes ?? null,
      failureMode: params.failureMode ?? null,
    },
    action: {
      side: 'buy',
      leverage: params.leverage ?? 2,
    },
    outcome: {
      thesisCorrect: params.thesisCorrect,
      netRealizedPnlUsd: params.netPnl,
    },
    qualityScores: {
      compositeScore: params.compositeScore,
    },
  });
}

describe('trade policy materialization', () => {
  beforeEach(() => {
    useTempDb();
  });

  it('does not materialize an adjustment before minimum evidence is met', () => {
    const learningCase = createExecutionLearningCase({
      tradeId: 1,
      signalClass: 'mean_reversion',
      thesisCorrect: false,
      netPnl: -12,
      compositeScore: 0.4,
    });

    const adjustment = materializeTradePolicyAdjustmentFromLearningCase({
      config: {
        autonomy: {
          tradePolicyAdjustments: {
            enabled: true,
            minSamples: 2,
          },
        },
      } as any,
      learningCase,
    });

    expect(adjustment).toBeNull();
    expect(listTradePolicyAdjustments('perp')).toHaveLength(0);
  });

  it('replaces the prior active row when the same scope materializes again', () => {
    createExecutionLearningCase({
      tradeId: 1,
      signalClass: 'mean_reversion',
      thesisCorrect: false,
      netPnl: -10,
      compositeScore: 0.45,
    });
    const second = createExecutionLearningCase({
      tradeId: 2,
      signalClass: 'mean_reversion',
      thesisCorrect: false,
      netPnl: -9,
      compositeScore: 0.4,
    });

    const firstAdjustment = materializeTradePolicyAdjustmentFromLearningCase({
      config: {
        autonomy: {
          tradePolicyAdjustments: {
            enabled: true,
            minSamples: 2,
            downweightOnThesisFailureRatio: 0.5,
          },
        },
      } as any,
      learningCase: second,
    });
    expect(firstAdjustment).not.toBeNull();

    const third = createExecutionLearningCase({
      tradeId: 3,
      signalClass: 'mean_reversion',
      thesisCorrect: false,
      netPnl: -15,
      compositeScore: 0.2,
    });
    const replacement = materializeTradePolicyAdjustmentFromLearningCase({
      config: {
        autonomy: {
          tradePolicyAdjustments: {
            enabled: true,
            minSamples: 2,
            blockBelowScore: 0.3,
          },
        },
      } as any,
      learningCase: third,
    });

    const rows = listTradePolicyAdjustments('perp').filter(
      (row) => row.signalClass === 'mean_reversion'
    );
    expect(replacement).not.toBeNull();
    expect(rows.filter((row) => row.active)).toHaveLength(1);
    expect(rows.find((row) => row.active)?.id).toBe(replacement?.id);
    expect(rows.find((row) => row.id === firstAdjustment?.id)?.active).toBe(false);
  });

  it('derives confirmation, cooldown, and leverage-cap policies from repeated evidence', () => {
    const cases = [
      createExecutionLearningCase({
        tradeId: 10,
        signalClass: 'news_event',
        thesisCorrect: false,
        netPnl: -18,
        compositeScore: 0.5,
        leverage: 5,
        confirmationHelpful: true,
        cooldownHelpful: true,
        cooldownMinutes: 30,
        failureMode: 'post_news_whipsaw',
      }),
      createExecutionLearningCase({
        tradeId: 11,
        signalClass: 'news_event',
        thesisCorrect: false,
        netPnl: -16,
        compositeScore: 0.48,
        leverage: 4,
        confirmationHelpful: true,
        cooldownHelpful: true,
        cooldownMinutes: 45,
        failureMode: 'post_news_whipsaw',
      }),
      createExecutionLearningCase({
        tradeId: 12,
        signalClass: 'news_event',
        thesisCorrect: false,
        netPnl: -14,
        compositeScore: 0.46,
        leverage: 4,
        failureMode: 'post_news_whipsaw',
      }),
    ];

    const derived = deriveTradePolicyAdjustments(
      {
        autonomy: {
          tradePolicyAdjustments: {
            enabled: true,
            minSamples: 3,
            confirmationMinSamples: 2,
            cooldownMinSamples: 2,
            leverageCapOnNegativePnlRatio: 0.6,
            downweightOnThesisFailureRatio: 0.5,
          },
        },
      } as any,
      cases
    );

    expect(derived.map((entry) => entry.policyKey)).toEqual(
      expect.arrayContaining(['confirmation', 'cooldown', 'leverage', 'size'])
    );
    expect(derived.find((entry) => entry.policyKey === 'confirmation')?.action).toBe('require_confirmation');
    expect(derived.find((entry) => entry.policyKey === 'cooldown')?.cooldownMinutes).toBe(45);
    expect(derived.find((entry) => entry.policyKey === 'leverage')?.leverageCap).toBe(3);
  });
});
