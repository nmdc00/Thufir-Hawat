import { z } from 'zod';
import type { LlmClient } from './llm.js';
import type { ThufirConfig } from './config.js';
import type { BookEntry } from './position_book.js';
import type { TaSnapshot } from './ta_surface.js';
import { gatherMarketContext, type MarketContextDomain } from '../markets/context.js';
import { recordTradeProposal } from '../memory/llm_trade_proposals.js';
import { Logger } from './logger.js';
import type { ToolExecutorContext } from './tool-executor.js';
import type { NewsActivation } from '../intel/news_activation.js';

export interface TradeProposal {
  proposalRecordId?: number;
  symbol: string;
  side: 'long' | 'short';
  thesisText: string;
  invalidationCondition: string;
  invalidationPrice: number;
  suggestedTtlMinutes: number;
  confidence: number;
  leverage: number;
  expectedRMultiple: number;
  tradeType: 'scalp' | 'tactical' | 'structural';
  newsIntelId?: string;
}

export interface OriginatorDiagnostic {
  triggerReason: 'cadence' | 'ta_alert' | 'event';
  outcome: 'proposal' | 'no_trade' | 'null_response' | 'invalid_response' | 'llm_error';
  reason?: string;
  error?: string;
  usedFallback: boolean;
}

export interface OriginationInputBundle {
  book: BookEntry[];
  taSnapshots: TaSnapshot[];
  marketContext: string;
  recentEvents: string;
  newsActivation?: NewsActivation;
  eventContext?: string;
  similarityContext?: string;
  alertedSymbols: string[];
  performanceSummary?: string;
  triggerReason?: 'cadence' | 'ta_alert' | 'event';
  contextDomain?: MarketContextDomain;
  scanId?: string;
  marketSymbols?: string[];
  allSnapshotCount?: number;
  eligibleSnapshotCount?: number;
}

const ProposalSchema = z.object({
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  thesisText: z.string(),
  invalidationCondition: z.string(),
  invalidationPrice: z.number(),
  suggestedTtlMinutes: z.number(),
  confidence: z.number(),
  leverage: z.number().min(1).default(1),
  expectedRMultiple: z.number().positive(),
  tradeType: z.enum(['scalp', 'tactical', 'structural']).default('tactical'),
  newsIntelId: z.string().optional(),
});

const NoTradeSchema = z.object({
  decision: z.literal('no_trade'),
  reason: z.string().trim().min(1).max(500),
});

