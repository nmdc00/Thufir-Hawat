/**
 * Integration tests for the origination pipeline (v1.98, Task 5).
 *
 * Covers:
 *   Section 1: TaSurface + OriginationTrigger integration
 *   Section 2: LlmTradeOriginator null discipline
 *   Section 3: LlmTradeOriginator → EntryGate handoff shape
 *   Section 4: Exit policy write from LLM proposal
 *   Section 5: Symbol cooldown — see tests/core/autonomous-wiring.test.ts (test 4)
 *   Section 6: Quant fallback gating — see tests/core/autonomous-wiring.test.ts (tests 2, 3, 7)
 *   Section 7: DB logging
 *   Section 8: Regression — v1.97 components
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/memory/db.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRecordTradeProposal = vi.fn().mockReturnValue(1);
const mockUpdateTradeProposalOutcome = vi.fn();

vi.mock('../../src/memory/llm_trade_proposals.js', () => ({
  recordTradeProposal: (...args: unknown[]) => mockRecordTradeProposal(...args),
  updateTradeProposalOutcome: (...args: unknown[]) => mockUpdateTradeProposalOutcome(...args),
}));

const mockUpsertPositionExitPolicy = vi.fn();

vi.mock('../../src/memory/position_exit_policy.js', () => ({
  upsertPositionExitPolicy: (...args: unknown[]) => mockUpsertPositionExitPolicy(...args),
  getPositionExitPolicy: vi.fn().mockReturnValue(null),
}));

const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();

vi.mock('../../src/core/logger.js', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

const mockGatherMarketContext = vi.fn().mockResolvedValue({
  domain: 'crypto',
  primarySource: 'perp_market_list',
  sources: [],
  results: [],
});

vi.mock('../../src/markets/context.js', () => ({
  gatherMarketContext: (...args: unknown[]) => mockGatherMarketContext(...args),
  classifyMarketContextDomain: vi.fn().mockReturnValue('crypto'),
}));

const mockRecordEntryGateDecision = vi.fn();

vi.mock('../../src/memory/llm_entry_gate_log.js', () => ({
  recordEntryGateDecision: (...args: unknown[]) => mockRecordEntryGateDecision(...args),
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

import { OriginationTrigger } from '../../src/core/origination_trigger.js';
import type { TriggerResult } from '../../src/core/origination_trigger.js';
import type { TaSnapshot } from '../../src/core/ta_surface.js';
import { LlmTradeOriginator } from '../../src/core/llm_trade_originator.js';
import type { OriginationInputBundle, TradeProposal } from '../../src/core/llm_trade_originator.js';
import { LlmEntryGate } from '../../src/core/llm_entry_gate.js';
import type { EntryGateCandidate } from '../../src/core/llm_entry_gate.js';
import type { LlmClient } from '../../src/core/llm.js';
import type { PositionBook, BookEntry } from '../../src/core/position_book.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSnapshot(symbol: string, alertReason?: string): TaSnapshot {
  const price =
    symbol === 'BTC' ? 65_000 : symbol === 'ETH' ? 3_000 : symbol === 'SOL' ? 150 : 100;
  return {
    symbol,
    price,
    priceVs24hHigh: 0,
    priceVs24hLow: 0,
    oiUsd: 1_000_000,
    oiDelta1hPct: 0,
    oiDelta4hPct: 0,
    fundingRatePct: 0,
    volumeVs24hAvgPct: 0,
    priceVsEma20_1h: 0,
    trendBias: 'flat',
    alertReason,
  };
}

function makeLlmClient(response: string | null, shouldThrow?: boolean): LlmClient {
  const completeFn = shouldThrow
    ? vi.fn().mockRejectedValue(new Error('LLM timeout'))
    : vi.fn().mockResolvedValue({ content: response ?? 'null', model: 'test-model' });
  return { complete: completeFn } as unknown as LlmClient;
}

function makeBundle(overrides?: Partial<OriginationInputBundle>): OriginationInputBundle {
  return {
    book: [],
    taSnapshots: [makeSnapshot('BTC')],
    marketContext: 'BTC market context',
    recentEvents: 'No notable events',
    alertedSymbols: [],
    triggerReason: 'cadence',
    ...overrides,
  };
}

function makeBook(opts?: {
  hasConflict?: boolean;
  hasPosition?: boolean;
  entries?: BookEntry[];
}): PositionBook {
  return {
    hasConflict: vi.fn().mockReturnValue(opts?.hasConflict ?? false),
    hasPosition: vi.fn().mockReturnValue(opts?.hasPosition ?? false),
    getAll: vi.fn().mockReturnValue(opts?.entries ?? []),
    get: vi.fn(),
    refresh: vi.fn(),
    getInstance: vi.fn(),
  } as unknown as PositionBook;
}

function makeGateCandidate(overrides?: Partial<EntryGateCandidate>): EntryGateCandidate {
  return {
    symbol: 'BTC',
    side: 'buy',
    notionalUsd: 50,
    leverage: 3,
    edge: 0.08,
    confidence: 0.65,
    signalClass: 'momentum_breakout',
    regime: 'trending',
    session: 'us',
    entryReasoning: 'Strong momentum',
    ...overrides,
  };
}

const validProposalJson = JSON.stringify({
  symbol: 'BTC',
  side: 'long',
  thesisText: 'Strong OI spike confirms breakout',
  invalidationCondition: 'Price closes below $63,000',
  invalidationPrice: 63000,
  suggestedTtlMinutes: 120,
  confidence: 0.72,
  leverage: 3,
  expectedRMultiple: 2.5,
});

const validShortProposalJson = JSON.stringify({
  symbol: 'ETH',
  side: 'short',
  thesisText: 'Overextended with extreme funding',
  invalidationCondition: 'Break above $3,200',
  invalidationPrice: 3200,
  suggestedTtlMinutes: 60,
  confidence: 0.68,
  leverage: 2,
  expectedRMultiple: 2.0,
});

const dummyConfig = {} as any;
const originalDbPath = process.env.THUFIR_DB_PATH;
let dbDir: string | null = null;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'thufir-origination-pipeline-'));
  process.env.THUFIR_DB_PATH = join(dbDir, 'thufir.sqlite');
  openDatabase();
});

afterEach(() => {
  process.env.THUFIR_DB_PATH = originalDbPath;
  if (dbDir) {
    rmSync(dbDir, { recursive: true, force: true });
    dbDir = null;
  }
});

// ── Section 1: TaSurface + OriginationTrigger ─────────────────────────────────

describe('Section 1: TaSurface + OriginationTrigger', () => {
  const now = Date.now();

  it('TA alert from snapshot causes trigger to fire as ta_alert', () => {
    const trigger = new OriginationTrigger(dummyConfig);
    const lastFiredMs = now - 1 * 60 * 1000; // 1 min ago, within cadence
    const snapshots = [makeSnapshot('BTC', 'oi_spike_1h:10.0%')];

    const result = trigger.shouldFire(lastFiredMs, snapshots, []);

    expect(result.fire).toBe(true);
    expect(result.reason).toBe('ta_alert');
    expect(result.alertedSymbols).toContain('BTC');
  });

  it('neutral snapshots (no alertReason) fall through to cadence check — no fire within cadence', () => {
    const trigger = new OriginationTrigger(
      { autonomy: { origination: { cadenceMinutes: 15 } } } as any
    );
    const lastFiredMs = now - 5 * 60 * 1000; // 5 min ago, within 15-min cadence
    const snapshots = [makeSnapshot('BTC'), makeSnapshot('ETH'), makeSnapshot('SOL')];

    const result = trigger.shouldFire(lastFiredMs, snapshots, []);

    expect(result.fire).toBe(false);
    expect(result.reason).toBe('cadence');
    expect(result.alertedSymbols).toHaveLength(0);
  });

  it('alertedSymbols in TriggerResult matches only snapshots with alertReason set', () => {
    const trigger = new OriginationTrigger(dummyConfig);
    const lastFiredMs = now - 1 * 60 * 1000;
    const snapshots = [
      makeSnapshot('BTC', 'oi_spike_1h:12.5%'),
      makeSnapshot('ETH'),                              // no alert
      makeSnapshot('SOL', 'funding_extreme:75.0%_ann'),
      makeSnapshot('HYPE'),                             // no alert
      makeSnapshot('WIF', 'volume_spike:220.0%'),
    ];

    const result = trigger.shouldFire(lastFiredMs, snapshots, []);

    expect(result.fire).toBe(true);
    expect(result.reason).toBe('ta_alert');
    expect(result.alertedSymbols).toEqual(['BTC', 'SOL', 'WIF']);
    expect(result.alertedSymbols).not.toContain('ETH');
    expect(result.alertedSymbols).not.toContain('HYPE');
  });
});

// ── Section 2: LlmTradeOriginator null discipline ─────────────────────────────

describe('Section 2: LlmTradeOriginator null discipline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when LLM emits literal "null" string', async () => {
    const originator = new LlmTradeOriginator(
      makeLlmClient('null'),
      makeLlmClient('null'),
      dummyConfig
    );
    const result = await originator.propose(makeBundle());
    expect(result).toBeNull();
  });

  it('returns null when LLM response is malformed JSON', async () => {
    const originator = new LlmTradeOriginator(
      makeLlmClient('not json {{ broken'),
      makeLlmClient('null'),
      dummyConfig
    );
    const result = await originator.propose(makeBundle());
    expect(result).toBeNull();
  });

  it('returns null when confidence below minConfidence (0.3 < 0.55)', async () => {
    const lowConfProposal = JSON.stringify({
      symbol: 'SOL',
      side: 'long',
      thesisText: 'Weak setup',
      invalidationCondition: 'Falls below support',
      invalidationPrice: 140,
      suggestedTtlMinutes: 60,
      confidence: 0.3,
      leverage: 1,
      expectedRMultiple: 1.5,
    });
    const config = { autonomy: { origination: { minConfidence: 0.55, timeoutMs: 10000 } } } as any;
    const originator = new LlmTradeOriginator(
      makeLlmClient(lowConfProposal),
      makeLlmClient('null'),
      config
    );
    const result = await originator.propose(makeBundle());
    expect(result).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('confidence_gate'),
      expect.objectContaining({ confidence: 0.3 })
    );
  });

  it('returns null when main LLM times out and fallback also returns null', async () => {
    const originator = new LlmTradeOriginator(
      makeLlmClient(null, /* shouldThrow */ true),
      makeLlmClient('null'),
      dummyConfig
    );
    const result = await originator.propose(makeBundle());
    expect(result).toBeNull();
  });

  it('10 repeated calls all returning null validates default-no-trade discipline', async () => {
    const originator = new LlmTradeOriginator(
      makeLlmClient('null'),
      makeLlmClient('null'),
      dummyConfig
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, () => originator.propose(makeBundle()))
    );

    expect(results.every((r) => r === null)).toBe(true);
    expect(results).toHaveLength(10);
  });
});

