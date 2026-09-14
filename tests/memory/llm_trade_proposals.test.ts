import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { closeDatabase, openDatabase } from '../../src/memory/db.js';
import { recordTradeProposal } from '../../src/memory/llm_trade_proposals.js';

describe('llm trade proposal scan observability', () => {
  let dir: string;
  let previousPath: string | undefined;

  beforeEach(() => {
    previousPath = process.env.THUFIR_DB_PATH;
    dir = mkdtempSync(join(tmpdir(), 'proposal-observability-'));
    process.env.THUFIR_DB_PATH = join(dir, 'test.sqlite');
  });

  afterEach(() => {
    closeDatabase(process.env.THUFIR_DB_PATH);
    if (previousPath === undefined) delete process.env.THUFIR_DB_PATH;
    else process.env.THUFIR_DB_PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a null proposal with scan counts and outcome diagnostics', () => {
    const id = recordTradeProposal({
      triggerReason: 'ta_alert',
      alertedSymbols: ['BTC'],
      proposed: false,
      executeTrades: true,
      scanId: 'scan_test_1',
      marketSymbols: ['BTC', 'ETH', 'SOL'],
      allSnapshotCount: 3,
      eligibleSnapshotCount: 2,
      originatorOutcome: 'null_response',
      originatorError: undefined,
    });

    const row = openDatabase().prepare('SELECT * FROM llm_trade_proposals WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({
      proposed: 0,
      scan_id: 'scan_test_1',
      all_snapshot_count: 3,
      eligible_snapshot_count: 2,
      originator_outcome: 'null_response',
      originator_error: null,
    });
    expect(JSON.parse(String(row.market_symbols))).toEqual(['BTC', 'ETH', 'SOL']);
  });
});
