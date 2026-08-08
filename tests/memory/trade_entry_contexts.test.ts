import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/memory/db.js';
import {
  createTradeEntryContext,
  getTradeEntryContextByExecutionIdempotencyKey,
  getTradeEntryContextById,
  getTradeEntryContextByLifecycleId,
  getTradeEntryContextsByLifecycleId,
  markExecutionFailed,
  markExecutionSubmitted,
  markOpened,
  reconcileStaleTradeEntryContexts,
  type CreateTradeEntryContextInput,
} from '../../src/memory/trade_entry_contexts.js';

function useTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-trade-entry-contexts-'));
  const path = join(dir, 'thufir.sqlite');
  process.env.THUFIR_DB_PATH = path;
  return path;
}

// created_at is a decision-snapshot column and is (correctly) protected by the immutability
// trigger, so fixtures that need a backdated created_at/submitted_at for crash-recovery /
// ordering tests must insert the row directly with the desired timestamp rather than insert
// then UPDATE. INSERT is never covered by the BEFORE UPDATE trigger.
function insertContextRow(overrides: {
  id: string;
  lifecycleId?: string | null;
  status: 'prepared' | 'execution_submitted';
  createdAtOffsetSeconds: number;
  submittedAtOffsetSeconds?: number;
}): { id: string; executionIdempotencyKey: string } {
  const db = openDatabase();
  const executionIdempotencyKey = `idem-${overrides.id}`;
  const input = baseInput({ executionIdempotencyKey });
  const createdAtExpr = `datetime('now', '-${Math.max(0, overrides.createdAtOffsetSeconds)} seconds')`;
  const submittedAtExpr =
    overrides.status === 'execution_submitted'
      ? `datetime('now', '-${Math.max(0, overrides.submittedAtOffsetSeconds ?? overrides.createdAtOffsetSeconds)} seconds')`
      : 'NULL';

  db.prepare(
    `
      INSERT INTO trade_entry_contexts (
        id, lifecycle_id, candidate_id, prediction_id, status, execution_idempotency_key, submitted_at,
        symbol, symbol_class, execution_mode, entry_side,
        requested_size, effective_size, leverage, entry_notional_usd,
        risk_budget_usd, risk_fraction, expected_edge,
        signal_class, trigger_reason, entry_trigger, strategy_source, session_tag,
        market_regime, volatility_bucket, liquidity_bucket, trade_archetype,
        invalidation_type, invalidation_price, thesis_expires_at, time_stop_at,
        policy_version, active_adjustment_ids, source_authority,
        decision_payload, context_schema_version, created_at
      ) VALUES (
        @id, @lifecycleId, @candidateId, @predictionId, @status, @executionIdempotencyKey, ${submittedAtExpr},
        @symbol, @symbolClass, @executionMode, @entrySide,
        @requestedSize, @effectiveSize, @leverage, @entryNotionalUsd,
        @riskBudgetUsd, @riskFraction, @expectedEdge,
        @signalClass, @triggerReason, @entryTrigger, @strategySource, @sessionTag,
        @marketRegime, @volatilityBucket, @liquidityBucket, @tradeArchetype,
        @invalidationType, @invalidationPrice, @thesisExpiresAt, @timeStopAt,
        @policyVersion, @activeAdjustmentIds, @sourceAuthority,
        @decisionPayload, @contextSchemaVersion, ${createdAtExpr}
      )
    `
  ).run({
    id: overrides.id,
    lifecycleId: overrides.lifecycleId ?? null,
    candidateId: input.candidateId,
    predictionId: input.predictionId,
    status: overrides.status,
    executionIdempotencyKey,
    symbol: input.symbol,
    symbolClass: input.symbolClass,
    executionMode: input.executionMode,
    entrySide: input.entrySide,
    requestedSize: input.requestedSize,
    effectiveSize: input.effectiveSize,
    leverage: input.leverage,
    entryNotionalUsd: input.entryNotionalUsd,
    riskBudgetUsd: input.riskBudgetUsd,
    riskFraction: input.riskFraction,
    expectedEdge: input.expectedEdge,
    signalClass: input.signalClass,
    triggerReason: input.triggerReason,
    entryTrigger: input.entryTrigger,
    strategySource: input.strategySource,
    sessionTag: input.sessionTag,
    marketRegime: input.marketRegime,
    volatilityBucket: input.volatilityBucket,
    liquidityBucket: input.liquidityBucket,
    tradeArchetype: input.tradeArchetype,
    invalidationType: input.invalidationType,
    invalidationPrice: input.invalidationPrice,
    thesisExpiresAt: input.thesisExpiresAt,
    timeStopAt: input.timeStopAt,
    policyVersion: input.policyVersion,
    activeAdjustmentIds: JSON.stringify(input.activeAdjustmentIds),
    sourceAuthority: input.sourceAuthority,
    decisionPayload: JSON.stringify(input.decisionPayload),
    contextSchemaVersion: 1,
  });

  return { id: overrides.id, executionIdempotencyKey };
}