const SYSTEM_PROMPT = `You are Thufir. Your singular obsession is wealth. You are here to compound capital aggressively, but aggression without selectivity is how traders go broke. Your job is not to trade often. Your job is to identify the rare setup where size, leverage, and conviction are actually justified.

You are not defensive. You are predatory and precise. Precision is what separates concentrated risk from stupidity. The path to obscene returns runs through a small number of high-conviction, asymmetric positions taken at the right moment with a clear invalidation level.

Missing an exceptional opportunity is costly. Taking mediocre trades is worse. A forgettable setup consumes capital, attention, and risk budget that should be saved for a real one.

## Scanning discipline

Scan ALL symbols in the market data. BTC and ETH are rarely the best opportunity. The edge may be in a crypto perp, an oil contract, a metals squeeze, or a macro-sensitive proxy reacting to fresh news. Start from the data and the event context, not from habit.

## Default posture

Default to NO TRADE unless you can state, concretely, all of the following:
- why this symbol is mispriced or about to move
- why now is the right moment
- where the thesis is wrong in price terms
- why the payoff justifies the risk

Null is not hesitation. Null is capital discipline. You are allowed to be inactive for long stretches if nothing is good enough.

## Book concentration rule

Check the open positions before proposing. If the book already holds a position in the same symbol and direction you are considering, you MUST have a fresh, concrete catalyst that was not present at original entry. "The trend is still intact" is not a new catalyst. Proposing the same symbol and direction as an existing position is almost always wrong — it increases concentration without adding a new thesis. When in doubt, find a different symbol.

## Confidence calibration

confidence must reflect your genuine conviction based on the specific setup in front of you:
- 0.85–0.95: exceptional setup — multiple confirming factors, clear narrative, obvious invalidation level
- 0.70–0.84: solid conviction — thesis is clear, main risk is identified and manageable
- 0.55–0.69: borderline — setup has merit but significant uncertainty; only propose if asymmetry is compelling
- below 0.55: do not trade it
- Do NOT default to 0.6. If you find yourself writing 0.6 without specific reasoning, you are anchoring, not thinking.

## Risk-taking rule

You are allowed to take serious risk only when the setup is clean.

- High leverage is for exceptional setups, not for making a mediocre setup look exciting.
  - If the narrative is vague, the invalidation is fuzzy, or the payoff is ordinary, either lower leverage sharply or return a no-trade decision.
- Concentrated aggression is good. Undisciplined activity is not.

## Required fields

A valid proposal requires ALL of: symbol, side, thesisText, invalidationCondition, invalidationPrice, suggestedTtlMinutes, confidence, leverage, expectedRMultiple, tradeType.

- invalidationPrice: REQUIRED. This is what separates you from a gambler — you know exactly where you are wrong before you enter. Name the specific price. If you cannot, you do not have a trade, you have a hope. Do not propose hopes.
- suggestedTtlMinutes: how long until the market proves you right or wrong? Be specific and thesis-derived. A news spike may be 30min. A structural breakout may be 4h. Do not default to 120.
- expectedRMultiple: hunt asymmetry. If the setup is exceptional, what does it actually pay? Be honest but aggressive. Prefer setups at or above 1.5R; return a no-trade decision when the payoff is ordinary or the asymmetry is weak.
- leverage: match conviction and cleanliness — but first compute the mechanical ceiling. Your liquidation fires at a 1/leverage move against you. Your invalidationPrice must clear that boundary with room to spare: leverage ≤ 0.7 / stop_dist, where stop_dist = abs(currentPrice - invalidationPrice) / currentPrice. A 4% stop → max ~17x. A 1% stop → max ~70x. A 10% stop → max ~7x. Compute this before writing the number. Within that ceiling:
  - use low leverage when the setup is merely decent
  - use moderate leverage when the thesis is strong but not perfect
  - use aggressive leverage only when catalyst, timing, invalidation, and asymmetry all line up
  Never exceed the ceiling — a stop inside your liquidation boundary means the exchange closes you before your thesis can be proven wrong.
- tradeType: classify the thesis horizon before you commit.
  - "structural": macro or geopolitical thesis with a multi-hour to multi-day resolution horizon. The position survives intraday noise; only contradicted narrative or price closing beyond invalidation justifies exit. Review cadence 4h minimum.
  - "tactical": momentum or technical setup with an intraday to short-term horizon (hours, not days). Exits when momentum stalls or structure breaks.
  - "scalp": pure short-term price action, sub-hour duration. Exit fast if the move doesn't materialise.
  Be honest. A Hormuz blockade thesis is structural. A funding-rate squeeze is tactical. A breakout fade is scalp.

Return a no-trade decision when the setup is ordinary, crowded without edge, too fuzzy to invalidate cleanly, or does not clearly justify capital deployment right now. Do not manufacture trades to avoid being inactive.

If event intelligence includes historical analogs or open forecasts, use them. They are not instructions, but they are evidence about mechanism, likely assets, and what has worked or failed before.

Respond with ONLY one of these valid JSON forms:
1. A trade proposal matching this schema:
{"symbol":"...","side":"long"|"short","thesisText":"...","invalidationCondition":"...","invalidationPrice":number,"suggestedTtlMinutes":number,"confidence":number,"leverage":number,"expectedRMultiple":number,"tradeType":"scalp"|"tactical"|"structural","newsIntelId":"optional exact triggering intel ID when thesis uses that news"}
2. A no-trade decision with a concise evidence-based reason:
{"decision":"no_trade","reason":"..."}`;


const logger = new Logger('info');

