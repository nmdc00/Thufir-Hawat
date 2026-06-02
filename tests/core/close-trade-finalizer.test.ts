import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrapOpenPerpPositionLifecycles } from '../../src/core/close_trade_finalizer.js';
import { openDatabase } from '../../src/memory/db.js';
import { createLearningCase } from '../../src/memory/learning_cases.js';
import { recordTradeCloseEvent } from '../../src/memory/close_trade_finalizer.js';
import { finalizeCloseEvent } from '../../src/core/close_trade_finalizer.js';
import { placePaperPerpOrder } from '../../src/memory/paper_perps.js';
import { getActivePerpPositionTradeId } from '../../src/memory/perp_trades.js';

describe('close trade finalizer bootstrap', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-close-finalizer-'));
    process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');
  });

  afterEach(() => {
    if (process.env.THUFIR_DB_PATH) {
      rmSync(process.env.THUFIR_DB_PATH, { force: true });
      rmSync(dirname(process.env.THUFIR_DB_PATH), { recursive: true, force: true });
    }
    if (originalDbPath === undefined) {
      delete process.env.THUFIR_DB_PATH;
    } else {
      process.env.THUFIR_DB_PATH = originalDbPath;
    }
  });

  it('bootstraps active lifecycles for already-open paper net positions', () => {
    placePaperPerpOrder(
      { symbol: 'BOOT', side: 'buy', size: 0.25, orderType: 'market', markPrice: 100, leverage: 2 },
      { initialCashUsdc: 200 }
    );

    expect(getActivePerpPositionTradeId('BOOT')).toBeNull();

    const result = bootstrapOpenPerpPositionLifecycles({
      mode: 'paper',
      initialCashUsdc: 200,
      source: 'test',
    });

    expect(result).toEqual({ inspected: 1, bootstrapped: 1, skipped: 0 });
    const tradeId = getActivePerpPositionTradeId('BOOT');
    expect(tradeId).toBeGreaterThan(0);

    const db = openDatabase();
    const artifact = db
      .prepare("SELECT kind, market_id FROM decision_artifacts WHERE kind = 'close_finalizer_bootstrap'")
      .get() as { kind: string; market_id: string };
    expect(artifact).toEqual({ kind: 'close_finalizer_bootstrap', market_id: 'BOOT' });

    const second = bootstrapOpenPerpPositionLifecycles({ mode: 'paper', initialCashUsdc: 200, source: 'test' });
    expect(second).toEqual({ inspected: 1, bootstrapped: 0, skipped: 1 });
  });

  it('finalizes policy evidence with entry regime when close journal omits it', () => {
    createLearningCase({
      caseType: 'execution_quality',
      domain: 'perp',
      entityType: 'symbol',
      entityId: 'XYZ:TSLA',
      comparable: false,
      exclusionReason: 'execution_quality_case',
      sourceTradeId: 101,
      context: {
        symbol: 'XYZ:TSLA',
        triggerReason: 'technical',
        signalClass: 'momentum_breakout',
        marketRegime: 'high_vol_expansion',
      },
      outcome: {
        thesisCorrect: true,
        netRealizedPnlUsd: -2.1,
      },
      qualityScores: {
        compositeScore: 0.5,
      },
    });
    createLearningCase({
      caseType: 'execution_quality',
      domain: 'perp',
      entityType: 'symbol',
      entityId: 'XYZ:EWY',
      comparable: false,
      exclusionReason: 'execution_quality_case',
      sourceTradeId: 102,
      context: {
        symbol: 'XYZ:EWY',
        triggerReason: 'technical',
        signalClass: 'momentum_breakout',
        marketRegime: 'high_vol_expansion',
      },
      outcome: {
        thesisCorrect: true,
        netRealizedPnlUsd: -2.0,
      },
      qualityScores: {
        compositeScore: 0.52,
      },
    });
    createLearningCase({
      caseType: 'execution_quality',
      domain: 'perp',
      entityType: 'symbol',
      entityId: 'XYZ:CRWV',
      comparable: false,
      exclusionReason: 'execution_quality_case',
      sourceTradeId: 103,
      context: {
        symbol: 'XYZ:CRWV',
        triggerReason: 'technical',
        signalClass: 'momentum_breakout',
        marketRegime: 'high_vol_expansion',
      },
      outcome: {
        thesisCorrect: true,
        netRealizedPnlUsd: -1.7,
      },
      qualityScores: {
        compositeScore: 0.51,
      },
    });

    const event = recordTradeCloseEvent({
      id: 'close-103',
      lifecycleId: 'life-103',
      tradeId: 103,
      symbol: 'XYZ:CRWV',
      executionMode: 'paper',
      side: 'buy',
      closeKind: 'full_close',
      sizeReduced: 0.5,
      realizedPnlUsd: -1.65,
      netRealizedPnlUsd: -1.7,
      realizedFeeUsd: 0.05,
      exitPrice: 97,
      exitMode: 'risk_reduction',
      entryJournalPayload: {
        symbol: 'XYZ:CRWV',
        side: 'sell',
        size: 0.5,
        markPrice: 100,
        signalClass: 'momentum_breakout',
        marketRegime: 'high_vol_expansion',
        entryTrigger: 'technical',
      },
      closeJournalPayload: {
        symbol: 'XYZ:CRWV',
        side: 'buy',
        size: 0.5,
        signalClass: 'momentum_breakout',
        marketRegime: null,
        entryTrigger: 'technical',
        thesisCorrect: true,
        realizedPnlUsd: -1.65,
        netRealizedPnlUsd: -1.7,
        capturedR: -1.1,
        directionScore: 1,
        timingScore: 0.9,
        sizingScore: 0.7,
        exitScore: 0,
      },
    });

    finalizeCloseEvent({
      config: {
        autonomy: {
          tradePolicyAdjustments: {
            enabled: true,
            minSamples: 3,
            downweightOnThesisFailureRatio: 2,
            downweightOnNegativePnlRatio: 0.6,
            downweightMultiplier: 0.4,
          },
        },
      } as any,
      closeEventId: event.id,
    });

    const db = openDatabase();
    const regret = db
      .prepare('SELECT policy_evidence_payload AS payload FROM regret_learning_cases WHERE trade_close_id = ?')
      .get(event.id) as { payload: string } | undefined;
    const adjustment = db
      .prepare(
        `
          SELECT symbol, signal_class AS signalClass, market_regime AS marketRegime,
                 action, size_multiplier AS sizeMultiplier, evidence_count AS evidenceCount,
                 negative_pnl_rate AS negativePnlRate
          FROM trade_policy_adjustments
          WHERE active = 1
        `
      )
      .get() as
      | {
          symbol: string | null;
          signalClass: string;
          marketRegime: string;
          action: string;
          sizeMultiplier: number;
          evidenceCount: number;
          negativePnlRate: number;
        }
      | undefined;

    expect(regret ? JSON.parse(regret.payload) : null).toMatchObject({
      signalClass: 'momentum_breakout',
      marketRegime: 'high_vol_expansion',
    });
    expect(adjustment).toMatchObject({
      symbol: null,
      signalClass: 'momentum_breakout',
      marketRegime: 'high_vol_expansion',
      action: 'downweight',
      sizeMultiplier: 0.4,
      evidenceCount: 3,
      negativePnlRate: 1,
    });
  });
});
