/**
 * Tests for LlmExitConsultant
 *
 * Covers:
 * - shouldConsult triggers (time, ROE thresholds, TTL approach)
 * - consult() returning hold/close/extend_ttl decisions from mock LLM
 * - fallback fires when main LLM times out
 * - both fail → returns hold, does not throw
 * - DB log written for each consult
 * - integration with PositionHeartbeatService for close/reduce/extend_ttl
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmExitConsultant } from '../../src/core/llm_exit_consultant.js';
import { getExecutionContext, withExecutionContext } from '../../src/core/llm_infra.js';
import type { BookEntry } from '../../src/core/position_book.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_000_000_000_000; // arbitrary fixed timestamp
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
// Default thesis expires 2 hours from a fake entry time.
// We set thesisExpiresAtMs = NOW + 60 min (so entry was 60 min ago)
const THESIS_EXPIRES = NOW + 60 * 60 * 1000; // 60 min from now
// Canonical entry time: 60 min before NOW (matching the THESIS_EXPIRES proxy assumption)
const ENTRY_AT = NOW - 60 * 60 * 1000;

function makeBookEntry(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    symbol: 'BTC',
    side: 'long',
    size: 0.1,
    entryPrice: 50000,
    currentMarkPrice: null,
    unrealizedPnlUsd: null,
    entryReasoningText: 'Strong breakout on news',
    thesisExpiresAtMs: THESIS_EXPIRES,
    exitContract: null,
    exitContractSummary: null,
    lastConsultAtMs: null,
    lastConsultDecision: null,
    entryAtMs: ENTRY_AT,
    ...overrides,
  };
}

function makeConfig() {
  return { agent: { promptBudget: { trivial: 10000 } }, heartbeat: { llmExitConsult: { timeoutMs: 500 } } } as any;
}

function makeLlm(responseJson: object): { complete: ReturnType<typeof vi.fn> } {
  return {
    complete: vi.fn().mockResolvedValue({ content: JSON.stringify(responseJson), model: 'mock' }),
  };
}

function makeTimeoutLlm(): { complete: ReturnType<typeof vi.fn> } {
  return {
    complete: vi.fn().mockReturnValue(new Promise(() => { /* never resolves */ })),
  };
}

function makeErrorLlm(): { complete: ReturnType<typeof vi.fn> } {
  return {
    complete: vi.fn().mockRejectedValue(new Error('LLM error')),
  };
}

function makeConsultant(
  mainLlm: any,
  fallbackLlm: any,
  notify?: (msg: string) => Promise<void>,
) {
  const notifyFn = notify ?? vi.fn().mockResolvedValue(undefined);
  return new LlmExitConsultant(mainLlm, fallbackLlm, notifyFn, makeConfig());
}

// ---------------------------------------------------------------------------
// shouldConsult tests
// ---------------------------------------------------------------------------

