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
      originatorOutcome: 'no_trade',
      originatorReason: 'No clean invalidation level from the available evidence',
      originatorError: undefined,
      activationId: 'act-1',
      activationIntelId: 'intel-1',
      activationSource: '@marketfeed',
      activationReceivedAtMs: 1_790_000_000_000,
    });

    const row = openDatabase().prepare('SELECT * FROM llm_trade_proposals WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({
      proposed: 0,
      scan_id: 'scan_test_1',
      all_snapshot_count: 3,
      eligible_snapshot_count: 2,
      originator_outcome: 'no_trade',
      originator_error: null,
      originator_reason: 'No clean invalidation level from the available evidence',
      activation_id: 'act-1',
      activation_intel_id: 'intel-1',
      activation_source: '@marketfeed',
      activation_received_at_ms: 1_790_000_000_000,
    });
    expect(JSON.parse(String(row.market_symbols))).toEqual(['BTC', 'ETH', 'SOL']);
  });
});
