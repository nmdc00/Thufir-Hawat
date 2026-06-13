import { z } from 'zod';
import type { LlmClient } from './llm.js';
import type { ThufirConfig } from './config.js';
import type { PositionBook } from './position_book.js';
import { recordEntryGateDecision } from '../memory/llm_entry_gate_log.js';
import { getGateVerdictCooldown, recordGateVerdictReject } from '../memory/gate_verdict_cooldowns.js';
import { listPerpTradeJournals } from '../memory/perp_trade_journal.js';
import { summarizeSignalPerformance, type SignalPerformanceSummary } from './signal_performance.js';
import { Logger } from './logger.js';
import { withExecutionContext } from './llm_infra.js';
import type { EntryGateMarketContext } from './entry_gate_market_context.js';

export interface EntryGateCandidate {
  symbol: string;
  side: 'buy' | 'sell';
  notionalUsd: number;
  leverage: number;
  leverageMax: number;
  edge: number;
  confidence: number;
  signalClass: string;
  regime: string;
  session: string;
  entryReasoning: string;
  invalidationPrice?: number | null;
  suggestedTtlMinutes?: number;
  expectedRMultiple?: number;
  catalystTimestamp?: string;
  marketContext?: EntryGateMarketContext;
}

export type EntryGateReasonCode =
  | 'approve'
  | 'book_conflict'
  | 'same_symbol_stacking'
  | 'invalidation_missing'
  | 'edge_too_low'
  | 'confidence_too_low'
  | 'regime_mismatch'
  | 'no_fresh_catalyst'
  | 'risk_reward_insufficient'
  | 'size_downshift'
  | 'cooldown_suppressed'
  | 'llm_unavailable'
  | 'invalid_leverage_geometry'
  | 'discretionary_reject';

export interface EntryGateDecision {
  verdict: 'approve' | 'reject' | 'resize';
  reasoning: string;
  reasonCode?: EntryGateReasonCode;
  adjustedSizeUsd?: number;
  stopLevelPrice?: number | null;
  equityAtRiskPct?: number;
  targetRR?: number;
  suggestedLeverage?: number;
}

const DecisionSchema = z.object({
  verdict: z.enum(['approve', 'reject', 'resize']),
  reasoning: z.string(),
  reasonCode: z.string().optional(),
  adjustedSizeUsd: z.number().optional(),
  stopLevelPrice: z.number().finite().nullable(),
  equityAtRiskPct: z.number(),
  targetRR: z.number(),
  suggestedLeverage: z.number().optional(),
}).superRefine((decision, ctx) => {
  if ((decision.verdict === 'approve' || decision.verdict === 'resize') && decision.stopLevelPrice == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stopLevelPrice'],
      message: `${decision.verdict} decisions require a finite stopLevelPrice`,
    });
  }
});

const logger = new Logger('info');

function normalizeOptionalFieldPseudoJson(
  raw: string,
  optionalFields: string[]
): string {
  let normalized = raw;
  for (const field of optionalFields) {
    const pattern = new RegExp(`("${field}"\\s*:)\\s*undefined(?=\\s*[,}])`, 'g');
    normalized = normalized.replace(pattern, '$1 null');
  }
  return normalized;
}

function toFiniteNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositiveNumberOrNull(value: unknown): number | null {
  const parsed = toFiniteNumberOrNull(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function formatOptionalNumber(value: number | null | undefined, digits = 2, suffix = ''): string {
  return value == null || !Number.isFinite(value) ? 'unknown' : `${value.toFixed(digits)}${suffix}`;
}

function floorWithTolerance(value: number): number {
  return Math.floor(value + 1e-9);
}

function resolveEffectiveMarketContext(
  candidate: EntryGateCandidate,
  markPrice: number,
): EntryGateMarketContext | undefined {
  const existing = candidate.marketContext;
  const safeMarkPrice = toPositiveNumberOrNull(markPrice) ?? toPositiveNumberOrNull(existing?.markPrice);
  const invalidationPrice = toFiniteNumberOrNull(candidate.invalidationPrice);
  const stopDistancePct =
    safeMarkPrice != null && safeMarkPrice > 0 && invalidationPrice != null
      ? Math.abs(safeMarkPrice - invalidationPrice) / safeMarkPrice
      : existing?.stopDistancePct ?? null;
  const liquidationMovePctAtCandidateLeverage =
    candidate.leverage > 0 ? 1 / candidate.leverage : existing?.liquidationMovePctAtCandidateLeverage ?? null;
  const liquidationBufferPct =
    stopDistancePct != null && liquidationMovePctAtCandidateLeverage != null
      ? liquidationMovePctAtCandidateLeverage - stopDistancePct
      : existing?.liquidationBufferPct ?? null;
  const mechanicalLeverageCeiling =
    stopDistancePct != null && stopDistancePct > 0
      ? Math.max(0, floorWithTolerance(Math.min(candidate.leverageMax, 0.7 / stopDistancePct)))
      : existing?.mechanicalLeverageCeiling ?? null;
  if (!existing && invalidationPrice == null && stopDistancePct == null && mechanicalLeverageCeiling == null) {
    return undefined;
  }
  return {
    markPrice: safeMarkPrice ?? null,
    stopDistancePct,
    liquidationMovePctAtCandidateLeverage,
    liquidationBufferPct,
    mechanicalLeverageCeiling,
    trendBias: existing?.trendBias ?? 'unknown',
    priceVsEma20_1hPct: existing?.priceVsEma20_1hPct ?? null,
    regimeSource: existing?.regimeSource ?? 'fallback',
    liquidityBucket: existing?.liquidityBucket ?? 'normal',
    liquidityScore: existing?.liquidityScore ?? null,
    executionScore: existing?.executionScore ?? null,
    fundingScore: existing?.fundingScore ?? null,
    spreadProxyBps: existing?.spreadProxyBps ?? null,
    openInterestUsd: existing?.openInterestUsd ?? null,
    dayVolumeUsd: existing?.dayVolumeUsd ?? null,
    oiUsd: existing?.oiUsd ?? null,
    oiDelta1hPct: existing?.oiDelta1hPct ?? null,
    oiDelta4hPct: existing?.oiDelta4hPct ?? null,
    fundingRatePct: existing?.fundingRatePct ?? null,
    volumeVs24hAvgPct: existing?.volumeVs24hAvgPct ?? null,
    alertReason: existing?.alertReason ?? null,
    triggerReason: existing?.triggerReason ?? null,
  };
}

function buildCandidateForEvaluation(candidate: EntryGateCandidate, markPrice: number): EntryGateCandidate {
  const marketContext = resolveEffectiveMarketContext(candidate, markPrice);
  return marketContext ? { ...candidate, marketContext } : candidate;
}

function buildObservabilityFields(candidate: EntryGateCandidate) {
  return {
    mechanicalLeverageCeiling: candidate.marketContext?.mechanicalLeverageCeiling ?? null,
    stopDistancePct: candidate.marketContext?.stopDistancePct ?? null,
    liquidityScore: candidate.marketContext?.liquidityScore ?? null,
    executionScore: candidate.marketContext?.executionScore ?? null,
    liquidityBucket: candidate.marketContext?.liquidityBucket ?? null,
  };
}

function getMechanicalLeverageCeiling(
  candidate: EntryGateCandidate,
  stopPrice: number | null | undefined,
  markPrice: number | null | undefined,
): number | null {
  const safeMarkPrice = toPositiveNumberOrNull(markPrice);
  const safeStopPrice = toFiniteNumberOrNull(stopPrice);
  if (safeMarkPrice == null || safeStopPrice == null) {
    return null;
  }
  const stopDistancePct = Math.abs(safeMarkPrice - safeStopPrice) / safeMarkPrice;
  if (!Number.isFinite(stopDistancePct) || stopDistancePct <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(Math.min(candidate.leverageMax, 0.7 / stopDistancePct)));
}

function hasInvalidStopSide(
  side: EntryGateCandidate['side'],
  stopPrice: number | null | undefined,
  markPrice: number | null | undefined,
): boolean {
  const safeMarkPrice = toPositiveNumberOrNull(markPrice);
  const safeStopPrice = toFiniteNumberOrNull(stopPrice);
  if (safeMarkPrice == null || safeStopPrice == null) {
    return false;
  }
  return side === 'buy' ? safeStopPrice >= safeMarkPrice : safeStopPrice <= safeMarkPrice;
}

function buildInvalidGeometryDecision(
  candidate: EntryGateCandidate,
  stopPrice: number | null | undefined,
  markPrice: number | null | undefined,
): EntryGateDecision {
  const safeMarkPrice = toPositiveNumberOrNull(markPrice);
  const safeStopPrice = toFiniteNumberOrNull(stopPrice);
  const stopLabel = safeStopPrice != null ? `$${safeStopPrice.toFixed(2)}` : 'the proposed stop';
  const markLabel = safeMarkPrice != null ? `$${safeMarkPrice.toFixed(2)}` : 'the current mark price';
  const reasoning = hasInvalidStopSide(candidate.side, safeStopPrice, safeMarkPrice)
    ? candidate.side === 'buy'
      ? `Invalid stop geometry: buy invalidation ${stopLabel} must be below ${markLabel}.`
      : `Invalid stop geometry: sell invalidation ${stopLabel} must be above ${markLabel}.`
    : `Invalid stop geometry: ${stopLabel} leaves no safe leverage room versus ${markLabel}.`;
  return {
    verdict: 'reject',
    reasoning,
    reasonCode: 'invalid_leverage_geometry',
    stopLevelPrice: safeStopPrice,
    equityAtRiskPct: 0,
    targetRR: 0,
  };
}

function appendReasoningNote(reasoning: string, note: string): string {
  return reasoning.includes(note) ? reasoning : `${reasoning} ${note}`.trim();
}

function applyLeverageEnvelope(
  candidate: EntryGateCandidate,
  decision: EntryGateDecision,
  marketContext: EntryGateMarketContext | undefined,
): EntryGateDecision {
  const marketMarkPrice = toPositiveNumberOrNull(marketContext?.markPrice);
  const finalStopPrice = toFiniteNumberOrNull(decision.stopLevelPrice);
  const stopForFinalValidation =
    finalStopPrice ?? toFiniteNumberOrNull(candidate.invalidationPrice);

  if (
    (decision.verdict === 'approve' || decision.verdict === 'resize') &&
    marketMarkPrice != null &&
    stopForFinalValidation != null
  ) {
    if (hasInvalidStopSide(candidate.side, stopForFinalValidation, marketMarkPrice)) {
      return buildInvalidGeometryDecision(candidate, stopForFinalValidation, marketMarkPrice);
    }
    const finalCeiling = getMechanicalLeverageCeiling(candidate, stopForFinalValidation, marketMarkPrice);
    if (finalCeiling != null && finalCeiling < 1) {
      return buildInvalidGeometryDecision(candidate, stopForFinalValidation, marketMarkPrice);
    }
  }

  const contextCeiling = toFiniteNumberOrNull(marketContext?.mechanicalLeverageCeiling);
  const finalStopCeiling =
    decision.verdict === 'approve' || decision.verdict === 'resize'
      ? getMechanicalLeverageCeiling(candidate, finalStopPrice, marketMarkPrice)
      : null;
  const effectiveCeiling = [candidate.leverageMax, contextCeiling, finalStopCeiling]
    .filter((value): value is number => value != null && Number.isFinite(value) && value >= 1)
    .reduce((min, value) => Math.min(min, value), candidate.leverageMax);
  const rawLeverage = toFiniteNumberOrNull(decision.suggestedLeverage);
  const candidateLeverage = toFiniteNumberOrNull(candidate.leverage);
  const leverageNeedsClamp =
    (contextCeiling != null && candidateLeverage != null && candidateLeverage > contextCeiling) ||
    (finalStopCeiling != null && candidateLeverage != null && candidateLeverage > finalStopCeiling) ||
    (rawLeverage != null && rawLeverage > effectiveCeiling);
  const leverageSeed =
    rawLeverage != null && rawLeverage >= 1
      ? rawLeverage
      : leverageNeedsClamp
        ? candidateLeverage
        : null;
  const clampedLeverage =
    leverageSeed != null && Number.isFinite(leverageSeed) && leverageSeed >= 1
      ? Math.max(1, Math.round(Math.min(leverageSeed, effectiveCeiling)))
      : undefined;

  if (decision.verdict === 'approve' || decision.verdict === 'resize') {
    return {
      ...decision,
      reasoning:
        clampedLeverage != null && leverageNeedsClamp
          ? appendReasoningNote(
              decision.reasoning,
              `Mechanical leverage ceiling enforced at ${clampedLeverage}x.`
            )
          : decision.reasoning,
      ...(clampedLeverage != null ? { suggestedLeverage: clampedLeverage } : {}),
    };
  }

  return decision;
}

function formatBookTable(entries: ReturnType<PositionBook['getAll']>): string {
  if (entries.length === 0) return '(no open positions)';
  const totalNotional = entries.reduce((sum, e) => sum + e.size * e.entryPrice, 0);
  const header = 'symbol | side  | notional  | conc% | thesis expires';
  const divider = '-------|-------|-----------|-------|----------------';
  const rows = entries.map((e) => {
    const notional = e.size * e.entryPrice;
    const concPct = totalNotional > 0 ? ((notional / totalNotional) * 100).toFixed(0) : '0';
    const ttlMin = Math.round((e.thesisExpiresAtMs - Date.now()) / 60_000);
    const ttlStr = ttlMin > 0 ? `${ttlMin}min` : 'EXPIRED';
    return `${e.symbol.padEnd(6)} | ${e.side.padEnd(5)} | $${notional.toFixed(0).padEnd(8)} | ${concPct.padEnd(5)} | ${ttlStr}`;
  });
  const summary = `Total notional: $${totalNotional.toFixed(0)} across ${entries.length} position(s)`;
  return [summary, '', header, divider, ...rows].join('\n');
}

function formatTrackRecord(stats: SignalPerformanceSummary): string {
  if (stats.sampleCount === 0) {
    if (stats.signalClass === 'llm_originator') {
      return `Signal class: llm_originator — this proposal was generated by the LLM originator with an explicit thesis, invalidation price, and R:R estimate. No trade history yet; the track record is building. Judge the thesis quality, the invalidation logic, and the R:R directly. Do not reject solely because sample count is zero.`;
    }
    return `No historical trades for signal class "${stats.signalClass}". Treat as a novel setup — apply extra scrutiny.`;
  }
  const winPct = (stats.thesisCorrectRate * 100).toFixed(0);
  const credibility = stats.sampleCount < 5 ? ' (low sample — high uncertainty)' : '';
  return [
    `Signal class: ${stats.signalClass} — ${stats.sampleCount} trades${credibility}`,
    `Win rate: ${winPct}% | Expectancy: ${stats.expectancy.toFixed(2)} | Sharpe-like: ${stats.sharpeLike.toFixed(2)}`,
    `Avg adverse move: ${stats.maeProxy.toFixed(3)} | Avg favorable move: ${stats.mfeProxy.toFixed(3)}`,
  ].join('\n');
}

function resolveTimeoutMs(config: ThufirConfig): number {
  return Math.max(1, Number(config.autonomy?.llmEntryGate?.timeoutMs ?? 5_000));
}

function shouldRejectOnBothFail(config: ThufirConfig): boolean {
  return config.autonomy?.llmEntryGate?.rejectOnBothFail !== false;
}

function deterministicPrechecksEnabled(config: ThufirConfig): boolean {
  return config.autonomy?.llmEntryGate?.deterministicPrechecks !== false;
}

function resolveGateCooldownMinutes(config: ThufirConfig): number {
  return Math.max(0, Number(config.autonomy?.llmEntryGate?.gateCooldownMinutes ?? 60));
}

function resolveMinEdge(config: ThufirConfig): number {
  return Math.max(0, Number(config.autonomy?.minEdge ?? 0.05));
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldBypassCooldownForCandidate(
  candidate: EntryGateCandidate,
  cooldown: { lastRejectAt: string; lastEdge: number },
): boolean {
  const improvedEdge = Number.isFinite(candidate.edge) && candidate.edge >= cooldown.lastEdge * 1.25;
  const catalystMs = parseTimestampMs(candidate.catalystTimestamp);
  const lastRejectMs = parseTimestampMs(cooldown.lastRejectAt);
  const freshCatalyst = catalystMs != null && lastRejectMs != null && catalystMs > lastRejectMs;
  return improvedEdge || freshCatalyst;
}

function recordGateDecision(
  candidate: EntryGateCandidate,
  decision: EntryGateDecision,
  usedFallback: boolean,
  llmConsulted: boolean,
): void {
  recordEntryGateDecision({
    symbol: candidate.symbol,
    side: candidate.side,
    notionalUsd: candidate.notionalUsd,
    verdict: decision.verdict,
    reasoning: decision.reasoning,
    reasonCode: decision.reasonCode,
    adjustedSizeUsd: decision.adjustedSizeUsd,
    usedFallback,
    signalClass: candidate.signalClass,
    regime: candidate.regime,
    session: candidate.session,
    edge: candidate.edge,
    ...buildObservabilityFields(candidate),
    stopLevelPrice: decision.stopLevelPrice,
    equityAtRiskPct: decision.equityAtRiskPct,
    targetRR: decision.targetRR,
    suggestedLeverage: decision.suggestedLeverage,
    llmConsulted,
  });
  if (decision.verdict === 'reject' && decision.reasonCode !== 'cooldown_suppressed') {
    recordGateVerdictReject({
      symbol: candidate.symbol,
      side: candidate.side,
      edge: candidate.edge,
    });
  }
}

function buildPrompt(
  candidate: EntryGateCandidate,
  bookEntries: ReturnType<PositionBook['getAll']>,
  sameSideWarning: string | null,
  signalStats: SignalPerformanceSummary,
): { system: string; user: string } {
  const system = `You are Thufir, an LLM-primary trading agent. Your job is to decide whether to approve, reject, or resize a trade candidate, and — if approving — what leverage to use.

The default is no trade. You need a compelling reason to approve. When in doubt, reject.

You are not a quant system. You reason about narrative, market context, and whether this setup makes sense right now.

Respond ONLY with valid JSON matching this schema:
{"verdict":"approve"|"reject"|"resize","reasoning":"...","reasonCode":"approve"|"book_conflict"|"same_symbol_stacking"|"invalidation_missing"|"edge_too_low"|"confidence_too_low"|"regime_mismatch"|"no_fresh_catalyst"|"risk_reward_insufficient"|"size_downshift"|"invalid_leverage_geometry"|"discretionary_reject","adjustedSizeUsd":number|undefined,"stopLevelPrice":number|null,"equityAtRiskPct":number,"targetRR":number,"suggestedLeverage":number|undefined}

Fields:
- stopLevelPrice: the price at which the thesis is invalidated. If the candidate does not provide one, derive it yourself from market structure (nearest support/resistance, recent swing, or a 2–3% move against the position). "approve" and "resize" require a finite stopLevelPrice. Use null only on "reject" when you genuinely cannot justify a machine-readable invalidation level.
- equityAtRiskPct: estimated % of book equity lost if stop is hit (use candidate notional and leverage)
- targetRR: your estimated reward-to-risk ratio for this setup
- suggestedLeverage: only set when verdict is "approve" or "resize". Pick an integer from 1 to leverageMax. Use 1x by default. Scale up only when ALL of the following hold: high edge (>10%), high confidence (>70%), clear directional regime (trending or expansion), deep liquidity, and a well-defined stop. Use maximum leverage only for exceptional setups. Omit (or set to 1) if you have any doubt. Never suggest leverage above the mechanical leverage ceiling when one is provided.

Use the structured market context first and thesis prose second. Treat thin liquidity, poor execution quality, or a non-positive liquidation buffer as strong reasons to keep leverage low or reject. If the current leverage is mechanically unsafe but the thesis still works, resize leverage down to a safe level instead of approving the unsafe level unchanged.

All five required fields (verdict, reasoning, stopLevelPrice, equityAtRiskPct, targetRR) are always required. suggestedLeverage is optional — omit it on reject, required on approve/resize.`;

  const bookTable = formatBookTable(bookEntries);

  const warningBlock = sameSideWarning
    ? `\n## ⚠️ Concentration Warning\n\n${sameSideWarning}\n`
    : '';

  const ttlWarning =
    candidate.suggestedTtlMinutes === 60 || candidate.suggestedTtlMinutes === 120
      ? `\n⚠️ TTL is ${candidate.suggestedTtlMinutes}min — a common default. Verify this is thesis-derived, not a placeholder.`
      : '';

  const originatorFields =
    candidate.invalidationPrice != null || candidate.expectedRMultiple != null
      ? [
          `- Originator invalidation price: $${candidate.invalidationPrice}`,
          `- Originator expected R:R: ${candidate.expectedRMultiple}R`,
          `- Originator TTL: ${candidate.suggestedTtlMinutes}min${ttlWarning}`,
        ].join('\n')
      : '';
  const marketContextBlock = candidate.marketContext
    ? [
        '## Market Structure Context',
        '',
        `- Current mark price: ${formatOptionalNumber(candidate.marketContext.markPrice, 2)}`,
        `- Invalidation price: ${formatOptionalNumber(toFiniteNumberOrNull(candidate.invalidationPrice), 2)}`,
        `- Stop distance: ${formatOptionalNumber(candidate.marketContext.stopDistancePct != null ? candidate.marketContext.stopDistancePct * 100 : null, 2, '%')}`,
        `- Candidate leverage: ${formatOptionalNumber(candidate.leverage, 0, 'x')}`,
        `- Mechanical leverage ceiling from stop geometry: ${formatOptionalNumber(candidate.marketContext.mechanicalLeverageCeiling, 0, 'x')}`,
        `- Liquidation move at candidate leverage: ${formatOptionalNumber(candidate.marketContext.liquidationMovePctAtCandidateLeverage != null ? candidate.marketContext.liquidationMovePctAtCandidateLeverage * 100 : null, 2, '%')}`,
        `- Buffer between invalidation and liquidation: ${formatOptionalNumber(candidate.marketContext.liquidationBufferPct != null ? candidate.marketContext.liquidationBufferPct * 100 : null, 2, '%')}`,
        `- Trend bias: ${candidate.marketContext.trendBias}`,
        `- Price vs EMA20 1h: ${formatOptionalNumber(candidate.marketContext.priceVsEma20_1hPct, 2, '%')}`,
        `- Liquidity bucket: ${candidate.marketContext.liquidityBucket}`,
        `- Liquidity score: ${formatOptionalNumber(candidate.marketContext.liquidityScore, 2)}`,
        `- Execution score: ${formatOptionalNumber(candidate.marketContext.executionScore, 2)}`,
        `- Funding score: ${formatOptionalNumber(candidate.marketContext.fundingScore, 2)}`,
        `- Spread proxy: ${formatOptionalNumber(candidate.marketContext.spreadProxyBps, 1, ' bps')}`,
        `- Open interest USD: ${formatOptionalNumber(candidate.marketContext.openInterestUsd, 0)}`,
        `- Day volume USD: ${formatOptionalNumber(candidate.marketContext.dayVolumeUsd, 0)}`,
        `- OI USD: ${formatOptionalNumber(candidate.marketContext.oiUsd, 0)}`,
        `- OI delta 1h: ${formatOptionalNumber(candidate.marketContext.oiDelta1hPct, 2, '%')}`,
        `- OI delta 4h: ${formatOptionalNumber(candidate.marketContext.oiDelta4hPct, 2, '%')}`,
        `- Funding rate: ${formatOptionalNumber(candidate.marketContext.fundingRatePct, 2, '%')}`,
        `- Volume vs 24h average: ${formatOptionalNumber(candidate.marketContext.volumeVs24hAvgPct, 2, '%')}`,
        `- Trigger reason: ${candidate.marketContext.triggerReason ?? 'unknown'}`,
        `- Alert reason: ${candidate.marketContext.alertReason ?? 'none'}`,
      ].join('\n')
    : '';

  const user = `## Current Open Book

${bookTable}
${warningBlock}
## Trade Candidate

- Symbol: ${candidate.symbol}
- Side: ${candidate.side}
- Notional USD: $${candidate.notionalUsd.toFixed(2)}
- Leverage range: 1x – ${candidate.leverageMax}x (you decide)
- Edge: ${(candidate.edge * 100).toFixed(2)}%
- Confidence: ${(candidate.confidence * 100).toFixed(1)}%
- Signal class: ${candidate.signalClass}
- Regime: ${candidate.regime}
- Session: ${candidate.session}
- Entry reasoning: ${candidate.entryReasoning}${originatorFields ? '\n' + originatorFields : ''}

${marketContextBlock ? '\n' + marketContextBlock + '\n' : ''}

## Signal Performance Context

${formatTrackRecord(signalStats)}

## Instruction

Respond ONLY with valid JSON:
{"verdict":"approve"|"reject"|"resize","reasoning":"<your reasoning>","reasonCode":"<structured short code>","adjustedSizeUsd":<number if resize, omit otherwise>,"stopLevelPrice":<price that invalidates thesis, or null>,"equityAtRiskPct":<% of book equity lost at stop>,"targetRR":<reward:risk ratio>,"suggestedLeverage":<integer 1–${candidate.leverageMax} if approving, omit if rejecting>}

If verdict is "approve" or "resize", stopLevelPrice must be a finite number.`;

  return { system, user };
}

async function callLlm(
  client: LlmClient,
  candidate: EntryGateCandidate,
  bookEntries: ReturnType<PositionBook['getAll']>,
  sameSideWarning: string | null,
  signalStats: SignalPerformanceSummary,
  timeoutMs?: number
): Promise<EntryGateDecision> {
  const { system, user } = buildPrompt(candidate, bookEntries, sameSideWarning, signalStats);
  const response = await client.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    timeoutMs !== undefined ? { timeoutMs } : {}
  );

  const normalized = normalizeOptionalFieldPseudoJson(
    response.content.trim(),
    ['adjustedSizeUsd', 'stopLevelPrice', 'suggestedLeverage']
  );
  const parsed = JSON.parse(normalized) as Record<string, unknown>;
  if (parsed.adjustedSizeUsd === null) {
    delete parsed.adjustedSizeUsd;
  }
  if (parsed.suggestedLeverage === null) {
    delete parsed.suggestedLeverage;
  }
  const validated = DecisionSchema.parse(parsed);
  const rawLeverage = validated.suggestedLeverage;
  const mechanicalLeverageCeiling =
    candidate.marketContext?.mechanicalLeverageCeiling != null &&
    Number.isFinite(candidate.marketContext.mechanicalLeverageCeiling)
      ? Math.max(1, Math.floor(candidate.marketContext.mechanicalLeverageCeiling))
      : null;
  const clampedLeverage =
    rawLeverage !== undefined && Number.isFinite(rawLeverage) && rawLeverage >= 1
      ? Math.round(
          Math.min(
            rawLeverage,
            candidate.leverageMax,
            mechanicalLeverageCeiling ?? candidate.leverageMax,
          )
        )
      : undefined;
  return {
    verdict: validated.verdict,
    reasoning: validated.reasoning,
    reasonCode: normalizeReasonCode(validated.reasonCode, validated.verdict, validated.reasoning),
    stopLevelPrice: validated.stopLevelPrice,
    equityAtRiskPct: validated.equityAtRiskPct,
    targetRR: validated.targetRR,
    ...(validated.adjustedSizeUsd !== undefined ? { adjustedSizeUsd: validated.adjustedSizeUsd } : {}),
    ...(clampedLeverage !== undefined ? { suggestedLeverage: clampedLeverage } : {}),
  };
}

function summarizeLlmError(error: unknown): { type: string; message: string } {
  if (error instanceof SyntaxError) {
    return { type: 'json_parse', message: error.message };
  }
  if (error instanceof z.ZodError) {
    return {
      type: 'schema_validation',
      message: error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { type: 'llm_call', message };
}

function normalizeReasonCode(
  raw: string | undefined,
  verdict: EntryGateDecision['verdict'],
  reasoning: string,
): EntryGateReasonCode {
  const normalized = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const allowed = new Set<EntryGateReasonCode>([
    'approve',
    'book_conflict',
    'same_symbol_stacking',
    'invalidation_missing',
    'edge_too_low',
    'confidence_too_low',
    'regime_mismatch',
    'no_fresh_catalyst',
    'risk_reward_insufficient',
    'size_downshift',
    'cooldown_suppressed',
    'llm_unavailable',
    'invalid_leverage_geometry',
    'discretionary_reject',
  ]);
  if (allowed.has(normalized as EntryGateReasonCode)) {
    return normalized as EntryGateReasonCode;
  }

  const lower = reasoning.trim().toLowerCase();
  if (lower.includes('opposite-side position already open') || lower.includes('conflicting trade')) {
    return 'book_conflict';
  }
  if (lower.includes('stack') || lower.includes('same-symbol') || lower.includes('same symbol')) {
    return 'same_symbol_stacking';
  }
  if (lower.includes('no price invalidation') || lower.includes('concrete stop price')) {
    return 'invalidation_missing';
  }
  if (lower.includes('fresh catalyst')) {
    return 'no_fresh_catalyst';
  }
  if (lower.includes('risk reward') || lower.includes('reward-to-risk') || lower.includes('r:r')) {
    return 'risk_reward_insufficient';
  }
  if (lower.includes('invalid stop geometry') || lower.includes('mechanical leverage ceiling')) {
    return 'invalid_leverage_geometry';
  }
  if (lower.includes('regime') || lower.includes('choppy')) {
    return 'regime_mismatch';
  }
  if (lower.includes('confidence') && (lower.includes('too low') || lower.includes('below'))) {
    return 'confidence_too_low';
  }
  if (lower.includes('edge') && (lower.includes('too low') || lower.includes('below') || lower.includes('moderate'))) {
    return 'edge_too_low';
  }
  if (verdict === 'resize') {
    return 'size_downshift';
  }
  if (lower.includes('llm unavailable')) {
    return 'llm_unavailable';
  }
  if (verdict === 'approve') {
    return 'approve';
  }
  return 'discretionary_reject';
}

export class LlmEntryGate {
  constructor(
    private mainLlm: LlmClient,
    private fallbackLlm: LlmClient,
    private notify: (msg: string) => Promise<void>,
    private book: PositionBook,
    private config: ThufirConfig,
  ) {}

  async evaluate(
    candidate: EntryGateCandidate,
    markPrice: number,
  ): Promise<EntryGateDecision> {
    const evaluationCandidate = buildCandidateForEvaluation(candidate, markPrice);
    // Conflict fast-path: no LLM call needed
    if (this.book.hasConflict(evaluationCandidate.symbol, evaluationCandidate.side)) {
      const decision: EntryGateDecision = {
        verdict: 'reject',
        reasoning: 'Opposite-side position already open on this symbol. Cannot open conflicting trade.',
        reasonCode: 'book_conflict',
      };
      recordGateDecision(evaluationCandidate, decision, false, false);
      return decision;
    }

    if (deterministicPrechecksEnabled(this.config)) {
      const sameSidePositionOpen = this.book.hasPosition(evaluationCandidate.symbol, evaluationCandidate.side);
      if (sameSidePositionOpen) {
        const decision: EntryGateDecision = {
          verdict: 'reject',
          reasoning:
            `Same-side ${evaluationCandidate.side} position already open on ${evaluationCandidate.symbol}; ` +
            'deterministic stacking guard suppressed duplicate exposure.',
          reasonCode: 'same_symbol_stacking',
        };
        recordGateDecision(evaluationCandidate, decision, false, false);
        return decision;
      }

      const cooldownMinutes = resolveGateCooldownMinutes(this.config);
      if (cooldownMinutes > 0) {
        const cooldown = getGateVerdictCooldown(evaluationCandidate.symbol, evaluationCandidate.side);
        const lastRejectMs = parseTimestampMs(cooldown?.lastRejectAt);
        const cooldownMs = cooldownMinutes * 60_000;
        if (
          cooldown &&
          lastRejectMs != null &&
          Date.now() - lastRejectMs < cooldownMs &&
          !shouldBypassCooldownForCandidate(evaluationCandidate, cooldown)
        ) {
          const remainingMs = Math.max(0, cooldownMs - (Date.now() - lastRejectMs));
          const decision: EntryGateDecision = {
            verdict: 'reject',
            reasoning:
              `Recent reject cooldown active for ${evaluationCandidate.symbol} ${evaluationCandidate.side}; ` +
              `suppressed repeat gate consult for ${Math.ceil(remainingMs / 60_000)} more minute(s).`,
            reasonCode: 'cooldown_suppressed',
          };
          recordGateDecision(evaluationCandidate, decision, false, false);
          return decision;
        }
      }

      const minEdge = resolveMinEdge(this.config);
      if (Number.isFinite(evaluationCandidate.edge) && evaluationCandidate.edge < minEdge) {
        const decision: EntryGateDecision = {
          verdict: 'reject',
          reasoning:
            `Candidate edge ${(evaluationCandidate.edge * 100).toFixed(2)}% is below ` +
            `the configured ${(minEdge * 100).toFixed(2)}% minimum edge floor.`,
          reasonCode: 'edge_too_low',
        };
        recordGateDecision(evaluationCandidate, decision, false, false);
        return decision;
      }
    }

    // Reject originator proposals that didn't name a price invalidation level
    if ('invalidationPrice' in evaluationCandidate && (evaluationCandidate.invalidationPrice == null || !Number.isFinite(evaluationCandidate.invalidationPrice))) {
      const decision: EntryGateDecision = {
        verdict: 'reject',
        reasoning: 'No price invalidation level set — cannot approve a trade without a concrete stop price.',
        reasonCode: 'invalidation_missing',
      };
      recordGateDecision(evaluationCandidate, decision, false, false);
      return decision;
    }
    if (
      hasInvalidStopSide(
        evaluationCandidate.side,
        evaluationCandidate.invalidationPrice,
        evaluationCandidate.marketContext?.markPrice,
      ) ||
      (
        evaluationCandidate.marketContext?.mechanicalLeverageCeiling != null &&
        Number.isFinite(evaluationCandidate.marketContext.mechanicalLeverageCeiling) &&
        evaluationCandidate.marketContext.mechanicalLeverageCeiling < 1
      )
    ) {
      const decision = buildInvalidGeometryDecision(
        evaluationCandidate,
        evaluationCandidate.invalidationPrice,
        evaluationCandidate.marketContext?.markPrice,
      );
      recordGateDecision(evaluationCandidate, decision, false, false);
      return decision;
    }

    const bookEntries = this.book.getAll();
    const signalStats = summarizeSignalPerformance(
      listPerpTradeJournals({ limit: 200 }),
      evaluationCandidate.signalClass,
    );
    const timeoutMs = resolveTimeoutMs(this.config);
    let usedFallback = false;
    let decision: EntryGateDecision;

    // Build same-side concentration warning if a position in this symbol/side already exists
    const sameSideWarning = this.book.hasPosition(evaluationCandidate.symbol, evaluationCandidate.side)
      ? `A ${evaluationCandidate.side} position in ${evaluationCandidate.symbol} is ALREADY OPEN in the book. ` +
        `Approving this candidate would stack concentration in the same symbol and direction. ` +
        `Reject unless you can name a specific, concrete reason to increase exposure here right now — ` +
        `not just because the signal fired again.`
      : null;

    const criticalCtx = { mode: 'FULL_AGENT' as const, critical: true, reason: 'entry_gate' };

    // Try main LLM — no timeoutMs cap, matching AgenticOpenAiClient behaviour
    try {
      decision = await withExecutionContext(criticalCtx, () =>
        callLlm(this.mainLlm, evaluationCandidate, bookEntries, sameSideWarning, signalStats)
      );
    } catch (error) {
      const summary = summarizeLlmError(error);
      logger.warn('Entry gate main LLM failed; falling back', {
        provider: this.mainLlm.meta?.provider ?? 'unknown',
        model: this.mainLlm.meta?.model ?? 'unknown',
        symbol: evaluationCandidate.symbol,
        side: evaluationCandidate.side,
        failureType: summary.type,
        reason: summary.message,
      });
      usedFallback = true;
      try {
        await this.notify('⚠️ Entry gate: using fallback LLM — decision quality may be lower');
      } catch { /* best-effort */ }
      try {
        decision = await withExecutionContext(criticalCtx, () =>
          callLlm(this.fallbackLlm, evaluationCandidate, bookEntries, sameSideWarning, signalStats, timeoutMs)
        );
      } catch (fallbackError) {
        const summary = summarizeLlmError(fallbackError);
        logger.warn('Entry gate fallback LLM failed; using safe default', {
          provider: this.fallbackLlm.meta?.provider ?? 'unknown',
          model: this.fallbackLlm.meta?.model ?? 'unknown',
          symbol: evaluationCandidate.symbol,
          side: evaluationCandidate.side,
          failureType: summary.type,
          reason: summary.message,
        });
        decision = shouldRejectOnBothFail(this.config)
          ? {
              verdict: 'reject',
              reasoning: 'LLM unavailable — defaulting to reject (safe)',
              reasonCode: 'llm_unavailable',
            }
          : {
              verdict: 'approve',
              reasoning: 'LLM unavailable and rejectOnBothFail=false — allowing execution',
              reasonCode: 'llm_unavailable',
            };
      }
    }

    decision = applyLeverageEnvelope(
      evaluationCandidate,
      decision,
      evaluationCandidate.marketContext,
    );

    recordGateDecision(evaluationCandidate, decision, usedFallback, true);

    return decision;
  }
}