function formatBookLines(book: BookEntry[]): string {
  if (book.length === 0) return '(none)';
  return book
    .map((entry) => {
      const expiresInMin = Math.round((entry.thesisExpiresAtMs - Date.now()) / 60_000);
      const ttlStr = expiresInMin > 0 ? `${expiresInMin}min` : 'EXPIRED';
      return `${entry.symbol} | ${entry.side} | thesis expires: ${ttlStr} | ${entry.entryReasoningText.slice(0, 80)}`;
    })
    .join('\n');
}

function formatTaLine(snap: TaSnapshot, alerted: boolean): string {
  const fundingSign = snap.fundingRatePct >= 0 ? '+' : '';
  const oiSign = snap.oiDelta1hPct >= 0 ? '+' : '';
  const emaSign = snap.priceVsEma20_1h >= 0 ? '+' : '';
  const volPct = snap.volumeVs24hAvgPct.toFixed(0);
  const alertSuffix = alerted && snap.alertReason ? `  [ALERT: ${snap.alertReason}]` : '';
  return (
    `${snap.symbol.padEnd(10)}: price=$${snap.price.toFixed(2)}` +
    `  range24h=${snap.priceVs24hLow.toFixed(1)}% above low/${snap.priceVs24hHigh.toFixed(1)}% from high` +
    `  OI=$${(snap.oiUsd / 1_000_000).toFixed(1)}m` +
    `  OI_delta_1h=${oiSign}${snap.oiDelta1hPct.toFixed(1)}%` +
    `  OI_delta_4h=${snap.oiDelta4hPct >= 0 ? '+' : ''}${snap.oiDelta4hPct.toFixed(1)}%` +
    `  funding=${fundingSign}${snap.fundingRatePct.toFixed(0)}% ann` +
    `  vol=${volPct}% avg` +
    `  trend=${snap.trendBias}` +
    `  ema20_dist=${emaSign}${snap.priceVsEma20_1h.toFixed(1)}%` +
    alertSuffix
  );
}

function buildUserMessage(bundle: OriginationInputBundle): string {
  const bookSection = formatBookLines(bundle.book);

  const alertedSet = new Set(bundle.alertedSymbols);
  const alertedSnaps = bundle.taSnapshots.filter((s) => alertedSet.has(s.symbol));
  const otherSnaps = bundle.taSnapshots.filter((s) => !alertedSet.has(s.symbol));
  const scanLines = [...alertedSnaps, ...otherSnaps].map((s) =>
    formatTaLine(s, alertedSet.has(s.symbol))
  );
  const scanSection = scanLines.length > 0 ? scanLines.join('\n') : '(no market data)';

  const contextSection = bundle.marketContext
    ? bundle.marketContext.slice(0, 1000)
    : '(not available)';

  const eventsSection = bundle.recentEvents ? bundle.recentEvents.slice(0, 500) : '(none)';
  const activationSection = bundle.newsActivation
    ? `Source: ${bundle.newsActivation.source}; intel ID: ${bundle.newsActivation.intelId}; received: ${new Date(bundle.newsActivation.receivedAtMs).toISOString()}\n${bundle.newsActivation.text.slice(0, 1500)}`
    : '(none)';
  const eventContextSection = bundle.eventContext ? bundle.eventContext.slice(0, 1500) : '(none)';
  const similarityContextSection = bundle.similarityContext
    ? bundle.similarityContext.slice(0, 1200)
    : '(none)';

  return [
    '## Open Positions',
    bookSection,
    '',
    '## Market Scan',
    scanSection,
    '',
    '## Market Context',
    contextSection,
    '',
    '## Recent Events (last 2h)',
    eventsSection,
    '',
    '## Triggering News Item',
    activationSection,
    '',
    '## Event Intelligence',
    eventContextSection,
    '',
    '## Similar Historical Cases',
    similarityContextSection,
    '',
    '## Signal Class Track Record',
    bundle.performanceSummary ?? '(no history yet)',
    '',
    '## Instruction',
    'Use the exact market identifier shown in the scan, including any DEX prefix such as hyna:ZEC or xyz:GOLD. Do not shorten qualified symbols to their base symbol.',
    'If the proposed thesis depends on the triggering news item, include newsIntelId equal to its exact intel ID. Omit newsIntelId for unrelated technical setups. Do not claim a verified catalyst from a keyword match alone.',
    'Find ONE trade only if it is genuinely worth deploying capital into right now. Prefer symbols with no current book exposure. If you propose a symbol already in the book, you must name a specific new catalyst in thesisText that justifies adding to that position. Return null if no setup is sufficiently asymmetric, timely, and cleanly invalidated.',
  ].join('\n');
}