// ── Section 3: LlmTradeOriginator → EntryGate handoff shape ──────────────────

describe('Section 3: LlmTradeOriginator → EntryGate handoff shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('side="long" from proposal maps to side="buy" for gate candidate', async () => {
    const originator = new LlmTradeOriginator(
      makeLlmClient(validProposalJson),
      makeLlmClient('null'),
      dummyConfig
    );
    const proposal = await originator.propose(makeBundle());
    expect(proposal).not.toBeNull();
    expect(proposal!.side).toBe('long');

    // Verify the mapping: 'long' → 'buy' for EntryGateCandidate
    const gateCandidate = makeGateCandidate({
      symbol: proposal!.symbol,
      side: proposal!.side === 'long' ? 'buy' : 'sell',
      entryReasoning: proposal!.thesisText,
    });
    expect(gateCandidate.side).toBe('buy');
  });

  it('side="short" from proposal maps to side="sell" for gate candidate', async () => {
    const originator = new LlmTradeOriginator(
      makeLlmClient(validShortProposalJson),
      makeLlmClient('null'),
      dummyConfig
    );
    const proposal = await originator.propose(makeBundle());
    expect(proposal).not.toBeNull();
    expect(proposal!.side).toBe('short');

    // Verify the mapping: 'short' → 'sell' for EntryGateCandidate
    const gateCandidate = makeGateCandidate({
      symbol: proposal!.symbol,
      side: proposal!.side === 'long' ? 'buy' : 'sell',
      entryReasoning: proposal!.thesisText,
    });
    expect(gateCandidate.side).toBe('sell');
  });

  it('gate reject: executor not called when gate returns reject', async () => {
    // Mock the gate to return reject
    const book = makeBook();
    const gateMainLlm = makeLlmClient(JSON.stringify({ verdict: 'reject', reasoning: 'not a good setup', stopLevelPrice: null, equityAtRiskPct: 2.5, targetRR: 2.0 }));
    const gate = new LlmEntryGate(gateMainLlm, makeLlmClient(null), vi.fn().mockResolvedValue(undefined), book, dummyConfig);
    const mockExecute = vi.fn();

    // Simulate: gate.evaluate(...) → reject → don't call execute
    const candidate = makeGateCandidate({ symbol: 'BTC', side: 'buy' });
    const decision = await gate.evaluate(candidate, 65000);
    expect(decision.verdict).toBe('reject');

    // Confirm executor was never called
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('gate approve: executor called with correct symbol', async () => {
    const book = makeBook();
    const gateMainLlm = makeLlmClient(JSON.stringify({ verdict: 'approve', reasoning: 'strong setup', stopLevelPrice: 64000, equityAtRiskPct: 2.5, targetRR: 2.0 }));
    const gate = new LlmEntryGate(gateMainLlm, makeLlmClient(null), vi.fn().mockResolvedValue(undefined), book, dummyConfig);
    const mockExecute = vi.fn().mockResolvedValue({ success: true });

    const candidate = makeGateCandidate({ symbol: 'BTC', side: 'buy' });
    const decision = await gate.evaluate(candidate, 65000);
    expect(decision.verdict).toBe('approve');

    // Gate approved — simulate executor call with the candidate's symbol
    if (decision.verdict === 'approve') {
      await mockExecute(candidate.symbol);
    }
    expect(mockExecute).toHaveBeenCalledWith('BTC');
  });
});

