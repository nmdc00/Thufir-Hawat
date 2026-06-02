import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrapOpenPerpPositionLifecycles } from '../../src/core/close_trade_finalizer.js';
import { openDatabase } from '../../src/memory/db.js';
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
});