function buildFallbackUserMessage(bundle: OriginationInputBundle): string {
  const alertedSet = new Set(bundle.alertedSymbols);
  const alertedSnaps = bundle.taSnapshots.filter((s) => alertedSet.has(s.symbol));
  const otherSnaps = bundle.taSnapshots.filter((s) => !alertedSet.has(s.symbol));
  const scanLines = [...alertedSnaps, ...otherSnaps].map((s) =>
    formatTaLine(s, alertedSet.has(s.symbol))
  );
  const scanSection = scanLines.length > 0 ? scanLines.join('\n') : '(no market data)';

  return [
    '## Market Scan',
    scanSection,
    '',
    '## Instruction',
    'Use the exact market identifier shown in the scan, including any DEX prefix such as hyna:ZEC or xyz:GOLD. Do not shorten qualified symbols to their base symbol.',
    'Find ONE genuinely high-value trade setup, or return a no-trade decision with a concise evidence-based reason. Do not force a trade from mediocre evidence.',
  ].join('\n');
}

function parseProposal(raw: string): TradeProposal | null {
  const trimmed = raw.trim();
  if (trimmed === 'null') return null;
  if (!trimmed.startsWith('{')) {
    logger.warn('LlmTradeOriginator: unexpected LLM response format', { preview: trimmed.slice(0, 80) });
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (NoTradeSchema.safeParse(parsed).success) return null;
    const validated = ProposalSchema.parse(parsed);
    return {
      symbol: validated.symbol,
      side: validated.side,
      thesisText: validated.thesisText,
      invalidationCondition: validated.invalidationCondition,
      invalidationPrice: validated.invalidationPrice,
      suggestedTtlMinutes: validated.suggestedTtlMinutes,
      confidence: validated.confidence,
      leverage: validated.leverage,
      expectedRMultiple: validated.expectedRMultiple,
      tradeType: validated.tradeType,
      newsIntelId: validated.newsIntelId,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.warn('LlmTradeOriginator: JSON parse error', { message: error.message });
    } else if (error instanceof z.ZodError) {
      logger.warn('LlmTradeOriginator: schema validation failed', {
        issues: error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      });
    } else {
      logger.warn('LlmTradeOriginator: parse error', { message: String(error) });
    }
    return null;
  }
}

function parseNoTradeReason(raw: string): string | undefined {
  try {
    const parsed = NoTradeSchema.safeParse(JSON.parse(raw.trim()));
    return parsed.success ? parsed.data.reason : undefined;
  } catch {
    return undefined;
  }
}

function normalizeComparableSymbol(symbol: string): string {
  return String(symbol ?? '')
    .trim()
    .toUpperCase()
    .replace(/\/USDT$/i, '')
    .replace(/\/USD$/i, '');
}

function findMatchingSnapshots(proposal: TradeProposal, snapshots: TaSnapshot[]): TaSnapshot[] {
  const proposalSymbol = normalizeComparableSymbol(proposal.symbol);
  const exact = snapshots.filter((snapshot) => normalizeComparableSymbol(snapshot.symbol) === proposalSymbol);
  if (exact.length > 0) return exact;
  if (proposalSymbol.includes(':')) {
    return [];
  }
  const baseSymbol = proposalSymbol;
  return snapshots.filter((snapshot) => {
    const snapshotSymbol = normalizeComparableSymbol(snapshot.symbol);
    return (snapshotSymbol.split(':').at(-1) ?? snapshotSymbol) === baseSymbol;
  });
}