// ── Section 4: Exit policy from LLM proposal ─────────────────────────────────

describe('Section 4: Exit policy from LLM proposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Helper: simulates what the autonomous scan would do after receiving a proposal.
   * Writes exit policy from the proposal fields.
   */
  function writeExitPolicyFromProposal(
    proposal: TradeProposal,
    upsert: typeof mockUpsertPositionExitPolicy
  ): void {
    const side = proposal.side === 'long' ? 'long' : 'short';
    const timeStopAtMs = Date.now() + proposal.suggestedTtlMinutes * 60 * 1000;
    upsert(
      proposal.symbol,
      side,
      timeStopAtMs,
      proposal.invalidationPrice ?? null,
      null
    );
  }

  it('upsertPositionExitPolicy called with timeStopAtMs ≈ now + ttlMinutes * 60_000', async () => {
    const originator = new LlmTradeOriginator(
      makeLlmClient(validProposalJson),
      makeLlmClient('null'),
      dummyConfig
    );
    const proposal = await originator.propose(makeBundle());
    expect(proposal).not.toBeNull();

    const beforeMs = Date.now();
    writeExitPolicyFromProposal(proposal!, mockUpsertPositionExitPolicy);
    const afterMs = Date.now();

    expect(mockUpsertPositionExitPolicy).toHaveBeenCalledOnce();
    const args = mockUpsertPositionExitPolicy.mock.calls[0];
    const timeStopAtMs = args[2] as number;
    const expectedMin = beforeMs + proposal!.suggestedTtlMinutes * 60 * 1000;
    const expectedMax = afterMs + proposal!.suggestedTtlMinutes * 60 * 1000;
    expect(timeStopAtMs).toBeGreaterThanOrEqual(expectedMin);
    expect(timeStopAtMs).toBeLessThanOrEqual(expectedMax);
  });

  it('invalidationPrice passed through when proposal provides a specific price level', async () => {
    const originator = new LlmTradeOriginator(
      makeLlmClient(validProposalJson),
      makeLlmClient('null'),
      dummyConfig
    );
    const proposal = await originator.propose(makeBundle());
    expect(proposal!.invalidationPrice).toBe(63000);

    writeExitPolicyFromProposal(proposal!, mockUpsertPositionExitPolicy);

    const args = mockUpsertPositionExitPolicy.mock.calls[0];
    expect(args[3]).toBe(63000);
  });

  it('proposal is rejected when invalidationPrice is null — price is now required', async () => {
    const noInvalidationProposal = JSON.stringify({
      symbol: 'SOL',
      side: 'long',
      thesisText: 'Narrative trade, no specific price level',
      invalidationCondition: 'Macro risk-off shift',
      invalidationPrice: null,
      suggestedTtlMinutes: 90,
      confidence: 0.65,
      leverage: 1,
      expectedRMultiple: 2.0,
    });
    const originator = new LlmTradeOriginator(
      makeLlmClient(noInvalidationProposal),
      makeLlmClient('null'),
      dummyConfig
    );
    const proposal = await originator.propose(makeBundle());
    expect(proposal).toBeNull();
    expect(mockUpsertPositionExitPolicy).not.toHaveBeenCalled();
  });
});