describe('LlmExitConsultant.shouldConsult', () => {
  it('returns false when position is < 20 min old, ROE below thresholds, TTL not close', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    // Entry 10 min ago — entryAtMs set explicitly, TTL 110 min from now.
    const entry = makeBookEntry({
      thesisExpiresAtMs: NOW + 110 * 60 * 1000,
      entryAtMs: NOW - 10 * 60 * 1000,
      lastConsultAtMs: null,
    });
    expect(consultant.shouldConsult(entry, 50000, 0.01, NOW)).toBe(false);
  });

  it('returns false immediately after entry with long TTL (regression: 24h TTL must not trigger at t=0)', () => {
    // The bug: when thesis TTL > 2h, (thesisExpiresAtMs - 2h) > entryTime, giving entryAge < 0.
    // The old code had `entryAge < 0 || entryAge >= firstConsultMs`, causing instant consultation.
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      thesisExpiresAtMs: NOW + 24 * 60 * 60 * 1000, // 24h TTL
      entryAtMs: NOW - 30 * 1000,                    // opened 30 seconds ago
      lastConsultAtMs: null,
    });
    expect(consultant.shouldConsult(entry, 95.77, 0, NOW)).toBe(false);
  });

  it('returns true after 20 min since last consult', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      lastConsultAtMs: NOW - 21 * 60 * 1000, // 21 min ago
    });
    expect(consultant.shouldConsult(entry, 50000, 0.01, NOW)).toBe(true);
  });

  it('returns false when only 19 min have passed since last consult', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      lastConsultAtMs: NOW - 19 * 60 * 1000, // 19 min ago
    });
    expect(consultant.shouldConsult(entry, 50000, 0.01, NOW)).toBe(false);
  });

  it('returns true when ROE crosses 3% threshold', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      lastConsultAtMs: NOW - 1 * 60 * 1000, // 1 min ago (well within cadence)
      lastConsultDecision: JSON.stringify({ action: 'hold', reasoning: 'fine', roeAtConsult: 0.01 }), // was 1%
    });
    // Now ROE is 3.5% → crossed 3% threshold
    expect(consultant.shouldConsult(entry, 50000, 0.035, NOW)).toBe(true);
  });

  it('returns true when ROE crosses 7% threshold', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      lastConsultAtMs: NOW - 1 * 60 * 1000,
      lastConsultDecision: JSON.stringify({ action: 'hold', reasoning: 'fine', roeAtConsult: 0.04 }), // was 4%
    });
    // Now ROE is 7.5% → crossed 7%
    expect(consultant.shouldConsult(entry, 50000, 0.075, NOW)).toBe(true);
  });

  it('returns false when ROE is 4% but last consult was also above 3%', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      lastConsultAtMs: NOW - 1 * 60 * 1000,
      lastConsultDecision: JSON.stringify({ action: 'hold', reasoning: 'fine', roeAtConsult: 0.035 }), // was 3.5%
    });
    // ROE still 4% — no new threshold crossed
    expect(consultant.shouldConsult(entry, 50000, 0.04, NOW)).toBe(false);
  });

  it('returns true when TTL approach < 15 min', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      thesisExpiresAtMs: NOW + 10 * 60 * 1000, // expires in 10 min
      lastConsultAtMs: NOW - 1 * 60 * 1000,    // consulted 1 min ago
    });
    expect(consultant.shouldConsult(entry, 50000, 0.01, NOW)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Structural trade behaviour
  // -------------------------------------------------------------------------

  it('structural: does not trigger at 20 min (suppressed until 4h)', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      entryAtMs: NOW - 21 * 60 * 1000,           // 21 min old
      thesisExpiresAtMs: NOW + 4 * 60 * 60 * 1000,
      lastConsultAtMs: null,
      exitContract: { tradeType: 'structural', thesis: 'Hormuz blockade → oil', hardRules: [], reviewGuidance: [] },
    });
    expect(consultant.shouldConsult(entry, 97, 0.023, NOW)).toBe(false);
  });

  it('structural: triggers after 4h first-consult window', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      entryAtMs: NOW - 4 * 60 * 60 * 1000 - 1000, // just over 4h old
      thesisExpiresAtMs: NOW + 24 * 60 * 60 * 1000,
      lastConsultAtMs: null,
      exitContract: { tradeType: 'structural', thesis: 'Hormuz blockade → oil', hardRules: [], reviewGuidance: [] },
    });
    expect(consultant.shouldConsult(entry, 97, 0.023, NOW)).toBe(true);
  });

  it('structural: positive ROE threshold crossings do not trigger consultation', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      lastConsultAtMs: NOW - 1 * 60 * 1000,
      lastConsultDecision: JSON.stringify({ roeAtConsult: 0.01 }),
      thesisExpiresAtMs: NOW + 4 * 60 * 60 * 1000,
      exitContract: { tradeType: 'structural', thesis: 'Hormuz blockade → oil', hardRules: [], reviewGuidance: [] },
    });
    // ROE just crossed 3% — should NOT trigger for structural
    expect(consultant.shouldConsult(entry, 97, 0.035, NOW)).toBe(false);
  });

  it('structural: triggers on significant drawdown (ROE ≤ -5%)', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      lastConsultAtMs: NOW - 1 * 60 * 1000,
      thesisExpiresAtMs: NOW + 4 * 60 * 60 * 1000,
      exitContract: { tradeType: 'structural', thesis: 'Hormuz blockade → oil', hardRules: [], reviewGuidance: [] },
    });
    expect(consultant.shouldConsult(entry, 93, -0.05, NOW)).toBe(true);
  });

  it('structural: small drawdown below 5% does not trigger', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      lastConsultAtMs: NOW - 1 * 60 * 1000,
      thesisExpiresAtMs: NOW + 4 * 60 * 60 * 1000,
      exitContract: { tradeType: 'structural', thesis: 'Hormuz blockade → oil', hardRules: [], reviewGuidance: [] },
    });
    expect(consultant.shouldConsult(entry, 96, -0.02, NOW)).toBe(false);
  });

  it('structural: triggers when price within 2% of invalidation level', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      lastConsultAtMs: NOW - 1 * 60 * 1000,
      thesisExpiresAtMs: NOW + 4 * 60 * 60 * 1000,
      exitContract: {
        tradeType: 'structural',
        thesis: 'Hormuz blockade → oil',
        hardRules: [{ metric: 'mark_price', op: '<=', value: 94, action: 'close', reason: 'thesis invalidation' }],
        reviewGuidance: [],
      },
    });
    // Current price 95.5 — invalidation at 94 — proximity = (95.5-94)/95.5 = 1.57% < 2%
    expect(consultant.shouldConsult(entry, 95.5, 0.01, NOW)).toBe(true);
  });

  it('structural: does not trigger when price far from invalidation level', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      lastConsultAtMs: NOW - 1 * 60 * 1000,
      thesisExpiresAtMs: NOW + 4 * 60 * 60 * 1000,
      exitContract: {
        tradeType: 'structural',
        thesis: 'Hormuz blockade → oil',
        hardRules: [{ metric: 'mark_price', op: '<=', value: 90, action: 'close', reason: 'thesis invalidation' }],
        reviewGuidance: [],
      },
    });
    // Current price 97 — invalidation at 90 — proximity = 7.2% > 2%
    expect(consultant.shouldConsult(entry, 97, 0.023, NOW)).toBe(false);
  });

  it('structural: TTL approach still triggers regardless of trade type', () => {
    const consultant = makeConsultant(makeLlm({ action: 'hold', reasoning: 'ok' }), makeLlm({ action: 'hold', reasoning: 'ok' }));
    const entry = makeBookEntry({
      thesisExpiresAtMs: NOW + 10 * 60 * 1000, // 10 min remaining
      lastConsultAtMs: NOW - 1 * 60 * 1000,
      exitContract: { tradeType: 'structural', thesis: 'Hormuz blockade → oil', hardRules: [], reviewGuidance: [] },
    });
    expect(consultant.shouldConsult(entry, 97, 0.023, NOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// consult() tests
// ---------------------------------------------------------------------------

describe('LlmExitConsultant.consult', () => {
  beforeEach(() => {
    recordExitConsultDecisionMock.mockClear();
    mockLoggerWarn.mockClear();
  });

  it('returns hold decision from mock LLM', async () => {
    const main = makeLlm({ action: 'hold', reasoning: 'Thesis intact, hold.' });
    const fallback = makeLlm({ action: 'hold', reasoning: 'fb' });
    const consultant = makeConsultant(main, fallback);
    const entry = makeBookEntry();

    const decision = await consultant.consult(entry, 50000, 0.02, 'BTC momentum continues');

    expect(decision.action).toBe('hold');
    expect(decision.reasoning).toContain('Thesis intact');
    expect(main.complete).toHaveBeenCalledOnce();
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  it('returns close decision from mock LLM', async () => {
    const main = makeLlm({ action: 'close', reasoning: 'Narrative reversed.' });
    const fallback = makeLlm({ action: 'hold', reasoning: 'fb' });
    const consultant = makeConsultant(main, fallback);
    const entry = makeBookEntry();

    const decision = await consultant.consult(entry, 49000, -0.02, 'BTC selling off hard');

    expect(decision.action).toBe('close');
    expect(decision.reasoning).toContain('Narrative reversed');
  });

  it('returns extend_ttl decision with newTimeStopAtMs', async () => {
    const newStop = NOW + 4 * 60 * 60 * 1000;
    const main = makeLlm({ action: 'extend_ttl', reasoning: 'Still running.', newTimeStopAtMs: newStop });
    const fallback = makeLlm({ action: 'hold', reasoning: 'fb' });
    const consultant = makeConsultant(main, fallback);
    const entry = makeBookEntry();

    const decision = await consultant.consult(entry, 52000, 0.04, 'Bull continuing');

    expect(decision.action).toBe('extend_ttl');
    expect(decision.newTimeStopAtMs).toBe(newStop);
  });

  it('returns reduce decision with reduceToFraction', async () => {
    const main = makeLlm({ action: 'reduce', reasoning: 'Take some off.', reduceToFraction: 0.5 });
    const fallback = makeLlm({ action: 'hold', reasoning: 'fb' });
    const consultant = makeConsultant(main, fallback);
    const entry = makeBookEntry();

    const decision = await consultant.consult(entry, 51000, 0.03, 'Momentum fading');

    expect(decision.action).toBe('reduce');
    expect(decision.reduceToFraction).toBe(0.5);
  });

  it('accepts undefined pseudo-json optional fields from exit consultant output', async () => {
    const main = {
      complete: vi.fn().mockResolvedValue({
        content:
          '{"action":"hold","reasoning":"stay in","newTimeStopAtMs":undefined,"newInvalidationPrice":undefined,"reduceToFraction":undefined}',
        model: 'mock',
      }),
    };
    const fallback = makeLlm({ action: 'hold', reasoning: 'fb' });
    const consultant = makeConsultant(main, fallback);
    const entry = makeBookEntry();

    const decision = await consultant.consult(entry, 50000, 0.02, 'context');

    expect(decision).toEqual({
      action: 'hold',
      reasoning: 'stay in',
    });
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  it('fires fallback on main LLM timeout and calls notify', async () => {
    const main = makeTimeoutLlm();
    const fallback = makeLlm({ action: 'hold', reasoning: 'fb hold' });
    const notifyMock = vi.fn().mockResolvedValue(undefined);
    const consultant = makeConsultant(main, fallback, notifyMock);
    const entry = makeBookEntry();

    const decision = await consultant.consult(entry, 50000, 0.01, '');

    expect(decision.action).toBe('hold');
    expect(fallback.complete).toHaveBeenCalledOnce();
    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining('using fallback LLM')
    );
  }, 15000);

  it('applies heartbeat execution context to the main consultant call', async () => {
    const observedContexts: Array<ReturnType<typeof getExecutionContext>> = [];
    const main = {
      complete: vi.fn().mockImplementation(async () => {
        observedContexts.push(getExecutionContext());
        return { content: JSON.stringify({ action: 'hold', reasoning: 'ok' }), model: 'mock' };
      }),
    };
    const fallback = makeLlm({ action: 'hold', reasoning: 'fb' });
    const consultant = makeConsultant(main, fallback);

    await consultant.consult(makeBookEntry(), 50000, 0.01, 'context');

    expect(observedContexts).toHaveLength(1);
    expect(observedContexts[0]).toMatchObject({
      mode: 'LIGHT_REASONING',
      critical: false,
      reason: 'exit_consultant_main',
      source: 'heartbeat',
    });
  });

  it('applies heartbeat execution context to the fallback consultant call', async () => {
    const observedContexts: Array<ReturnType<typeof getExecutionContext>> = [];
    const main = makeErrorLlm();
    const fallback = {
      complete: vi.fn().mockImplementation(async () => {
        observedContexts.push(getExecutionContext());
        return { content: JSON.stringify({ action: 'hold', reasoning: 'fallback ok' }), model: 'mock' };
      }),
    };
    const consultant = makeConsultant(main, fallback);

    await consultant.consult(makeBookEntry(), 50000, 0.01, 'context');

    expect(observedContexts).toHaveLength(1);
    expect(observedContexts[0]).toMatchObject({
      mode: 'LIGHT_REASONING',
      critical: false,
      reason: 'exit_consultant_fallback',
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
    const fallback = makeLlm({ action: 'hold', reasoning: 'fb' });
    const consultant = makeConsultant(main, fallback);

    await withExecutionContext(
      {
        mode: 'FULL_AGENT',
        critical: true,
        reason: 'preexisting_context',
        source: 'test',
      },
      () => consultant.consult(makeBookEntry(), 50000, 0.01, 'context')
    );

    expect(observedContexts).toHaveLength(1);
    expect(observedContexts[0]).toMatchObject({
      mode: 'FULL_AGENT',
      critical: true,
      reason: 'preexisting_context',
      source: 'test',
    });
  });

  it('returns hold and does not throw when both LLMs fail', async () => {
    const main = makeErrorLlm();
    const fallback = makeErrorLlm();
    const notifyMock = vi.fn().mockResolvedValue(undefined);
    const consultant = makeConsultant(main, fallback, notifyMock);
    const entry = makeBookEntry();

    const decision = await consultant.consult(entry, 50000, 0.01, '');

    expect(decision.action).toBe('hold');
    expect(decision.reasoning).toContain('LLM unavailable');
  });

  it('records DB log for each consult', async () => {
    const main = makeLlm({ action: 'hold', reasoning: 'ok' });
    const fallback = makeLlm({ action: 'hold', reasoning: 'fb' });
    const consultant = makeConsultant(main, fallback);
    const entry = makeBookEntry();

    await consultant.consult(entry, 50000, 0.02, '');

    expect(recordExitConsultDecisionMock).toHaveBeenCalledOnce();
    const logArg = recordExitConsultDecisionMock.mock.calls[0]?.[0];
    expect(logArg).toMatchObject({
      symbol: 'BTC',
      side: 'long',
      action: 'hold',
      usedFallback: 0,
    });
  });

  it('uses entryAtMs for time-held prompt and log after TTL extensions', async () => {
    const main = makeLlm({ action: 'hold', reasoning: 'still valid' });
    const fallback = makeLlm({ action: 'hold', reasoning: 'fb' });
    const consultant = makeConsultant(main, fallback);
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    const entry = makeBookEntry({
      entryAtMs: NOW - fourteenDaysMs,
      thesisExpiresAtMs: NOW + 4 * 60 * 60 * 1000,
    });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      await consultant.consult(entry, 50000, 0.02, 'context');
    } finally {
      nowSpy.mockRestore();
    }

    const [messages] = main.complete.mock.calls[0]!;
    expect(JSON.stringify(messages)).toContain(`time held: ${14 * 24 * 60} minutes`);
    const logArg = recordExitConsultDecisionMock.mock.calls.at(-1)?.[0];
    expect(logArg.timeHeldMs).toBe(fourteenDaysMs);
  });

  it('includes exit contract summary in the LLM prompt', async () => {
    const main = makeLlm({ action: 'hold', reasoning: 'ok' });
    const fallback = makeLlm({ action: 'hold', reasoning: 'fb' });
    const consultant = makeConsultant(main, fallback);
    const entry = makeBookEntry({
      exitContractSummary: 'thesis=BTC trend; hard_rules=close when mark_price <= 49000 (support lost)',
    });

    await consultant.consult(entry, 50000, 0.02, 'BTC momentum continues');

    const [messages] = main.complete.mock.calls[0]!;
    expect(JSON.stringify(messages)).toContain('## Exit contract');
    expect(JSON.stringify(messages)).toContain('support lost');
  });

  it('records DB log with usedFallback=1 when fallback is used', async () => {
    const main = makeErrorLlm();
    const fallback = makeLlm({ action: 'hold', reasoning: 'fb hold' });
    const notifyMock = vi.fn().mockResolvedValue(undefined);
    const consultant = makeConsultant(main, fallback, notifyMock);
    const entry = makeBookEntry();

    await consultant.consult(entry, 50000, 0.01, '');

    expect(recordExitConsultDecisionMock).toHaveBeenCalledOnce();
    const logArg = recordExitConsultDecisionMock.mock.calls[0]?.[0];
    expect(logArg.usedFallback).toBe(1);
  });

  it('logs the failure type when the main LLM returns schema-invalid JSON', async () => {
    const main = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({ action: 'hold', reasoning: 'bad', reduceToFraction: 'nope' }),
        model: 'main-model',
      }),
      meta: { provider: 'openai', model: 'main-model' },
    };
    const fallback = makeLlm({ action: 'hold', reasoning: 'fb hold' });
    const consultant = makeConsultant(main, fallback);
    const entry = makeBookEntry();

    const decision = await consultant.consult(entry, 50000, 0.01, '');

    expect(decision.action).toBe('hold');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Exit consultant main LLM failed; falling back',
      expect.objectContaining({
        failureType: 'schema_validation',
        provider: 'openai',
        model: 'main-model',
      })
    );
  });

  it('logs the fallback failure type before using the safe default', async () => {
    const main = makeErrorLlm();
    const fallback = {
      complete: vi.fn().mockResolvedValue({
        content: '{"action":"hold","reasoning":"bad","reduceToFraction":"nope"}',
        model: 'fallback-model',
      }),
      meta: { provider: 'openai', model: 'fallback-model' },
    };
    const consultant = makeConsultant(main, fallback as any);
    const entry = makeBookEntry();

    const decision = await consultant.consult(entry, 50000, 0.01, '');

    expect(decision.reasoning).toContain('LLM unavailable');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Exit consultant fallback LLM failed; using safe default',
      expect.objectContaining({
        failureType: 'schema_validation',
        provider: 'openai',
        model: 'fallback-model',
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: heartbeat wires up exit consultant
// ---------------------------------------------------------------------------

// Module-level mocks for heartbeat integration tests
vi.mock('../../src/memory/position_heartbeat_journal.js', () => ({
  recordPositionHeartbeatDecision: () => {},
}));

vi.mock('../../src/memory/paper_perps.js', () => ({
  placePaperPerpOrder: vi.fn(() => ({
    orderId: 'mock-liq',
    filled: true,
    fillPrice: 100,
    markPrice: 100,
    slippageBps: 0,
    realizedPnlUsd: 0,
    feeUsd: 0,
    message: 'ok',
  })),
  listPaperPerpPositions: vi.fn(() => []),
}));

const mockUpsertPolicyInteg = vi.fn();
const mockClearPolicyInteg = vi.fn();
const mockGetPolicyInteg = vi.fn().mockReturnValue(null);

vi.mock('../../src/memory/position_exit_policy.js', () => ({
  getPositionExitPolicy: (...args: unknown[]) => mockGetPolicyInteg(...args),
  clearPositionExitPolicy: (...args: unknown[]) => mockClearPolicyInteg(...args),
  upsertPositionExitPolicy: (...args: unknown[]) => mockUpsertPolicyInteg(...args),
}));

import { PositionHeartbeatService } from '../../src/core/position_heartbeat.js';
import { Logger } from '../../src/core/logger.js';

describe('PositionHeartbeatService + LlmExitConsultant integration', () => {
  beforeEach(() => {
    mockUpsertPolicyInteg.mockClear();
    mockClearPolicyInteg.mockClear();
    recordExitConsultDecisionMock.mockClear();
  });

  function makeHbConfig() {
    return {
      execution: { mode: 'live', provider: 'hyperliquid' },
      heartbeat: {
        enabled: true,
        tickIntervalSeconds: 1,
        rollingBufferSize: 10,
        triggers: {
          pnlShiftPct: 99,
          liquidationProximityPct: 0.001,
          volatilitySpikePct: 99,
          volatilitySpikeWindowTicks: 100,
          timeCeilingMinutes: 9999,
          triggerCooldownSeconds: 0,
        },
      },
    } as any;
  }

  function makePosition(overrides: Record<string, unknown> = {}) {
    return {
      symbol: 'BTC',
      side: 'long',
      size: 1,
      unrealized_pnl: 0,
      return_on_equity: 5,
      liquidation_price: 10,
      ...overrides,
    };
  }

  /** Build a fake exitConsultant whose shouldConsult always returns true and consult returns a fixed decision */
  function makeStubConsultant(decision: { action: string; reasoning: string; newTimeStopAtMs?: number; newInvalidationPrice?: number; reduceToFraction?: number }) {
    return {
      shouldConsult: vi.fn().mockReturnValue(true),
      consult: vi.fn().mockResolvedValue(decision),
    } as unknown as LlmExitConsultant;
  }

  async function runTick(
    positions: unknown[],
    consultant: LlmExitConsultant,
    bookEntryOverrides: Partial<BookEntry> = {}
  ) {
    const fullEntry: BookEntry = {
      symbol: 'BTC',
      side: 'long',
      size: 1,
      entryPrice: 50000,
      currentMarkPrice: null,
      unrealizedPnlUsd: null,
      entryReasoningText: 'test',
      thesisExpiresAtMs: Date.now() + 60 * 60 * 1000,
      exitContract: null,
      exitContractSummary: null,
      lastConsultAtMs: null,
      lastConsultDecision: null,
      entryAtMs: Date.now() - 30 * 60 * 1000,
      ...bookEntryOverrides,
    };

    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const toolExec = async (toolName: string, toolInput: Record<string, unknown>) => {
      calls.push({ tool: toolName, input: toolInput });
      if (toolName === 'get_positions') return { success: true as const, data: { positions } };
      if (toolName === 'perp_place_order') return { success: true as const, data: { ok: true } };
      if (toolName === 'current_time') return { success: true as const, data: { iso: new Date().toISOString() } };
      if (toolName === 'intel_search') return { success: true as const, data: [{ title: 'fresh intel' }] };
      if (toolName === 'web_search') return { success: true as const, data: [{ title: 'market update' }] };
      if (toolName === 'perp_market_list') return { success: true as const, data: [{ symbol: 'BTC', markPrice: 50000 }] };
      if (toolName === 'signal_hyperliquid_funding_oi_skew') {
        return { success: true as const, data: { symbol: 'BTC', fundingRate: 0.01 } };
      }
      return { success: false as const, error: `unexpected: ${toolName}` };
    };

    const client = { getAllMids: async () => ({ BTC: 50000 }) } as any;
    const service = new PositionHeartbeatService(makeHbConfig(), {} as any, new Logger('error'), {
      client,
      toolExec: toolExec as any,
      exitConsultant: consultant,
      // Inject book lookup directly — bypasses PositionBook singleton
      getBookEntry: (sym: string) => sym === 'BTC' ? fullEntry : undefined,
    });

    service.start();
    await service.tickOnce();
    service.stop();
    return { calls, fullEntry };
  }

  it('upsertPositionExitPolicy called when consultant returns extend_ttl', async () => {
    const newStop = Date.now() + 4 * 60 * 60 * 1000;
    const consultant = makeStubConsultant({ action: 'extend_ttl', reasoning: 'still running', newTimeStopAtMs: newStop });

    const { calls } = await runTick([makePosition()], consultant);

    expect(mockUpsertPolicyInteg).toHaveBeenCalledWith('BTC', 'long', newStop, null, null);
    expect(calls.some(c => c.tool === 'perp_place_order')).toBe(false);
  });

  it('closes when consultant tries to extend beyond tactical TTL cap', async () => {
    const consultant = makeStubConsultant({
      action: 'extend_ttl',
      reasoning: 'keep it alive',
      newTimeStopAtMs: Date.now() + 12 * 60 * 60 * 1000,
    });

    const { calls } = await runTick([makePosition()], consultant, {
      thesisExpiresAtMs: Date.now() + 60 * 60 * 1000,
      exitContract: { thesis: 'BTC breakout', tradeType: 'tactical', hardRules: [], reviewGuidance: [] } as any,
      entryAtMs: Date.now() - 7 * 60 * 60 * 1000,
    });

    expect(mockUpsertPolicyInteg).not.toHaveBeenCalled();
    expect(calls.some((call) => call.tool === 'perp_place_order')).toBe(true);
  });

  it('close order placed when consultant returns close', async () => {
    const consultant = makeStubConsultant({ action: 'close', reasoning: 'thesis invalidated' });

    const { calls } = await runTick([makePosition()], consultant);

    const order = calls.find(c => c.tool === 'perp_place_order');
    expect(order).toBeDefined();
    expect(order?.input.reduce_only).toBe(true);
  });

  it('reduce order placed when consultant returns reduce with fraction 0.5', async () => {
    const consultant = makeStubConsultant({ action: 'reduce', reasoning: 'partial exit', reduceToFraction: 0.5 });

    const { calls } = await runTick([makePosition({ size: 2 })], consultant);

    const order = calls.find(c => c.tool === 'perp_place_order');
    expect(order).toBeDefined();
    // size should be 2 * (1 - 0.5) = 1
    expect(order?.input.size).toBe(1);
  });

  it('rebuilds exit contract notes when consultant updates invalidation', async () => {
    const consultant = makeStubConsultant({
      action: 'update_invalidation',
      reasoning: 'raise the stop',
      newInvalidationPrice: 49500,
    });

    await runTick([makePosition()], consultant, {
      exitContract: { thesis: 'BTC breakout', tradeType: 'tactical', hardRules: [], reviewGuidance: [] } as any,
    });

    expect(mockUpsertPolicyInteg).toHaveBeenCalledWith(
      'BTC',
      'long',
      expect.any(Number),
      49500,
      expect.stringContaining('thesis invalidation')
    );
  });

  it('nothing happens when consultant returns hold', async () => {
    const consultant = makeStubConsultant({ action: 'hold', reasoning: 'all good' });

    const { calls } = await runTick([makePosition()], consultant);

    expect(mockUpsertPolicyInteg).not.toHaveBeenCalled();
    expect(calls.some(c => c.tool === 'perp_place_order')).toBe(false);
    // Verify the consultant was actually consulted (shouldConsult was called)
    expect((consultant.shouldConsult as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((consultant.consult as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('passes gathered market context into consultant calls', async () => {
    const consultant = makeStubConsultant({ action: 'hold', reasoning: 'context checked' });

    await runTick([makePosition()], consultant);

    expect((consultant.consult as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      expect.any(Number),
      expect.stringContaining('perp_market_list')
    );
  });

  it('skips consultant path entirely when heartbeat.llmExitConsult.enabled is false', async () => {
    const consultant = makeStubConsultant({ action: 'close', reasoning: 'should not run' });
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const toolExec = async (toolName: string, toolInput: Record<string, unknown>) => {
      calls.push({ tool: toolName, input: toolInput });
      if (toolName === 'get_positions') return { success: true as const, data: { positions: [makePosition()] } };
      if (toolName === 'perp_place_order') return { success: true as const, data: { ok: true } };
      return { success: false as const, error: `unexpected: ${toolName}` };
    };

    const service = new PositionHeartbeatService({
      ...makeHbConfig(),
      heartbeat: {
        ...makeHbConfig().heartbeat,
        llmExitConsult: { enabled: false },
      },
    } as any, {} as any, new Logger('error'), {
      client: { getAllMids: async () => ({ BTC: 50000 }) } as any,
      toolExec: toolExec as any,
      exitConsultant: consultant,
      getBookEntry: () => ({
        symbol: 'BTC',
        side: 'long',
        size: 1,
        entryPrice: 50000,
        currentMarkPrice: null,
        unrealizedPnlUsd: null,
        entryReasoningText: 'test',
        thesisExpiresAtMs: Date.now() + 60 * 60 * 1000,
        exitContract: null,
        exitContractSummary: null,
        lastConsultAtMs: null,
        lastConsultDecision: null,
      }),
    });

    service.start();
    await service.tickOnce();
    service.stop();

    expect((consultant.shouldConsult as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((consultant.consult as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(calls.some((call) => call.tool === 'perp_place_order')).toBe(false);
  });
});
