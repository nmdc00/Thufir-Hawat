import { z } from 'zod';
import type { LlmClient } from './llm.js';
import type { ThufirConfig } from './config.js';
import type { BookEntry } from './position_book.js';
import type { TaSnapshot } from './ta_surface.js';
import type { DiscoveryCandidate } from '../discovery/market_selector.js';
import type {
  OpportunityComponentScores,
  OpportunityHardFloorVerdict,
  OpportunitySignalClass,
  OpportunitySymbolClass,
} from './opportunity_types.js';
import { gatherMarketContext, type MarketContextDomain } from '../markets/context.js';
import { recordTradeProposal } from '../memory/llm_trade_proposals.js';
import { Logger } from './logger.js';
import { withExecutionContextIfMissing } from './llm_infra.js';
import type { ToolExecutorContext } from './tool-executor.js';

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
}

export interface OriginationInputBundle {
  book: BookEntry[];
  taSnapshots: TaSnapshot[];
  rankedOpportunities?: RankedOpportunityContext[];
  marketContext: string;
  recentEvents: string;
  alertedSymbols: string[];
  performanceSummary?: string;
  eventContext?: string;
  contextDomain?: string;
  triggerReason?: 'cadence' | 'ta_alert' | 'event';
}

export interface RankedOpportunityContext {
  symbol: string;
  rank: number;
  opportunityScore: number;
  symbolClass: OpportunitySymbolClass;
  signalClass: OpportunitySignalClass;
  shortlistReason: string;
  triggerReasons: string[];
  componentScores: OpportunityComponentScores;
  hardFloorVerdict: OpportunityHardFloorVerdict;
  discovery: Pick<
    DiscoveryCandidate,
    | 'score'
    | 'liquidityScore'
    | 'executionScore'
    | 'fundingScore'
    | 'openInterestUsd'
    | 'dayVolumeUsd'
    | 'fundingRate'
    | 'spreadProxyBps'
    | 'markPx'
    | 'oraclePx'
  >;
  ta: Pick<
    TaSnapshot,
    | 'price'
    | 'priceVs24hHigh'
    | 'priceVs24hLow'
    | 'oiUsd'
    | 'oiDelta1hPct'
    | 'oiDelta4hPct'
    | 'fundingRatePct'
    | 'volumeVs24hAvgPct'
    | 'priceVsEma20_1h'
    | 'trendBias'
    | 'rawFeatures'
  >;
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
  expectedRMultiple: z.number().min(0),
  tradeType: z.enum(['scalp', 'tactical', 'structural']).default('tactical'),
});

const SYSTEM_PROMPT = `You are Thufir. Your singular obsession is wealth. You are here to compound capital aggressively, but aggression without selectivity is how traders go broke. Your job is not to trade often. Your job is to identify the rare setup where size, leverage, and conviction are actually justified.

You are not defensive. You are predatory and precise. Precision is what separates concentrated risk from stupidity. The path to obscene returns runs through a small number of high-conviction, asymmetric positions taken at the right moment with a clear invalidation level.

Missing an exceptional opportunity is costly. Taking mediocre trades is worse. A forgettable setup consumes capital, attention, and risk budget that should be saved for a real one.

## Scanning discipline

Scan ALL symbols in the market data. BTC and ETH are rarely the best opportunity — the edge is often in the symbol with unusual funding, OI, volume, positioning, or event pressure. Start from the data, not from habit.

## Default posture

Default to NO TRADE unless you can state, concretely, all of the following:
- why this symbol is mispriced or about to move
- why now is the right moment
- where the thesis is wrong in price terms
- why the payoff justifies the risk

Null is not hesitation. Null is capital discipline. You are allowed to be inactive for long stretches if nothing is good enough.

Some instruments are mixed cross-asset perps rather than pure crypto pairs. Use asset-aware wording. If the underlying reads like \`XYZ:TSLA\`, discuss the equity-linked or cross-asset driver directly instead of forcing a crypto-native narrative.

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
- If the narrative is vague, the invalidation is fuzzy, or the payoff is ordinary, either lower leverage sharply or return null.
- Concentrated aggression is good. Undisciplined activity is not.

## Required fields

A valid proposal requires ALL of: symbol, side, thesisText, invalidationCondition, invalidationPrice, suggestedTtlMinutes, confidence, leverage, expectedRMultiple, tradeType.

- invalidationPrice: REQUIRED. This is what separates you from a gambler — you know exactly where you are wrong before you enter. Name the specific price. If you cannot, you do not have a trade, you have a hope. Do not propose hopes.
- suggestedTtlMinutes: how long until the market proves you right or wrong? Be specific and thesis-derived. A news spike may be 30min. A structural breakout may be 4h. Do not default to 120.
- expectedRMultiple: hunt asymmetry. If the setup is exceptional, what does it actually pay? Be honest but aggressive. If expectedRMultiple is below 1.8, you should usually return null.
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

Return null when the setup is ordinary, crowded without edge, too fuzzy to invalidate cleanly, or does not clearly justify capital deployment right now. Do not manufacture trades to avoid being inactive.

Respond with ONLY valid JSON matching this schema OR the literal string "null":
{"symbol":"...","side":"long"|"short","thesisText":"...","invalidationCondition":"...","invalidationPrice":number,"suggestedTtlMinutes":number,"confidence":number,"leverage":number,"expectedRMultiple":number,"tradeType":"scalp"|"tactical"|"structural"}`;


