import { describe, expect, it } from 'vitest';

import {
  summarizeComparableSignalPerformance,
  summarizeAllSignalClasses,
  summarizeSignalPerformance,
} from '../../src/core/signal_performance.js';

describe('signal_performance', () => {
  it('summarizes per-signal expectancy and sharpe-like score', () => {
    const entries = [
      { kind: 'perp_trade_journal', outcome: 'executed', signalClass: 'mean_reversion', thesisCorrect: true },
      { kind: 'perp_trade_journal', outcome: 'executed', signalClass: 'mean_reversion', thesisCorrect: false },
      { kind: 'perp_trade_journal', outcome: 'failed', signalClass: 'mean_reversion', thesisCorrect: false },
      { kind: 'perp_trade_journal', outcome: 'executed', signalClass: 'momentum_breakout', thesisCorrect: true },
    ] as any;

    const mr = summarizeSignalPerformance(entries, 'mean_reversion');
    expect(mr.sampleCount).toBe(3);
    expect(mr.wins).toBe(1);
    expect(mr.losses).toBe(2);
    expect(Number.isFinite(mr.expectancy)).toBe(true);
  });

  it('builds summary map for all populated signal classes', () => {
    const entries = [
      { kind: 'perp_trade_journal', outcome: 'executed', signalClass: 'mean_reversion', thesisCorrect: true },
      { kind: 'perp_trade_journal', outcome: 'executed', signalClass: 'momentum_breakout', thesisCorrect: true },
    ] as any;

    const map = summarizeAllSignalClasses(entries);
    expect(Object.keys(map)).toContain('mean_reversion');
    expect(Object.keys(map)).toContain('momentum_breakout');
  });

  it('excludes blocked and unresolved entries from realized sample counts', () => {
    const entries = [
      { kind: 'perp_trade_journal', symbol: 'XYZ:GOLD', outcome: 'blocked', signalClass: 'momentum_breakout' },
      { kind: 'perp_trade_journal', symbol: 'XYZ:GOLD', outcome: 'executed', signalClass: 'momentum_breakout', thesisCorrect: null },
      { kind: 'perp_trade_journal', symbol: 'XYZ:GOLD', outcome: 'executed', signalClass: 'momentum_breakout', thesisCorrect: true },
      { kind: 'perp_trade_journal', symbol: 'XYZ:GOLD', outcome: 'executed', signalClass: 'momentum_breakout', thesisCorrect: false },
    ] as any;

    const summary = summarizeSignalPerformance(entries, 'momentum_breakout');
    expect(summary.sampleCount).toBe(2);
    expect(summary.observedCount).toBe(4);
    expect(summary.blockedCount).toBe(1);
    expect(summary.unresolvedCount).toBe(1);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(1);
  });

  it('prefers narrower comparable scope and derives symbolClass from symbol when missing', () => {
    const entries = [
      { kind: 'perp_trade_journal', symbol: 'XYZ:GOLD', outcome: 'executed', signalClass: 'momentum_breakout', marketRegime: 'trending', thesisCorrect: true },
      { kind: 'perp_trade_journal', symbol: 'XYZ:GOLD', outcome: 'blocked', signalClass: 'momentum_breakout', marketRegime: 'trending' },
      { kind: 'perp_trade_journal', symbol: 'ETH', outcome: 'executed', signalClass: 'momentum_breakout', marketRegime: 'trending', thesisCorrect: false },
    ] as any;

    const summary = summarizeComparableSignalPerformance(entries, {
      signalClass: 'momentum_breakout',
      symbolClass: 'macro_contract',
      marketRegime: 'trending',
    });
    expect(summary.sampleCount).toBe(1);
    expect(summary.scopeLevel).toBe('signal_class_and_symbol_class_and_regime');
    expect(summary.symbolClass).toBe('macro_contract');
    expect(summary.blockedCount).toBe(1);
  });

  it('falls back from regime scope to symbol-class scope to signal-class scope', () => {
    const entries = [
      { kind: 'perp_trade_journal', symbol: 'XYZ:GOLD', outcome: 'executed', signalClass: 'momentum_breakout', marketRegime: 'choppy', thesisCorrect: true },
      { kind: 'perp_trade_journal', symbol: 'ETH', outcome: 'executed', signalClass: 'momentum_breakout', marketRegime: 'trending', thesisCorrect: false },
    ] as any;

    const summary = summarizeComparableSignalPerformance(entries, {
      signalClass: 'momentum_breakout',
      symbolClass: 'macro_contract',
      marketRegime: 'trending',
    });
    expect(summary.sampleCount).toBe(1);
    expect(summary.scopeLevel).toBe('signal_class_and_symbol_class');
    expect(summary.symbolClass).toBe('macro_contract');
  });
});
