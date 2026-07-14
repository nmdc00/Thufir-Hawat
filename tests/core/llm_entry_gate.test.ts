/**
 * Tests for LlmEntryGate.
 *
 * Validates:
 * - Conflict fast-path: hasConflict === true → rejects without calling LLM
 * - LLM returns valid JSON approve → returns approve
 * - LLM returns valid JSON reject → returns reject
 * - LLM returns valid JSON resize with adjustedSizeUsd → returns resize
 * - LLM times out → fallback called → notify called → fallback returns valid decision
 * - Both LLM and fallback fail → returns reject, does not throw
 * - Invalid JSON from LLM → fallback called
 * - DB log written for each decision (recordEntryGateDecision called)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PerpTradeJournalEntry } from '../../src/memory/perp_trade_journal.js';
import type { SignalPerformanceSummary } from '../../src/core/signal_performance.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRecordEntryGateDecision = vi.fn();
const mockGetGateVerdictCooldown = vi.fn();
const mockRecordGateVerdictReject = vi.fn();

vi.mock('../../src/memory/llm_entry_gate_log.js', () => ({
  recordEntryGateDecision: (...args: unknown[]) => mockRecordEntryGateDecision(...args),
}));

vi.mock('../../src/memory/gate_verdict_cooldowns.js', () => ({
  getGateVerdictCooldown: (...args: unknown[]) => mockGetGateVerdictCooldown(...args),
  recordGateVerdictReject: (...args: unknown[]) => mockRecordGateVerdictReject(...args),
}));

const mockLoggerWarn = vi.fn();
const mockListPerpTradeJournals = vi.fn(() => []);
const mockSummarizeSignalPerformance = vi.fn(
  (_entries: PerpTradeJournalEntry[], signalClass: string): SignalPerformanceSummary => ({
    signalClass,
    sampleCount: 0,
    wins: 0,
    losses: 0,
    thesisCorrectRate: 0,
    expectancy: 0,
    variance: 0,
    sharpeLike: 0,
    maeProxy: 0,
    mfeProxy: 0,
  })
);

vi.mock('../../src/core/logger.js', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  })),
}));

vi.mock('../../src/memory/perp_trade_journal.js', () => ({
  listPerpTradeJournals: (...args: unknown[]) => mockListPerpTradeJournals(...args),
}));

vi.mock('../../src/core/signal_performance.js', () => ({
  summarizeSignalPerformance: (...args: unknown[]) => mockSummarizeSignalPerformance(...args),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { LlmEntryGate, type EntryGateCandidate } from '../../src/core/llm_entry_gate.js';
import type { LlmClient } from '../../src/core/llm.js';
import type { PositionBook } from '../../src/core/position_book.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMarketContext(
  overrides?: Partial<NonNullable<EntryGateCandidate['marketContext']>>
): NonNullable<EntryGateCandidate['marketContext']> {
  return {
    markPrice: 50000,
    stopDistancePct: 0.04,
    liquidationMovePctAtCandidateLeverage: 0.2,
    liquidationBufferPct: 0.16,
    mechanicalLeverageCeiling: 5,
    trendBias: 'up',
    priceVsEma20_1hPct: 1.2,
    regimeSource: 'originator_runtime',
    liquidityBucket: 'deep',
    liquidityScore: 0.91,
    executionScore: 0.88,
    fundingScore: 0.42,
    spreadProxyBps: 3.2,
    openInterestUsd: 240000000,
    dayVolumeUsd: 1800000000,
    oiUsd: 235000000,
    oiDelta1hPct: 9.5,
    oiDelta4hPct: 14.2,
    fundingRatePct: 0.12,
    volumeVs24hAvgPct: 165,
    alertReason: '1h breakout with OI expansion',
    triggerReason: 'ta_alert',
    ...overrides,
  };
}

function makeCandidate(overrides?: Partial<EntryGateCandidate>): EntryGateCandidate {
  return {
    symbol: 'BTC',
    side: 'buy',
    notionalUsd: 50,
    leverage: 1,
    leverageMax: 5,
    edge: 0.08,
    confidence: 0.65,
    signalClass: 'momentum_breakout',
    regime: 'trending',
    session: 'us',
    entryReasoning: 'Strong breakout above resistance',
    ...overrides,
  };
}

function makeBook(overrides?: {
  hasConflict?: boolean;
  hasPosition?: boolean;
  entries?: ReturnType<PositionBook['getAll']>;
}): PositionBook {
  return {
    hasConflict: vi.fn().mockReturnValue(overrides?.hasConflict ?? false),
    hasPosition: vi.fn().mockReturnValue(overrides?.hasPosition ?? false),
    getAll: vi.fn().mockReturnValue(overrides?.entries ?? []),
    get: vi.fn(),
    refresh: vi.fn(),
    getInstance: vi.fn(),
  } as unknown as PositionBook;
}

const defaultRiskFields = { stopLevelPrice: 48000, equityAtRiskPct: 2.5, targetRR: 2.0 };

function makeLlmClient(responseJson: object | null, shouldThrow?: boolean): LlmClient {
  const fullResponse = responseJson === null ? null : { ...defaultRiskFields, ...responseJson };
  const completeFn = shouldThrow
    ? vi.fn().mockRejectedValue(new Error('LLM timeout'))
    : vi.fn().mockResolvedValue({
        content: JSON.stringify(fullResponse),
        model: 'test-model',
      });
  return { complete: completeFn } as unknown as LlmClient;
}

const dummyConfig = {} as any;
const markPrice = 50000;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LlmEntryGate', () => {
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    notify = vi.fn().mockResolvedValue(undefined);
    mockGetGateVerdictCooldown.mockReturnValue(null);
    mockListPerpTradeJournals.mockReturnValue([]);
    mockSummarizeSignalPerformance.mockImplementation(
      (_entries: PerpTradeJournalEntry[], signalClass: string): SignalPerformanceSummary => ({
        signalClass,
        sampleCount: 0,
        wins: 0,
        losses: 0,
        thesisCorrectRate: 0,
        expectancy: 0,
        variance: 0,
        sharpeLike: 0,
        maeProxy: 0,
        mfeProxy: 0,
      })
    );
  });

  describe('conflict fast-path', () => {
    it('returns reject without calling LLM when hasConflict is true', async () => {
      const book = makeBook({ hasConflict: true });
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fine' });
      const fallbackLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fine' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('reject');
      expect(result.reasoning).toMatch(/opposite-side/i);
      expect(result.reasonCode).toBe('book_conflict');
      expect((mainLlm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('records DB log entry on conflict reject', async () => {
      const book = makeBook({ hasConflict: true });
      const gate = new LlmEntryGate(
        makeLlmClient(null),
        makeLlmClient(null),
        notify,
        book,
        dummyConfig
      );

      await gate.evaluate(makeCandidate({ symbol: 'ETH', side: 'sell' }), markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalledOnce();
      const call = mockRecordEntryGateDecision.mock.calls[0][0];
      expect(call.verdict).toBe('reject');
      expect(call.symbol).toBe('ETH');
      expect(call.reasonCode).toBe('book_conflict');
      expect(call.llmConsulted).toBe(false);
    });
  });

  describe('deterministic prechecks', () => {
    it('suppresses repeated rejects during cooldown without calling LLM', async () => {
      const lastRejectAt = new Date(Date.now() - 10 * 60_000).toISOString();
      mockGetGateVerdictCooldown.mockReturnValue({
        symbol: 'BTC',
        side: 'buy',
        lastRejectAt,
        lastEdge: 0.08,
      });
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fine' });
      const fallbackLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fine' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, {
        autonomy: { minEdge: 0.05, llmEntryGate: { gateCooldownMinutes: 60, deterministicPrechecks: true } },
      } as any);

      const result = await gate.evaluate(makeCandidate({ edge: 0.08 }), markPrice);

      expect(result.verdict).toBe('reject');
      expect(result.reasonCode).toBe('cooldown_suppressed');
      expect((mainLlm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect(mockRecordEntryGateDecision).toHaveBeenCalledOnce();
      expect(mockRecordEntryGateDecision.mock.calls[0][0]).toMatchObject({
        reasonCode: 'cooldown_suppressed',
        llmConsulted: false,
      });
      expect(mockRecordGateVerdictReject).not.toHaveBeenCalled();
    });

    it('bypasses cooldown when edge improved by at least 25 percent', async () => {
      mockGetGateVerdictCooldown.mockReturnValue({
        symbol: 'BTC',
        side: 'buy',
        lastRejectAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        lastEdge: 0.08,
      });
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'edge improved' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, {
        autonomy: { minEdge: 0.05, llmEntryGate: { gateCooldownMinutes: 60, deterministicPrechecks: true } },
      } as any);

      const result = await gate.evaluate(makeCandidate({ edge: 0.1 }), markPrice);

      expect(result.verdict).toBe('approve');
      expect((mainLlm.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
      expect(mockRecordEntryGateDecision.mock.calls[0][0].llmConsulted).toBe(true);
    });

    it('bypasses cooldown when a fresh catalyst timestamp is newer than the reject', async () => {
      const lastRejectAt = new Date(Date.now() - 10 * 60_000);
      mockGetGateVerdictCooldown.mockReturnValue({
        symbol: 'BTC',
        side: 'buy',
        lastRejectAt: lastRejectAt.toISOString(),
        lastEdge: 0.08,
      });
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fresh catalyst' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, {
        autonomy: { minEdge: 0.05, llmEntryGate: { gateCooldownMinutes: 60, deterministicPrechecks: true } },
      } as any);

      const result = await gate.evaluate(
        makeCandidate({
          edge: 0.08,
          catalystTimestamp: new Date(lastRejectAt.getTime() + 60_000).toISOString(),
        }),
        markPrice,
      );

      expect(result.verdict).toBe('approve');
      expect((mainLlm.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
      expect(mockRecordEntryGateDecision.mock.calls[0][0].llmConsulted).toBe(true);
    });

    it('rejects same-side stacking without calling LLM', async () => {
      const book = makeBook({ hasPosition: true });
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fine' });
      const fallbackLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fine' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('reject');
      expect(result.reasonCode).toBe('same_symbol_stacking');
      expect((mainLlm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect(mockRecordEntryGateDecision.mock.calls[0][0].llmConsulted).toBe(false);
    });

    it('rejects candidates below the edge floor without calling LLM', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fine' });
      const fallbackLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fine' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, {
        autonomy: { minEdge: 0.05, llmEntryGate: { deterministicPrechecks: true } },
      } as any);

      const result = await gate.evaluate(makeCandidate({ edge: 0.049 }), markPrice);

      expect(result.verdict).toBe('reject');
      expect(result.reasonCode).toBe('edge_too_low');
      expect((mainLlm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect(mockRecordEntryGateDecision.mock.calls[0][0].llmConsulted).toBe(false);
    });

    it('still consults the LLM once for a clean approval candidate', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'clean setup' });
      const fallbackLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fallback' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('approve');
      expect((mainLlm.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      expect(mockRecordEntryGateDecision.mock.calls[0][0].llmConsulted).toBe(true);
    });
  });

  describe('LLM approve path', () => {
    it('returns approve when LLM responds with approve verdict', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'Strong setup' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('approve');
      expect(result.reasoning).toContain('Strong setup');
      expect(result.reasonCode).toBe('approve');
    });

    it('records DB log for approve', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'ok' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalledOnce();
      expect(mockRecordEntryGateDecision.mock.calls[0][0].verdict).toBe('approve');
      expect(mockRecordEntryGateDecision.mock.calls[0][0].reasonCode).toBe('approve');
    });
  });

  describe('LLM reject path', () => {
    it('returns reject when LLM responds with reject verdict', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'reject', reasoning: 'Choppy conditions' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('reject');
      expect(result.reasoning).toBe('Choppy conditions');
      expect(result.reasonCode).toBe('regime_mismatch');
    });

    it('records DB log for reject', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'reject', reasoning: 'no' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalledOnce();
      expect(mockRecordEntryGateDecision.mock.calls[0][0].verdict).toBe('reject');
    });
  });

  describe('LLM resize path', () => {
    it('returns resize with adjustedSizeUsd when LLM responds with resize', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({
        verdict: 'resize',
        reasoning: 'Reduce size for risk',
        adjustedSizeUsd: 25,
      });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('resize');
      expect(result.adjustedSizeUsd).toBe(25);
      expect(result.reasoning).toContain('Reduce size for risk');
      expect(result.reasonCode).toBe('size_downshift');
    });

    it('records DB log for resize with adjustedSizeUsd', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'resize', reasoning: 'smaller', adjustedSizeUsd: 20 });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalledOnce();
      const call = mockRecordEntryGateDecision.mock.calls[0][0];
      expect(call.verdict).toBe('resize');
      expect(call.adjustedSizeUsd).toBe(20);
    });
  });

  describe('fallback and error handling', () => {
    it('uses fallback LLM when main LLM fails, and calls notify', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient(null, /* shouldThrow */ true);
      const fallbackLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fallback ok' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('approve');
      expect(notify).toHaveBeenCalledOnce();
      expect(notify.mock.calls[0][0]).toContain('fallback LLM');
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it('records usedFallback=true in DB log when fallback is used', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient(null, true);
      const fallbackLlm = makeLlmClient({ verdict: 'reject', reasoning: 'fallback reject' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalledOnce();
      expect(mockRecordEntryGateDecision.mock.calls[0][0].usedFallback).toBe(true);
    });

    it('returns safe reject when both main and fallback fail, does not throw', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient(null, true);
      const fallbackLlm = makeLlmClient(null, true);
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      let result: Awaited<ReturnType<typeof gate.evaluate>>;
      await expect(async () => {
        result = await gate.evaluate(makeCandidate(), markPrice);
      }).not.toThrow();

      result = await gate.evaluate(makeCandidate(), markPrice);
      expect(result.verdict).toBe('reject');
      expect(result.reasoning).toMatch(/unavailable/i);
    });

    it('allows execution when both LLMs fail and rejectOnBothFail is false', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient(null, true);
      const fallbackLlm = makeLlmClient(null, true);
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, {
        autonomy: { llmEntryGate: { rejectOnBothFail: false } },
      } as any);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('approve');
      expect(result.reasoning).toMatch(/rejectOnBothFail=false/i);
    });

    it('records DB log even when fallback is used', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient(null, true);
      const fallbackLlm = makeLlmClient({ verdict: 'approve', reasoning: 'ok' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalled();
    });

    it('passes separate primary and local fallback timeout budgets', async () => {
      const book = makeBook();
      const completeFn = vi.fn().mockRejectedValue(new Error('primary unavailable'));
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const fallbackLlm = makeLlmClient({ verdict: 'reject', reasoning: 'local fallback' });
      const gate = new LlmEntryGate(
        mainLlm,
        fallbackLlm,
        notify,
        book,
        {
          autonomy: {
            llmEntryGate: { primaryTimeoutMs: 45_000, fallbackTimeoutMs: 25_000 },
          },
        } as any
      );

      await gate.evaluate(makeCandidate(), markPrice);

      expect(completeFn).toHaveBeenCalledOnce();
      expect(completeFn.mock.calls[0][1]).toMatchObject({ timeoutMs: 45_000 });
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
        timeoutMs: 25_000,
      });
    });

    it('aborts a timed-out primary before invoking the local fallback', async () => {
      const book = makeBook();
      let primarySignal: AbortSignal | undefined;
      const mainLlm: LlmClient = {
        complete: vi.fn().mockImplementation((_messages, options) => {
          primarySignal = options?.signal;
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }),
      };
      const fallbackLlm = makeLlmClient({ verdict: 'reject', reasoning: 'local fallback' });
      const gate = new LlmEntryGate(
        mainLlm,
        fallbackLlm,
        notify,
        book,
        {
          autonomy: {
            llmEntryGate: { primaryTimeoutMs: 20, fallbackTimeoutMs: 100 },
          },
        } as any
      );

      const decision = await gate.evaluate(makeCandidate(), markPrice);

      expect(primarySignal?.aborted).toBe(true);
      expect(decision).toMatchObject({ verdict: 'reject', reasoning: 'local fallback' });
      expect(fallbackLlm.complete).toHaveBeenCalledOnce();
    });

    it('uses fallback when main LLM returns invalid JSON', async () => {
      const book = makeBook();
      const mainLlm: LlmClient = {
        complete: vi.fn().mockResolvedValue({ content: 'not valid json }{', model: 'test' }),
      } as unknown as LlmClient;
      const fallbackLlm = makeLlmClient({ verdict: 'reject', reasoning: 'fallback after parse error' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('reject');
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expect(notify).toHaveBeenCalled();
    });

    it('accepts adjustedSizeUsd null from the LLM as omitted', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({
        verdict: 'reject',
        reasoning: 'fallback-shaped reject',
        adjustedSizeUsd: null,
      });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result).toEqual({
        verdict: 'reject',
        reasoning: 'fallback-shaped reject',
        reasonCode: 'discretionary_reject',
        ...defaultRiskFields,
      });
    });

    it('accepts adjustedSizeUsd undefined pseudo-json from the LLM as omitted', async () => {
      const book = makeBook();
      const mainLlm: LlmClient = {
        complete: vi.fn().mockResolvedValue({
          content: '{"verdict":"reject","reasoning":"pseudo-json reject","adjustedSizeUsd":undefined,"stopLevelPrice":47000,"equityAtRiskPct":3.0,"targetRR":1.5}',
          model: 'test-main',
        }),
      } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result).toEqual({
        verdict: 'reject',
        reasoning: 'pseudo-json reject',
        reasonCode: 'discretionary_reject',
        stopLevelPrice: 47000,
        equityAtRiskPct: 3.0,
        targetRR: 1.5,
      });
    });

    it('logs the failure type when the main LLM returns schema-invalid JSON', async () => {
      const book = makeBook();
      const mainLlm: LlmClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({ verdict: 'reject', reasoning: 'bad', adjustedSizeUsd: 'nope' }),
          model: 'test-main',
        }),
        meta: { provider: 'openai', model: 'test-main' },
      } as unknown as LlmClient;
      const fallbackLlm = makeLlmClient({ verdict: 'approve', reasoning: 'fallback ok' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('approve');
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Entry gate main LLM failed; falling back',
        expect.objectContaining({
          failureType: 'schema_validation',
          provider: 'openai',
          model: 'test-main',
        })
      );
    });

    it('does not throw when both fail and records DB log with safe reject', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient(null, true);
      const fallbackLlm = makeLlmClient(null, true);
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('reject');
      expect(mockRecordEntryGateDecision).toHaveBeenCalled();
      const call = mockRecordEntryGateDecision.mock.calls[0][0];
      expect(call.verdict).toBe('reject');
    });
  });

  describe('DB logging', () => {
    it('always calls recordEntryGateDecision with correct fields', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'good' });
      const candidate = makeCandidate({
        symbol: 'SOL',
        side: 'sell',
        notionalUsd: 75,
        signalClass: 'mean_reversion',
        regime: 'choppy',
        session: 'asia',
        edge: 0.05,
      });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(candidate, markPrice);

      expect(mockRecordEntryGateDecision).toHaveBeenCalledOnce();
      const call = mockRecordEntryGateDecision.mock.calls[0][0];
      expect(call.symbol).toBe('SOL');
      expect(call.side).toBe('sell');
      expect(call.notionalUsd).toBe(75);
      expect(call.signalClass).toBe('mean_reversion');
      expect(call.regime).toBe('choppy');
      expect(call.session).toBe('asia');
      expect(call.edge).toBe(0.05);
      expect(call.usedFallback).toBe(false);
    });
  });

  describe('risk fields (stopLevelPrice, equityAtRiskPct, targetRR)', () => {
    it('returns risk fields from LLM response', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({
        verdict: 'approve',
        reasoning: 'good setup',
        stopLevelPrice: 45000,
        equityAtRiskPct: 3.0,
        targetRR: 2.5,
      });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.stopLevelPrice).toBe(45000);
      expect(result.equityAtRiskPct).toBe(3.0);
      expect(result.targetRR).toBe(2.5);
    });

    it('falls back when approve returns null stopLevelPrice', async () => {
      const book = makeBook();
      const mainLlm: LlmClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({ verdict: 'approve', reasoning: 'ok', stopLevelPrice: null, equityAtRiskPct: 2.0, targetRR: 1.8 }),
          model: 'test-main',
        }),
      } as unknown as LlmClient;
      const fallbackLlm = makeLlmClient({ verdict: 'reject', reasoning: 'missing invalidation' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('reject');
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it('falls back when resize returns null stopLevelPrice', async () => {
      const book = makeBook();
      const mainLlm: LlmClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            verdict: 'resize',
            reasoning: 'reduce but no stop',
            adjustedSizeUsd: 20,
            stopLevelPrice: null,
            equityAtRiskPct: 2.0,
            targetRR: 1.8,
          }),
          model: 'test-main',
        }),
      } as unknown as LlmClient;
      const fallbackLlm = makeLlmClient({ verdict: 'reject', reasoning: 'missing invalidation' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('reject');
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it('still accepts null stopLevelPrice on reject', async () => {
      const book = makeBook();
      const mainLlm: LlmClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({ verdict: 'reject', reasoning: 'no clean invalidation', stopLevelPrice: null, equityAtRiskPct: 2.0, targetRR: 1.8 }),
          model: 'test-main',
        }),
      } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('reject');
      expect(result.stopLevelPrice).toBeNull();
    });

    it('falls back when LLM omits required risk fields', async () => {
      const book = makeBook();
      const mainLlm: LlmClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({ verdict: 'approve', reasoning: 'missing risk fields' }),
          model: 'test-main',
        }),
      } as unknown as LlmClient;
      const fallbackLlm = makeLlmClient({ verdict: 'reject', reasoning: 'fallback reject' });
      const gate = new LlmEntryGate(mainLlm, fallbackLlm, notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('reject');
      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it('includes risk fields in DB log', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({
        verdict: 'approve',
        reasoning: 'logged',
        stopLevelPrice: 44000,
        equityAtRiskPct: 1.5,
        targetRR: 3.0,
      });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      const call = mockRecordEntryGateDecision.mock.calls[0][0];
      expect(call.stopLevelPrice).toBe(44000);
      expect(call.equityAtRiskPct).toBe(1.5);
      expect(call.targetRR).toBe(3.0);
    });
  });

  describe('structured market context and leverage ceiling', () => {
    it('includes structured market context in the prompt when provided', async () => {
      const book = makeBook();
      const completeFn = vi.fn().mockResolvedValue({
        content: JSON.stringify({
          verdict: 'approve',
          reasoning: 'structured ok',
          stopLevelPrice: 95,
          equityAtRiskPct: 2.5,
          targetRR: 2.0,
        }),
        model: 'test-main',
      });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate({
        leverage: 6,
        leverageMax: 50,
        invalidationPrice: 95,
        marketContext: makeMarketContext({
          markPrice: 100,
          stopDistancePct: 0.05,
          liquidationMovePctAtCandidateLeverage: 1 / 6,
          liquidationBufferPct: 1 / 6 - 0.05,
          mechanicalLeverageCeiling: 14,
          priceVsEma20_1hPct: 1.25,
          liquidityScore: 0.9,
          executionScore: 0.85,
          fundingScore: 0.8,
          spreadProxyBps: 2.1,
          openInterestUsd: 250_000_000,
          dayVolumeUsd: 500_000_000,
          oiUsd: 125_000_000,
          oiDelta1hPct: 9,
          oiDelta4hPct: 12,
          fundingRatePct: 15,
          volumeVs24hAvgPct: 140,
          alertReason: 'oi_spike_1h:9%',
          triggerReason: 'ta_alert',
        }),
      }), 100);

      expect(completeFn).toHaveBeenCalled();
      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((message) => message.role === 'user')?.content ?? '';
      expect(userContent).toContain('Market Structure Context');
      expect(userContent).toContain('Mechanical leverage ceiling');
      expect(userContent).toContain('Liquidity bucket: deep');
      expect(userContent).toContain('Trigger reason: ta_alert');
    });

    it('clamps suggested leverage to the mechanical ceiling', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({
        verdict: 'approve',
        reasoning: 'overshoots leverage',
        suggestedLeverage: 20,
        stopLevelPrice: 88,
      });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate({
        leverage: 5,
        leverageMax: 50,
        invalidationPrice: 88,
      }), 100);

      expect(result.verdict).toBe('approve');
      expect(result.suggestedLeverage).toBe(5);
    });

    it('rejects before LLM call when stop geometry leaves no valid leverage', async () => {
      const book = makeBook();
      const completeFn = vi.fn();
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate({
        leverage: 2,
        leverageMax: 50,
        invalidationPrice: 20,
      }), 100);

      expect(result.verdict).toBe('reject');
      expect(result.reasonCode).toBe('invalid_leverage_geometry');
      expect(completeFn).not.toHaveBeenCalled();
    });
  });

  describe('market context and geometry enforcement', () => {
    it('includes a structured market context block in the prompt', async () => {
      const book = makeBook();
      const completeFn = vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: 'approve', reasoning: 'context-aware', suggestedLeverage: 2 }),
        model: 'test-main',
      });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(
        makeCandidate({
          invalidationPrice: 48000,
          marketContext: makeMarketContext(),
        }),
        markPrice
      );

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userContent).toContain('Market Structure Context');
      expect(userContent).toContain('Mechanical leverage ceiling from stop geometry');
      expect(userContent).toContain('Liquidity bucket: deep');
      expect(userContent).toContain('Execution score: 0.88');
      expect(userContent).toContain('Trigger reason: ta_alert');
    });

    it('rejects before the LLM when stop geometry is on the wrong side of the mark price', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'should not run' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(
        makeCandidate({
          invalidationPrice: 51000,
          marketContext: makeMarketContext({ markPrice: 50000 }),
        }),
        markPrice
      );

      expect(result.verdict).toBe('reject');
      expect(result.reasonCode).toBe('invalid_leverage_geometry');
      expect(result.reasoning).toMatch(/must be below/i);
      expect((mainLlm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('clamps suggested leverage to the mechanical ceiling', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({
        verdict: 'approve',
        reasoning: 'high conviction',
        suggestedLeverage: 9,
      });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(
        makeCandidate({
          leverage: 4,
          leverageMax: 10,
          invalidationPrice: 44000,
          marketContext: makeMarketContext({ markPrice: 50000, mechanicalLeverageCeiling: 5 }),
        }),
        markPrice
      );

      expect(result.suggestedLeverage).toBe(5);
    });

    it('injects a safe leverage when the candidate leverage is above the ceiling and the LLM omits one', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({
        verdict: 'approve',
        reasoning: 'thesis works at lower risk',
      });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(
        makeCandidate({
          leverage: 8,
          leverageMax: 10,
          invalidationPrice: 44000,
          marketContext: makeMarketContext({ markPrice: 50000, mechanicalLeverageCeiling: 5 }),
        }),
        markPrice
      );

      expect(result.verdict).toBe('approve');
      expect(result.suggestedLeverage).toBe(5);
      expect(result.reasoning).toContain('Mechanical leverage ceiling enforced at 5x.');
    });

    it('rejects approve decisions whose returned stop creates invalid final geometry', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({
        verdict: 'approve',
        reasoning: 'approve but bad stop',
        stopLevelPrice: 52000,
        suggestedLeverage: 2,
      });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(
        makeCandidate({
          invalidationPrice: 48000,
          marketContext: makeMarketContext({ markPrice: 50000 }),
        }),
        markPrice
      );

      expect(result.verdict).toBe('reject');
      expect(result.reasonCode).toBe('invalid_leverage_geometry');
      expect(result.reasoning).toMatch(/must be below/i);
    });
  });

  describe('same-side concentration warning', () => {
    it('includes concentration warning in prompt when same-side position exists', async () => {
      const book = makeBook({ hasPosition: true });
      const completeFn = vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: 'reject', reasoning: 'stacking risk', stopLevelPrice: null, equityAtRiskPct: 0, targetRR: 0 }),
        model: 'test-main',
      });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, {
        autonomy: { llmEntryGate: { deterministicPrechecks: false } },
      } as any);

      await gate.evaluate(makeCandidate({ symbol: 'HYPE', side: 'sell' }), markPrice);

      expect(completeFn).toHaveBeenCalledOnce();
      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userContent).toContain('Concentration Warning');
      expect(userContent).toContain('ALREADY OPEN');
      expect(userContent).toContain('HYPE');
    });

    it('does not include concentration warning when no same-side position exists', async () => {
      const book = makeBook({ hasPosition: false });
      const completeFn = vi.fn().mockResolvedValue({
        content: JSON.stringify({
          verdict: 'approve',
          reasoning: 'clean entry',
          stopLevelPrice: 48000,
          equityAtRiskPct: 1,
          targetRR: 2,
        }),
        model: 'test-main',
      });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userContent).not.toContain('Concentration Warning');
    });

    it('still lets the LLM approve when same-side warning is present (no auto-reject)', async () => {
      const book = makeBook({ hasPosition: true });
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'strong specific reason' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, {
        autonomy: { llmEntryGate: { deterministicPrechecks: false } },
      } as any);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('approve');
    });
  });

  describe('book table concentration display', () => {
    it('shows notional and concentration% in book table when positions exist', async () => {
      const entries = [
        {
          symbol: 'HYPE',
          side: 'short' as const,
          size: 100,
          entryPrice: 40,
          entryReasoningText: '',
          thesisExpiresAtMs: Date.now() + 60 * 60 * 1000,
          exitContract: null,
          exitContractSummary: null,
          lastConsultAtMs: null,
          lastConsultDecision: null,
        },
        {
          symbol: 'TAO',
          side: 'short' as const,
          size: 1,
          entryPrice: 500,
          entryReasoningText: '',
          thesisExpiresAtMs: Date.now() + 60 * 60 * 1000,
          exitContract: null,
          exitContractSummary: null,
          lastConsultAtMs: null,
          lastConsultDecision: null,
        },
      ];
      const book = makeBook({ entries });
      const completeFn = vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: 'reject', reasoning: 'crowded' }),
        model: 'test-main',
      });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      // HYPE: 100*40=$4000, TAO: 1*500=$500, total=$4500; HYPE=89%, TAO=11%
      expect(userContent).toContain('Total notional');
      expect(userContent).toContain('conc%');
      expect(userContent).toContain('$4000');
      expect(userContent).toContain('$500');
    });
  });

  describe('suggestedLeverage', () => {
    it('returns suggestedLeverage from LLM on approve', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'strong setup', suggestedLeverage: 3 });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate({ leverageMax: 5 }), markPrice);

      expect(result.suggestedLeverage).toBe(3);
    });

    it('clamps suggestedLeverage to leverageMax', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'high conviction', suggestedLeverage: 10 });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate({ leverageMax: 5 }), markPrice);

      expect(result.suggestedLeverage).toBe(5);
    });

    it('rounds suggestedLeverage to integer', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'ok', suggestedLeverage: 2.7 });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate({ leverageMax: 5 }), markPrice);

      expect(result.suggestedLeverage).toBe(3);
    });

    it('omits suggestedLeverage when LLM does not return it', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'ok' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.suggestedLeverage).toBeUndefined();
    });

    it('omits suggestedLeverage when LLM sends null', async () => {
      const book = makeBook();
      const mainLlm: LlmClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({ verdict: 'approve', reasoning: 'ok', stopLevelPrice: 48000, equityAtRiskPct: 2, targetRR: 2, suggestedLeverage: null }),
          model: 'test-main',
        }),
      } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.suggestedLeverage).toBeUndefined();
    });

    it('omits suggestedLeverage when LLM returns value below 1', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'ok', suggestedLeverage: 0.5 });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.suggestedLeverage).toBeUndefined();
    });

    it('records suggestedLeverage in DB log', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'ok', suggestedLeverage: 2 });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      const call = mockRecordEntryGateDecision.mock.calls[0][0];
      expect(call.suggestedLeverage).toBe(2);
    });

    it('includes leverageMax range in user prompt', async () => {
      const book = makeBook();
      const completeFn = vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: 'approve', reasoning: 'ok' }),
        model: 'test-main',
      });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate({ leverageMax: 4 }), markPrice);

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userContent).toContain('1x – 4x');
    });

    it('includes suggestedLeverage in system prompt schema', async () => {
      const book = makeBook();
      const completeFn = vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: 'approve', reasoning: 'ok' }),
        model: 'test-main',
      });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const systemContent = messages.find((m) => m.role === 'system')?.content ?? '';
      expect(systemContent).toContain('suggestedLeverage');
    });
  });

  describe('signal performance context', () => {
    it('queries recent perp trade journals and summarizes the candidate signal class', async () => {
      const entries: PerpTradeJournalEntry[] = [
        { kind: 'perp_trade_journal', symbol: 'BTC', signalClass: 'momentum_breakout', outcome: 'executed' },
      ];
      const book = makeBook();
      const gate = new LlmEntryGate(makeLlmClient({ verdict: 'approve', reasoning: 'good' }), makeLlmClient(null), notify, book, dummyConfig);

      mockListPerpTradeJournals.mockReturnValue(entries);

      await gate.evaluate(makeCandidate({ signalClass: 'momentum_breakout' }), markPrice);

      expect(mockListPerpTradeJournals).toHaveBeenCalledWith({ limit: 200 });
      expect(mockSummarizeSignalPerformance).toHaveBeenCalledWith(entries, 'momentum_breakout');
    });

    it('renders live track record stats in the prompt when signal history exists', async () => {
      const book = makeBook();
      const completeFn = vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: 'approve', reasoning: 'supported by stats' }),
        model: 'test-main',
      });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      mockSummarizeSignalPerformance.mockReturnValue({
        signalClass: 'momentum_breakout',
        sampleCount: 7,
        wins: 4,
        losses: 3,
        thesisCorrectRate: 4 / 7,
        expectancy: 0.37,
        variance: 0.21,
        sharpeLike: 0.81,
        maeProxy: 0.042,
        mfeProxy: 0.118,
      });

      await gate.evaluate(makeCandidate({ signalClass: 'momentum_breakout' }), markPrice);

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userContent).toContain('Signal class: momentum_breakout');
      expect(userContent).toContain('7 trades');
      expect(userContent).toContain('Win rate: 57%');
      expect(userContent).toContain('Expectancy: 0.37');
      expect(userContent).toContain('Sharpe-like: 0.81');
      expect(userContent).toContain('Avg adverse move: 0.042');
      expect(userContent).toContain('Avg favorable move: 0.118');
      expect(userContent).not.toContain('Signal performance data will be populated in Phase 2');
    });

    it('renders novel setup guidance when no signal history exists', async () => {
      const book = makeBook();
      const completeFn = vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: 'reject', reasoning: 'novel setup' }),
        model: 'test-main',
      });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      mockSummarizeSignalPerformance.mockReturnValue({
        signalClass: 'novel_breakout',
        sampleCount: 0,
        wins: 0,
        losses: 0,
        thesisCorrectRate: 0,
        expectancy: 0,
        variance: 0,
        sharpeLike: 0,
        maeProxy: 0,
        mfeProxy: 0,
      });

      await gate.evaluate(makeCandidate({ signalClass: 'novel_breakout' }), markPrice);

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userContent).toContain('No historical trades for signal class "novel_breakout"');
      expect(userContent).toContain('Treat as a novel setup');
    });
  });
});
