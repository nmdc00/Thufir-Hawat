import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LlmExitConsultant } from '../../src/core/llm_exit_consultant.js';
import { getExecutionContext, withExecutionContext } from '../../src/core/llm_infra.js';
import type { BookEntry } from '../../src/core/position_book.js';

const recordExitConsultDecisionMock = vi.fn();
vi.mock('../../src/memory/llm_exit_consult_log.js', () => ({
  recordExitConsultDecision: (...args: unknown[]) => recordExitConsultDecisionMock(...args),
}));

const mockLoggerWarn = vi.fn();
vi.mock('../../src/core/logger.js', () => ({
  Logger: class {
    info(): void {}
    warn(...args: unknown[]): void {
      mockLoggerWarn(...args);
    }
    error(): void {}
  },
}));

const NOW = 1_000_000_000_000;

function makeBookEntry(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    symbol: 'BTC',
    side: 'long',
    size: 0.1,
    entryPrice: 50000,
    currentMarkPrice: null,
    unrealizedPnlUsd: null,
    entryReasoningText: 'Strong breakout on news',
    thesisExpiresAtMs: NOW + 60 * 60 * 1000,
    exitContract: null,
    exitContractSummary: null,
    lastConsultAtMs: null,
    lastConsultDecision: null,
    entryAtMs: NOW - 60 * 60 * 1000,
    ...overrides,
  };
}

function makeConfig() {
  return {
    agent: { promptBudget: { trivial: 10000 } },
    heartbeat: {
      llmExitConsult: {
        primaryTimeoutMs: 500,
        fallbackTimeoutMs: 500,
        timeoutMs: 500,
        firstConsultMinutes: 20,
        cadenceMinutes: 20,
        minConsultSpacingMinutes: 5,
        maxCallsPerPositionPerHour: 3,
        approachTtlMinutes: 15,
      },
    },
  } as any;
}

function makeLlm(responseJson: object) {
  return {
    complete: vi.fn().mockResolvedValue({ content: JSON.stringify(responseJson), model: 'mock' }),
  };
}

function makeTimeoutLlm() {
  return {
    complete: vi.fn().mockReturnValue(new Promise(() => {})),
  };
}

function makeErrorLlm() {
  return {
    complete: vi.fn().mockRejectedValue(new Error('LLM error')),
  };
}

function makeConsultant(mainLlm: any, fallbackLlm: any, notify?: (msg: string) => Promise<void>) {
  return new LlmExitConsultant(
    mainLlm,
    fallbackLlm,
    notify ?? vi.fn().mockResolvedValue(undefined),
    makeConfig()
  );
}

describe('LlmExitConsultant.shouldConsult', () => {
  it('does not consult too early when the position is fresh and TTL is not close', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      thesisExpiresAtMs: NOW + 110 * 60 * 1000,
      entryAtMs: NOW - 10 * 60 * 1000,
    });
    expect(consultant.shouldConsult(entry, 50000, 0.01, NOW)).toBe(false);
  });

  it('consults once when TTL is approaching and the position has never been reviewed', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      thesisExpiresAtMs: NOW + 10 * 60 * 1000,
      lastConsultAtMs: null,
    });
    expect(consultant.shouldConsult(entry, 50000, 0.01, NOW)).toBe(true);
  });

  it('does not repeat a TTL-approach consult before cadence', () => {
    const consultant = makeConsultant(
      makeLlm({ action: 'hold', reasoning: 'ok' }),
      makeLlm({ action: 'hold', reasoning: 'ok' })
    );
    const entry = makeBookEntry({
      thesisExpiresAtMs: NOW + 10 * 60 * 1000,
      lastConsultAtMs: NOW - 6 * 60 * 1000,
      lastConsultDecision: JSON.stringify({
        action: 'hold',
        roeAtConsult: 0.01,
        priceAtConsult: 50000,
      }),
    });
    expect(consultant.shouldConsult(entry, 50000, 0.01, NOW)).toBe(false);
  });

  it('allows a new ROE threshold crossing after minimum spacing but before cadence', () => {
    const consultant = makeConsultant(
      makeLlm({ action: 'hold', reasoning: 'ok' }),
      makeLlm({ action: 'hold', reasoning: 'ok' })
    );
    const entry = makeBookEntry({
      lastConsultAtMs: NOW - 6 * 60 * 1000,
      lastConsultDecision: JSON.stringify({
        action: 'hold',
        roeAtConsult: 0.02,
        priceAtConsult: 50000,
      }),
    });
    expect(consultant.shouldConsult(entry, 50000, 0.04, NOW)).toBe(true);
  });

  it('hard-caps consultations per position within a rolling hour', async () => {
    const main = makeLlm({ action: 'hold', reasoning: 'ok' });
    const consultant = makeConsultant(main, makeLlm({ action: 'hold', reasoning: 'fallback' }));
    const entry = makeBookEntry();
    await consultant.consult(entry, 50000, 0.01, 'context');
    await consultant.consult(entry, 50000, 0.01, 'context');
    await consultant.consult(entry, 50000, 0.01, 'context');
    expect(consultant.shouldConsult(entry, 50000, 0.04, Date.now())).toBe(false);
  });
});

