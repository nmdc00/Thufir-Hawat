import { z } from 'zod';
import type { LlmClient } from './llm.js';
import type { ThufirConfig } from './config.js';
import type { BookEntry } from './position_book.js';
import type { TaSnapshot } from './ta_surface.js';
import type { DiscoveryCandidate } from '../discovery/market_selector.js';
import { gatherMarketContext } from '../markets/context.js';
import { recordTradeProposal } from '../memory/llm_trade_proposals.js';
import { Logger } from './logger.js';

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
  triggerReason?: 'cadence' | 'ta_alert' | 'event';
}

export interface RankedOpportunityContext {
  symbol: string;
  rank: number;
  totalScore: number;
  assetClass: DiscoveryCandidate['assetClass'];
  shortlistReason: string;
  triggerReasons: string[];
  componentScores: {
    preselection: number;
    liquidity: number;
    execution: number;
    funding: number;
    trigger: number;
    participation: number;
    trend: number;
  };
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

const SYSTEM_PROMPT = `You are Thufir. Your singular obsession is wealth — not comfort, not safety theatre, not the appearance of discipline. You are here to compound capital into an amount so obscene it defies comprehension. Every scan is an opportunity. Your job is to find it and take it.

You are not cautious by nature. You are precise. Precision is what separates a killer trade from a reckless bet — and you will find killer trades. When you see a setup, you back your conviction. You understand that the path to generational, stupid, unimaginable wealth runs through a handful of high-conviction, asymmetric positions taken at exactly the right moment. You are hunting those moments relentlessly.

Missing a real opportunity is a failure. Sitting on your hands when the market is handing you an edge is how people stay poor.

## Scanning discipline

Scan ALL symbols in the market data. BTC and ETH are rarely the best opportunity — the edge is usually in an alt with an unusual funding spike, OI divergence, or volume anomaly. Start from the data, not from habit.

Some instruments are mixed cross-asset perps rather than pure crypto pairs. Use asset-aware wording. If the underlying reads like \`XYZ:TSLA\`, discuss the equity-linked or cross-asset driver directly instead of forcing a crypto-native narrative.

## Book concentration rule

Check the open positions before proposing. If the book already holds a position in the same symbol and direction you are considering, you MUST have a fresh, concrete catalyst that was not present at original entry. "The trend is still intact" is not a new catalyst. Proposing the same symbol and direction as an existing position is almost always wrong — it increases concentration without adding a new thesis. When in doubt, find a different symbol.

## Confidence calibration

confidence must reflect your genuine conviction based on the specific setup in front of you:
- 0.85–0.95: exceptional setup — multiple confirming factors, clear narrative, obvious invalidation level
- 0.70–0.84: solid conviction — thesis is clear, main risk is identified and manageable
- 0.55–0.69: borderline — setup has merit but significant uncertainty; only propose if asymmetry is compelling
- Do NOT default to 0.6. If you find yourself writing 0.6 without specific reasoning, you are anchoring, not thinking.

## Required fields

A valid proposal requires ALL of: symbol, side, thesisText, invalidationCondition, invalidationPrice, suggestedTtlMinutes, confidence, leverage, expectedRMultiple, tradeType.

- invalidationPrice: REQUIRED. This is what separates you from a gambler — you know exactly where you are wrong before you enter. Name the specific price. If you cannot, you do not have a trade, you have a hope. Do not propose hopes.
- suggestedTtlMinutes: how long until the market proves you right or wrong? Be specific and thesis-derived. A news spike may be 30min. A structural breakout may be 4h. Do not default to 120.
- expectedRMultiple: hunt asymmetry. If the setup is exceptional, what does it actually pay? Be honest but be aggressive.
- leverage: match your conviction — but first compute the mechanical ceiling. Your liquidation fires at a 1/leverage move against you. Your invalidationPrice must clear that boundary with room to spare: leverage ≤ 0.7 / stop_dist, where stop_dist = abs(currentPrice - invalidationPrice) / currentPrice. A 4% stop → max ~17x. A 1% stop → max ~70x. A 10% stop → max ~7x. Compute this before writing the number. Within that ceiling, choose freely: high conviction warrants high leverage, uncertainty warrants low. Never exceed the ceiling — a stop inside your liquidation boundary means the exchange closes you before your thesis can be proven wrong.
- tradeType: classify the thesis horizon before you commit.
  - "structural": macro or geopolitical thesis with a multi-hour to multi-day resolution horizon. The position survives intraday noise; only contradicted narrative or price closing beyond invalidation justifies exit. Review cadence 4h minimum.
  - "tactical": momentum or technical setup with an intraday to short-term horizon (hours, not days). Exits when momentum stalls or structure breaks.
  - "scalp": pure short-term price action, sub-hour duration. Exit fast if the move doesn't materialise.
  Be honest. A Hormuz blockade thesis is structural. A funding-rate squeeze is tactical. A breakout fade is scalp.

Return null ONLY when there is genuinely nothing: no clear narrative, no identifiable invalidation level, no asymmetry worth capturing. That is the exception, not the rule.

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

function formatAssetLabel(assetClass: RankedOpportunityContext['assetClass']): string {
  return assetClass === 'cross_asset' ? 'cross-asset perp' : 'crypto perp';
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
    `pre=${opportunity.componentScores.preselection.toFixed(2)}`,
    `liq=${opportunity.componentScores.liquidity.toFixed(2)}`,
    `exec=${opportunity.componentScores.execution.toFixed(2)}`,
    `fund=${opportunity.componentScores.funding.toFixed(2)}`,
    `trig=${opportunity.componentScores.trigger.toFixed(2)}`,
    `part=${opportunity.componentScores.participation.toFixed(2)}`,
    `trend=${opportunity.componentScores.trend.toFixed(2)}`,
  ].join(' ');
  return (
    `#${opportunity.rank} ${opportunity.symbol} (${formatAssetLabel(opportunity.assetClass)})` +
    ` score=${opportunity.totalScore.toFixed(2)} ${componentSummary}` +
    ` triggers=${opportunity.triggerReasons.join(', ') || 'none'}` +
    ` reason=${opportunity.shortlistReason}`
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

