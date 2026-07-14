/**
 * LlmTradeOriginator null-rate discipline tests (v1.98, Task 5).
 *
 * Validates that the default-no-trade bias holds:
 * - 10 consecutive null responses → all results are null
 * - Null response even with 3 open book positions
 * - Proposal accepted only when confidence >= minConfidence
 * - Proposal rejected when confidence < minConfidence
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRecordTradeProposal = vi.fn().mockReturnValue(1);

vi.mock('../../src/memory/llm_trade_proposals.js', () => ({
  recordTradeProposal: (...args: unknown[]) => mockRecordTradeProposal(...args),
}));

vi.mock('../../src/core/logger.js', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../src/markets/context.js', () => ({
  gatherMarketContext: vi.fn().mockResolvedValue({
    domain: 'crypto',
    primarySource: 'perp_market_list',
    sources: [],
    results: [],
  }),
  classifyMarketContextDomain: vi.fn().mockReturnValue('crypto'),
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

import { LlmTradeOriginator } from '../../src/core/llm_trade_originator.js';
import type { OriginationInputBundle } from '../../src/core/llm_trade_originator.js';
import type { LlmClient } from '../../src/core/llm.js';
import type { BookEntry } from '../../src/core/position_book.js';
import type { TaSnapshot } from '../../src/core/ta_surface.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLlmClient(response: string): LlmClient {
  return {
    complete: vi.fn().mockResolvedValue({ content: response, model: 'test-model' }),
  } as unknown as LlmClient;
}

function makeSnapshot(symbol: string): TaSnapshot {
  return {
    symbol,
    price: 100,
    priceVs24hHigh: 0,
    priceVs24hLow: 0,
    oiUsd: 1_000_000,
    oiDelta1hPct: 0,
    oiDelta4hPct: 0,
    fundingRatePct: 0,
    volumeVs24hAvgPct: 0,
    priceVsEma20_1h: 0,
    trendBias: 'flat',
  };
}

function makeBookEntry(symbol: string, side: 'long' | 'short'): BookEntry {
  return {
    symbol,
    side,
    size: 1,
    entryPrice: 100,
    currentMarkPrice: null,
    unrealizedPnlUsd: null,
    entryReasoningText: 'test entry',
    thesisExpiresAtMs: Date.now() + 60 * 60 * 1000,
    exitContract: null,
    exitContractSummary: null,
    lastConsultAtMs: null,
    lastConsultDecision: null,
    entryAtMs: Date.now(),
  };
}

function makeBundle(overrides?: Partial<OriginationInputBundle>): OriginationInputBundle {
  return {
    book: [],
    taSnapshots: [makeSnapshot('BTC'), makeSnapshot('ETH')],
    marketContext: 'Generic market context',
    recentEvents: 'No notable events',
    alertedSymbols: [],
    triggerReason: 'cadence',
    ...overrides,
  };
}

const dummyConfig = {} as any;
const configWithThreshold = {
  autonomy: { origination: { minConfidence: 0.55, timeoutMs: 10000 } },
} as any;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LlmTradeOriginator null-rate discipline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null in all 10 calls when LLM consistently returns "null"', async () => {
    const originator = new LlmTradeOriginator(
      makeLlmClient('null'),
      makeLlmClient('null'),
      dummyConfig
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, () => originator.propose(makeBundle()))
    );

    expect(results).toHaveLength(10);
    expect(results.every((r) => r === null)).toBe(true);
    // DB write should be called 10 times with proposed=false
    expect(mockRecordTradeProposal).toHaveBeenCalledTimes(10);
    for (const call of mockRecordTradeProposal.mock.calls) {
      expect(call[0].proposed).toBe(false);
    }
  });

  it('returns null when book has 3 open positions and LLM returns null', async () => {
    const busyBook: BookEntry[] = [
      makeBookEntry('BTC', 'long'),
      makeBookEntry('ETH', 'short'),
      makeBookEntry('SOL', 'long'),
    ];

    const originator = new LlmTradeOriginator(
      makeLlmClient('null'),
      makeLlmClient('null'),
      dummyConfig
    );

    const result = await originator.propose(makeBundle({ book: busyBook }));
    expect(result).toBeNull();
  });

  it('accepts proposal when confidence >= minConfidence threshold', async () => {
    const proposalAtThreshold = JSON.stringify({
      symbol: 'BTC',
      side: 'long',
      thesisText: 'Momentum confirmed with volume breakout',
      invalidationCondition: 'Closes below $95',
      invalidationPrice: 95,
      suggestedTtlMinutes: 120,
      confidence: 0.55,   // exactly at threshold
      leverage: 3,
      expectedRMultiple: 2.5,
    });

    const originator = new LlmTradeOriginator(
      makeLlmClient(proposalAtThreshold),
      makeLlmClient('null'),
      configWithThreshold
    );

    const result = await originator.propose(makeBundle());
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.55);
    expect(result!.symbol).toBe('BTC');

    // DB write with proposed=true
    expect(mockRecordTradeProposal).toHaveBeenCalledOnce();
    expect(mockRecordTradeProposal.mock.calls[0][0].proposed).toBe(true);
  });

  it('rejects proposal when confidence < minConfidence threshold', async () => {
    const proposalBelowThreshold = JSON.stringify({
      symbol: 'ETH',
      side: 'short',
      thesisText: 'Weak bearish signal',
      invalidationCondition: 'Break above $3,000',
      invalidationPrice: 3000,
      suggestedTtlMinutes: 60,
      confidence: 0.49,   // below 0.55
      leverage: 2,
      expectedRMultiple: 1.5,
    });

    const originator = new LlmTradeOriginator(
      makeLlmClient(proposalBelowThreshold),
      makeLlmClient('null'),
      configWithThreshold
    );

    const result = await originator.propose(makeBundle());
    expect(result).toBeNull();

    // DB write with proposed=false (confidence gate caused rejection)
    expect(mockRecordTradeProposal).toHaveBeenCalledOnce();
    expect(mockRecordTradeProposal.mock.calls[0][0].proposed).toBe(false);
  });
});
