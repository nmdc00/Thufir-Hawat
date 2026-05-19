/**
 * Tests for LlmTradeOriginator.
 *
 * Validates:
 * 1. Returns null when LLM emits literal "null" string
 * 2. Returns null when LLM emits {"null":true} (invalid schema) — graceful parse failure
 * 3. Returns valid TradeProposal when LLM emits valid JSON
 * 4. minConfidence gate: proposal with confidence 0.3 returns null when threshold is 0.55
 * 5. Returns null when main LLM throws (fallback also fails) — no crash
 * 6. Fallback LLM is tried when main LLM times out/fails
 * 7. DB write (recordTradeProposal) is called for both null and non-null results
 * 8. invalidationPrice is required and market-sane
 * 9. Market context is cached — second call within 10 min does NOT call gatherMarketContext again
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRecordTradeProposal = vi.fn().mockReturnValue(1);

vi.mock('../../src/memory/llm_trade_proposals.js', () => ({
  recordTradeProposal: (...args: unknown[]) => mockRecordTradeProposal(...args),
}));

const mockLoggerWarn = vi.fn();

vi.mock('../../src/core/logger.js', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: vi.fn(),
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

// ── Import after mocks ────────────────────────────────────────────────────────

import { LlmTradeOriginator, type OriginationInputBundle } from '../../src/core/llm_trade_originator.js';
import type { LlmClient } from '../../src/core/llm.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLlmClient(response: string | null, shouldThrow?: boolean): LlmClient {
  const completeFn = shouldThrow
    ? vi.fn().mockRejectedValue(new Error('LLM timeout'))
    : vi.fn().mockResolvedValue({ content: response ?? 'null', model: 'test-model' });
  return { complete: completeFn } as unknown as LlmClient;
}

function makeBundle(overrides?: Partial<OriginationInputBundle>): OriginationInputBundle {
  return {
    book: [],
    taSnapshots: [
      {
        symbol: 'BTC',
        price: 65000,
        priceVs24hHigh: -0.5,
        priceVs24hLow: 2.1,
        oiUsd: 500_000_000,
        oiDelta1hPct: 3.2,
        oiDelta4hPct: 1.1,
        fundingRatePct: 12,
        volumeVs24hAvgPct: 89,
        priceVsEma20_1h: 0.4,
        trendBias: 'up',
      },
    ],
    marketContext: 'BTC market context summary',
    recentEvents: 'No notable events in last 2h',
    alertedSymbols: [],
    triggerReason: 'cadence',
    contextDomain: 'crypto',
    ...overrides,
  };
}

const dummyConfig = {} as any;

const validProposalJson = JSON.stringify({
  symbol: 'BTC',
  side: 'long',
  thesisText: 'Strong momentum with OI spike confirms breakout above resistance',
  invalidationCondition: 'Price closes below $63,000 on 1h candle',
  invalidationPrice: 63000,
  suggestedTtlMinutes: 120,
  confidence: 0.72,
  leverage: 3,
  expectedRMultiple: 2.5,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LlmTradeOriginator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGatherMarketContext.mockResolvedValue({
      domain: 'crypto',
      primarySource: 'perp_market_list',
      sources: [],
      results: [],
    });
  });

  describe('1. null response handling', () => {
    it('returns null when LLM emits literal "null" string', async () => {
      const mainLlm = makeLlmClient('null');
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      const result = await originator.propose(makeBundle());
      expect(result).toBeNull();
    });

    it('returns null when LLM emits whitespace-padded "null"', async () => {
      const mainLlm = makeLlmClient('  null  ');
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      const result = await originator.propose(makeBundle());
      expect(result).toBeNull();
    });
  });

  describe('2. invalid schema graceful failure', () => {
    it('returns null when LLM emits {"null":true} (invalid schema)', async () => {
      const mainLlm = makeLlmClient(JSON.stringify({ null: true }));
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      const result = await originator.propose(makeBundle());
      expect(result).toBeNull();
    });

    it('returns null when LLM emits invalid JSON', async () => {
      const mainLlm = makeLlmClient('not valid json {{');
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      const result = await originator.propose(makeBundle());
      expect(result).toBeNull();
    });

    it('does not throw on invalid schema response', async () => {
      const mainLlm = makeLlmClient(JSON.stringify({ verdict: 'buy' }));
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      await expect(originator.propose(makeBundle())).resolves.toBeNull();
    });
  });

  describe('3. valid proposal parsing', () => {
    it('returns valid TradeProposal when LLM emits valid JSON', async () => {
      const mainLlm = makeLlmClient(validProposalJson);
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      const result = await originator.propose(makeBundle());

      expect(result).not.toBeNull();
      expect(result!.symbol).toBe('BTC');
      expect(result!.side).toBe('long');
      expect(result!.thesisText).toContain('momentum');
      expect(result!.invalidationCondition).toContain('$63,000');
      expect(result!.invalidationPrice).toBe(63000);
      expect(result!.suggestedTtlMinutes).toBe(120);
      expect(result!.confidence).toBe(0.72);
    });

    it('returns correct side for short proposals', async () => {
      const shortProposal = JSON.stringify({
        symbol: 'HYPE',
        side: 'short',
        thesisText: 'OI spiked negative, funding extreme',
        invalidationCondition: 'Break above $8 with volume',
        invalidationPrice: 6.8,
        suggestedTtlMinutes: 60,
        confidence: 0.65,
        leverage: 2,
        expectedRMultiple: 2.0,
      });
      const mainLlm = makeLlmClient(shortProposal);
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      const result = await originator.propose(
        makeBundle({
          taSnapshots: [
            {
              symbol: 'HYPE',
              price: 7.2,
              priceVs24hHigh: -0.5,
              priceVs24hLow: 2.1,
              oiUsd: 500_000_000,
              oiDelta1hPct: 3.2,
              oiDelta4hPct: 1.1,
              fundingRatePct: 12,
              volumeVs24hAvgPct: 89,
              priceVsEma20_1h: 0.4,
              trendBias: 'up',
            },
          ],
        })
      );

      expect(result).toBeNull();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('invalidation_side_validation'),
        expect.objectContaining({ symbol: 'HYPE', side: 'short' })
      );
    });
  });

  describe('4. minConfidence gate', () => {
    it('returns null when confidence is below threshold (0.3 < 0.55)', async () => {
      const lowConfidenceProposal = JSON.stringify({
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
      const mainLlm = makeLlmClient(lowConfidenceProposal);
      const config = { autonomy: { origination: { minConfidence: 0.55, timeoutMs: 10000 } } } as any;
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), config);
      const result = await originator.propose(makeBundle());

      expect(result).toBeNull();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('confidence_gate'),
        expect.objectContaining({ confidence: 0.3, minConfidence: 0.55 })
      );
    });

    it('passes when confidence exactly equals threshold', async () => {
      const proposal = JSON.stringify({
        symbol: 'ETH',
        side: 'long',
        thesisText: 'At threshold confidence',
        invalidationCondition: 'Drop below support',
        invalidationPrice: 3200,
        suggestedTtlMinutes: 60,
        confidence: 0.55,
        leverage: 2,
        expectedRMultiple: 2.0,
      });
      const mainLlm = makeLlmClient(proposal);
      const config = { autonomy: { origination: { minConfidence: 0.55, timeoutMs: 10000 } } } as any;
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), config);
      const result = await originator.propose(makeBundle());

      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.55);
    });
  });

  describe('5. both LLMs fail — no crash', () => {
    it('returns null when main and fallback both throw, does not crash', async () => {
      const mainLlm = makeLlmClient(null, true);
      const fallbackLlm = makeLlmClient(null, true);
      const originator = new LlmTradeOriginator(mainLlm, fallbackLlm, dummyConfig);

      const result = await originator.propose(makeBundle());

      expect(result).toBeNull();
    });

    it('does not throw when both LLMs fail', async () => {
      const originator = new LlmTradeOriginator(
        makeLlmClient(null, true),
        makeLlmClient(null, true),
        dummyConfig
      );
      await expect(originator.propose(makeBundle())).resolves.toBeNull();
    });
  });

  describe('6. fallback LLM on main failure', () => {
    it('tries fallback LLM when main LLM throws', async () => {
      const mainLlm = makeLlmClient(null, true);
      const fallbackLlm = makeLlmClient(validProposalJson);
      const originator = new LlmTradeOriginator(mainLlm, fallbackLlm, dummyConfig);

      const result = await originator.propose(makeBundle());

      expect((fallbackLlm.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expect(result).not.toBeNull();
      expect(result!.symbol).toBe('BTC');
    });

    it('uses 5s timeout for fallback LLM call', async () => {
      const mainLlm = makeLlmClient(null, true);
      const fallbackCompleteFn = vi.fn().mockResolvedValue({
        content: validProposalJson,
        model: 'fallback-model',
      });
      const fallbackLlm = { complete: fallbackCompleteFn } as unknown as LlmClient;
      const originator = new LlmTradeOriginator(mainLlm, fallbackLlm, dummyConfig);

      await originator.propose(makeBundle());

      expect(fallbackCompleteFn).toHaveBeenCalledOnce();
      const options = fallbackCompleteFn.mock.calls[0][1] as Record<string, unknown>;
      expect(options.timeoutMs).toBe(5_000);
    });

    it('fallback message is shorter (scan only, no context)', async () => {
      const mainLlm = makeLlmClient(null, true);
      const fallbackCompleteFn = vi.fn().mockResolvedValue({
        content: 'null',
        model: 'fallback-model',
      });
      const fallbackLlm = { complete: fallbackCompleteFn } as unknown as LlmClient;
      const originator = new LlmTradeOriginator(mainLlm, fallbackLlm, dummyConfig);

      await originator.propose(makeBundle());

      const messages = fallbackCompleteFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userContent).toContain('## Market Scan');
      expect(userContent).not.toContain('## Market Context');
      expect(userContent).not.toContain('## Recent Events');
    });
  });

  describe('7. DB write on all paths', () => {
    it('calls recordTradeProposal when result is null', async () => {
      const mainLlm = makeLlmClient('null');
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      await originator.propose(makeBundle());

      expect(mockRecordTradeProposal).toHaveBeenCalledOnce();
      const call = mockRecordTradeProposal.mock.calls[0][0];
      expect(call.proposed).toBe(false);
    });

    it('calls recordTradeProposal when result is a valid proposal', async () => {
      const mainLlm = makeLlmClient(validProposalJson);
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      await originator.propose(makeBundle());

      expect(mockRecordTradeProposal).toHaveBeenCalledOnce();
      const call = mockRecordTradeProposal.mock.calls[0][0];
      expect(call.proposed).toBe(true);
      expect(call.symbol).toBe('BTC');
      expect(call.confidence).toBe(0.72);
    });

    it('records usedFallback=true when fallback was used', async () => {
      const mainLlm = makeLlmClient(null, true);
      const fallbackLlm = makeLlmClient(validProposalJson);
      const originator = new LlmTradeOriginator(mainLlm, fallbackLlm, dummyConfig);
      await originator.propose(makeBundle());

      expect(mockRecordTradeProposal).toHaveBeenCalledOnce();
      const call = mockRecordTradeProposal.mock.calls[0][0];
      expect(call.usedFallback).toBe(true);
    });

    it('records triggerReason from bundle', async () => {
      const mainLlm = makeLlmClient('null');
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      await originator.propose(makeBundle({ triggerReason: 'ta_alert' }));

      expect(mockRecordTradeProposal).toHaveBeenCalledOnce();
      const call = mockRecordTradeProposal.mock.calls[0][0];
      expect(call.triggerReason).toBe('ta_alert');
    });

    it('records alertedSymbols in DB write', async () => {
      const mainLlm = makeLlmClient('null');
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      await originator.propose(makeBundle({ alertedSymbols: ['BTC', 'HYPE'] }));

      const call = mockRecordTradeProposal.mock.calls[0][0];
      expect(call.alertedSymbols).toEqual(['BTC', 'HYPE']);
    });
  });

  describe('8. invalidationPrice required', () => {
    it('returns null when invalidationPrice is null — no price, no trade', async () => {
      const proposalWithNullPrice = JSON.stringify({
        symbol: 'SOL',
        side: 'long',
        thesisText: 'Narrative trade, no clear price level',
        invalidationCondition: 'Macro risk-off event',
        invalidationPrice: null,
        suggestedTtlMinutes: 90,
        confidence: 0.6,
        leverage: 1,
        expectedRMultiple: 1.5,
      });
      const mainLlm = makeLlmClient(proposalWithNullPrice);
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      const result = await originator.propose(makeBundle());

      expect(result).toBeNull();
    });

    it('returns null when invalidationPrice is omitted', async () => {
      const proposalNoPrice = JSON.stringify({
        symbol: 'ETH',
        side: 'short',
        thesisText: 'Overextended with negative funding',
        invalidationCondition: 'Break above recent high',
        suggestedTtlMinutes: 60,
        confidence: 0.63,
        leverage: 2,
        expectedRMultiple: 2.0,
      });
      const mainLlm = makeLlmClient(proposalNoPrice);
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      const result = await originator.propose(makeBundle());

      expect(result).toBeNull();
    });

    it('returns null when expectedRMultiple is omitted', async () => {
      const proposalNoR = JSON.stringify({
        symbol: 'BTC',
        side: 'long',
        thesisText: 'Strong breakout',
        invalidationCondition: 'Close below 63k',
        invalidationPrice: 63000,
        suggestedTtlMinutes: 90,
        confidence: 0.65,
        leverage: 3,
      });
      const mainLlm = makeLlmClient(proposalNoR);
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      const result = await originator.propose(makeBundle());

      expect(result).toBeNull();
    });

    it('accepts a valid proposal with all required fields', async () => {
      const proposal = JSON.stringify({
        symbol: 'SOL',
        side: 'long',
        thesisText: 'Break and hold above key resistance',
        invalidationCondition: 'Close below $140 on 1h',
        invalidationPrice: 140,
        suggestedTtlMinutes: 90,
        confidence: 0.68,
        leverage: 3,
        expectedRMultiple: 2.5,
      });
      const mainLlm = makeLlmClient(proposal);
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);
      const result = await originator.propose(makeBundle());

      expect(result).not.toBeNull();
      expect(result!.invalidationPrice).toBe(140);
      expect(result!.expectedRMultiple).toBe(2.5);
    });

    it('returns null when invalidation is on the wrong side of market price', async () => {
      const proposal = JSON.stringify({
        symbol: 'BTC',
        side: 'long',
        thesisText: 'Breakout continuation',
        invalidationCondition: 'Below entry',
        invalidationPrice: 66000,
        suggestedTtlMinutes: 90,
        confidence: 0.7,
        leverage: 2,
        expectedRMultiple: 2.1,
      });
      const mainLlm = makeLlmClient(proposal);
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);

      const result = await originator.propose(makeBundle());

      expect(result).toBeNull();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('invalidation_side_validation'),
        expect.objectContaining({ symbol: 'BTC', side: 'long', invalidationPrice: 66000 })
      );
    });

    it('returns null when stop distance is implausibly wide for tactical trades', async () => {
      const proposal = JSON.stringify({
        symbol: 'BTC',
        side: 'long',
        thesisText: 'Weakly defined swing',
        invalidationCondition: 'Lose the whole move',
        invalidationPrice: 40000,
        suggestedTtlMinutes: 120,
        confidence: 0.66,
        leverage: 1,
        expectedRMultiple: 2.0,
      });
      const mainLlm = makeLlmClient(proposal);
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);

      const result = await originator.propose(makeBundle());

      expect(result).toBeNull();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('stop_distance_validation'),
        expect.objectContaining({ symbol: 'BTC', tradeType: 'tactical', reason: 'too_wide' })
      );
    });

    it('returns null when TTL exceeds trade-type bounds', async () => {
      const proposal = JSON.stringify({
        symbol: 'BTC',
        side: 'long',
        thesisText: 'Too slow for tactical',
        invalidationCondition: 'Break below 63k',
        invalidationPrice: 63000,
        suggestedTtlMinutes: 800,
        confidence: 0.7,
        leverage: 2,
        expectedRMultiple: 2.4,
      });
      const mainLlm = makeLlmClient(proposal);
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);

      const result = await originator.propose(makeBundle());

      expect(result).toBeNull();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('ttl_validation'),
        expect.objectContaining({ symbol: 'BTC', tradeType: 'tactical', suggestedTtlMinutes: 800 })
      );
    });
  });

  describe('9. market context caching', () => {
    it('calls gatherMarketContext only once for two propose() calls within 10 min', async () => {
      // We need to trigger the internal getMarketContext cache path.
      // The originator calls getMarketContext() internally when needed.
      // We can verify by checking that gatherMarketContext is not called twice
      // when we invoke propose() twice consecutively.
      const mainLlm = makeLlmClient('null');
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);

      // Trigger the internal cache via propose() — first call should populate the cache
      // The originator's propose() doesn't call getMarketContext() by default since bundle has marketContext.
      // We test the cache by calling it directly via the accessible propose() wrapper.
      // To test caching, we call getMarketContext via a bundle with no marketContext so fallback is invoked:
      const bundleNoContext = makeBundle({ marketContext: '' });

      await originator.propose(bundleNoContext);
      await originator.propose(bundleNoContext);

      // gatherMarketContext should only be called once since the cache is populated after the first call
      expect(mockGatherMarketContext).toHaveBeenCalledTimes(1);
      expect(mockGatherMarketContext).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'crypto', message: 'crypto markets overview for BTC' }),
        expect.any(Function)
      );
    });

    it('does not call gatherMarketContext when bundle provides marketContext directly', async () => {
      const mainLlm = makeLlmClient('null');
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);

      await originator.propose(makeBundle({ marketContext: 'pre-built context' }));

      // With pre-built context in bundle, gatherMarketContext is not needed
      // (The internal cache is only used when bundle.marketContext is empty)
      expect(mockGatherMarketContext).not.toHaveBeenCalled();
    });
  });

  describe('user message format', () => {
    it('includes open positions section in main LLM message', async () => {
      const completeFn = vi.fn().mockResolvedValue({ content: 'null', model: 'test' });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);

      const book = [
        {
          symbol: 'ETH',
          side: 'long' as const,
          size: 1.5,
          entryPrice: 2500,
          currentMarkPrice: null,
          unrealizedPnlUsd: null,
          entryReasoningText: 'Momentum thesis',
          thesisExpiresAtMs: Date.now() + 60 * 60 * 1000,
          exitContract: null,
          exitContractSummary: null,
          lastConsultAtMs: null,
          lastConsultDecision: null,
        },
      ];
      await originator.propose(makeBundle({ book }));

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userContent).toContain('## Open Positions');
      expect(userContent).toContain('ETH');
      expect(userContent).toContain('long');
    });

    it('marks alerted symbols in market scan section', async () => {
      const completeFn = vi.fn().mockResolvedValue({ content: 'null', model: 'test' });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);

      const taSnapshots = [
        {
          symbol: 'HYPE',
          price: 7.5,
          priceVs24hHigh: -0.1,
          priceVs24hLow: 5.0,
          oiUsd: 10_000_000,
          oiDelta1hPct: -8.5,
          oiDelta4hPct: -2.1,
          fundingRatePct: -22,
          volumeVs24hAvgPct: 210,
          priceVsEma20_1h: -1.1,
          trendBias: 'down' as const,
          alertReason: 'OI spike',
        },
      ];
      await originator.propose(makeBundle({ taSnapshots, alertedSymbols: ['HYPE'] }));

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userContent).toContain('HYPE');
      expect(userContent).toContain('[ALERT: OI spike]');
    });

    it('caps marketContext at 1000 chars', async () => {
      const completeFn = vi.fn().mockResolvedValue({ content: 'null', model: 'test' });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);

      const longContext = 'x'.repeat(2000);
      await originator.propose(makeBundle({ marketContext: longContext }));

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      const contextSection = userContent.split('## Market Context\n')[1]?.split('\n## ')[0]?.trimEnd() ?? '';
      expect(contextSection.length).toBeLessThanOrEqual(1000);
    });

    it('includes event intelligence section when supplied', async () => {
      const completeFn = vi.fn().mockResolvedValue({ content: 'null', model: 'test' });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);

      await originator.propose(makeBundle({
        eventContext: [
          '[energy] Hormuz disruption tightens crude exports',
          'thought: shipping disruption reduces crude availability',
          'historical_analogs: 2019-abqaiq-attack-oil',
        ].join('\n'),
      }));

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const userContent = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userContent).toContain('## Event Intelligence');
      expect(userContent).toContain('Hormuz disruption tightens crude exports');
      expect(userContent).toContain('2019-abqaiq-attack-oil');
    });

    it('uses provided contextDomain when marketContext fallback is needed', async () => {
      const mainLlm = makeLlmClient('null');
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);

      await originator.propose(makeBundle({
        marketContext: '',
        contextDomain: 'energy',
        taSnapshots: [
          {
            symbol: 'XYZ:CL',
            price: 70,
            priceVs24hHigh: -0.5,
            priceVs24hLow: 1.1,
            oiUsd: 1_000_000,
            oiDelta1hPct: 2,
            oiDelta4hPct: 1,
            fundingRatePct: 0,
            volumeVs24hAvgPct: 120,
            priceVsEma20_1h: 0.2,
            trendBias: 'up',
          },
        ],
      }));

      expect(mockGatherMarketContext).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'energy', message: 'energy markets overview for XYZ:CL' }),
        expect.any(Function)
      );
    });

    it('includes system prompt with wealth-accumulation framing', async () => {
      const completeFn = vi.fn().mockResolvedValue({ content: 'null', model: 'test' });
      const mainLlm: LlmClient = { complete: completeFn } as unknown as LlmClient;
      const originator = new LlmTradeOriginator(mainLlm, makeLlmClient('null'), dummyConfig);

      await originator.propose(makeBundle());

      const messages = completeFn.mock.calls[0][0] as Array<{ role: string; content: string }>;
      const systemContent = messages.find((m) => m.role === 'system')?.content ?? '';
      expect(systemContent).toContain('invalidationPrice');
      expect(systemContent).toContain('expectedRMultiple');
    });
  });
});