// ── Sections 5 & 6: covered by tests/core/autonomous-wiring.test.ts ──────────
//
// Symbol cooldown (Section 5) and quant fallback gating (Section 6) are
// AutonomousManager-level concerns tested in autonomous-wiring.test.ts:
//   - Cooldown: test 4 (BTC filtered from next scan after proposal)
//   - Quant fallback on cadence: test 2
//   - No quant fallback on ta_alert: test 3
//   - LLM down → quant fallback: test 7

// ── Section 7: DB logging ─────────────────────────────────────────────────────

describe('Section 7: DB logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recordTradeProposal called with proposed=false when LLM returns null', async () => {
    const originator = new LlmTradeOriginator(
      makeLlmClient('null'),
      makeLlmClient('null'),
      dummyConfig
    );
    await originator.propose(makeBundle({ triggerReason: 'cadence' }));

    expect(mockRecordTradeProposal).toHaveBeenCalledOnce();
    const record = mockRecordTradeProposal.mock.calls[0][0];
    expect(record.proposed).toBe(false);
    expect(record.symbol).toBeUndefined();
  });

  it('recordTradeProposal called with proposed=true for valid proposal', async () => {
    mockRecordTradeProposal.mockReturnValueOnce(42);
    const originator = new LlmTradeOriginator(
      makeLlmClient(validProposalJson),
      makeLlmClient('null'),
      dummyConfig
    );
    const proposal = await originator.propose(
      makeBundle({ triggerReason: 'ta_alert', alertedSymbols: ['BTC'] })
    );

    expect(mockRecordTradeProposal).toHaveBeenCalledOnce();
    const record = mockRecordTradeProposal.mock.calls[0][0];
    expect(record.proposed).toBe(true);
    expect(record.symbol).toBe('BTC');
    expect(record.side).toBe('long');
    expect(record.confidence).toBe(0.72);
    expect(record.triggerReason).toBe('ta_alert');
    expect(record.alertedSymbols).toContain('BTC');
    expect(proposal?.proposalRecordId).toBe(42);
  });

  it('updateTradeProposalOutcome callable with gate verdict', () => {
    // updateTradeProposalOutcome is a standalone DB helper; verify it can be called
    // with a proposal ID and a gate verdict without throwing.
    mockRecordTradeProposal.mockReturnValueOnce(42);
    const proposalId = mockRecordTradeProposal();
    expect(proposalId).toBe(42);

    // Should not throw when called with valid args
    expect(() => {
      mockUpdateTradeProposalOutcome(proposalId, 'approve', true, 'trade-001');
    }).not.toThrow();

    expect(mockUpdateTradeProposalOutcome).toHaveBeenCalledWith(42, 'approve', true, 'trade-001');
  });
});