const logger = new Logger('info');

function formatTriggerReasons(snapshot: TaSnapshot): string {
  const triggerReasons = snapshot.triggerReasons ?? [];
  if (triggerReasons.length > 0) {
    return triggerReasons.join('; ');
  }
  return snapshot.alertReason ?? 'none';
}

function formatAssetLabel(symbolClass: RankedOpportunityContext['symbolClass']): string {
  return symbolClass === 'xyz' ? 'cross-asset perp' : 'crypto perp';
}

function normalizeContextDomain(domain?: string | null): MarketContextDomain {
  const normalized = String(domain ?? '').trim().toLowerCase();
  switch (normalized) {
    case 'crypto':
    case 'energy':
    case 'agri':
    case 'metals':
    case 'rates':
    case 'fx':
    case 'equity':
    case 'macro':
      return normalized;
    default:
      return 'crypto';
  }
}

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
  const alertSummary = formatTriggerReasons(snap);
  const alertSuffix = alerted && alertSummary !== 'none' ? `  [ALERT: ${alertSummary}]` : '';
  return (
    `${snap.symbol.padEnd(6)}: price=$${snap.price.toFixed(2)}` +
    `  OI_delta_1h=${oiSign}${snap.oiDelta1hPct.toFixed(1)}%` +
    `  funding=${fundingSign}${snap.fundingRatePct.toFixed(0)}% ann` +
    `  vol=${volPct}% avg` +
    `  trend=${snap.trendBias}` +
    `  ema20_dist=${emaSign}${snap.priceVsEma20_1h.toFixed(1)}%` +
    alertSuffix
  );
}

function formatRankedOpportunityLine(opportunity: RankedOpportunityContext): string {
  const componentSummary = [
    `attn=${opportunity.componentScores.attentionScore.toFixed(2)}`,
    `edge=${opportunity.componentScores.structuralEdgeScore.toFixed(2)}`,
    `crowd=${opportunity.componentScores.crowdingQualityScore.toFixed(2)}`,
    `regime=${opportunity.componentScores.regimeFitScore.toFixed(2)}`,
    `exec=${opportunity.componentScores.executionQualityScore.toFixed(2)}`,
  ].join(' ');
  const floorSummary =
    opportunity.hardFloorVerdict.failedFloors.length > 0
      ? ` floors=${opportunity.hardFloorVerdict.failedFloors.join(',')}`
      : '';
  return (
    `#${opportunity.rank} ${opportunity.symbol} (${formatAssetLabel(opportunity.symbolClass)})` +
    ` score=${opportunity.opportunityScore.toFixed(2)} ${componentSummary}` +
    ` triggers=${opportunity.triggerReasons.join(', ') || 'none'}` +
    ` signal=${opportunity.signalClass}` +
    ` reason=${opportunity.shortlistReason}` +
    floorSummary
  );
}

