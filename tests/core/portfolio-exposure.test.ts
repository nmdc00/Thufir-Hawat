import { describe, expect, it } from 'vitest';

import { evaluateExposure, type PortfolioExposureConfig } from '../../src/core/portfolio_exposure.js';
import type { BookEntry } from '../../src/core/position_book.js';

const cfg: PortfolioExposureConfig = {
  enabled: true,
  maxGrossLeverage: 3,
  maxNetLeverage: 2,
  maxClusterPercent: 75,
  clusters: {
    'crypto-majors': ['BTC', 'ETH', 'SOL'],
    energy: {
      oil: ['CL', 'BRENTOIL'],
      gas: ['NG'],
    },
  },
};

function entry(symbol: string, side: 'long' | 'short', notionalUsd: number): BookEntry {
  return {
    symbol,
    side,
    size: notionalUsd,
    entryPrice: 1,
    currentMarkPrice: 1,
    unrealizedPnlUsd: null,
    entryReasoningText: '',
    thesisExpiresAtMs: 0,
    exitContract: null,
    exitContractSummary: null,
    lastConsultAtMs: null,
    lastConsultDecision: null,
    entryAtMs: null,
  };
}

describe('portfolio exposure evaluator', () => {
  it('blocks gross exposure cap breaches', () => {
    const verdict = evaluateExposure(
      [entry('BTC', 'long', 250)],
      { symbol: 'ETH', side: 'buy', notionalUsd: 60 },
      100,
      { ...cfg, maxClusterPercent: 400 },
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('exposure_gross_cap');
    expect(verdict.detail.after.grossUsd).toBe(310);
  });

  it('blocks net exposure cap breaches', () => {
    const verdict = evaluateExposure(
      [entry('BTC', 'long', 180)],
      { symbol: 'ETH', side: 'buy', notionalUsd: 30 },
      100,
      { ...cfg, maxClusterPercent: 400 },
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('exposure_net_cap');
    expect(verdict.detail.after.absNetUsd).toBe(210);
  });

  it('allows opposite-side opens that reduce an already over-cap short-heavy book', () => {
    const book = [
      ...Array.from({ length: 10 }, (_, i) => entry(`SHORT${i}`, 'short', 30)),
      ...Array.from({ length: 2 }, (_, i) => entry(`LONG${i}`, 'long', 30)),
    ];

    const newShort = evaluateExposure(
      book,
      { symbol: 'NEW_SHORT', side: 'sell', notionalUsd: 20 },
      100,
      cfg,
    );
    const newLong = evaluateExposure(
      book,
      { symbol: 'NEW_LONG', side: 'buy', notionalUsd: 20 },
      100,
      cfg,
    );

    expect(newShort.allowed).toBe(false);
    expect(newShort.reason).toBe('exposure_gross_cap');
    expect(newLong.allowed).toBe(true);
    expect(newLong.detail.existingBookOverCap).toBe(true);
    expect(newLong.detail.netExposureImproves).toBe(true);
  });

  it('blocks cluster cap breaches', () => {
    const verdict = evaluateExposure(
      [entry('BTC', 'long', 60)],
      { symbol: 'ETH', side: 'sell', notionalUsd: 20 },
      100,
      cfg,
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('exposure_cluster_cap');
    expect(verdict.detail.after.clusterUsd['crypto-majors']).toBe(80);
  });

  it('blocks same-side duplicate underlying and allows opposite side', () => {
    const book = [entry('CL', 'short', 30)];
    const sameSide = evaluateExposure(
      book,
      { symbol: 'BRENTOIL', side: 'sell', notionalUsd: 20 },
      100,
      cfg,
    );
    const oppositeSide = evaluateExposure(
      book,
      { symbol: 'BRENTOIL', side: 'buy', notionalUsd: 20 },
      100,
      cfg,
    );

    expect(sameSide.allowed).toBe(false);
    expect(sameSide.reason).toBe('exposure_duplicate_underlying');
    expect(sameSide.detail.duplicateUnderlying).toMatchObject({
      symbol: 'CL',
      cluster: 'energy',
      underlying: 'OIL',
    });
    expect(oppositeSide.allowed).toBe(true);
  });

  it('treats unmapped symbols as singleton clusters', () => {
    const verdict = evaluateExposure(
      [entry('NEWCOIN', 'long', 70)],
      { symbol: 'NEWCOIN', side: 'sell', notionalUsd: 10 },
      100,
      cfg,
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('exposure_cluster_cap');
    expect(verdict.detail.candidate.cluster).toBe('unclustered:NEWCOIN');
    expect(verdict.detail.candidate.mapped).toBe(false);
  });
});
