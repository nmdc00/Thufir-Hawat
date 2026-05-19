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

vi.mock('../../src/memory/llm_entry_gate_log.js', () => ({
  recordEntryGateDecision: (...args: unknown[]) => mockRecordEntryGateDecision(...args),
}));

const mockLoggerWarn = vi.fn();
const mockListPerpTradeJournals = vi.fn(() => []);
const mockComputeRollingWindowMetrics = vi.fn(() => []);
const mockSummarizeSignalPerformance = vi.fn(
  (_entries: PerpTradeJournalEntry[], signalClass: string): SignalPerformanceSummary => ({
    signalClass,
    sampleCount: 0,
    observedCount: 0,
    blockedCount: 0,
    unresolvedCount: 0,
    wins: 0,
    losses: 0,
    thesisCorrectRate: 0,
    expectancy: 0,
    variance: 0,
    sharpeLike: 0,
    maeProxy: 0,
    mfeProxy: 0,
    scopeLevel: 'signal_class',
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
  summarizeComparableSignalPerformance: (...args: unknown[]) => mockSummarizeSignalPerformance(...args),
}));

vi.mock('../../src/memory/learning_metrics.js', () => ({
  computeRollingWindowMetrics: (...args: unknown[]) => mockComputeRollingWindowMetrics(...args),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { LlmEntryGate, type EntryGateCandidate } from '../../src/core/llm_entry_gate.js';
import type { LlmClient } from '../../src/core/llm.js';
import type { PositionBook } from '../../src/core/position_book.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  oppositeSideLosers?: Array<{ symbol: string; side: 'long' | 'short'; unrealizedPnlUsd: number }>;
  entries?: ReturnType<PositionBook['getAll']>;
}): PositionBook {
  return {
    hasConflict: vi.fn().mockReturnValue(overrides?.hasConflict ?? false),
    hasPosition: vi.fn().mockReturnValue(overrides?.hasPosition ?? false),
    findOppositeSideLosers: vi.fn().mockReturnValue(overrides?.oppositeSideLosers ?? []),
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
    mockListPerpTradeJournals.mockReturnValue([]);
    mockComputeRollingWindowMetrics.mockReturnValue([]);
    mockSummarizeSignalPerformance.mockImplementation(
      (_entries: PerpTradeJournalEntry[], signalClass: string): SignalPerformanceSummary => ({
        signalClass,
        sampleCount: 0,
        observedCount: 0,
        blockedCount: 0,
        unresolvedCount: 0,
        wins: 0,
        losses: 0,
        thesisCorrectRate: 0,
        expectancy: 0,
        variance: 0,
        sharpeLike: 0,
        maeProxy: 0,
        mfeProxy: 0,
        scopeLevel: 'signal_class',
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
    });

  });

  describe('LLM approve path', () => {
    it('returns approve when LLM responds with approve verdict', async () => {
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'Strong setup' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.verdict).toBe('approve');
      expect(result.reasoning).toBe('Strong setup');
      expect(result.reasonCode).toBe('approve');
    });

    it('renders resolved trade stats and configured thresholds in the prompt', async () => {
      mockSummarizeSignalPerformance.mockImplementation(
        (_entries: PerpTradeJournalEntry[], signalClass: string): SignalPerformanceSummary => ({
          signalClass,
          sampleCount: 3,
          observedCount: 35,
          blockedCount: 32,
          unresolvedCount: 0,
          wins: 2,
          losses: 1,
          thesisCorrectRate: 2 / 3,
          expectancy: 0.33,
          variance: 0.2,
          sharpeLike: 0.74,
          maeProxy: 0.12,
          mfeProxy: 0.41,
          symbolClass: 'macro_contract',
          marketRegime: 'trending',
          scopeLevel: 'signal_class_and_symbol_class_and_regime',
        })
      );
      const book = makeBook();
      const mainLlm = makeLlmClient({ verdict: 'approve', reasoning: 'Strong setup' });
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(
        makeCandidate({
          symbol: 'XYZ:GOLD',
          symbolClass: 'macro_contract',
          regime: 'trending',
          mechanicalMinEdge: 0.05,
          mechanicalMinConfidence: 0.7,
        }),
        markPrice
      );

      const call = (mainLlm.complete as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = call[0];
      const userPrompt = messages[1].content as string;
      const systemPrompt = messages[0].content as string;
      expect(userPrompt).toContain('3 resolved trades');
      expect(userPrompt).not.toContain('35 trades');
      expect(userPrompt).toContain('Excluded 32 blocked and 0 unresolved attempts');
      expect(userPrompt).toContain('Mechanical floor already passed: edge >= 5.00% and confidence >= 70.0%');
      expect(systemPrompt).toContain('Treat edge >10% and confidence >70% as a leverage scale-up bar, not as a general approval threshold');
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
      expect(result.reasoning).toBe('Reduce size for risk');
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

    it('calls main LLM without timeoutMs option (avoids proxy rejection)', async () => {
      const book = makeBook();
      const completeFn = vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: 'approve', reasoning: 'ok' }),
        model: 'test-main',
      });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      await gate.evaluate(makeCandidate(), markPrice);

      expect(completeFn).toHaveBeenCalledOnce();
      const options = completeFn.mock.calls[0][1] as Record<string, unknown>;
      expect(options).not.toHaveProperty('timeoutMs');
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

    it('accepts null stopLevelPrice', async () => {
      const book = makeBook();
      const mainLlm: LlmClient = {
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({ verdict: 'approve', reasoning: 'ok', stopLevelPrice: null, equityAtRiskPct: 2.0, targetRR: 1.8 }),
          model: 'test-main',
        }),
      } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

      const result = await gate.evaluate(makeCandidate(), markPrice);

      expect(result.stopLevelPrice).toBeNull();
      expect(result.equityAtRiskPct).toBe(2.0);
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

  describe('same-side concentration warning', () => {
    it('includes concentration warning in prompt when same-side position exists', async () => {
      const book = makeBook({ hasPosition: true });
      const completeFn = vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: 'reject', reasoning: 'stacking risk' }),
        model: 'test-main',
      });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

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
        content: JSON.stringify({ verdict: 'approve', reasoning: 'clean entry' }),
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
      const gate = new LlmEntryGate(mainLlm, makeLlmClient(null), notify, book, dummyConfig);

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
          currentMarkPrice: null,
          unrealizedPnlUsd: null,
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
          currentMarkPrice: null,
          unrealizedPnlUsd: null,
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
      expect(mockSummarizeSignalPerformance).toHaveBeenCalledWith(entries, {
        signalClass: 'momentum_breakout',
        symbolClass: null,
        marketRegime: 'trending',
      });
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
        observedCount: 7,
        blockedCount: 0,
        unresolvedCount: 0,
        wins: 4,
        losses: 3,
        thesisCorrectRate: 4 / 7,
        expectancy: 0.37,
        variance: 0.21,
        sharpeLike: 0.81,
        maeProxy: 0.042,
        mfeProxy: 0.118,
        scopeLevel: 'signal_class',
      });

      await gate.evaluate(makeCandidate({ signalClass: 'momentum_breakout' }), markPrice);

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userContent).toContain('Signal class: momentum_breakout');
      expect(userContent).toContain('7 resolved trades');
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
        observedCount: 0,
        blockedCount: 0,
        unresolvedCount: 0,
        wins: 0,
        losses: 0,
        thesisCorrectRate: 0,
        expectancy: 0,
        variance: 0,
        sharpeLike: 0,
        maeProxy: 0,
        mfeProxy: 0,
        scopeLevel: 'signal_class',
      });

      await gate.evaluate(makeCandidate({ signalClass: 'novel_breakout' }), markPrice);

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userContent).toContain('No resolved comparable trade history for signal class "novel_breakout"');
      expect(userContent).toContain('Treat as a novel setup');
    });
  });
});