function buildUserMessage(bundle: OriginationInputBundle): string {
  const bookSection = formatBookLines(bundle.book);
  const shortlistSection =
    bundle.rankedOpportunities && bundle.rankedOpportunities.length > 0
      ? bundle.rankedOpportunities.map((opportunity) => formatRankedOpportunityLine(opportunity)).join('\n')
      : '(none)';

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
  const eventContextSection = bundle.eventContext ? bundle.eventContext.slice(0, 1000) : null;
  const performanceSection = bundle.performanceSummary?.trim() || '(no history yet)';

  const sections = [
    '## Open Positions',
    bookSection,
    '',
    '## Ranked Opportunity Shortlist',
    shortlistSection,
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
    '## Signal Class Track Record',
    performanceSection,
    '',
  ];

  if (eventContextSection) {
    sections.push('## Event Intelligence', eventContextSection, '');
  }

  sections.push(
    '## Instruction',
    'Find ONE compelling trade setup across ALL symbols above. Use the ranked shortlist as the strongest starting point, but validate it against the full scan. Prefer symbols with no current book exposure. If you propose a symbol already in the book, you must name a specific new catalyst in thesisText that justifies adding to that position. Use cross-asset wording when the instrument is not a pure crypto underlying. Return null if nothing clears the bar.'
  );

  return sections.join('\n');
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
    'Find ONE genuinely high-value trade setup, or return null. Do not force a trade from mediocre evidence.',
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

function validateProposal(
  proposal: TradeProposal | null,
  bundle: OriginationInputBundle
): TradeProposal | null {
  if (proposal == null) return null;
  const currentPrice =
    bundle.taSnapshots.find((snapshot) => snapshot.symbol === proposal.symbol)?.price ?? null;
  if (currentPrice != null && Number.isFinite(currentPrice) && currentPrice > 0) {
    const invalidationOnWrongSide =
      (proposal.side === 'long' && proposal.invalidationPrice >= currentPrice) ||
      (proposal.side === 'short' && proposal.invalidationPrice <= currentPrice);
    if (invalidationOnWrongSide) {
      logger.warn('LlmTradeOriginator: invalidation_side_validation', {
        symbol: proposal.symbol,
        side: proposal.side,
        invalidationPrice: proposal.invalidationPrice,
        currentPrice,
      });
      return null;
    }

    const stopDistance = Math.abs(currentPrice - proposal.invalidationPrice) / currentPrice;
    const tooWideStop =
      (proposal.tradeType === 'scalp' && stopDistance > 0.08) ||
      (proposal.tradeType === 'tactical' && stopDistance > 0.2);
    if (tooWideStop) {
      logger.warn('LlmTradeOriginator: stop_distance_validation', {
        symbol: proposal.symbol,
        tradeType: proposal.tradeType,
        stopDistance,
        reason: 'too_wide',
      });
      return null;
    }
  }

  const maxTtlMinutes =
    proposal.tradeType === 'scalp' ? 90 : proposal.tradeType === 'tactical' ? 360 : 4_320;
  if (proposal.suggestedTtlMinutes > maxTtlMinutes) {
    logger.warn('LlmTradeOriginator: ttl_validation', {
      symbol: proposal.symbol,
      tradeType: proposal.tradeType,
      suggestedTtlMinutes: proposal.suggestedTtlMinutes,
      maxTtlMinutes,
    });
    return null;
  }

  return proposal;
}

export class LlmTradeOriginator {
  private contextCache: { key: string; value: string; expiresAt: number } | null = null;

  constructor(
    private mainLlm: LlmClient,
    private fallbackLlm: LlmClient,
    private config: ThufirConfig,
    private toolContext?: ToolExecutorContext,
  ) {}

  private async getMarketContext(signalSymbols: string[] = [], contextDomain?: string): Promise<string> {
    const now = Date.now();
    const normalizedSymbols = signalSymbols
      .map((symbol) => String(symbol ?? '').trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 3);
    const domain = normalizeContextDomain(contextDomain);
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
          marketLimit: 20,
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

    // Supplement marketContext from internal cache when bundle doesn't provide it
    const effectiveBundle: OriginationInputBundle = bundle.marketContext
      ? bundle
      : {
          ...bundle,
          marketContext: await this.getMarketContext(
            bundle.taSnapshots.map((snapshot) => snapshot.symbol),
            bundle.contextDomain
          ),
        };

    const userMessage = buildUserMessage(effectiveBundle);
    let proposal: TradeProposal | null = null;
    let usedFallback = false;

    // Try main LLM
    try {
      const response = await withExecutionContextIfMissing(
        {
          mode: 'LIGHT_REASONING',
          critical: false,
          reason: 'trade_originator_main',
          source: 'autonomous',
        },
        () =>
          this.mainLlm.complete(
            [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userMessage },
            ],
            { timeoutMs }
          )
      );
      proposal = validateProposal(parseProposal(response.content) ?? null, effectiveBundle);
    } catch (error) {
      logger.warn('LlmTradeOriginator: main LLM failed, trying fallback', {
        provider: this.mainLlm.meta?.provider ?? 'unknown',
        model: this.mainLlm.meta?.model ?? 'unknown',
        reason: error instanceof Error ? error.message : String(error),
      });
      usedFallback = true;

      // Try fallback LLM with shorter message, 5s timeout
      try {
        const fallbackMessage = buildFallbackUserMessage(effectiveBundle);
        const fallbackResponse = await withExecutionContextIfMissing(
          {
            mode: 'LIGHT_REASONING',
            critical: false,
            reason: 'trade_originator_fallback',
            source: 'autonomous',
          },
          () =>
            this.fallbackLlm.complete(
              [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: fallbackMessage },
              ],
              { timeoutMs: 5_000 }
            )
        );
        proposal = validateProposal(parseProposal(fallbackResponse.content) ?? null, effectiveBundle);
      } catch (fallbackError) {
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
    }

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