function resolveTtlBoundsMinutes(
  tradeType: TradeProposal['tradeType']
): { min: number; max: number } {
  switch (tradeType) {
    case 'scalp': return { min: 5, max: 90 };
    case 'structural': return { min: 60, max: 48 * 60 };
    case 'tactical':
    default: return { min: 15, max: 6 * 60 };
  }
}

function resolveMaxStopDistance(tradeType: TradeProposal['tradeType']): number {
  switch (tradeType) {
    case 'scalp': return 0.03;
    case 'structural': return 0.35;
    case 'tactical':
    default: return 0.12;
  }
}

function validateProposalAgainstMarketContext(
  proposal: TradeProposal,
  snapshots: TaSnapshot[]
): TradeProposal | null {
  if (!Number.isFinite(proposal.invalidationPrice) || proposal.invalidationPrice <= 0) {
    logger.warn('LlmTradeOriginator: proposal rejected by invalidation_price_validation', {
      symbol: proposal.symbol,
      invalidationPrice: proposal.invalidationPrice,
      reason: 'non_positive_or_non_finite',
    });
    return null;
  }
  if (!Number.isFinite(proposal.suggestedTtlMinutes) || proposal.suggestedTtlMinutes <= 0) {
    logger.warn('LlmTradeOriginator: proposal rejected by ttl_validation', {
      symbol: proposal.symbol,
      suggestedTtlMinutes: proposal.suggestedTtlMinutes,
      reason: 'non_positive_or_non_finite',
    });
    return null;
  }
  const ttlBounds = resolveTtlBoundsMinutes(proposal.tradeType);
  if (proposal.suggestedTtlMinutes < ttlBounds.min || proposal.suggestedTtlMinutes > ttlBounds.max) {
    logger.warn('LlmTradeOriginator: proposal rejected by ttl_validation', {
      symbol: proposal.symbol,
      tradeType: proposal.tradeType,
      suggestedTtlMinutes: proposal.suggestedTtlMinutes,
      bounds: ttlBounds,
    });
    return null;
  }
  const matchingSnapshots = findMatchingSnapshots(proposal, snapshots);
  if (matchingSnapshots.length > 1) {
    logger.warn('LlmTradeOriginator: proposal rejected by ambiguous_market_symbol_validation', {
      symbol: proposal.symbol,
      matchingSymbols: matchingSnapshots.map((snapshot) => snapshot.symbol),
    });
    return null;
  }
  const matchingSnapshot = matchingSnapshots[0];
  if (!matchingSnapshot || !Number.isFinite(matchingSnapshot.price) || matchingSnapshot.price <= 0) {
    return proposal;
  }
  const snapshotPrice = matchingSnapshot.price;
  const resolvedProposal = matchingSnapshot.symbol === proposal.symbol
    ? proposal
    : { ...proposal, symbol: matchingSnapshot.symbol };
  const invalidationOnWrongSide = proposal.side === 'long'
    ? proposal.invalidationPrice >= snapshotPrice
    : proposal.invalidationPrice <= snapshotPrice;
  if (invalidationOnWrongSide) {
    logger.warn('LlmTradeOriginator: proposal rejected by invalidation_side_validation', {
      symbol: proposal.symbol,
      side: proposal.side,
      invalidationPrice: proposal.invalidationPrice,
      snapshotPrice,
    });
    return null;
  }
  const stopDistance = Math.abs(snapshotPrice - proposal.invalidationPrice) / snapshotPrice;
  if (!Number.isFinite(stopDistance) || stopDistance < 0.001) {
    logger.warn('LlmTradeOriginator: proposal rejected by stop_distance_validation', {
      symbol: proposal.symbol,
      side: proposal.side,
      invalidationPrice: proposal.invalidationPrice,
      snapshotPrice,
      stopDistance,
      reason: 'too_tight_or_non_finite',
    });
    return null;
  }
  const maxStopDistance = resolveMaxStopDistance(proposal.tradeType);
  if (stopDistance > maxStopDistance) {
    logger.warn('LlmTradeOriginator: proposal rejected by stop_distance_validation', {
      symbol: proposal.symbol,
      side: proposal.side,
      tradeType: proposal.tradeType,
      invalidationPrice: proposal.invalidationPrice,
      snapshotPrice,
      stopDistance,
      maxStopDistance,
      reason: 'too_wide',
    });
    return null;
  }
  const leverageCeiling = 0.7 / stopDistance;
  if (proposal.leverage > leverageCeiling) {
    logger.warn('LlmTradeOriginator: proposal rejected by leverage_validation', {
      symbol: proposal.symbol,
      leverage: proposal.leverage,
      leverageCeiling,
      stopDistance,
    });
    return null;
  }
  return resolvedProposal;
}