describe('LlmExitConsultant.consult', () => {
  beforeEach(() => {
    recordExitConsultDecisionMock.mockClear();
    mockLoggerWarn.mockClear();
  });

  it('returns allowed review decisions from the model', async () => {
    const consultant = makeConsultant(
      makeLlm({ action: 'update_invalidation', reasoning: 'higher low formed', newInvalidationPrice: 51000 }),
      makeLlm({ action: 'hold', reasoning: 'fb' })
    );
    const decision = await consultant.consult(makeBookEntry(), 52000, 0.04, 'context');
    expect(decision).toEqual({
      action: 'update_invalidation',
      reasoning: 'higher low formed',
      newInvalidationPrice: 51000,
    });
  });

  it('rejects obsolete close output and falls back to hold', async () => {
    const consultant = makeConsultant(
      makeLlm({ action: 'close', reasoning: 'obsolete authority' }),
      makeLlm({ action: 'hold', reasoning: 'fallback hold' })
    );
    const decision = await consultant.consult(makeBookEntry(), 49000, -0.02, 'context');
    expect(decision.action).toBe('hold');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Exit consultant main LLM failed; falling back',
      expect.objectContaining({ failureType: 'schema_validation' })
    );
  });

  it('falls back when the main LLM times out', async () => {
    const notifyMock = vi.fn().mockResolvedValue(undefined);
    const consultant = makeConsultant(
      makeTimeoutLlm(),
      makeLlm({ action: 'hold', reasoning: 'fallback hold' }),
      notifyMock
    );
    const decision = await consultant.consult(makeBookEntry(), 50000, 0.01, '');
    expect(decision.action).toBe('hold');
    expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining('using fallback LLM'));
  }, 15000);

  it('aborts the primary request before starting the local fallback', async () => {
    let primarySignal: AbortSignal | undefined;
    const main = {
      complete: vi.fn().mockImplementation((_messages, options) => {
        primarySignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }),
    };
    const consultant = new LlmExitConsultant(
      main as any,
      makeLlm({ action: 'hold', reasoning: 'local fallback' }) as any,
      vi.fn().mockResolvedValue(undefined),
      {
        agent: { promptBudget: { trivial: 10000 } },
        heartbeat: { llmExitConsult: { primaryTimeoutMs: 20, fallbackTimeoutMs: 100 } },
      } as any
    );

    const decision = await consultant.consult(makeBookEntry(), 50000, 0.01, '');

    expect(primarySignal?.aborted).toBe(true);
    expect(decision).toMatchObject({ action: 'hold', reasoning: 'local fallback' });
  });

  it('returns safe hold when both LLMs fail', async () => {
    const consultant = makeConsultant(makeErrorLlm(), makeErrorLlm());
    const decision = await consultant.consult(makeBookEntry(), 50000, 0.01, '');
    expect(decision.action).toBe('hold');
    expect(decision.reasoning).toContain('LLM unavailable');
  });

  it('applies heartbeat execution context to the main call', async () => {
    const observedContexts: Array<ReturnType<typeof getExecutionContext>> = [];
    const main = {
      complete: vi.fn().mockImplementation(async () => {
        observedContexts.push(getExecutionContext());
        return { content: JSON.stringify({ action: 'hold', reasoning: 'ok' }), model: 'mock' };
      }),
    };
    const consultant = makeConsultant(main, makeLlm({ action: 'hold', reasoning: 'fb' }));
    await consultant.consult(makeBookEntry(), 50000, 0.01, 'context');
    expect(observedContexts[0]).toMatchObject({
      mode: 'LIGHT_REASONING',
      critical: false,
      reason: 'exit_consultant_main',
      source: 'heartbeat',
    });
  });

  it('preserves an existing execution context instead of overwriting it', async () => {
    const observedContexts: Array<ReturnType<typeof getExecutionContext>> = [];
    const main = {
      complete: vi.fn().mockImplementation(async () => {
        observedContexts.push(getExecutionContext());
        return { content: JSON.stringify({ action: 'hold', reasoning: 'ok' }), model: 'mock' };
      }),
    };
    const consultant = makeConsultant(main, makeLlm({ action: 'hold', reasoning: 'fb' }));
    await withExecutionContext(
      { mode: 'FULL_AGENT', critical: true, reason: 'preexisting_context', source: 'test' },
      () => consultant.consult(makeBookEntry(), 50000, 0.01, 'context')
    );
    expect(observedContexts[0]).toMatchObject({
      mode: 'FULL_AGENT',
      critical: true,
      reason: 'preexisting_context',
      source: 'test',
    });
  });

  it('records each consult decision to the audit log', async () => {
    const consultant = makeConsultant(
      makeLlm({ action: 'reduce', reasoning: 'extended and fading', reduceToFraction: 0.6 }),
      makeLlm({ action: 'hold', reasoning: 'fb' })
    );
    await consultant.consult(makeBookEntry(), 52000, 0.04, 'context');
    expect(recordExitConsultDecisionMock).toHaveBeenCalledOnce();
    expect(recordExitConsultDecisionMock.mock.calls[0]?.[0]).toMatchObject({
      symbol: 'BTC',
      side: 'long',
      action: 'reduce',
      reduceToFraction: 0.6,
    });
  });
});
