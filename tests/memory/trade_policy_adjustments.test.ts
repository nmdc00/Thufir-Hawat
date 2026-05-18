import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/memory/db.js';
import {
  createTradePolicyAdjustment,
  deactivateTradePolicyAdjustmentsForScope,
  listTradePolicyAdjustments,
  replaceActiveTradePolicyAdjustment,
  selectActiveTradePolicyAdjustment,
} from '../../src/memory/trade_policy_adjustments.js';

function useTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-trade-policy-adjustments-'));
  const path = join(dir, 'thufir.sqlite');
  process.env.THUFIR_DB_PATH = path;
  return path;
}

describe('trade policy adjustments', () => {
  beforeEach(() => {
    useTempDb();
    openDatabase();
  });

  it('selects the most specific active adjustment for a matching runtime scope', () => {
    createTradePolicyAdjustment({
      domain: 'perp',
      signalClass: 'momentum_breakout',
      action: 'downweight',
      sizeMultiplier: 0.7,
      evidenceCount: 3,
    });
    createTradePolicyAdjustment({
      domain: 'perp',
      signalClass: 'momentum_breakout',
      marketRegime: 'trending',
      volatilityBucket: 'high',
      action: 'block',
      sizeMultiplier: 0,
      evidenceCount: 4,
    });

    const selected = selectActiveTradePolicyAdjustment({
      domain: 'perp',
      signalClass: 'momentum_breakout',
      marketRegime: 'trending',
      volatilityBucket: 'high',
      liquidityBucket: 'deep',
    });

    expect(selected).not.toBeNull();
    expect(selected?.action).toBe('block');
  });

  it('deactivates prior active adjustments for the same scope', () => {
    createTradePolicyAdjustment({
      domain: 'perp',
      signalClass: 'mean_reversion',
      marketRegime: 'choppy',
      action: 'downweight',
      sizeMultiplier: 0.5,
      evidenceCount: 3,
    });

    deactivateTradePolicyAdjustmentsForScope('perp', {
      signalClass: 'mean_reversion',
      marketRegime: 'choppy',
    });

    const rows = listTradePolicyAdjustments('perp');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.active).toBe(false);
  });

  it('replaces the active adjustment for the same scope and keeps non-overlapping scopes active', () => {
    createTradePolicyAdjustment({
      domain: 'perp',
      signalClass: 'mean_reversion',
      marketRegime: 'choppy',
      action: 'downweight',
      sizeMultiplier: 0.7,
      evidenceCount: 3,
    });
    createTradePolicyAdjustment({
      domain: 'perp',
      signalClass: 'momentum_breakout',
      marketRegime: 'trending',
      action: 'downweight',
      sizeMultiplier: 0.6,
      evidenceCount: 3,
    });

    const replacement = replaceActiveTradePolicyAdjustment({
      domain: 'perp',
      signalClass: 'mean_reversion',
      marketRegime: 'choppy',
      action: 'block',
      sizeMultiplier: 0,
      evidenceCount: 5,
    });

    const rows = listTradePolicyAdjustments('perp');
    const meanReversion = rows.filter(
      (row) => row.signalClass === 'mean_reversion' && row.marketRegime === 'choppy'
    );
    const momentum = rows.filter(
      (row) => row.signalClass === 'momentum_breakout' && row.marketRegime === 'trending'
    );

    expect(meanReversion).toHaveLength(2);
    expect(meanReversion.filter((row) => row.active)).toHaveLength(1);
    expect(meanReversion.find((row) => row.active)?.id).toBe(replacement.id);
    expect(momentum).toHaveLength(1);
    expect(momentum[0]!.active).toBe(true);
  });

  it('matches broader persisted scope dimensions deterministically', () => {
    createTradePolicyAdjustment({
      domain: 'perp',
      triggerReason: 'news',
      signalClass: 'news_event',
      symbolClass: 'major',
      session: 'us_open',
      strategySource: 'discovery_news',
      action: 'cooldown',
      cooldownMinutes: 30,
      evidenceCount: 4,
    });

    const selected = selectActiveTradePolicyAdjustment({
      domain: 'perp',
      triggerReason: 'news',
      signalClass: 'news_event',
      symbolClass: 'major',
      session: 'us_open',
      strategySource: 'discovery_news',
    });

    expect(selected).not.toBeNull();
    expect(selected?.action).toBe('cooldown');
    expect(selected?.cooldownMinutes).toBe(30);
  });
});