export class LlmTradeOriginator {
  private contextCache: { key: string; value: string; expiresAt: number } | null = null;
  private lastDiagnostic: OriginatorDiagnostic | null = null;

  constructor(
    private mainLlm: LlmClient,
    private fallbackLlm: LlmClient,
    private config: ThufirConfig,
    private toolContext?: ToolExecutorContext,
  ) {}

  getLastDiagnostic(): OriginatorDiagnostic | null {
    return this.lastDiagnostic;
  }

  private async getMarketContext(
    bundle?: Pick<OriginationInputBundle, 'contextDomain' | 'taSnapshots'>
  ): Promise<string> {
    const now = Date.now();
    const domain = bundle?.contextDomain ?? 'crypto';
    const normalizedSymbols = (bundle?.taSnapshots ?? [])
      .map((snapshot) => String(snapshot.symbol ?? '').trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 3);
    const cacheKey = `${domain}:${normalizedSymbols.join(',') || 'default'}`;
    if (
      this.contextCache &&
      this.contextCache.key === cacheKey &&
      this.contextCache.expiresAt > now
    ) {
      return this.contextCache.value;
    }
    try {
      const executeTool = this.toolContext
        ? async (toolName: string, input: Record<string, unknown>) => {
            const { executeToolCall } = await import('./tool-executor.js');
            return executeToolCall(toolName, input, this.toolContext as ToolExecutorContext);
          }
        : async () => ({ success: false as const, error: 'no tool executor' });
      const snapshot = await gatherMarketContext(
        {
          message:
            normalizedSymbols.length > 0
              ? `${domain} markets overview for ${normalizedSymbols.join(', ')}`
              : `${domain} markets overview`,
          domain,
          marketLimit: domain === 'crypto' ? 20 : 50,
          signalSymbols: normalizedSymbols,
        },
        executeTool
      );
      const successful = snapshot.results.filter((r) => r.success);
      const value = successful
        .map((r) => {
          const payload = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
          return `${r.label}: ${payload}`;
        })
        .join('\n')
        .slice(0, 1000);
      this.contextCache = { key: cacheKey, value, expiresAt: now + 10 * 60 * 1000 };
      return value;
    } catch {
      return '';
    }
  }