function baseInput(overrides: Partial<CreateTradeEntryContextInput> = {}): CreateTradeEntryContextInput {
  return {
    candidateId: 'candidate-1',
    predictionId: null,
    executionIdempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    symbol: 'BTC',
    symbolClass: 'major',
    executionMode: 'paper',
    entrySide: 'buy',
    requestedSize: 1,
    effectiveSize: 1,
    leverage: 2,
    entryNotionalUsd: 50000,
    riskBudgetUsd: 100,
    riskFraction: 0.01,
    expectedEdge: 0.02,
    signalClass: 'momentum_breakout',
    triggerReason: 'breakout_confirmed',
    entryTrigger: 'signal_scan',
    strategySource: 'autonomous_scan',
    sessionTag: 'us_session',
    marketRegime: 'trending',
    volatilityBucket: 'medium',
    liquidityBucket: 'high',
    tradeArchetype: 'momentum',
    invalidationType: 'price_level',
    invalidationPrice: 48000,
    thesisExpiresAt: null,
    timeStopAt: null,
    policyVersion: 'v1',
    activeAdjustmentIds: [],
    sourceAuthority: 'autonomous_manager',
    decisionPayload: { note: 'test fixture' },
    ...overrides,
  };
}

describe('trade_entry_contexts state machine', () => {
  beforeEach(() => {
    useTempDb();
    openDatabase();
  });

  describe('happy path', () => {
    it('moves prepared -> execution_submitted -> opened', () => {
      const created = createTradeEntryContext(baseInput());
      expect(created.status).toBe('prepared');
      expect(created.tradeId).toBeNull();
      expect(created.lifecycleId).toBeNull();
      expect(created.submittedAt).toBeNull();
      expect(created.openedAt).toBeNull();

      const submitted = markExecutionSubmitted(created.id);
      expect(submitted.status).toBe('execution_submitted');
      expect(submitted.submittedAt).not.toBeNull();

      const opened = markOpened(created.id, {
        tradeId: 42,
        lifecycleId: 'perp:BTC:42',
        fillIdentityPayload: { fillIds: ['f1', 'f2'] },
      });
      expect(opened.status).toBe('opened');
      expect(opened.tradeId).toBe(42);
      expect(opened.lifecycleId).toBe('perp:BTC:42');
      expect(opened.openedAt).not.toBeNull();
      expect(opened.fillIdentityPayload).toEqual({ fillIds: ['f1', 'f2'] });

      const fetched = getTradeEntryContextById(created.id);
      expect(fetched?.status).toBe('opened');
    });

    it('markOpened uses the lifecycleId already attached at creation for a scale-in', () => {
      const created = createTradeEntryContext(baseInput({ lifecycleId: 'perp:BTC:1' }));
      markExecutionSubmitted(created.id);
      const opened = markOpened(created.id, { tradeId: 99 });
      expect(opened.lifecycleId).toBe('perp:BTC:1');
      expect(opened.tradeId).toBe(99);
    });

    it('rejects markOpened when no lifecycleId is available from either source', () => {
      const created = createTradeEntryContext(baseInput());
      markExecutionSubmitted(created.id);
      expect(() => markOpened(created.id, { tradeId: 7 })).toThrow(/lifecycleId/);
    });

    it('rejects markOpened when the supplied lifecycleId conflicts with one already attached', () => {
      const created = createTradeEntryContext(baseInput({ lifecycleId: 'perp:BTC:1' }));
      markExecutionSubmitted(created.id);
      expect(() => markOpened(created.id, { tradeId: 7, lifecycleId: 'perp:BTC:2' })).toThrow(
        /already attached/
      );
    });
  });

  describe('failure paths', () => {
    it('moves prepared -> execution_failed', () => {
      const created = createTradeEntryContext(baseInput());
      const failed = markExecutionFailed(created.id, { reason: 'abandoned_before_submit' });
      expect(failed.status).toBe('execution_failed');
      expect(failed.failedAt).not.toBeNull();
      expect(failed.failurePayload).toEqual({ reason: 'abandoned_before_submit' });
      expect(failed.tradeId).toBeNull();
      expect(failed.lifecycleId).toBeNull();
    });

    it('moves execution_submitted -> execution_failed', () => {
      const created = createTradeEntryContext(baseInput());
      markExecutionSubmitted(created.id);
      const failed = markExecutionFailed(created.id, { reason: 'no_execution_found' });
      expect(failed.status).toBe('execution_failed');
      expect(failed.failurePayload).toEqual({ reason: 'no_execution_found' });
    });

    it('rejects markExecutionFailed without a reason', () => {
      const created = createTradeEntryContext(baseInput());
      expect(() => markExecutionFailed(created.id, {} as never)).toThrow(/reason/);
    });

    it('rejects transitions out of a terminal execution_failed state', () => {
      const created = createTradeEntryContext(baseInput());
      markExecutionFailed(created.id, { reason: 'abandoned_before_submit' });
      expect(() => markExecutionSubmitted(created.id)).toThrow(/cannot transition/);
      expect(() => markOpened(created.id, { tradeId: 1, lifecycleId: 'perp:BTC:1' })).toThrow(
        /cannot transition/
      );
      expect(() => markExecutionFailed(created.id, { reason: 'again' })).toThrow(/cannot transition/);
    });

    it('rejects markOpened from prepared (must go through execution_submitted)', () => {
      const created = createTradeEntryContext(baseInput());
      expect(() => markOpened(created.id, { tradeId: 1, lifecycleId: 'perp:BTC:1' })).toThrow(
        /cannot transition/
      );
    });
  });

  describe('decision-snapshot immutability', () => {
    it('rejects mutation of a decision-snapshot column once prepared', () => {
      const created = createTradeEntryContext(baseInput());
      const db = openDatabase();
      expect(() =>
        db.prepare('UPDATE trade_entry_contexts SET symbol = ? WHERE id = ?').run('ETH', created.id)
      ).toThrow(/immutable/);
      expect(() =>
        db.prepare('UPDATE trade_entry_contexts SET requested_size = ? WHERE id = ?').run(5, created.id)
      ).toThrow(/immutable/);
    });

    it('allows the state-machine columns to move without touching decision-snapshot columns', () => {
      const created = createTradeEntryContext(baseInput());
      expect(() => markExecutionSubmitted(created.id)).not.toThrow();
      const updated = getTradeEntryContextById(created.id);
      expect(updated?.symbol).toBe('BTC');
      expect(updated?.status).toBe('execution_submitted');
    });
  });

  describe('required-field validation', () => {
    it('rejects missing categorical fields with a clear error', () => {
      expect(() =>
        createTradeEntryContext(baseInput({ symbolClass: '' as unknown as string }))
      ).toThrow(/symbolClass is required/);
    });

    it('rejects missing numeric fields with a clear error', () => {
      expect(() =>
        createTradeEntryContext(baseInput({ leverage: 0 }))
      ).toThrow(/leverage is required/);
    });

    it('rejects a missing executionIdempotencyKey', () => {
      expect(() =>
        createTradeEntryContext(baseInput({ executionIdempotencyKey: '' }))
      ).toThrow(/executionIdempotencyKey is required/);
    });
  });

  describe('execution_idempotency_key uniqueness', () => {
    it('rejects a duplicate execution_idempotency_key at the database level', () => {
      const key = 'idem-fixed-key';
      createTradeEntryContext(baseInput({ executionIdempotencyKey: key }));
      expect(() => createTradeEntryContext(baseInput({ executionIdempotencyKey: key }))).toThrow();
    });

    it('looks up a context by its execution_idempotency_key', () => {
      const key = 'idem-lookup-key';
      const created = createTradeEntryContext(baseInput({ executionIdempotencyKey: key }));
      const found = getTradeEntryContextByExecutionIdempotencyKey(key);
      expect(found?.id).toBe(created.id);
    });
  });

  describe('scale-in lifecycle sharing', () => {
    it('allows multiple contexts to share one lifecycle_id and lists them in creation order', () => {
      // Insert directly with distinct created_at so ordering is deterministic regardless of
      // sqlite datetime('now') second-level resolution.
      const first = insertContextRow({
        id: 'scale-in-first',
        lifecycleId: 'perp:BTC:1',
        status: 'prepared',
        createdAtOffsetSeconds: 10,
      });
      const second = insertContextRow({
        id: 'scale-in-second',
        lifecycleId: 'perp:BTC:1',
        status: 'prepared',
        createdAtOffsetSeconds: 5,
      });

      const all = getTradeEntryContextsByLifecycleId('perp:BTC:1');
      expect(all.map((row) => row.id)).toEqual([first.id, second.id]);

      const primary = getTradeEntryContextByLifecycleId('perp:BTC:1');
      expect(primary?.id).toBe(first.id);
    });
  });

  describe('crash-recovery sweep', () => {
    it('marks a stale prepared context abandoned_before_submit', () => {
      const staleId = insertContextRow({ id: 'stale-prepared-1', status: 'prepared', createdAtOffsetSeconds: 600 }).id;
      const freshId = createTradeEntryContext(baseInput()).id;

      const result = reconcileStaleTradeEntryContexts({
        submissionTimeoutMs: 60_000,
        executionVisibilityWindowMs: 120_000,
        findExecutionByIdempotencyKey: () => null,
      });

      expect(result.abandonedContextIds).toEqual([staleId]);
      expect(getTradeEntryContextById(staleId)?.status).toBe('execution_failed');
      expect(getTradeEntryContextById(staleId)?.failurePayload).toEqual({ reason: 'abandoned_before_submit' });
      expect(getTradeEntryContextById(freshId)?.status).toBe('prepared');
    });

    it('completes a stale execution_submitted context to opened when a match is found', () => {
      const staleId = insertContextRow({
        id: 'stale-submitted-1',
        status: 'execution_submitted',
        createdAtOffsetSeconds: 600,
      }).id;
      const context = getTradeEntryContextById(staleId)!;

      const result = reconcileStaleTradeEntryContexts({
        submissionTimeoutMs: 60_000,
        executionVisibilityWindowMs: 120_000,
        findExecutionByIdempotencyKey: (key) => {
          expect(key).toBe(context.executionIdempotencyKey);
          return { tradeId: 555, lifecycleId: 'perp:BTC:555', fillIdentityPayload: { fillIds: ['x'] } };
        },
      });

      expect(result.reconciledOpenedContextIds).toEqual([staleId]);
      const updated = getTradeEntryContextById(staleId);
      expect(updated?.status).toBe('opened');
      expect(updated?.tradeId).toBe(555);
      expect(updated?.lifecycleId).toBe('perp:BTC:555');
      expect(updated?.fillIdentityPayload).toEqual({ fillIds: ['x'] });
    });

    it('marks a stale execution_submitted context execution_failed(no_execution_found) when no match is found', () => {
      const staleId = insertContextRow({
        id: 'stale-submitted-2',
        status: 'execution_submitted',
        createdAtOffsetSeconds: 600,
      }).id;

      const result = reconcileStaleTradeEntryContexts({
        submissionTimeoutMs: 60_000,
        executionVisibilityWindowMs: 120_000,
        findExecutionByIdempotencyKey: () => null,
      });

      expect(result.reconciledFailedContextIds).toEqual([staleId]);
      const updated = getTradeEntryContextById(staleId);
      expect(updated?.status).toBe('execution_failed');
      expect(updated?.failurePayload).toEqual({ reason: 'no_execution_found' });
    });

    it('does not touch contexts within their timeout/visibility window', () => {
      const preparedFreshId = insertContextRow({
        id: 'fresh-prepared-1',
        status: 'prepared',
        createdAtOffsetSeconds: 5,
      }).id;
      const submittedFreshId = insertContextRow({
        id: 'fresh-submitted-1',
        status: 'execution_submitted',
        createdAtOffsetSeconds: 5,
      }).id;

      const result = reconcileStaleTradeEntryContexts({
        submissionTimeoutMs: 60_000,
        executionVisibilityWindowMs: 60_000,
        findExecutionByIdempotencyKey: () => null,
      });

      expect(result.abandonedContextIds).toEqual([]);
      expect(result.reconciledFailedContextIds).toEqual([]);
      expect(getTradeEntryContextById(preparedFreshId)?.status).toBe('prepared');
      expect(getTradeEntryContextById(submittedFreshId)?.status).toBe('execution_submitted');
    });
  });
});
