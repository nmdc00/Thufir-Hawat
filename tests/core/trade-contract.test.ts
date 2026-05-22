import { describe, expect, it } from 'vitest';

import {
  hydrateEntryTradeContract,
  normalizeReduceOnlyExitFsmInput,
  validateEntryTradeContract,
  validateReduceOnlyExitFsm,
} from '../../src/core/trade_contract.js';

describe('trade contract validation', () => {
  const nowMs = Date.parse('2026-02-17T12:00:00Z');

  it('passes through when enforcement is disabled', () => {
    const result = validateEntryTradeContract({
      enabled: false,
      reduceOnly: false,
      input: {},
      nowMs,
    });
    expect(result.valid).toBe(true);
  });

  it('requires archetype/invalidation/time stop when enabled', () => {
    const result = validateEntryTradeContract({
      enabled: true,
      reduceOnly: false,
      input: {},
      nowMs,
    });
    expect(result.valid).toBe(false);
  });

  it('enforces invalidation_price for price-level contracts', () => {
    const result = validateEntryTradeContract({
      enabled: true,
      reduceOnly: false,
      input: {
        tradeArchetype: 'intraday',
        invalidationType: 'price_level',
        timeStopAtMs: nowMs + 60 * 60 * 1000,
        trailMode: 'atr',
      },
      nowMs,
    });
    expect(result.valid).toBe(false);
  });

  it('enforces minimum hold windows by archetype', () => {
    const result = validateEntryTradeContract({
      enabled: true,
      reduceOnly: false,
      input: {
        tradeArchetype: 'swing',
        invalidationType: 'structure_break',
        timeStopAtMs: nowMs + 60 * 60 * 1000,
        takeProfitR: 2,
        trailMode: 'none',
      },
      nowMs,
    });
    expect(result.valid).toBe(false);
  });

  it('accepts a valid enabled contract', () => {
    const result = validateEntryTradeContract({
      enabled: true,
      reduceOnly: false,
      input: {
        tradeArchetype: 'intraday',
        invalidationType: 'price_level',
        invalidationPrice: 49000,
        timeStopAtMs: nowMs + 3 * 60 * 60 * 1000,
        trailMode: 'none',
      },
      nowMs,
    });
    expect(result.valid).toBe(true);
  });

  it('hydrates missing entry fields deterministically when enforcement is enabled', () => {
    const hydrated = hydrateEntryTradeContract({
      enabled: true,
      reduceOnly: false,
      side: 'buy',
      markPrice: 100,
      input: {},
      nowMs,
    });

    expect(hydrated.tradeArchetype).toBe('intraday');
    expect(hydrated.invalidationType).toBe('price_level');
    expect(Number(hydrated.invalidationPrice)).toBeGreaterThan(0);
    expect(Number(hydrated.timeStopAtMs)).toBeGreaterThan(nowMs);
    expect(hydrated.trailMode).toBe('structure');
  });

  it('rejects discretionary reduce-only exits when FSM enforcement is enabled', () => {
    const result = validateReduceOnlyExitFsm({
      enabled: true,
      reduceOnly: true,
      exitMode: 'manual',
      thesisInvalidationHit: false,
      emergencyOverride: false,
      emergencyReason: null,
    });
    expect(result.valid).toBe(false);
  });

  it('accepts emergency override reduce-only exits when reason is provided', () => {
    const result = validateReduceOnlyExitFsm({
      enabled: true,
      reduceOnly: true,
      exitMode: 'manual',
      thesisInvalidationHit: false,
      emergencyOverride: true,
      emergencyReason: 'liquidation buffer collapsed after venue spike',
    });
    expect(result.valid).toBe(true);
  });

  it('normalizes missing reduce-only exit metadata under FSM enforcement', () => {
    const normalized = normalizeReduceOnlyExitFsmInput({
      enabled: true,
      reduceOnly: true,
      exitMode: null,
      thesisInvalidationHit: null,
    });
    expect(normalized.exitMode).toBe('risk_reduction');
    expect(normalized.thesisInvalidationHit).toBe(false);
  });

  it('normalizes conflicting reduce-only invalidation flags under FSM enforcement', () => {
    const normalized = normalizeReduceOnlyExitFsmInput({
      enabled: true,
      reduceOnly: true,
      exitMode: 'dynamic_profit_protection',
      thesisInvalidationHit: true,
    });
    expect(normalized.exitMode).toBe('thesis_invalidation');
    expect(normalized.thesisInvalidationHit).toBe(true);
  });
});
