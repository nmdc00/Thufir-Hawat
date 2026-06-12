import { describe, expect, it } from 'vitest';

import type { ThufirConfig } from '../../src/core/config.js';
import {
  resolvePriceClimatologyComparator,
  type PriceClimatologyMarketData,
  type PriceClimatologyTarget,
} from '../../src/core/perp_exogenous_comparators.js';
import type { OHLCV } from '../../src/technical/types.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function makeConfig(overrides: Record<string, unknown> = {}): ThufirConfig {
  return {
    autonomy: {
      exogenousComparators: {
        priceClimatology: {
          enabled: true,
          lookbackDays: 30,
          minComparableSamples: 1,
          defaultThresholdPct: 0.015,
          defaultHorizonMinutes: 60,
          ...overrides,
        },
      },
    },
  } as unknown as ThufirConfig;
}

function target(overrides: Partial<PriceClimatologyTarget> = {}): PriceClimatologyTarget {
  return {
    kind: 'price_reaches_directional_threshold_before_horizon',
    symbol: 'SOL',
    direction: 'up',
    thresholdPct: 0.1,
    horizonMinutes: 60,
    referencePrice: 100,
    ...overrides,
  };
}

function candle(hoursAgo: number, open: number, high: number, low: number, close = open): OHLCV {
  return {
    timestamp: NOW.getTime() - hoursAgo * HOUR_MS,
    open,
    high,
    low,
    close,
    volume: 1000,
  };
}

function marketData(candles: OHLCV[]): PriceClimatologyMarketData {
  return {
    symbol: 'SOL',
    candles,
  };
}

describe('resolvePriceClimatologyComparator', () => {
  it('computes upward threshold climatology from OHLCV windows', () => {
    const result = resolvePriceClimatologyComparator(
      makeConfig({ minComparableSamples: 3 }),
      target({ direction: 'up', thresholdPct: 0.1 }),
      marketData([
        candle(4, 100, 105, 99),
        candle(3, 100, 112, 98),
        candle(2, 100, 106, 99),
        candle(1, 100, 111, 97),
      ]),
      NOW
    );

    expect(result.comparable).toBe(true);
    expect(result.source).toBe('price_climatology');
    expect(result.sampleCount).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.probability).toBeCloseTo(2 / 3, 5);
    expect(result.exclusionReason).toBeNull();
  });

  it('computes downward threshold climatology from OHLCV windows', () => {
    const result = resolvePriceClimatologyComparator(
      makeConfig({ minComparableSamples: 3 }),
      target({ direction: 'down', thresholdPct: 0.1 }),
      marketData([
        candle(4, 100, 101, 95),
        candle(3, 100, 104, 88),
        candle(2, 100, 103, 94),
        candle(1, 100, 102, 89),
      ]),
      NOW
    );

    expect(result.comparable).toBe(true);
    expect(result.sampleCount).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.probability).toBeCloseTo(2 / 3, 5);
  });

  it('uses only candles at or before decision time', () => {
    const futureWin = {
      ...candle(-1, 100, 200, 50),
      timestamp: NOW.getTime() + HOUR_MS,
    };

    const result = resolvePriceClimatologyComparator(
      makeConfig({ minComparableSamples: 3 }),
      target({ direction: 'up', thresholdPct: 0.1 }),
      marketData([
        candle(4, 100, 105, 99),
        candle(3, 100, 106, 98),
        candle(2, 100, 104, 99),
        candle(1, 100, 103, 97),
        futureWin,
      ]),
      NOW
    );

    expect(result.sampleCount).toBe(3);
    expect(result.wins).toBe(0);
    expect(result.probability).toBe(0.01);
  });

  it('returns insufficient_samples below configured sample floor', () => {
    const result = resolvePriceClimatologyComparator(
      makeConfig({ minComparableSamples: 4 }),
      target(),
      marketData([
        candle(3, 100, 112, 99),
        candle(2, 100, 106, 98),
        candle(1, 100, 111, 97),
      ]),
      NOW
    );

    expect(result.probability).toBeNull();
    expect(result.comparable).toBe(false);
    expect(result.source).toBe('missing');
    expect(result.sampleCount).toBe(2);
    expect(result.wins).toBe(1);
    expect(result.exclusionReason).toBe('insufficient_samples');
  });

  it('rejects invalid target payloads', () => {
    const result = resolvePriceClimatologyComparator(
      makeConfig(),
      target({ thresholdPct: 0 }),
      marketData([candle(2, 100, 112, 99), candle(1, 100, 106, 98)]),
      NOW
    );

    expect(result.probability).toBeNull();
    expect(result.comparable).toBe(false);
    expect(result.exclusionReason).toBe('invalid_target');
  });

  it('rejects target kind positive_net_pnl_before_ttl_or_invalidation', () => {
    const result = resolvePriceClimatologyComparator(
      makeConfig(),
      {
        kind: 'positive_net_pnl_before_ttl_or_invalidation',
      },
      marketData([candle(2, 100, 112, 99), candle(1, 100, 106, 98)]),
      NOW
    );

    expect(result.probability).toBeNull();
    expect(result.comparable).toBe(false);
    expect(result.exclusionReason).toBe('invalid_target');
  });

  it('rejects market data that does not match the target symbol', () => {
    const result = resolvePriceClimatologyComparator(
      makeConfig(),
      target({ symbol: 'BTC' }),
      marketData([candle(2, 100, 112, 99), candle(1, 100, 106, 98)]),
      NOW
    );

    expect(result.probability).toBeNull();
    expect(result.comparable).toBe(false);
    expect(result.exclusionReason).toBe('target_mismatch');
  });

  it('clamps probabilities after computing the base rate', () => {
    const result = resolvePriceClimatologyComparator(
      makeConfig({ minComparableSamples: 3 }),
      target({ direction: 'up', thresholdPct: 0.1 }),
      marketData([
        candle(4, 100, 112, 99),
        candle(3, 100, 113, 98),
        candle(2, 100, 114, 99),
        candle(1, 100, 115, 97),
      ]),
      NOW
    );

    expect(result.sampleCount).toBe(3);
    expect(result.wins).toBe(3);
    expect(result.probability).toBe(0.99);
  });

  it('produces stable auditable metadata', () => {
    const result = resolvePriceClimatologyComparator(
      makeConfig({ lookbackDays: 10, minComparableSamples: 2 }),
      target({ thresholdPct: 0.05, horizonMinutes: 60, referencePrice: 123.45 }),
      marketData([
        candle(3, 100, 106, 99),
        candle(2, 100, 104, 98),
        candle(1, 100, 107, 97),
      ]),
      NOW
    );

    expect(result).toMatchObject({
      comparatorKind: 'exogenous_price_climatology',
      source: 'price_climatology',
      comparable: true,
      sampleCount: 2,
      wins: 1,
      lookbackDays: 10,
      thresholdPct: 0.05,
      horizonMinutes: 60,
      referencePrice: 123.45,
      frozenAt: '2026-06-12T12:00:00.000Z',
      exclusionReason: null,
    });
  });
});
