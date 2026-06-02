import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { ThufirConfig } from '../../src/core/config.js';
import {
  resolvePerpPredictionBaseline,
  type PerpPredictionBaselineInput,
} from '../../src/core/perp_prediction_baselines.js';
import { createLearningCase } from '../../src/memory/learning_cases.js';
import { openDatabase } from '../../src/memory/db.js';

function useTempDb(): void {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-perp-baselines-'));
  process.env.THUFIR_DB_PATH = join(dir, 'thufir.sqlite');
}

function makeConfig(overrides: Record<string, unknown> = {}): ThufirConfig {
  return {
    autonomy: {
      perpPredictionBaselines: {
        enabled: true,
        priorStrength: 20,
        minComparableSamples: 5,
        lookbackDays: null,
        target: 'positive_net_pnl_before_ttl_or_invalidation',
        ...overrides,
      },
    },
  } as unknown as ThufirConfig;
}

const BASE_INPUT: PerpPredictionBaselineInput = {
  symbol: 'SOL',
  side: 'buy',
  signalClass: 'momentum_breakout',
  marketRegime: 'high_vol_expansion',
  triggerReason: 'technical',
  symbolClass: 'alt',
  session: null,
  volatilityBucket: null,
  liquidityBucket: null,
};

function seedExecutionCase(input: {
  id: string;
  symbol?: string;
  side?: 'buy' | 'sell';
  signalClass?: string | null;
  marketRegime?: string | null;
  triggerReason?: string | null;
  symbolClass?: string | null;
  direction?: 'long' | 'short' | null;
  netRealizedPnlUsd: number;
}): void {
  createLearningCase({
    id: input.id,
    caseType: 'execution_quality',
    domain: 'perp',
    entityType: 'symbol',
    entityId: input.symbol ?? 'SOL',
    comparable: false,
    comparatorKind: null,
    context: {
      symbol: input.symbol ?? 'SOL',
      signalClass: input.signalClass ?? BASE_INPUT.signalClass,
      marketRegime: input.marketRegime ?? BASE_INPUT.marketRegime,
      triggerReason: input.triggerReason ?? BASE_INPUT.triggerReason,
      symbolClass: input.symbolClass ?? BASE_INPUT.symbolClass,
      direction: input.direction ?? (input.side === 'sell' ? 'short' : 'long'),
    },
    action: {
      side: input.side ?? 'buy',
    },
    outcome: {
      netRealizedPnlUsd: input.netRealizedPnlUsd,
    },
    exclusionReason: 'execution_quality_case',
  });
}

describe('resolvePerpPredictionBaseline', () => {
  beforeEach(() => {
    useTempDb();
  });

  it('uses exact segment when enough samples exist', () => {
    for (let index = 0; index < 4; index += 1) {
      seedExecutionCase({ id: `exact-win-${index}`, netRealizedPnlUsd: 10 });
    }
    for (let index = 0; index < 2; index += 1) {
      seedExecutionCase({ id: `exact-loss-${index}`, netRealizedPnlUsd: -5 });
    }
    for (let index = 0; index < 4; index += 1) {
      seedExecutionCase({
        id: `broader-short-loss-${index}`,
        side: 'sell',
        direction: 'short',
        netRealizedPnlUsd: -5,
      });
    }

    const result = resolvePerpPredictionBaseline(makeConfig(), BASE_INPUT, openDatabase());

    expect(result.source).toBe('segment_history_blended');
    expect(result.comparable).toBe(true);
    expect(result.fallbackLevel).toBe('signal_regime_trigger_symbol_class_direction');
    expect(result.sampleCount).toBe(6);
    expect(result.wins).toBe(4);
    expect(result.priorProbability).toBeCloseTo(0.4, 5);
    expect(result.probability).toBeCloseTo(12 / 26, 5);
    expect(result.segmentKey).toBe(
      'signalClass=momentum_breakout|marketRegime=high_vol_expansion|triggerReason=technical|symbolClass=alt|direction=long'
    );
    expect(result.exclusionReason).toBeNull();
  });

  it('falls back hierarchically when exact segment is sparse', () => {
    seedExecutionCase({ id: 'sparse-exact', netRealizedPnlUsd: 8 });
    for (let index = 0; index < 5; index += 1) {
      seedExecutionCase({
        id: `regime-win-${index}`,
        triggerReason: 'macro',
        symbolClass: 'major',
        netRealizedPnlUsd: 10,
      });
    }
    for (let index = 0; index < 2; index += 1) {
      seedExecutionCase({
        id: `regime-loss-${index}`,
        triggerReason: 'macro',
        symbolClass: 'major',
        netRealizedPnlUsd: -4,
      });
    }

    const result = resolvePerpPredictionBaseline(makeConfig({ minComparableSamples: 5 }), BASE_INPUT, openDatabase());

    expect(result.comparable).toBe(true);
    expect(result.fallbackLevel).toBe('signal_regime');
    expect(result.sampleCount).toBe(8);
    expect(result.wins).toBe(6);
    expect(result.segmentKey).toBe('signalClass=momentum_breakout|marketRegime=high_vol_expansion');
  });

  it('returns missing comparator when no evidence exists', () => {
    const result = resolvePerpPredictionBaseline(makeConfig(), BASE_INPUT, openDatabase());

    expect(result.probability).toBeNull();
    expect(result.comparable).toBe(false);
    expect(result.source).toBe('missing');
    expect(result.exclusionReason).toBe('missing_comparator');
  });

  it('does not mark pure global prior comparable unless configured', () => {
    for (let index = 0; index < 8; index += 1) {
      seedExecutionCase({
        id: `global-only-${index}`,
        signalClass: 'mean_reversion',
        marketRegime: 'range_bound',
        triggerReason: 'technical',
        symbolClass: 'major',
        netRealizedPnlUsd: index < 5 ? 10 : -5,
      });
    }

    const result = resolvePerpPredictionBaseline(makeConfig({ minComparableSamples: 5 }), BASE_INPUT, openDatabase());

    expect(result.source).toBe('global_prior');
    expect(result.probability).not.toBeNull();
    expect(result.comparable).toBe(false);
    expect(result.fallbackLevel).toBe('global');
    expect(result.exclusionReason).toBe('insufficient_samples');
  });

  it('clamps malformed probabilities', () => {
    for (let index = 0; index < 6; index += 1) {
      seedExecutionCase({ id: `clamp-win-${index}`, netRealizedPnlUsd: 10 });
    }

    const result = resolvePerpPredictionBaseline(
      makeConfig({ priorStrength: 0, minComparableSamples: 5 }),
      BASE_INPUT,
      openDatabase()
    );

    expect(result.probability).toBe(0.99);
    expect(result.comparable).toBe(true);
  });

  it('does not use raw symbol by default', () => {
    for (let index = 0; index < 5; index += 1) {
      seedExecutionCase({ id: `btc-overfit-${index}`, symbol: 'BTC', netRealizedPnlUsd: 10 });
      seedExecutionCase({ id: `eth-counter-${index}`, symbol: 'ETH', netRealizedPnlUsd: -10 });
    }

    const result = resolvePerpPredictionBaseline(
      makeConfig({ priorStrength: 0, minComparableSamples: 5 }),
      { ...BASE_INPUT, symbol: 'BTC' },
      openDatabase()
    );

    expect(result.comparable).toBe(true);
    expect(result.probability).toBeCloseTo(0.5, 5);
    expect(result.segmentKey).not.toContain('symbol=');
    expect(result.segmentKey).not.toContain('BTC');
  });
});
