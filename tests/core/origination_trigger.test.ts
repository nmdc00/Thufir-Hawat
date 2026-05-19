import { describe, it, expect } from 'vitest';
import { OriginationTrigger } from '../../src/core/origination_trigger.js';
import type { TriggerResult } from '../../src/core/origination_trigger.js';
import type { TaSnapshot } from '../../src/core/ta_surface.js';
import type { NormalizedEvent } from '../../src/events/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(cadenceMinutes = 15) {
  return {
    autonomy: {
      origination: {
        cadenceMinutes,
      },
    },
  } as any;
}

function makeSnapshot(symbol: string, alertReason?: string): TaSnapshot {
  return {
    symbol,
    price: 100,
    priceVs24hHigh: 0,
    priceVs24hLow: 0,
    oiUsd: 1_000_000,
    oiDelta1hPct: 0,
    oiDelta4hPct: 0,
    fundingRatePct: 0,
    volumeVs24hAvgPct: 0,
    priceVsEma20_1h: 0,
    trendBias: 'flat',
    triggerReasons: alertReason ? [alertReason] : [],
    rawFeatures: {
      priceVs24hHighPct: 0,
      priceVs24hLowPct: 0,
      oiUsd: 1_000_000,
      oiDelta1hPct: 0,
      oiDelta4hPct: 0,
      fundingRateAnnualPct: 0,
      volumeVs24hAvgPct: 0,
      priceVsEma20_1hPct: 0,
      trendBias: 'flat',
    },
    alertReason,
  };
}

function makeEvent(createdAt: string): NormalizedEvent {
  return {
    id: 'evt-1',
    eventKey: 'key-1',
    title: 'Test event',
    domain: 'crypto',
    occurredAt: createdAt,
    sourceIntelIds: [],
    tags: [],
    status: 'active',
    createdAt,
    updatedAt: createdAt,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OriginationTrigger', () => {
  const trigger = new OriginationTrigger(makeConfig(15));
  const now = Date.now();

  // 1. Cadence fires when elapsed >= cadenceMs
  it('fires on cadence when lastFiredMs is old enough', () => {
    const lastFiredMs = now - 16 * 60 * 1000; // 16 min ago
    const result = trigger.shouldFire(lastFiredMs, [], []);
    expect(result).toEqual<TriggerResult>({
      fire: true,
      reason: 'cadence',
      alertedSymbols: [],
    });
  });

  // 2. Cadence does NOT fire when elapsed < cadenceMs
  it('does not fire on cadence when lastFiredMs is recent', () => {
    const lastFiredMs = now - 5 * 60 * 1000; // 5 min ago
    const result = trigger.shouldFire(lastFiredMs, [], []);
    expect(result).toEqual<TriggerResult>({
      fire: false,
      reason: 'cadence',
      alertedSymbols: [],
    });
  });

  // 3. TA alert fires regardless of cadence window
  it('fires on ta_alert even when cadence interval has not elapsed', () => {
    const lastFiredMs = now - 1 * 60 * 1000; // 1 min ago — within cadence
    const snapshots = [makeSnapshot('BTC', 'oi_spike_1h:10.0%')];
    const result = trigger.shouldFire(lastFiredMs, snapshots, []);
    expect(result.fire).toBe(true);
    expect(result.reason).toBe('ta_alert');
  });

  // 4. TA alert returns correct alertedSymbols (only symbols with alertReason)
  it('returns only alerted symbols in alertedSymbols', () => {
    const lastFiredMs = now - 1 * 60 * 1000;
    const snapshots = [
      makeSnapshot('BTC', 'oi_spike_1h:10.0%'),
      makeSnapshot('ETH'), // no alert
      makeSnapshot('SOL', 'funding_extreme:60.0%_ann'),
    ];
    const result = trigger.shouldFire(lastFiredMs, snapshots, []);
    expect(result.fire).toBe(true);
    expect(result.reason).toBe('ta_alert');
    expect(result.alertedSymbols).toEqual(['BTC', 'SOL']);
  });

  // 5. Event fires before cadence interval
  it('fires on event even when cadence interval has not elapsed', () => {
    const lastFiredMs = now - 1 * 60 * 1000; // 1 min ago
    const recentEvent = makeEvent(new Date(now).toISOString()); // created now
    const result = trigger.shouldFire(lastFiredMs, [], [recentEvent]);
    expect(result.fire).toBe(true);
    expect(result.reason).toBe('event');
    expect(result.alertedSymbols).toEqual([]);
  });

  // 6. Event does NOT fire when event.createdAt is older than lastFiredMs
  it('does not fire on event when event is older than lastFiredMs', () => {
    const lastFiredMs = now - 5 * 60 * 1000; // fired 5 min ago
    const oldEvent = makeEvent(new Date(now - 10 * 60 * 1000).toISOString()); // 10 min ago
    // also within cadence so no cadence fire either
    const result = trigger.shouldFire(lastFiredMs, [], [oldEvent]);
    expect(result.fire).toBe(false);
    expect(result.reason).toBe('cadence');
  });

  // 7. Multiple symbols with TA alerts all appear in alertedSymbols
  it('collects all alerted symbols when multiple snapshots have alertReason', () => {
    const lastFiredMs = now - 1 * 60 * 1000;
    const snapshots = [
      makeSnapshot('BTC', 'oi_spike_1h:9.0%'),
      makeSnapshot('ETH', 'volume_spike:200.0%'),
      makeSnapshot('SOL', 'funding_extreme:55.0%_ann'),
    ];
    const result = trigger.shouldFire(lastFiredMs, snapshots, []);
    expect(result.alertedSymbols).toHaveLength(3);
    expect(result.alertedSymbols).toContain('BTC');
    expect(result.alertedSymbols).toContain('ETH');
    expect(result.alertedSymbols).toContain('SOL');
  });

  // 8. TA alert takes priority over event (both present → reason = 'ta_alert')
  it('ta_alert takes priority over event when both are present', () => {
    const lastFiredMs = now - 1 * 60 * 1000;
    const snapshots = [makeSnapshot('BTC', 'oi_spike_1h:10.0%')];
    const recentEvent = makeEvent(new Date(now).toISOString());
    const result = trigger.shouldFire(lastFiredMs, snapshots, [recentEvent]);
    expect(result.fire).toBe(true);
    expect(result.reason).toBe('ta_alert');
    expect(result.alertedSymbols).toEqual(['BTC']);
  });

  // 9. No condition fires → { fire: false, reason: 'cadence', alertedSymbols: [] }
  it('returns no-fire result when no condition is met', () => {
    const lastFiredMs = now - 5 * 60 * 1000; // recent, within cadence
    const result = trigger.shouldFire(lastFiredMs, [], []);
    expect(result).toEqual<TriggerResult>({
      fire: false,
      reason: 'cadence',
      alertedSymbols: [],
    });
  });
});