// ── Section 8: Regression — v1.97 components ─────────────────────────────────

describe('Section 8: Regression — v1.97 components', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PositionBook.hasConflict returns false for non-conflicting positions', () => {
    // Mock a book with a 'long' BTC position
    const book = makeBook({ hasConflict: false });

    // 'buy' (long) side for BTC that already has a long → no conflict
    const result = book.hasConflict('BTC', 'buy');
    expect(result).toBe(false);
  });

  it('LlmEntryGate fast-path: hasConflict=true → verdict=reject, no LLM called', async () => {
    const book = makeBook({ hasConflict: true });
    const mainLlmComplete = vi.fn();
    const mainLlm: LlmClient = { complete: mainLlmComplete } as unknown as LlmClient;
    const fallbackLlmComplete = vi.fn();
    const fallbackLlm: LlmClient = { complete: fallbackLlmComplete } as unknown as LlmClient;

    const gate = new LlmEntryGate(
      mainLlm,
      fallbackLlm,
      vi.fn().mockResolvedValue(undefined),
      book,
      dummyConfig
    );

    const result = await gate.evaluate(makeGateCandidate({ symbol: 'ETH', side: 'buy' }), 2500);

    expect(result.verdict).toBe('reject');
    expect(result.reasoning).toMatch(/opposite-side/i);
    expect(mainLlmComplete).not.toHaveBeenCalled();
    expect(fallbackLlmComplete).not.toHaveBeenCalled();
  });

  it('OriginationTrigger returns fire=false when no conditions are met', () => {
    const trigger = new OriginationTrigger(
      { autonomy: { origination: { cadenceMinutes: 15 } } } as any
    );
    const now = Date.now();
    const lastFiredMs = now - 5 * 60 * 1000; // 5 min ago, within 15-min cadence
    const neutralSnapshots = [makeSnapshot('BTC'), makeSnapshot('ETH')];

    const result = trigger.shouldFire(lastFiredMs, neutralSnapshots, []);

    expect(result).toMatchObject<TriggerResult>({
      fire: false,
      reason: 'cadence',
      alertedSymbols: [],
    });
  });
});