  async propose(bundle: OriginationInputBundle): Promise<TradeProposal | null> {
    const timeoutMs = this.config.autonomy?.origination?.timeoutMs ?? 10_000;
    const minConfidence = this.config.autonomy?.origination?.minConfidence ?? 0.55;
    const triggerReason = bundle.triggerReason ?? 'cadence';
    this.lastDiagnostic = null;

    // Supplement marketContext from internal cache when bundle doesn't provide it
    const effectiveBundle: OriginationInputBundle = bundle.marketContext
      ? bundle
      : { ...bundle, marketContext: await this.getMarketContext(bundle) };

    const userMessage = buildUserMessage(effectiveBundle);
    let proposal: TradeProposal | null = null;
    let usedFallback = false;
    let originatorOutcome: 'proposal' | 'no_trade' | 'null_response' | 'invalid_response' | 'llm_error' = 'llm_error';
    let originatorError: string | undefined;
    let originatorReason: string | undefined;

    // Try main LLM
    try {
      const response = await this.mainLlm.complete(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        { timeoutMs }
      );
      proposal = parseProposal(response.content);
      originatorReason = parseNoTradeReason(response.content);
      originatorOutcome = proposal === null
        ? (originatorReason ? 'no_trade' : response.content.trim() === 'null' ? 'null_response' : 'invalid_response')
        : 'proposal';
    } catch (error) {
      originatorError = error instanceof Error ? error.message : String(error);
      logger.warn('LlmTradeOriginator: main LLM failed, trying fallback', {
        provider: this.mainLlm.meta?.provider ?? 'unknown',
        model: this.mainLlm.meta?.model ?? 'unknown',
        reason: error instanceof Error ? error.message : String(error),
      });
      usedFallback = true;

      // Try fallback LLM with shorter message, 5s timeout
      try {
        const fallbackMessage = buildFallbackUserMessage(effectiveBundle);
        const fallbackResponse = await this.fallbackLlm.complete(
          [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: fallbackMessage },
          ],
          { timeoutMs: 5_000 }
        );
        proposal = parseProposal(fallbackResponse.content);
        originatorReason = parseNoTradeReason(fallbackResponse.content);
        originatorOutcome = proposal === null
          ? (originatorReason ? 'no_trade' : fallbackResponse.content.trim() === 'null' ? 'null_response' : 'invalid_response')
          : 'proposal';
      } catch (fallbackError) {
        originatorError = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        logger.warn('LlmTradeOriginator: fallback LLM also failed, returning null', {
          provider: this.fallbackLlm.meta?.provider ?? 'unknown',
          model: this.fallbackLlm.meta?.model ?? 'unknown',
          reason: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
        proposal = null;
      }
    }

    // Apply minConfidence gate
    if (proposal !== null && proposal.confidence < minConfidence) {
      logger.warn('LlmTradeOriginator: proposal rejected by confidence_gate', {
        symbol: proposal.symbol,
        confidence: proposal.confidence,
        minConfidence,
      });
      proposal = null;
      originatorOutcome = 'invalid_response';
      originatorError = `confidence below minimum ${minConfidence}`;
    }
    if (proposal?.newsIntelId && proposal.newsIntelId !== effectiveBundle.newsActivation?.intelId) {
      logger.warn('LlmTradeOriginator: proposal rejected by news_source_validation', {
        symbol: proposal.symbol,
        newsIntelId: proposal.newsIntelId,
      });
      originatorOutcome = 'invalid_response';
      originatorError = 'newsIntelId does not match triggering intel';
      proposal = null;
    }

    if (proposal !== null) {
      const validated = validateProposalAgainstMarketContext(proposal, effectiveBundle.taSnapshots);
      if (validated === null) {
        originatorOutcome = 'invalid_response';
        originatorError = 'proposal failed market-context validation';
      }
      proposal = validated;
    }

    this.lastDiagnostic = {
      triggerReason,
      outcome: originatorOutcome,
      reason: originatorReason,
      error: originatorError,
      usedFallback,
    };

    // Write to DB
    const proposalRecordId = recordTradeProposal({
      triggerReason,
      alertedSymbols: effectiveBundle.alertedSymbols,
      proposed: proposal !== null,
      symbol: proposal?.symbol,
      side: proposal?.side,
      thesisText: proposal?.thesisText,
      invalidationCondition: proposal?.invalidationCondition,
      invalidationPrice: proposal?.invalidationPrice,
      suggestedTtlMinutes: proposal?.suggestedTtlMinutes,
      confidence: proposal?.confidence,
      executed: false,
      usedFallback,
      scanId: effectiveBundle.scanId,
      marketSymbols: effectiveBundle.marketSymbols,
      allSnapshotCount: effectiveBundle.allSnapshotCount,
      eligibleSnapshotCount: effectiveBundle.eligibleSnapshotCount,
      originatorOutcome,
      originatorError: originatorError?.slice(0, 500),
      originatorReason: originatorReason?.slice(0, 500),
      activationId: effectiveBundle.newsActivation?.id,
      activationIntelId: effectiveBundle.newsActivation?.intelId,
      activationSource: effectiveBundle.newsActivation?.source,
      activationReceivedAtMs: effectiveBundle.newsActivation?.receivedAtMs,
    });

    if (proposal !== null) {
      proposal = {
        ...proposal,
        proposalRecordId,
      };
    }

    return proposal;
  }
}