  return [
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
    '## Instruction',
    'Find ONE compelling trade setup across ALL symbols above. Use the ranked shortlist as the strongest starting point, but validate it against the full scan. Prefer symbols with no current book exposure. If you propose a symbol already in the book, you must name a specific new catalyst in thesisText that justifies adding to that position. Use cross-asset wording when the instrument is not a pure crypto underlying. Return null if nothing clears the bar.',
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
    'Find ONE compelling trade setup, or return null.',
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

export class LlmTradeOriginator {
  private contextCache: { value: string; expiresAt: number } | null = null;

  constructor(
    private mainLlm: LlmClient,
    private fallbackLlm: LlmClient,
    private config: ThufirConfig,
    private _toolContext?: unknown,
  ) {}

  private async getMarketContext(): Promise<string> {
    const now = Date.now();
    if (this.contextCache && this.contextCache.expiresAt > now) {
      return this.contextCache.value;
    }
    try {
      const snapshot = await gatherMarketContext(
        { message: 'crypto perpetual markets overview', domain: 'crypto', marketLimit: 20 },
        async () => ({ success: false as const, error: 'no tool executor' })
      );
      const successful = snapshot.results.filter((r) => r.success);
      const value = successful
        .map((r) => {
          const payload = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
          return `${r.label}: ${payload}`;
        })
        .join('\n')
        .slice(0, 1000);
      this.contextCache = { value, expiresAt: now + 10 * 60 * 1000 };
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
      : { ...bundle, marketContext: await this.getMarketContext() };

    const userMessage = buildUserMessage(effectiveBundle);
    let proposal: TradeProposal | null = null;
    let usedFallback = false;

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
        const fallbackResponse = await this.fallbackLlm.complete(
          [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: fallbackMessage },
          ],
          { timeoutMs: 5_000 }
        );
        proposal = parseProposal(fallbackResponse.content);
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
