import type { ThufirConfig } from './config.js';
import type { Market } from '../execution/markets.js';
import type { MarketClient } from '../execution/market-client.js';
import type { ExecutionAdapter, TradeDecision, TradeResult } from '../execution/executor.js';
import { PaperExecutor } from '../execution/modes/paper.js';
import { HyperliquidLiveExecutor } from '../execution/modes/hyperliquid-live.js';
import type { LimitCheckResult } from '../execution/wallet/limits.js';
import { ethers } from 'ethers';
import { checkPerpRiskLimits } from '../execution/perp-risk.js';
import { listCalibrationSummaries, recordOutcome } from '../memory/calibration.js';
import { listRecentIntel, searchIntel, type StoredIntel } from '../intel/store.js';
import { upsertAssumption, upsertFragilityCard, upsertMechanism } from '../memory/mentat.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import { runDiscovery } from '../discovery/engine.js';
import {
  signalPriceVolRegime,
  signalHyperliquidFundingOISkew,
  signalHyperliquidOrderflowImbalance,
} from '../discovery/signals.js';
import {
  clearActivePerpPositionLifecycle,
  getActivePerpPositionTradeId,
  listPerpTrades,
  recordPerpTrade,
  setActivePerpPositionLifecycle,
} from '../memory/perp_trades.js';
import { createLearningCase } from '../memory/learning_cases.js';
import { recordPerpTradeJournal, listPerpTradeJournals } from '../memory/perp_trade_journal.js';
import { findOpenPerpPrediction, findOpenPerpPredictionById } from '../memory/predictions.js';
import { recordDecisionAudit } from '../memory/decision_audit.js';
import { storeDecisionArtifact } from '../memory/decision_artifacts.js';
import { listRecentAgentIncidents } from '../memory/incidents.js';
import { getPlaybook, searchPlaybooks, upsertPlaybook } from '../memory/playbooks.js';
import {
  getEventById,
  getLatestThought,
  listEvents,
  listForecastsForEvent,
  listOutcomesForEvent,
} from '../memory/events.js';
import { searchHistoricalCases } from '../events/casebase.js';
import { getRpcUrl, getUsdcConfig, type EvmChain } from '../execution/evm/chains.js';
import { getErc20Balance, transferErc20 } from '../execution/evm/erc20.js';
import { cctpV1BridgeUsdc } from '../execution/evm/cctp_v1.js';
import { evaluateGlobalTradeGate } from './autonomy_policy.js';
import { buildPaperPromotionReport } from './paper_promotion.js';
import { resilientWebSearch } from '../intel/web_search_resilience.js';
import { computeClosedTradeComponentScores } from './decision_component_scores.js';
import { buildPerpExecutionLearningCase, toPerpExecutionLearningCaseInput } from './perp_lifecycle.js';
import { materializeTradePolicyAdjustmentFromLearningCase } from './trade_policy_materialization.js';
import {
  hydrateEntryTradeContract,
  normalizeReduceOnlyExitFsmInput,
  validateEntryTradeContract,
  validateReduceOnlyExitFsm,
} from './trade_contract.js';
import {
  buildLegacyExitContract,
  parseExitContract,
  serializeExitContract,
} from './exit_contract.js';
import {
  clearPositionExitPolicy,
  getPositionExitPolicy,
  upsertPositionExitPolicy,
} from '../memory/position_exit_policy.js';

/** Minimal interface for spending limit enforcement used in tool execution */
export interface ToolSpendingLimiter {
  checkAndReserve(amount: number): Promise<LimitCheckResult>;
  confirm(amount: number): void;
  release(amount: number): void;
  getState?(): { todaySpent: number; reserved: number } & Record<string, unknown>;
}
import { getCashBalance } from '../memory/portfolio.js';
import { getPaperPerpBookSummary, listPaperPerpFills, listPaperPerpPositions, listPaperPerpPositionsWithMark } from '../memory/paper_perps.js';
import { getWalletBalances } from '../execution/wallet/balances.js';
import { loadWallet } from '../execution/wallet/manager.js';
import { loadKeystore } from '../execution/wallet/keystore.js';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { isIP } from 'node:net';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { constants as fsConstants } from 'node:fs';

const execAsync = promisify(exec);

type InstallManager = 'npm' | 'pnpm' | 'bun';

interface SystemToolPolicy {
  enabled: boolean;
  allowedCommands: Set<string>;
  allowedManagers: Set<InstallManager>;
  allowGlobalInstall: boolean;
  timeoutMs: number;
  maxOutputChars: number;
}

export interface ToolExecutorContext {
  config: ThufirConfig;
  marketClient: MarketClient;
  executor?: ExecutionAdapter;
  limiter?: ToolSpendingLimiter;
}

export type ToolResult =
  | { success: true; data: unknown }
  | { success: false; error: string };

type PerpOrderFeeEstimate = {
  estimated_notional_usd: number | null;
  estimated_fee_rate: number | null;
  estimated_fee_type: 'taker' | 'maker';
  estimated_fee_usd: number | null;
};

type PerpOrderRealizedFee = {
  realized_fee_usd: number | null;
  realized_fee_token: string | null;
  realized_fill_count: number;
  realized_order_id: number | null;
  realized_fill_time_ms: number | null;
  error?: string | null;
};

type PerpOrderRealizedCloseSummary = PerpOrderRealizedFee & {
  realized_pnl_usd: number | null;
  net_realized_pnl_usd: number | null;
};

type PerpExitMode =
  | 'thesis_invalidation'
  | 'take_profit'
  | 'time_exit'
  | 'risk_reduction'
  | 'manual'
  | 'unknown';

type PerpExecutionAttempt = {
  attempt: number;
  slippage_bps: number;
  executed: boolean;
  message: string;
};

type PerpBookMode = 'paper' | 'live';

function isNoImmediateMatchError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /could not immediately match against any resting orders/i.test(message);
}

async function executePerpWithRetry(params: {
  executor: ExecutionAdapter;
  marketClient: MarketClient;
  market: Market;
  symbol: string;
  decision: TradeDecision;
  baseSlippageBps: number;
}): Promise<{ result: TradeResult; attempts: PerpExecutionAttempt[] }> {
  const slippageSequence = [params.baseSlippageBps, params.baseSlippageBps + 25, params.baseSlippageBps + 50]
    .map((value) => Math.max(0, Math.min(300, value)));
  const attempts: PerpExecutionAttempt[] = [];

  for (let index = 0; index < slippageSequence.length; index += 1) {
    const slippageBps = slippageSequence[index]!;
    const market = index === 0 ? params.market : await params.marketClient.getMarket(params.symbol);
    const attemptDecision: TradeDecision = {
      ...params.decision,
      marketSlippageBps: slippageBps,
    };
    const result = await params.executor.execute(market, attemptDecision);
    attempts.push({
      attempt: index + 1,
      slippage_bps: slippageBps,
      executed: result.executed,
      message: result.message,
    });

    if (result.executed) {
      return { result, attempts };
    }
    if (!isNoImmediateMatchError(result.message) || index === slippageSequence.length - 1) {
      return { result, attempts };
    }
  }

  return {
    result: { executed: false, message: 'Execution failed before attempting order placement.' },
    attempts,
  };
}

function normalizePerpBookMode(value: unknown): PerpBookMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'paper' || normalized === 'live' ? normalized : null;
}

function resolvePerpBookMode(config: ThufirConfig, toolInput: Record<string, unknown>): PerpBookMode {
  const explicit = normalizePerpBookMode(toolInput.mode);
  if (explicit) return explicit;

  if (config.execution?.mode === 'paper') {
    return 'paper';
  }

  const defaultMode = config.paper?.defaultMode ?? 'paper';
  const requireExplicitLive = config.paper?.requireExplicitLive ?? true;
  if (defaultMode === 'live' && !requireExplicitLive) {
    return 'live';
  }
  return 'paper';
}

function validateLiveBookPolicy(config: ThufirConfig, symbol: string): string | null {
  const allowlist = (config.paper?.liveSymbolsAllowlist ?? []).map((entry) => entry.trim().toUpperCase());
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (allowlist.length > 0 && normalizedSymbol.length > 0 && !allowlist.includes(normalizedSymbol)) {
    return `Live mode blocked for ${normalizedSymbol}. Allowed symbols: ${allowlist.join(', ')}`;
  }
  return null;
}

function resolvePerpExecutor(ctx: ToolExecutorContext, mode: PerpBookMode): ExecutionAdapter {
  if (mode === 'live') {
    if (ctx.config.execution?.provider !== 'hyperliquid') {
      throw new Error('Live perp execution requires hyperliquid provider.');
    }
    if (ctx.executor) {
      const ctorName = String((ctx.executor as { constructor?: { name?: string } })?.constructor?.name ?? '');
      if (ctx.config.execution?.mode === 'live' || ctorName !== 'PaperExecutor') {
        return ctx.executor;
      }
    }
    return new HyperliquidLiveExecutor({ config: ctx.config });
  }

  if (ctx.config.execution?.mode !== 'live' && ctx.executor) {
    return ctx.executor;
  }
  return new PaperExecutor();
}

function resolveMidForSymbol(symbol: string, mids: Record<string, number>): number | undefined {
  if (mids[symbol] != null) return mids[symbol];
  // Strip DEX prefix: "XYZ:CL" → "CL"
  if (symbol.includes(':')) {
    const afterColon = symbol.split(':').at(-1);
    if (afterColon && mids[afterColon] != null) return mids[afterColon];
  }
  // Strip quote currency: "CL/USDC" → "CL"
  const beforeSlash = symbol.split('/')[0];
  if (beforeSlash && beforeSlash !== symbol && mids[beforeSlash] != null) return mids[beforeSlash];
  return undefined;
}

async function resolvePaperMids(
  marketClient: MarketClient,
  config?: ThufirConfig
): Promise<Record<string, number>> {
  try {
    if (marketClient.isAvailable()) {
      const markets = await marketClient.listMarkets(500);
      const mids: Record<string, number> = {};
      // First pass: index main-perp markets (no colon prefix) so they take priority.
      for (const m of markets) {
        if (m.symbol && !m.symbol.includes(':') && typeof m.markPrice === 'number' && Number.isFinite(m.markPrice)) {
          mids[m.symbol] = m.markPrice;
          // Also index by base for slash-quoted symbols (e.g. "CL/USDC" → "CL").
          if (m.symbol.includes('/')) {
            const base = m.symbol.split('/')[0];
            if (base && base !== m.symbol) mids[base] = m.markPrice;
          }
        }
      }
      // Second pass: index DEX markets; strip prefix only if base has no main-perp price.
      // e.g. "xyz:CL" → "CL" when there is no main "CL", but "cash:BTC" → "BTC" is skipped.
      for (const m of markets) {
        if (m.symbol && m.symbol.includes(':') && typeof m.markPrice === 'number' && Number.isFinite(m.markPrice)) {
          mids[m.symbol] = m.markPrice;
          const afterColon = m.symbol.split(':').at(-1);
          if (afterColon && afterColon !== m.symbol && mids[afterColon] == null) {
            mids[afterColon] = m.markPrice;
          }
        }
      }
      return mids;
    }
    // Fall back to direct HyperliquidClient when execution provider doesn't expose a market client
    if (config?.hyperliquid?.enabled !== false) {
      const raw = await new HyperliquidClient(config!).getAllMids();
      // Normalize keys to uppercase so "xyz:CL" → "XYZ:CL" matches position symbols
      return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toUpperCase(), v]));
    }
    return {};
  } catch {
    return {};
  }
}

function buildPaperPerpSnapshot(initialCashUsdc: number, mids: Record<string, number> = {}): {
  cashBalanceUsdc: number;
  totalNotionalUsdc: number;
  accountValueUsdc: number;
  positions: Array<{
    symbol: string;
    side: 'long' | 'short';
    size: number;
    entry_price: number;
    leverage: number | null;
    position_value: number;
    unrealized_pnl: number | null;
    return_on_equity: number | null;
    liquidation_price: number | null;
    margin_used: number | null;
    leverage_type: string | null;
    max_leverage: number | null;
  }>;
} {
  const book = getPaperPerpBookSummary(initialCashUsdc);
  const positions = listPaperPerpPositions(initialCashUsdc).map((position) => {
    const markPrice = resolveMidForSymbol(position.symbol, mids);
    const effectivePrice = markPrice ?? position.entryPrice;
    const direction = position.side === 'long' ? 1 : -1;
    // Recover leverage from fill metadata when position column is null
    let leverage = position.leverage;
    if (leverage == null) {
      const openFill = listPaperPerpFills({ symbol: position.symbol, limit: 20 }, initialCashUsdc)
        .find((f) => !f.reduceOnly && f.leverage != null);
      leverage = openFill?.leverage ?? null;
    }
    return {
      symbol: position.symbol,
      side: position.side,
      size: position.size,
      entry_price: position.entryPrice,
      leverage,
      position_value: effectivePrice * position.size,
      unrealized_pnl: markPrice != null
        ? (markPrice - position.entryPrice) * position.size * direction
        : null,
      return_on_equity: markPrice != null && position.entryPrice > 0
        ? ((markPrice - position.entryPrice) * direction / position.entryPrice) * 100
        : null,
      liquidation_price: leverage != null && leverage > 1
        ? position.side === 'long'
          ? position.entryPrice * (1 - 1 / leverage)
          : position.entryPrice * (1 + 1 / leverage)
        : null,
      margin_used: null,
      leverage_type: null,
      max_leverage: null,
    };
  });
  const totalNotionalUsdc = positions.reduce((sum, position) => sum + Number(position.position_value ?? 0), 0);
  const totalUnrealizedPnlUsdc = positions.reduce((sum, p) => sum + (p.unrealized_pnl ?? 0), 0);
  return {
    cashBalanceUsdc: book.cashBalanceUsdc,
    totalNotionalUsdc,
    accountValueUsdc: book.cashBalanceUsdc + totalUnrealizedPnlUsdc,
    positions,
  };
}

function getPaperPositionSnapshot(
  symbol: string,
  initialCashUsdc: number
): { symbol: string; side: 'long' | 'short'; size: number } | null {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return null;
  const position = listPaperPerpPositions(initialCashUsdc).find(
    (entry) => entry.symbol.trim().toUpperCase() === normalized
  );
  if (!position) return null;
  return {
    symbol: position.symbol,
    side: position.side,
    size: position.size,
  };
}

function evaluatePaperReduceOnlyPostcondition(params: {
  symbol: string;
  before: { symbol: string; side: 'long' | 'short'; size: number } | null;
  after: { symbol: string; side: 'long' | 'short'; size: number } | null;
}) {
  const beforeSize = params.before?.size ?? 0;
  const afterSize = params.after?.size ?? 0;
  const sideFlipped =
    params.before != null &&
    params.after != null &&
    params.before.side !== params.after.side &&
    afterSize > 0;
  const reduced = afterSize < beforeSize;
  const closeComplete = beforeSize > 0 && afterSize === 0;
  const verified = reduced && !sideFlipped;
  const reason = verified
    ? closeComplete
      ? 'position_flat'
      : 'position_reduced'
    : sideFlipped
      ? 'side_flip_detected'
      : beforeSize <= 0
        ? 'no_position_before'
        : 'size_not_reduced';

  return {
    verified,
    reason,
    close_complete: closeComplete,
    reduced,
    before_size: beforeSize,
    after_size: afterSize,
    before_side: params.before?.side ?? null,
    after_side: params.after?.side ?? null,
    symbol: params.symbol,
  };
}

type TradeArchetype = 'scalp' | 'intraday' | 'swing';

function parseNewsSources(input: unknown): string[] | null {
  if (Array.isArray(input)) {
    const values = input
      .map((entry) => String(entry ?? '').trim())
      .filter((entry) => entry.length > 0);
    return values.length > 0 ? values : null;
  }
  if (typeof input === 'string') {
    const values = input
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return values.length > 0 ? values : null;
  }
  return null;
}

function parsePlanContext(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function pickPlanContextString(planContext: Record<string, unknown> | null, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = toOptionalNonEmptyString(planContext?.[key]);
    if (value) return value;
  }
  return null;
}

function inferPerpStrategySource(planContext: Record<string, unknown> | null, hypothesisId: string | null): string | null {
  const explicit = pickPlanContextString(planContext, 'strategySource', 'strategy_source', 'source');
  if (explicit) return explicit;
  if (hypothesisId?.includes('news')) return 'discovery_news';
  if (hypothesisId) return 'discovery_quant';
  return null;
}

function inferPerpSession(planContext: Record<string, unknown> | null): string | null {
  return pickPlanContextString(planContext, 'session', 'sessionTag', 'session_tag');
}

function inferPerpTriggerReason(
  planContext: Record<string, unknown> | null,
  entryTrigger: 'news' | 'technical' | 'hybrid' | null
): string | null {
  return (
    pickPlanContextString(planContext, 'triggerReason', 'trigger_reason', 'entryReason', 'entry_reason') ??
    entryTrigger
  );
}

function inferPerpSymbolClass(symbol: string, planContext: Record<string, unknown> | null): string | null {
  const explicit = pickPlanContextString(planContext, 'symbolClass', 'symbol_class');
  if (explicit) return explicit;
  const normalized = symbol.trim().toUpperCase();
  if (normalized.endsWith('BTC') || normalized === 'BTC') return 'major';
  if (normalized.endsWith('ETH') || normalized === 'ETH' || normalized.endsWith('SOL') || normalized === 'SOL') {
    return 'liquid_alt';
  }
  return normalized.length > 0 ? 'alt' : null;
}

function readScopeDirection(
  record: Record<string, unknown> | null | undefined
): 'buy' | 'sell' | null {
  const value = pickPlanContextString(record ?? null, 'direction', 'side');
  return value === 'buy' || value === 'sell' ? value : null;
}

function invertSide(side: 'buy' | 'sell'): 'buy' | 'sell' {
  return side === 'buy' ? 'sell' : 'buy';
}

function toPerpDirection(side: 'buy' | 'sell'): 'long' | 'short' {
  return side === 'buy' ? 'long' : 'short';
}

function resolvePerpLearningScopeContext(params: {
  side: 'buy' | 'sell';
  reduceOnly: boolean;
  entryTrigger: 'news' | 'technical' | 'hybrid' | null;
  planContext: Record<string, unknown> | null;
  closeReference: ReturnType<typeof resolveClosedTradeReference>;
  hypothesisId: string | null;
  symbol: string;
}) {
  const referenceSnapshot =
    params.closeReference?.snapshot && typeof params.closeReference.snapshot === 'object'
      ? (params.closeReference.snapshot as Record<string, unknown>)
      : null;
  const referencePlanContext = params.closeReference?.planContext ?? null;
  return {
    direction:
      readScopeDirection(referenceSnapshot) ??
      (params.closeReference?.side ?? null) ??
      (params.reduceOnly ? invertSide(params.side) : params.side),
    triggerReason:
      pickPlanContextString(referenceSnapshot, 'triggerReason', 'trigger_reason') ??
      pickPlanContextString(referencePlanContext, 'triggerReason', 'trigger_reason') ??
      inferPerpTriggerReason(params.planContext, params.entryTrigger),
    session:
      pickPlanContextString(referenceSnapshot, 'session', 'sessionTag', 'session_tag') ??
      pickPlanContextString(referencePlanContext, 'session', 'sessionTag', 'session_tag') ??
      inferPerpSession(params.planContext),
    strategySource:
      pickPlanContextString(referenceSnapshot, 'strategySource', 'strategy_source') ??
      pickPlanContextString(referencePlanContext, 'strategySource', 'strategy_source') ??
      inferPerpStrategySource(params.planContext, params.hypothesisId),
    symbolClass:
      pickPlanContextString(referenceSnapshot, 'symbolClass', 'symbol_class') ??
      pickPlanContextString(referencePlanContext, 'symbolClass', 'symbol_class') ??
      inferPerpSymbolClass(params.symbol, params.planContext),
    entryTrigger:
      (pickPlanContextString(referenceSnapshot, 'entryTrigger', 'entry_trigger') ??
        pickPlanContextString(referencePlanContext, 'entryTrigger', 'entry_trigger') ??
        params.entryTrigger) as 'news' | 'technical' | 'hybrid' | null,
  };
}

function toOptionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const CANONICAL_SIGNAL_CLASSES = new Set([
  'momentum_breakout',
  'mean_reversion',
  'news_event',
  'liquidation_cascade',
  'unknown',
]);

function toCanonicalSignalClass(value: string | null | undefined): string | null {
  if (!value) return null;
  return CANONICAL_SIGNAL_CLASSES.has(value) ? value : null;
}

function inferSignalClassFromSetupKey(setupKey: string | null): string | null {
  if (!setupKey) return null;
  const normalized = setupKey.trim();
  const colonIndex = normalized.indexOf(':');
  if (colonIndex < 0 || colonIndex >= normalized.length - 1) {
    return null;
  }
  const candidate = normalized.slice(colonIndex + 1).trim();
  return candidate.length > 0 ? candidate : null;
}

function inferSignalClassFromHypothesisId(hypothesisId: string | null): string | null {
  if (!hypothesisId) return null;
  const token = hypothesisId.toLowerCase();
  if (token.includes('_revert') || token.includes('mean_reversion')) return 'mean_reversion';
  if (token.includes('_trend') || token.includes('breakout') || token.includes('momentum')) {
    return 'momentum_breakout';
  }
  if (token.includes('_reflex') || token.includes('liquidation') || token.includes('cascade')) {
    return 'liquidation_cascade';
  }
  if (token.includes('news')) return 'news_event';
  return null;
}

function inferSignalClass(params: {
  explicitSignalClass: string | null;
  toolInput: Record<string, unknown>;
  planContext: Record<string, unknown> | null;
  hypothesisId: string | null;
  entryTrigger: 'news' | 'technical' | 'hybrid' | null;
}): string | null {
  // All LLM-supplied string sources are validated against the canonical set.
  // Non-canonical values (e.g. "scan_trend_follow") fall through to hypothesis inference.
  const explicitCanonical = toCanonicalSignalClass(params.explicitSignalClass);
  if (explicitCanonical) return explicitCanonical;

  const planContextRaw =
    toOptionalNonEmptyString(params.planContext?.signal_class) ??
    toOptionalNonEmptyString(params.planContext?.signalClass);
  const planContextCanonical = toCanonicalSignalClass(planContextRaw);
  if (planContextCanonical) return planContextCanonical;

  const setupKeyRaw =
    inferSignalClassFromSetupKey(toOptionalNonEmptyString(params.toolInput.setup_key)) ??
    inferSignalClassFromSetupKey(toOptionalNonEmptyString(params.toolInput.setupKey)) ??
    inferSignalClassFromSetupKey(toOptionalNonEmptyString(params.planContext?.setup_key)) ??
    inferSignalClassFromSetupKey(toOptionalNonEmptyString(params.planContext?.setupKey));
  const setupKeyCanonical = toCanonicalSignalClass(setupKeyRaw);
  if (setupKeyCanonical) return setupKeyCanonical;

  const inferredFromHypothesis = inferSignalClassFromHypothesisId(params.hypothesisId);
  if (inferredFromHypothesis) return inferredFromHypothesis;

  if (params.entryTrigger === 'news') return 'news_event';
  return null;
}

function toFiniteNumberOrNull(input: unknown): number | null {
  const value = Number(input);
  return Number.isFinite(value) ? value : null;
}

function buildPerpTradeSnapshot(params: {
  capturedAtMs: number;
  bookMode: PerpBookMode;
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  requestedSize: number;
  reduceOnly: boolean;
  markPrice: number | null;
  hypothesisId: string | null;
  direction?: 'buy' | 'sell' | 'long' | 'short' | null;
  strategySource?: string | null;
  triggerReason?: string | null;
  signalClass: string | null;
  symbolClass?: string | null;
  session?: string | null;
  marketRegime: string | null;
  volatilityBucket: string | null;
  liquidityBucket: string | null;
  expectedEdge: number | null;
  entryTrigger: 'news' | 'technical' | 'hybrid' | null;
  newsSubtype: string | null;
  newsSources: string[] | null;
  noveltyScore: number | null;
  marketConfirmationScore: number | null;
  thesisExpiresAtMs: number | null;
  invalidationPrice: number | null;
  timeStopAtMs: number | null;
  tradeArchetype: TradeArchetype | null;
  planContext: Record<string, unknown> | null;
  reasoning: string | null;
  estimatedNotionalUsd: number | null;
  estimatedFeeUsd: number | null;
  lifecycleTradeId?: number | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  pricePathHigh?: number | null;
  pricePathLow?: number | null;
  capturedR?: number | null;
  leftOnTableR?: number | null;
}): Record<string, unknown> {
  return {
    createdAtMs: params.capturedAtMs,
    createdAtIso: new Date(params.capturedAtMs).toISOString(),
    executionMode: params.bookMode,
    symbol: params.symbol,
    side: params.side,
    requestedSize: params.requestedSize,
    effectiveSize: params.size,
    reduceOnly: params.reduceOnly,
    tradeId: params.lifecycleTradeId ?? null,
    markPrice: params.markPrice,
    hypothesisId: params.hypothesisId,
    direction: params.direction ?? null,
    strategySource: params.strategySource ?? null,
    triggerReason: params.triggerReason ?? null,
    signalClass: params.signalClass,
    symbolClass: params.symbolClass ?? null,
    session: params.session ?? null,
    marketRegime: params.marketRegime,
    volatilityBucket: params.volatilityBucket,
    liquidityBucket: params.liquidityBucket,
    expectedEdge: params.expectedEdge,
    entryTrigger: params.entryTrigger,
    newsSubtype: params.newsSubtype,
    newsSources: params.newsSources,
    noveltyScore: params.noveltyScore,
    marketConfirmationScore: params.marketConfirmationScore,
    thesisExpiresAtMs: params.thesisExpiresAtMs,
    invalidationPrice: params.invalidationPrice,
    timeStopAtMs: params.timeStopAtMs,
    tradeArchetype: params.tradeArchetype,
    entryPrice: params.entryPrice ?? null,
    exitPrice: params.exitPrice ?? null,
    pricePathHigh: params.pricePathHigh ?? null,
    pricePathLow: params.pricePathLow ?? null,
    capturedR: params.capturedR ?? null,
    leftOnTableR: params.leftOnTableR ?? null,
    estimatedNotionalUsd: params.estimatedNotionalUsd,
    estimatedFeeUsd: params.estimatedFeeUsd,
    reasoning: params.reasoning,
    planContext: params.planContext,
  };
}

function persistPerpTradeEvidence(params: {
  symbol: string;
  fingerprint: string;
  outcome: 'executed' | 'failed' | 'blocked';
  snapshot: Record<string, unknown>;
  signalClass: string | null;
  confidence: number | null;
}): void {
  storeDecisionArtifact({
    source: 'perps',
    kind: 'perp_trade_snapshot',
    marketId: params.symbol,
    fingerprint: params.fingerprint,
    outcome: params.outcome,
    confidence: params.confidence,
    payload: params.snapshot,
    notes: { signalClass: params.signalClass },
  });
}

function persistExecutionLearningCase(params: {
  symbol: string;
  fingerprint: string;
  learningCase: ReturnType<typeof buildPerpExecutionLearningCase>;
  signalClass: string | null;
}) {
  const stored = createLearningCase(toPerpExecutionLearningCaseInput(params.learningCase));
  storeDecisionArtifact({
    source: 'perps',
    kind: 'execution_learning_case',
    marketId: params.symbol,
    fingerprint: params.fingerprint,
    outcome: 'executed',
    payload: params.learningCase,
    notes: {
      signalClass: params.signalClass,
      track: 'execution_quality',
      persistence: 'decision_artifacts_compat',
    },
  });
  return stored;
}

type ReduceOnlyPositionSnapshot = {
  side: 'long' | 'short';
  size: number;
};

type PerpCloseResolutionSummary = {
  netRealizedPnlUsd: number | null;
  realizedPnlUsd: number | null;
  feeUsd: number | null;
  orderId: number | string | null;
  fillCount: number | null;
  basis: 'paper_executor' | 'live_fill_lookup';
};

async function getPerpPositionSnapshotForLifecycle(params: {
  config: ThufirConfig;
  symbol: string;
  mode: 'live' | 'paper';
  isNativePaperExecutor: boolean;
  paperInitialCashUsdc: number;
}): Promise<ReduceOnlyPositionSnapshot | null> {
  const { config, symbol, mode, isNativePaperExecutor, paperInitialCashUsdc } = params;
  if (mode === 'paper' && isNativePaperExecutor) {
    return getPaperPositionSnapshot(symbol, paperInitialCashUsdc);
  }
  try {
    return await getReduceOnlyPositionSnapshot(config, symbol);
  } catch {
    return null;
  }
}

async function getReduceOnlyPositionSnapshot(
  config: ThufirConfig,
  symbol: string
): Promise<ReduceOnlyPositionSnapshot | null> {
  const client = new HyperliquidClient(config);
  const state = (await client.getClearinghouseState()) as {
    assetPositions?: Array<{ position?: Record<string, unknown> }>;
  };
  const target = symbol.trim().toUpperCase();
  for (const entry of state.assetPositions ?? []) {
    const position = entry?.position ?? {};
    const coin = String((position as { coin?: unknown }).coin ?? '')
      .trim()
      .toUpperCase();
    if (!coin || coin !== target) {
      continue;
    }
    const rawSize = Number((position as { szi?: unknown }).szi ?? NaN);
    if (!Number.isFinite(rawSize) || rawSize === 0) {
      return null;
    }
    return {
      side: rawSize > 0 ? 'long' : 'short',
      size: Math.abs(rawSize),
    };
  }
  return null;
}

async function maybeResolvePerpPredictionFromClose(params: {
  ctx: ToolExecutorContext;
  mode: 'live' | 'paper';
  symbol: string;
  reduceOnly: boolean;
  positionBefore: ReduceOnlyPositionSnapshot | null;
  positionAfter: ReduceOnlyPositionSnapshot | null;
  linkedPredictionId?: string | null;
}): Promise<void> {
  if (!params.reduceOnly || params.positionBefore == null) {
    return;
  }
  if (params.positionAfter != null && (params.positionAfter.size ?? 0) > 0) {
    return;
  }

  const openPrediction =
    (params.linkedPredictionId
      ? findOpenPerpPredictionById(params.linkedPredictionId, params.symbol)
      : null) ?? findOpenPerpPrediction(params.symbol);
  if (!openPrediction) {
    return;
  }

  const closeSummary = await resolvePerpCloseSummary({
    ctx: params.ctx,
    mode: params.mode,
    symbol: params.symbol,
    predictionCreatedAt: openPrediction.createdAt,
  });
  if (closeSummary.netRealizedPnlUsd == null || !Number.isFinite(closeSummary.netRealizedPnlUsd)) {
    return;
  }

  const thesisWorked = closeSummary.netRealizedPnlUsd > 0;
  const outcome = thesisWorked
    ? openPrediction.predictedOutcome
    : (openPrediction.predictedOutcome === 'YES' ? 'NO' : 'YES');

  recordOutcome({
    id: openPrediction.id,
    outcome,
    outcomeBasis: 'final',
    pnl: closeSummary.netRealizedPnlUsd,
    resolutionMetadata: {
      basis: 'realized_net_pnl_close',
      symbol: params.symbol,
      closeBasis: closeSummary.basis,
      realizedPnlUsd: closeSummary.realizedPnlUsd,
      feeUsd: closeSummary.feeUsd,
      netRealizedPnlUsd: closeSummary.netRealizedPnlUsd,
      orderId: closeSummary.orderId,
      fillCount: closeSummary.fillCount,
      resolvedAt: new Date().toISOString(),
    },
  });
}

async function resolvePerpCloseSummary(params: {
  ctx: ToolExecutorContext;
  mode: 'live' | 'paper';
  symbol: string;
  predictionCreatedAt: string;
}): Promise<PerpCloseResolutionSummary> {
  const predictionStartMs = parseTimestampMs(params.predictionCreatedAt);
  const effectiveStartMs = Number.isFinite(predictionStartMs)
    ? Math.max(0, predictionStartMs - 5_000)
    : Date.now() - 86_400_000;

  if (params.mode === 'paper') {
    const fills = listPaperPerpFills(
      { symbol: params.symbol, limit: 100 },
      params.ctx.config.paper?.initialCashUsdc ?? 200
    ).filter((fill) => parseTimestampMs(fill.createdAt) >= effectiveStartMs);
    if (fills.length === 0) {
      return {
        netRealizedPnlUsd: null,
        realizedPnlUsd: null,
        feeUsd: null,
        orderId: null,
        fillCount: 0,
        basis: 'paper_executor',
      };
    }
    const realizedPnlUsd = fills.reduce((sum, fill) => sum + fill.realizedPnlUsd, 0);
    const feeUsd = fills.reduce((sum, fill) => sum + fill.feeUsd, 0);
    const latestFill = fills.reduce((acc, fill) =>
      parseTimestampMs(fill.createdAt) > parseTimestampMs(acc.createdAt) ? fill : acc
    );
    return {
      netRealizedPnlUsd: realizedPnlUsd - feeUsd,
      realizedPnlUsd,
      feeUsd,
      orderId: latestFill.orderId,
      fillCount: fills.length,
      basis: 'paper_executor',
    };
  }

  const liveSummary = await fetchRealizedPerpCloseSummary(params.ctx, {
    symbol: params.symbol,
    startTimeMs: effectiveStartMs,
  });
  return {
    netRealizedPnlUsd: liveSummary.net_realized_pnl_usd,
    realizedPnlUsd: liveSummary.realized_pnl_usd,
    feeUsd: liveSummary.realized_fee_usd,
    orderId: liveSummary.realized_order_id,
    fillCount: liveSummary.realized_fill_count,
    basis: 'live_fill_lookup',
  };
}

async function resolvePerpLifecycleTradeId(params: {
  symbol: string;
  mode: PerpBookMode;
  hypothesisId: string | null;
  leverage: number | null;
  orderType: 'market' | 'limit';
  markPrice: number | null;
  before: ReduceOnlyPositionSnapshot | null;
  after: ReduceOnlyPositionSnapshot | null;
}): Promise<number | null> {
  const symbol = params.symbol.trim().toUpperCase();
  if (!symbol) return null;

  const openSide = (side: 'long' | 'short'): 'buy' | 'sell' => (side === 'long' ? 'buy' : 'sell');
  const ensureActiveTradeId = (side: 'long' | 'short'): number => {
    const existing = getActivePerpPositionTradeId(symbol);
    if (existing && existing > 0) {
      return existing;
    }
    const tradeId = recordPerpTrade({
      hypothesisId: params.hypothesisId,
      symbol,
      side: openSide(side),
      size: params.after?.size ?? params.before?.size ?? 0,
      executionMode: params.mode,
      price: params.markPrice,
      leverage: params.leverage,
      orderType: params.orderType,
      status: 'position_open',
    });
    setActivePerpPositionLifecycle({ symbol, tradeId, side });
    return tradeId;
  };

  const before = params.before;
  const after = params.after;

  if (before && after && before.side !== after.side) {
    clearActivePerpPositionLifecycle(symbol);
    return ensureActiveTradeId(after.side);
  }

  if (after) {
    return ensureActiveTradeId(after.side);
  }

  if (before) {
    const existing = getActivePerpPositionTradeId(symbol);
    if (existing && existing > 0) {
      clearActivePerpPositionLifecycle(symbol);
      return existing;
    }
    return null;
  }

  clearActivePerpPositionLifecycle(symbol);
  return null;
}

function resolveClosedTradeReference(params: {
  entries: ReturnType<typeof listPerpTradeJournals>;
  symbol: string;
  hypothesisId: string | null;
  closeSide: 'buy' | 'sell';
}) {
  for (const entry of params.entries) {
    if (entry.symbol !== params.symbol) continue;
    if (entry.reduceOnly === true) continue;
    if (entry.outcome !== 'executed') continue;
    if (params.hypothesisId && entry.hypothesisId !== params.hypothesisId) continue;
    if (!params.hypothesisId && entry.side && entry.side === params.closeSide) continue;
    return entry;
  }
  return null;
}

export function normalizeExitMode(input: unknown): PerpExitMode | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (
    value === 'thesis_invalidation' ||
    value === 'take_profit' ||
    value === 'time_exit' ||
    value === 'risk_reduction' ||
    value === 'manual' ||
    value === 'unknown'
  ) {
    return value;
  }
  return null;
}

function normalizeTradeArchetype(input: unknown): TradeArchetype | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (value === 'scalp' || value === 'intraday' || value === 'swing') {
    return value;
  }
  return null;
}

function validatePerpOrderContract(input: {
  reduceOnly: boolean;
  thesisInvalidationHit: boolean | null;
  exitMode: PerpExitMode | null;
  tradeArchetype: TradeArchetype | null;
  enforceReduceOnlyExitMode: boolean;
}): string | null {
  const { reduceOnly, thesisInvalidationHit, exitMode, tradeArchetype, enforceReduceOnlyExitMode } = input;

  if (!reduceOnly) {
    if (thesisInvalidationHit === true) {
      return 'thesis_invalidation_hit=true conflicts with non-reduce-only order';
    }
    if (exitMode != null && exitMode !== 'unknown') {
      return 'non-reduce-only order must not set exit_mode';
    }
    if (!tradeArchetype) {
      return 'Missing/invalid trade_archetype (scalp|intraday|swing)';
    }
    return null;
  }

  if (thesisInvalidationHit === true && exitMode != null && exitMode !== 'thesis_invalidation') {
    return 'thesis_invalidation_hit=true conflicts with non-invalidation exit_mode';
  }
  if (thesisInvalidationHit === false && exitMode === 'thesis_invalidation') {
    return 'thesis_invalidation exit_mode requires thesis_invalidation_hit=true';
  }
  if (enforceReduceOnlyExitMode && thesisInvalidationHit !== true && exitMode == null) {
    return 'reduce-only exit requires exit_mode (thesis_invalidation|take_profit|time_exit|risk_reduction|manual|unknown)';
  }
  return null;
}

export function evaluateReduceOnlyExitAssessment(params: {
  reduceOnly: boolean;
  thesisInvalidationHit: boolean | null;
  exitMode: PerpExitMode | null;
}): {
  thesisCorrect: boolean | null;
  thesisInvalidationHit: boolean | null;
  exitMode: PerpExitMode | null;
  emotionalExitFlag: boolean | null;
  thesisEvaluationReason: string | null;
} {
  if (!params.reduceOnly) {
    return {
      thesisCorrect: null,
      thesisInvalidationHit: null,
      exitMode: null,
      emotionalExitFlag: null,
      thesisEvaluationReason: null,
    };
  }

  const normalizedExitMode =
    params.exitMode ?? (params.thesisInvalidationHit === true ? 'thesis_invalidation' : null);
  const invalidationHit =
    params.thesisInvalidationHit ??
    (normalizedExitMode === 'thesis_invalidation' ? true : null);

  if (invalidationHit === true) {
    return {
      thesisCorrect: false,
      thesisInvalidationHit: true,
      exitMode: normalizedExitMode,
      emotionalExitFlag: false,
      thesisEvaluationReason: 'Exit aligned with explicit thesis invalidation condition.',
    };
  }

  if (invalidationHit === false) {
    const emotional = normalizedExitMode === 'manual' || normalizedExitMode === 'unknown';
    return {
      thesisCorrect: emotional ? false : true,
      thesisInvalidationHit: false,
      exitMode: normalizedExitMode,
      emotionalExitFlag: emotional,
      thesisEvaluationReason: emotional
        ? 'Exited before invalidation via discretionary/manual action.'
        : 'Exited without invalidation via planned management rule.',
    };
  }

  if (normalizedExitMode === 'manual' || normalizedExitMode === 'unknown') {
    return {
      thesisCorrect: false,
      thesisInvalidationHit: null,
      exitMode: normalizedExitMode,
      emotionalExitFlag: true,
      thesisEvaluationReason: 'Reduce-only exit lacked invalidation proof and appears discretionary.',
    };
  }

  if (
    normalizedExitMode === 'take_profit' ||
    normalizedExitMode === 'time_exit' ||
    normalizedExitMode === 'risk_reduction'
  ) {
    return {
      thesisCorrect: true,
      thesisInvalidationHit: false,
      exitMode: normalizedExitMode,
      emotionalExitFlag: false,
      thesisEvaluationReason: 'Reduce-only exit matched a deterministic management rule.',
    };
  }

  return {
    thesisCorrect: null,
    thesisInvalidationHit: null,
    exitMode: normalizedExitMode,
    emotionalExitFlag: null,
    thesisEvaluationReason: null,
  };
}

function getSystemToolPolicy(config: ThufirConfig): SystemToolPolicy {
  const settings = config.agent?.systemTools;
  const allowedCommands = Array.isArray(settings?.allowedCommands)
    ? settings.allowedCommands
    : ['node', 'npm', 'pnpm', 'bun', 'qmd'];
  const allowedManagersRaw = Array.isArray(settings?.allowedManagers)
    ? settings.allowedManagers
    : ['pnpm', 'npm', 'bun'];
  const allowedManagers = new Set<InstallManager>(
    allowedManagersRaw.filter((manager): manager is InstallManager =>
      manager === 'npm' || manager === 'pnpm' || manager === 'bun'
    )
  );

  return {
    enabled: settings?.enabled ?? false,
    allowedCommands: new Set(
      allowedCommands
        .map((command) => command.trim())
        .filter((command) => command.length > 0)
    ),
    allowedManagers,
    allowGlobalInstall: settings?.allowGlobalInstall ?? false,
    timeoutMs: Math.min(Math.max(settings?.timeoutMs ?? 120000, 1000), 10 * 60 * 1000),
    maxOutputChars: Math.min(Math.max(settings?.maxOutputChars ?? 12000, 1000), 200000),
  };
}

function isSafeCommandName(command: string): boolean {
  if (!command) return false;
  if (command.includes('/') || command.includes('\\')) return false;
  return /^[a-zA-Z0-9._-]+$/.test(command);
}

function isSafePackageSpec(spec: string): boolean {
  if (!spec) return false;
  if (spec.length > 150) return false;
  return /^[a-zA-Z0-9@._/:+\-#~]+$/.test(spec);
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    maxOutputChars: number;
    cwd?: string;
  }
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      cwd: options.cwd,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let done = false;
    let timedOut = false;

    const trimToLimit = (text: string): string => {
      if (text.length <= options.maxOutputChars) return text;
      return text.slice(text.length - options.maxOutputChars);
    };

    const finish = (exitCode: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: trimToLimit(stdout),
        stderr: trimToLimit(stderr),
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > options.maxOutputChars * 2) {
        stdout = stdout.slice(stdout.length - options.maxOutputChars * 2);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > options.maxOutputChars * 2) {
        stderr = stderr.slice(stderr.length - options.maxOutputChars * 2);
      }
    });

    child.on('error', (error) => {
      stderr += error.message;
      finish(1);
    });

    child.on('close', (code) => {
      finish(code ?? 0);
    });
  });
}

export async function executeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'agent_incidents_recent': {
        const limit = Math.max(1, Math.min(200, Number(toolInput.limit ?? 20) || 20));
        const incidents = listRecentAgentIncidents(limit);
        return { success: true, data: { incidents } };
      }

      case 'playbook_search': {
        const query = String(toolInput.query ?? '').trim();
        if (!query) return { success: false, error: 'Missing query' };
        const limit = Math.max(1, Math.min(50, Number(toolInput.limit ?? 8) || 8));
        const results = searchPlaybooks({ query, limit });
        return { success: true, data: { results } };
      }

      case 'playbook_get': {
        const key = String(toolInput.key ?? '').trim();
        if (!key) return { success: false, error: 'Missing key' };
        const playbook = getPlaybook(key);
        if (!playbook) return { success: false, error: `Playbook not found: ${key}` };
        return { success: true, data: playbook };
      }

      case 'playbook_upsert': {
        const key = String(toolInput.key ?? '').trim();
        const title = String(toolInput.title ?? '').trim();
        const content = String(toolInput.content ?? '').trim();
        const tags = Array.isArray(toolInput.tags) ? toolInput.tags.map(String) : [];
        if (!key || !title || !content) {
          return { success: false, error: 'Missing key/title/content' };
        }
        upsertPlaybook({ key, title, content, tags });
        return { success: true, data: { upserted: true, key } };
      }

      case 'hyperliquid_verify_live': {
        if (ctx.config.execution?.mode === 'paper') {
          return {
            success: false,
            error: 'Tool unavailable in paper mode: hyperliquid_verify_live.',
          };
        }
        const symbol = String(toolInput.symbol ?? 'BTC').trim().toUpperCase();
        const client = new HyperliquidClient(ctx.config);
        const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

        try {
          const markets = await client.listPerpMarkets();
          const hasSymbol = markets.some((m) => m.symbol === symbol);
          checks.push({
            name: 'Perp markets',
            ok: markets.length > 0,
            detail: `loaded ${markets.length} market(s)`,
          });
          checks.push({
            name: `Symbol ${symbol}`,
            ok: hasSymbol,
            detail: hasSymbol ? 'found in market metadata' : 'not found in market metadata',
          });
        } catch (error) {
          checks.push({
            name: 'Perp markets',
            ok: false,
            detail: error instanceof Error ? error.message : 'unknown error',
          });
        }

        try {
          const mids = await client.getAllMids();
          const mid = mids[symbol];
          checks.push({
            name: 'Mid prices',
            ok: Object.keys(mids).length > 0,
            detail:
              typeof mid === 'number'
                ? `${symbol} mid=${mid}`
                : `${Object.keys(mids).length} symbol(s) loaded`,
          });
        } catch (error) {
          checks.push({
            name: 'Mid prices',
            ok: false,
            detail: error instanceof Error ? error.message : 'unknown error',
          });
        }

        const accountAddress = client.getAccountAddress();
        if (accountAddress) {
          try {
            const state = await client.getClearinghouseState();
            const stateKeys =
              state && typeof state === 'object'
                ? Object.keys(state as Record<string, unknown>).length
                : 0;
            checks.push({
              name: 'Account state',
              ok: true,
              detail: `loaded for ${accountAddress.slice(0, 10)}... (${stateKeys} field(s))`,
            });
          } catch (error) {
            checks.push({
              name: 'Account state',
              ok: false,
              detail: error instanceof Error ? error.message : 'unknown error',
            });
          }

          try {
            const openOrders = await client.getOpenOrders();
            checks.push({
              name: 'Open orders',
              ok: Array.isArray(openOrders),
              detail: Array.isArray(openOrders)
                ? `${openOrders.length} open order(s)`
                : 'unexpected payload shape',
            });
          } catch (error) {
            checks.push({
              name: 'Open orders',
              ok: false,
              detail: error instanceof Error ? error.message : 'unknown error',
            });
          }

          try {
            client.getExchangeClient();
            checks.push({
              name: 'Exchange signer',
              ok: true,
              detail: 'private key loaded',
            });
          } catch (error) {
            checks.push({
              name: 'Exchange signer',
              ok: false,
              detail: error instanceof Error ? error.message : 'unknown error',
            });
          }
        } else {
          checks.push({
            name: 'Account state',
            ok: false,
            detail:
              'missing HYPERLIQUID_ACCOUNT_ADDRESS/HYPERLIQUID_PRIVATE_KEY (required for authenticated checks)',
          });
          checks.push({
            name: 'Open orders',
            ok: false,
            detail:
              'missing HYPERLIQUID_ACCOUNT_ADDRESS/HYPERLIQUID_PRIVATE_KEY (required for authenticated checks)',
          });
          checks.push({
            name: 'Exchange signer',
            ok: false,
            detail: 'missing HYPERLIQUID_PRIVATE_KEY',
          });
        }

        const ok = checks.every((c) => c.ok);
        return { success: true, data: { ok, checks } };
      }

      case 'hyperliquid_order_roundtrip': {
        if (ctx.config.execution?.mode === 'paper') {
          return {
            success: false,
            error: 'Tool unavailable in paper mode: hyperliquid_order_roundtrip.',
          };
        }
        const symbol = String(toolInput.symbol ?? 'BTC').trim().toUpperCase();
        const size = Number(toolInput.size ?? 0);
        const side = String(toolInput.side ?? 'buy').trim().toLowerCase() === 'sell' ? 'sell' : 'buy';
        const priceOffsetBps = Number(toolInput.price_offset_bps ?? 5000); // 50% away by default
        if (!Number.isFinite(size) || size <= 0) {
          return { success: false, error: 'Missing or invalid size' };
        }

        const client = new HyperliquidClient(ctx.config);
        const exchange = client.getExchangeClient();
        const markets = await client.listPerpMarkets();
        const marketMeta = markets.find((m) => m.symbol === symbol);
        if (!marketMeta) {
          return { success: false, error: `Unknown Hyperliquid symbol: ${symbol}` };
        }

        const mids = await client.getAllMids();
        const mid = mids[symbol];
        if (typeof mid !== 'number' || !Number.isFinite(mid) || mid <= 0) {
          return { success: false, error: `Missing mid price for ${symbol}` };
        }

        const bps = Math.max(100, Math.min(9000, Number.isFinite(priceOffsetBps) ? priceOffsetBps : 5000));
        const offset = bps / 10000;
        const limitPx = side === 'buy' ? mid * (1 - offset) : mid * (1 + offset);

        const formatDecimal = (value: number, decimals: number): string => {
          const fixed = value.toFixed(decimals);
          return fixed.replace(/\.?0+$/, '');
        };

        const sizeStr = formatDecimal(size, marketMeta.szDecimals ?? 6);
        const priceStr = formatDecimal(limitPx, 8);

        const result = await exchange.order({
          orders: [
            {
              a: marketMeta.assetId,
              b: side === 'buy',
              p: priceStr,
              s: sizeStr,
              r: false,
              t: { limit: { tif: 'Gtc' } },
            },
          ],
          grouping: 'na',
        } as any);

        const status = (result as any)?.response?.data?.statuses?.[0];
        const oid =
          status && typeof status === 'object' && 'resting' in status
            ? (status as any)?.resting?.oid
            : status && typeof status === 'object' && 'filled' in status
              ? (status as any)?.filled?.oid
              : null;

        if (!oid) {
          return { success: false, error: 'Order did not return an order id (oid)' };
        }

        // Cancel immediately.
        await exchange.cancel({ cancels: [{ a: marketMeta.assetId, o: Number(oid) }] } as any);

        // Verify it is not present anymore (best-effort).
        let stillOpen: boolean | null = null;
        try {
          const openOrders = await client.getOpenOrders();
          if (Array.isArray(openOrders)) {
            stillOpen = openOrders.some((o) => Number((o as any)?.oid) === Number(oid));
          }
        } catch {
          stillOpen = null;
        }

        return {
          success: true,
          data: {
            symbol,
            side,
            size: Number(sizeStr),
            mid,
            limitPx,
            oid: String(oid),
            cancelled: true,
            stillOpen,
          },
        };
      }

      case 'hyperliquid_usd_class_transfer': {
        if (ctx.config.execution?.mode === 'paper') {
          return {
            success: false,
            error: 'Tool unavailable in paper mode: hyperliquid_usd_class_transfer.',
          };
        }
        const amountUsdc = Number(toolInput.amount_usdc ?? 0);
        const to = String(toolInput.to ?? '').trim().toLowerCase();
        if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
          return { success: false, error: 'Invalid amount_usdc' };
        }
        if (to !== 'perp' && to !== 'spot') {
          return { success: false, error: 'Invalid to (use perp|spot)' };
        }

        const formatDecimal = (value: number, decimals: number): string => {
          const fixed = value.toFixed(decimals);
          return fixed.replace(/\.?0+$/, '');
        };

        const client = new HyperliquidClient(ctx.config);
        const exchange = client.getExchangeClient();
        const amountStr = formatDecimal(amountUsdc, 6);
        const toPerp = to === 'perp';

        // Hyperliquid Exchange: usdClassTransfer({ amount: "1", toPerp: true })
        const result = await (exchange as any).usdClassTransfer({ amount: amountStr, toPerp });

        return {
          success: true,
          data: {
            amount_usdc: Number(amountStr),
            to,
            result,
          },
        };
      }

      case 'evm_erc20_balance': {
        if (ctx.config.execution?.mode === 'paper') {
          return {
            success: false,
            error: 'Tool unavailable in paper mode: evm_erc20_balance.',
          };
        }
        const chain = String(toolInput.chain ?? '').trim().toLowerCase() as EvmChain;
        if (chain !== 'polygon' && chain !== 'arbitrum') {
          return { success: false, error: 'Invalid chain (use polygon|arbitrum)' };
        }
        const rpc = String(toolInput.rpc_url ?? '').trim() || getRpcUrl(ctx.config, chain);
        if (!rpc) return { success: false, error: `Missing RPC for ${chain}` };
        const provider = new ethers.providers.JsonRpcProvider(rpc);
        const token =
          String(toolInput.token_address ?? '').trim() || getUsdcConfig(ctx.config, chain).address;
        const owner = String(toolInput.address ?? '').trim();
        if (!token) return { success: false, error: 'Missing token_address' };
        if (!owner) return { success: false, error: 'Missing address' };
        const bal = await getErc20Balance({ provider, token, owner });
        return {
          success: true,
          data: {
            chain,
            token,
            owner,
            balance: Number(bal.formatted),
            decimals: bal.decimals,
            raw: bal.raw,
          },
        };
      }

      case 'evm_usdc_balances': {
        if (ctx.config.execution?.mode === 'paper') {
          return {
            success: false,
            error: 'Tool unavailable in paper mode: evm_usdc_balances.',
          };
        }
        let address = String(toolInput.address ?? '').trim();
        if (!address) {
          // Read address from keystore without decrypting the private key.
          const path =
            ctx.config.wallet?.keystorePath ??
            process.env.THUFIR_KEYSTORE_PATH ??
            `${process.env.HOME ?? ''}/.thufir/keystore.json`;
          const store = loadKeystore(path);
          address = String(store.address ?? '').trim();
        }
        if (!address) return { success: false, error: 'Missing address (and keystore has no address)' };
        const chains: EvmChain[] = ['polygon', 'arbitrum'];
        const results: Record<string, unknown> = {};
        for (const chain of chains) {
          const rpc = getRpcUrl(ctx.config, chain);
          if (!rpc) {
            results[chain] = { ok: false, error: `Missing RPC for ${chain}` };
            continue;
          }
          const provider = new ethers.providers.JsonRpcProvider(rpc);
          const usdc = getUsdcConfig(ctx.config, chain);
          try {
            const [native, erc20] = await Promise.all([
              provider.getBalance(address),
              getErc20Balance({ provider, token: usdc.address, owner: address }),
            ]);
            results[chain] = {
              ok: true,
              rpc,
              native: Number(ethers.utils.formatEther(native)),
              usdc: Number(erc20.formatted),
              usdcAddress: usdc.address,
            };
          } catch (error) {
            results[chain] = {
              ok: false,
              rpc,
              error: error instanceof Error ? error.message : 'Unknown error',
            };
          }
        }
        return { success: true, data: { address, results } };
      }

      case 'cctp_bridge_usdc': {
        if (ctx.config.execution?.mode === 'paper') {
          return {
            success: false,
            error: 'Tool unavailable in paper mode: cctp_bridge_usdc.',
          };
        }
        const fromChain = String(toolInput.from_chain ?? 'polygon').trim().toLowerCase() as EvmChain;
        const toChain = String(toolInput.to_chain ?? 'arbitrum').trim().toLowerCase() as EvmChain;
        const amountUsdc = Number(toolInput.amount_usdc ?? 0);
        const recipient = toolInput.recipient ? String(toolInput.recipient) : undefined;
        if (!['polygon', 'arbitrum'].includes(fromChain) || !['polygon', 'arbitrum'].includes(toChain)) {
          return { success: false, error: 'Invalid from_chain/to_chain' };
        }
        const password = process.env.THUFIR_WALLET_PASSWORD ?? '';
        if (!password) {
          return { success: false, error: 'Missing THUFIR_WALLET_PASSWORD (required for signing)' };
        }
        const path =
          ctx.config.wallet?.keystorePath ??
          process.env.THUFIR_KEYSTORE_PATH ??
          `${process.env.HOME ?? ''}/.thufir/keystore.json`;
        const store = loadKeystore(path);
        const { decryptPrivateKey } = await import('../execution/wallet/keystore.js');
        const privateKey = decryptPrivateKey(store, password);

        const res = await cctpV1BridgeUsdc({
          config: ctx.config,
          privateKey,
          fromChain,
          toChain,
          amountUsdc,
          recipient,
          pollSeconds: toolInput.poll_seconds ? Number(toolInput.poll_seconds) : undefined,
          maxWaitSeconds: toolInput.max_wait_seconds ? Number(toolInput.max_wait_seconds) : undefined,
        });
        return { success: true, data: res };
      }

      case 'hyperliquid_deposit_usdc': {
        const amountUsdc = Number(toolInput.amount_usdc ?? 0);
        if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
          return { success: false, error: 'Invalid amount_usdc' };
        }
        const password = process.env.THUFIR_WALLET_PASSWORD ?? '';
        if (!password) {
          return { success: false, error: 'Missing THUFIR_WALLET_PASSWORD (required for signing)' };
        }
        const chain: EvmChain = 'arbitrum';
        const rpc = getRpcUrl(ctx.config, chain);
        if (!rpc) {
          return {
            success: false,
            error: 'Missing Arbitrum RPC (THUFIR_EVM_RPC_ARBITRUM or config.evm.rpcUrls.arbitrum)',
          };
        }
        const path =
          ctx.config.wallet?.keystorePath ??
          process.env.THUFIR_KEYSTORE_PATH ??
          `${process.env.HOME ?? ''}/.thufir/keystore.json`;
        const store = loadKeystore(path);
        const { decryptPrivateKey } = await import('../execution/wallet/keystore.js');
        const privateKey = decryptPrivateKey(store, password);
        const provider = new ethers.providers.JsonRpcProvider(rpc);
        const wallet = new ethers.Wallet(privateKey, provider);

        const depositAddress =
          String(toolInput.deposit_address ?? '').trim() ||
          String(ctx.config.hyperliquid?.bridge?.depositAddress ?? '').trim();
        if (!depositAddress) {
          return { success: false, error: 'Missing deposit_address' };
        }
        const minDeposit = Number(ctx.config.hyperliquid?.bridge?.minDepositUsdc ?? 5);
        if (amountUsdc < minDeposit) {
          return { success: false, error: `Deposit too small. Minimum is ${minDeposit} USDC.` };
        }

        const usdc = getUsdcConfig(ctx.config, chain);
        const raw = ethers.utils.parseUnits(String(amountUsdc), usdc.decimals);
        const tx = await transferErc20({
          signer: wallet,
          token: usdc.address,
          to: depositAddress,
          amount: raw,
        });
        await provider.waitForTransaction(tx.txHash, 1);

        return {
          success: true,
          data: {
            chain,
            token: usdc.address,
            depositAddress,
            amountUsdc,
            txHash: tx.txHash,
          },
        };
      }

      case 'perp_market_list': {
        const limit = Math.min(Number(toolInput.limit ?? 20), 200);
        const markets = await ctx.marketClient.listMarkets(limit);
        return { success: true, data: formatMarketsForTool(markets) };
      }

      case 'perp_market_get': {
        const symbol = String(toolInput.symbol ?? '');
        if (!symbol) {
          return { success: false, error: 'Missing symbol' };
        }
        try {
          const market = await ctx.marketClient.getMarket(symbol);
          return { success: true, data: formatMarketForTool(market) };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'perp_place_order': {
        if (!ctx.limiter) {
          return { success: false, error: 'Trading is not enabled (no spending limiter configured)' };
        }
        const symbol = String(toolInput.symbol ?? '');
        const bookMode = resolvePerpBookMode(ctx.config, toolInput);
        if (bookMode === 'live') {
          const livePolicyError = validateLiveBookPolicy(ctx.config, symbol);
          if (livePolicyError) {
            return { success: false, error: livePolicyError };
          }
        }
        const perpExecutor = resolvePerpExecutor(ctx, bookMode);
        const isNativePaperExecutor = perpExecutor instanceof PaperExecutor;
        const side = String(toolInput.side ?? '').toLowerCase();
        const requestedSize = Number(toolInput.size ?? 0);
        const orderTypeRaw = String(toolInput.order_type ?? 'market').toLowerCase();
        const orderType: 'market' | 'limit' = orderTypeRaw === 'limit' ? 'limit' : 'market';
        const price = toolInput.price !== undefined ? Number(toolInput.price) : undefined;
        const leverage = toolInput.leverage !== undefined ? Number(toolInput.leverage) : undefined;
        const reduceOnly = Boolean(toolInput.reduce_only ?? false);
        const hypothesisId =
          typeof toolInput.hypothesis_id === 'string' && toolInput.hypothesis_id.trim().length > 0
            ? toolInput.hypothesis_id.trim()
            : null;
        const explicitSignalClass =
          toOptionalNonEmptyString(toolInput.signal_class) ?? toOptionalNonEmptyString(toolInput.signalClass);
        const volatilityBucketRaw =
          typeof toolInput.volatility_bucket === 'string' ? toolInput.volatility_bucket.trim() : '';
        const volatilityBucket =
          volatilityBucketRaw === 'low' || volatilityBucketRaw === 'medium' || volatilityBucketRaw === 'high'
            ? volatilityBucketRaw
            : null;
        const liquidityBucketRaw =
          typeof toolInput.liquidity_bucket === 'string' ? toolInput.liquidity_bucket.trim() : '';
        const liquidityBucket =
          liquidityBucketRaw === 'thin' || liquidityBucketRaw === 'normal' || liquidityBucketRaw === 'deep'
            ? liquidityBucketRaw
            : null;
        const expectedEdge =
          toolInput.expected_edge != null && Number.isFinite(Number(toolInput.expected_edge))
            ? Number(toolInput.expected_edge)
            : null;
        const entryTriggerRaw =
          typeof toolInput.entry_trigger === 'string' ? toolInput.entry_trigger.trim() : '';
        const entryTrigger =
          entryTriggerRaw === 'news' || entryTriggerRaw === 'technical' || entryTriggerRaw === 'hybrid'
            ? entryTriggerRaw
            : null;
        const newsSubtype =
          typeof toolInput.news_subtype === 'string' && toolInput.news_subtype.trim().length > 0
            ? toolInput.news_subtype.trim()
            : null;
        const noveltyScore =
          toolInput.novelty_score != null && Number.isFinite(Number(toolInput.novelty_score))
            ? Number(toolInput.novelty_score)
            : null;
        const marketConfirmationScore =
          toolInput.market_confirmation_score != null &&
          Number.isFinite(Number(toolInput.market_confirmation_score))
            ? Number(toolInput.market_confirmation_score)
            : null;
        const thesisExpiresAtMs =
          toolInput.thesis_expires_at_ms != null &&
          Number.isFinite(Number(toolInput.thesis_expires_at_ms))
            ? Number(toolInput.thesis_expires_at_ms)
            : null;
        let thesisInvalidationHit =
          typeof toolInput.thesis_invalidation_hit === 'boolean'
            ? toolInput.thesis_invalidation_hit
            : null;
        const inputExitMode = normalizeExitMode(toolInput.exit_mode);
        let exitMode: PerpExitMode | null =
          inputExitMode ??
          (reduceOnly
            ? thesisInvalidationHit === true
              ? 'thesis_invalidation'
              : thesisInvalidationHit === false
                ? 'unknown'
                : null
            : null);
        const closeEntryPriceOverride = toFiniteNumberOrNull(toolInput.entry_price);
        const closePathHigh = toFiniteNumberOrNull(toolInput.price_path_high);
        const closePathLow = toFiniteNumberOrNull(toolInput.price_path_low);
        let tradeArchetype = normalizeTradeArchetype(toolInput.trade_archetype);
        const invalidationType =
          typeof toolInput.invalidation_type === 'string' ? toolInput.invalidation_type.trim() : null;
        const invalidationPrice = toFiniteNumberOrNull(toolInput.invalidation_price);
        const timeStopAtMs =
          toolInput.time_stop_at_ms != null && Number.isFinite(Number(toolInput.time_stop_at_ms))
            ? Number(toolInput.time_stop_at_ms)
            : null;
        const rawExitContract = (toolInput as Record<string, unknown>).exit_contract;
        const rawTradeType = (toolInput as Record<string, unknown>).trade_type;
        const legacyTradeType: 'scalp' | 'tactical' | 'structural' | undefined =
          rawTradeType === 'scalp' || rawTradeType === 'tactical' || rawTradeType === 'structural'
            ? rawTradeType
            : undefined;
        const takeProfitR = toFiniteNumberOrNull(toolInput.take_profit_r);
        const trailMode = typeof toolInput.trail_mode === 'string' ? toolInput.trail_mode.trim() : null;
        const emergencyOverride = Boolean(toolInput.emergency_override ?? false);
        const emergencyReason =
          typeof toolInput.emergency_reason === 'string' && toolInput.emergency_reason.trim().length > 0
            ? toolInput.emergency_reason.trim()
            : null;
        const newsSources = parseNewsSources(toolInput.news_sources);
        const newsSourceCount = newsSources?.length ?? null;
        const planContext = parsePlanContext(toolInput.plan_context);
        const signalClass = inferSignalClass({
          explicitSignalClass,
          toolInput,
          planContext,
          hypothesisId,
          entryTrigger,
        });
        if (!reduceOnly && !tradeArchetype) {
          tradeArchetype = 'intraday';
        }
        const marketRegimeRaw =
          typeof toolInput.market_regime === 'string' ? toolInput.market_regime.trim() : '';
        const marketRegime =
          marketRegimeRaw === 'trending' ||
          marketRegimeRaw === 'choppy' ||
          marketRegimeRaw === 'high_vol_expansion' ||
          marketRegimeRaw === 'low_vol_compression'
            ? marketRegimeRaw
            : null;
        const defaultLearningDirection = reduceOnly
          ? toPerpDirection(invertSide(side as 'buy' | 'sell'))
          : toPerpDirection(side as 'buy' | 'sell');
        const defaultTriggerReason = inferPerpTriggerReason(planContext, entryTrigger);
        const defaultSession = inferPerpSession(planContext);
        const defaultStrategySource = inferPerpStrategySource(planContext, hypothesisId);
        const defaultSymbolClass = inferPerpSymbolClass(symbol, planContext);
        const tradeEvidenceBaseFingerprint =
          hypothesisId != null
            ? `${symbol}:${hypothesisId}:${Date.now()}`
            : `${symbol}:${Date.now()}:${randomUUID().slice(0, 8)}`;
        if (!symbol || !requestedSize || (side !== 'buy' && side !== 'sell')) {
          return { success: false, error: 'Missing or invalid order fields' };
        }
        let size = requestedSize;
        let reduceOnlyPreflightNote: string | null = null;
        if (reduceOnly && bookMode === 'live' && ctx.config.execution?.provider === 'hyperliquid') {
          try {
            const position = await getReduceOnlyPositionSnapshot(ctx.config, symbol);
            if (!position) {
              return {
                success: false,
                error: `Reduce-only preflight blocked: no open ${symbol} position to reduce.`,
              };
            }
            const wouldIncreaseLong = position.side === 'long' && side === 'buy';
            const wouldIncreaseShort = position.side === 'short' && side === 'sell';
            if (wouldIncreaseLong || wouldIncreaseShort) {
              return {
                success: false,
                error:
                  `Reduce-only preflight blocked: ${side} would increase current ` +
                  `${position.side} ${symbol} position (size=${position.size}).`,
              };
            }
            if (size > position.size) {
              reduceOnlyPreflightNote =
                `reduce_only size capped from ${size} to live position size ${position.size}`;
              size = position.size;
            }
          } catch (error) {
            // Best-effort preflight. If exchange state lookup fails, let exchange validation decide.
            const detail = error instanceof Error ? error.message : String(error);
            console.warn(`Reduce-only preflight lookup failed for ${symbol}: ${detail}`);
          }
        }
        const tradeContractEnabled = Boolean((ctx.config.autonomy as any)?.tradeContract?.enabled);
        const exitFsmEnabled = Boolean((ctx.config.autonomy as any)?.tradeContract?.enforceExitFsm);
        const normalizedReduceOnlyExit = normalizeReduceOnlyExitFsmInput({
          enabled: exitFsmEnabled,
          reduceOnly,
          exitMode,
          thesisInvalidationHit,
        });
        exitMode = normalizedReduceOnlyExit.exitMode;
        thesisInvalidationHit = normalizedReduceOnlyExit.thesisInvalidationHit;
        const contractError = validatePerpOrderContract({
          reduceOnly,
          thesisInvalidationHit,
          exitMode,
          tradeArchetype,
          enforceReduceOnlyExitMode: exitFsmEnabled,
        });
        if (contractError) {
          return { success: false, error: contractError };
        }
        const exitAssessment = evaluateReduceOnlyExitAssessment({
          reduceOnly,
          thesisInvalidationHit,
          exitMode,
        });
        // Resolve the matching entry journal early so both the failed and executed
        // close paths can inherit signalClass from the original open record.
        let closeReference: ReturnType<typeof resolveClosedTradeReference> = null;
        if (reduceOnly) {
          try {
            const closeHistory = listPerpTradeJournals({ symbol, limit: 200 });
            closeReference = resolveClosedTradeReference({
              entries: closeHistory,
              symbol,
              hypothesisId,
              closeSide: side as 'buy' | 'sell',
            });
          } catch { /* best-effort: never block trading */ }
        }
        const effectiveSignalClass = signalClass ?? closeReference?.signalClass ?? null;
        const learningScopeContext = resolvePerpLearningScopeContext({
          side: side as 'buy' | 'sell',
          reduceOnly,
          entryTrigger,
          planContext,
          closeReference,
          hypothesisId,
          symbol,
        });
        const exitFsmValidation = validateReduceOnlyExitFsm({
          enabled: exitFsmEnabled,
          reduceOnly,
          exitMode,
          thesisInvalidationHit,
          emergencyOverride,
          emergencyReason,
        });
        if (!exitFsmValidation.valid) {
          return { success: false, error: exitFsmValidation.error };
        }
        const tradeContractJournalFields = {
          tradeArchetype: null as 'scalp' | 'intraday' | 'swing' | null,
          invalidationType: null as 'price_level' | 'structure_break' | null,
          invalidationPrice: null as number | null,
          timeStopAtMs: null as number | null,
          takeProfitR: null as number | null,
          trailMode: null as 'none' | 'atr' | 'structure' | null,
          emergencyOverride: emergencyOverride || null,
          emergencyReason,
        };
        const market = await ctx.marketClient.getMarket(symbol);
        const hydratedContractInput = hydrateEntryTradeContract({
          enabled: tradeContractEnabled,
          reduceOnly,
          side: side as 'buy' | 'sell',
          markPrice: market.markPrice ?? null,
          input: {
            tradeArchetype,
            invalidationType,
            invalidationPrice,
            timeStopAtMs,
            takeProfitR,
            trailMode,
          },
        });
        const contractValidation = validateEntryTradeContract({
          enabled: tradeContractEnabled,
          reduceOnly,
          input: hydratedContractInput,
        });
        if (!contractValidation.valid) {
          return { success: false, error: contractValidation.error };
        }
        const resolvedContract = contractValidation.contract;
        if (resolvedContract) {
          tradeContractJournalFields.tradeArchetype = resolvedContract.tradeArchetype;
          tradeContractJournalFields.invalidationType = resolvedContract.invalidationType;
          tradeContractJournalFields.invalidationPrice = resolvedContract.invalidationPrice;
          tradeContractJournalFields.timeStopAtMs = resolvedContract.timeStopAtMs;
          tradeContractJournalFields.takeProfitR = resolvedContract.takeProfitR;
          tradeContractJournalFields.trailMode = resolvedContract.trailMode;
        }
        const thesisText =
          typeof toolInput.reasoning === 'string' && toolInput.reasoning.trim().length > 0
            ? toolInput.reasoning.trim()
            : `Manage ${symbol} ${side} position based on thesis invalidation and heartbeat review.`;
        const parsedExitContract = parseExitContract(rawExitContract);
        const persistedExitContract =
          !reduceOnly
            ? parsedExitContract ??
              buildLegacyExitContract({
                thesis: thesisText,
                invalidationPrice: resolvedContract?.invalidationPrice ?? invalidationPrice,
                side: (side as string) === 'buy' ? 'long' : 'short',
                tradeType: legacyTradeType,
              })
            : null;
        const policyNotes = persistedExitContract ? serializeExitContract(persistedExitContract) : null;
        const feeEstimate = await estimatePerpOrderFee(ctx, {
          orderType,
          size: requestedSize,
          inputPrice: price,
          markPrice: market.markPrice ?? null,
        });
        const policyGate = evaluateGlobalTradeGate(ctx.config, {
          symbol,
          direction: defaultLearningDirection,
          strategySource: defaultStrategySource,
          triggerReason: defaultTriggerReason,
          signalClass,
          symbolClass: defaultSymbolClass,
          session: defaultSession,
          marketRegime,
          volatilityBucket,
          liquidityBucket,
          expectedEdge,
          requestedLeverage: leverage ?? null,
          confirmationSatisfied: true,
        });
        if (!policyGate.allowed) {
          const blockedSnapshot = buildPerpTradeSnapshot({
            capturedAtMs: Date.now(),
            bookMode,
            symbol,
            side: side as 'buy' | 'sell',
            size: requestedSize,
            requestedSize,
            reduceOnly,
            markPrice: market.markPrice ?? null,
            hypothesisId,
            signalClass: effectiveSignalClass,
            marketRegime,
            volatilityBucket,
            liquidityBucket,
            expectedEdge,
            entryTrigger,
            newsSubtype,
            newsSources,
            noveltyScore,
            marketConfirmationScore,
            thesisExpiresAtMs,
            invalidationPrice,
            timeStopAtMs,
            tradeArchetype,
            planContext,
            reasoning: policyGate.reason ?? 'policy constraints active',
            estimatedNotionalUsd: feeEstimate.estimated_notional_usd,
            estimatedFeeUsd: feeEstimate.estimated_fee_usd,
          });
          try {
            recordPerpTradeJournal({
              kind: 'perp_trade_journal',
              execution_mode: bookMode,
              tradeId: null,
              hypothesisId,
              symbol,
              side: side as 'buy' | 'sell',
              size: requestedSize,
              leverage: leverage ?? null,
              orderType,
              reduceOnly,
              markPrice: market.markPrice ?? null,
              confidence: null,
              reasoning: `Policy gate blocked: ${policyGate.reason ?? 'policy constraints active'}`,
              signalClass: effectiveSignalClass,
              marketRegime,
              volatilityBucket,
              liquidityBucket,
              expectedEdge,
              entryTrigger,
              newsSubtype,
              newsSources,
              newsSourceCount,
              noveltyScore,
              marketConfirmationScore,
              thesisExpiresAtMs,
              ...tradeContractJournalFields,
              thesisInvalidationHit: exitAssessment.thesisInvalidationHit,
              exitMode: exitAssessment.exitMode,
              emotionalExitFlag: exitAssessment.emotionalExitFlag,
              thesisEvaluationReason: exitAssessment.thesisEvaluationReason,
              estimatedNotionalUsd: feeEstimate.estimated_notional_usd,
              estimatedFeeRate: feeEstimate.estimated_fee_rate,
              estimatedFeeType: feeEstimate.estimated_fee_type,
              estimatedFeeUsd: feeEstimate.estimated_fee_usd,
              snapshot: blockedSnapshot,
              planContext,
              outcome: 'blocked',
              error: policyGate.reason ?? 'policy constraints active',
            });
            persistPerpTradeEvidence({
              symbol,
              fingerprint: tradeEvidenceBaseFingerprint,
              outcome: 'blocked',
              snapshot: blockedSnapshot,
              signalClass: effectiveSignalClass,
              confidence: null,
            });
          } catch {
            // Best-effort journaling: never block trading due to local DB issues.
          }
          return { success: false, error: policyGate.reason ?? 'policy constraints active' };
        }
        let policyReasoning: string | null = null;
        if (!reduceOnly && policyGate.sizeMultiplier < 1) {
          size = Math.max(0.00000001, requestedSize * policyGate.sizeMultiplier);
          policyReasoning =
            `Policy applied (${policyGate.reasonCode ?? 'policy.size_adjust'}): ` +
            `${policyGate.reason ?? 'size multiplier enforced'}; requested_size=${requestedSize}, effective_size=${size}`;
        }
        if (reduceOnlyPreflightNote) {
          policyReasoning = policyReasoning
            ? `${policyReasoning} | ${reduceOnlyPreflightNote}`
            : reduceOnlyPreflightNote;
        }
        const riskCheck = await checkPerpRiskLimits({
          config: ctx.config,
          symbol,
          side: side as 'buy' | 'sell',
          size,
          leverage,
          reduceOnly,
          markPrice: market.markPrice ?? null,
          marketMaxLeverage:
            typeof market.metadata?.maxLeverage === 'number'
              ? (market.metadata.maxLeverage as number)
              : null,
        });
        if (!riskCheck.allowed) {
          const blockedSnapshot = buildPerpTradeSnapshot({
            capturedAtMs: Date.now(),
            bookMode,
            symbol,
            side: side as 'buy' | 'sell',
            size,
            requestedSize,
            reduceOnly,
            markPrice: market.markPrice ?? null,
            hypothesisId,
            signalClass: effectiveSignalClass,
            marketRegime,
            volatilityBucket,
            liquidityBucket,
            expectedEdge,
            entryTrigger,
            newsSubtype,
            newsSources,
            noveltyScore,
            marketConfirmationScore,
            thesisExpiresAtMs,
            invalidationPrice,
            timeStopAtMs,
            tradeArchetype,
            planContext,
            reasoning: riskCheck.reason ?? 'perp risk limits exceeded',
            estimatedNotionalUsd: feeEstimate.estimated_notional_usd,
            estimatedFeeUsd: feeEstimate.estimated_fee_usd,
          });
          try {
            recordPerpTradeJournal({
              kind: 'perp_trade_journal',
              execution_mode: bookMode,
              tradeId: null,
              hypothesisId,
              symbol,
              side: side as 'buy' | 'sell',
              size,
              leverage: leverage ?? null,
              orderType,
              reduceOnly,
              markPrice: market.markPrice ?? null,
              confidence: null,
              reasoning:
                `Risk check blocked: ${riskCheck.reason ?? 'perp risk limits exceeded'}` +
                (policyReasoning ? ` | ${policyReasoning}` : ''),
              estimatedNotionalUsd: feeEstimate.estimated_notional_usd,
              estimatedFeeRate: feeEstimate.estimated_fee_rate,
              estimatedFeeType: feeEstimate.estimated_fee_type,
              estimatedFeeUsd: feeEstimate.estimated_fee_usd,
              signalClass: effectiveSignalClass,
              marketRegime,
              volatilityBucket,
              liquidityBucket,
              expectedEdge,
              entryTrigger,
              newsSubtype,
              newsSources,
              newsSourceCount,
              noveltyScore,
              marketConfirmationScore,
              thesisExpiresAtMs,
              ...tradeContractJournalFields,
              thesisInvalidationHit: exitAssessment.thesisInvalidationHit,
              exitMode: exitAssessment.exitMode,
              emotionalExitFlag: exitAssessment.emotionalExitFlag,
              thesisEvaluationReason: exitAssessment.thesisEvaluationReason,
              snapshot: blockedSnapshot,
              planContext,
              outcome: 'blocked',
              error: riskCheck.reason ?? 'perp risk limits exceeded',
            });
            persistPerpTradeEvidence({
              symbol,
              fingerprint: tradeEvidenceBaseFingerprint,
              outcome: 'blocked',
              snapshot: blockedSnapshot,
              signalClass: effectiveSignalClass,
              confidence: null,
            });
          } catch {
            // Best-effort journaling: never block trading due to local DB issues.
          }
          return { success: false, error: riskCheck.reason ?? 'perp risk limits exceeded' };
        }
        // Reduce-only orders are strictly risk-reducing; do not block them on spending limits.
        // This is critical for safety loops (heartbeat/trade-management) that must be able to flatten.
        if (!reduceOnly) {
          // Paper mode equity guard: block new entries when account is already bankrupt.
          // Liquidation simulation handles positions-going-underwater; this guard prevents
          // opening new positions after the account equity has reached zero or below.
          if (bookMode === 'paper') {
            try {
              const paperInitialCash = ctx.config.paper?.initialCashUsdc ?? 200;
              const paperSummary = getPaperPerpBookSummary(paperInitialCash);
              const paperPositions = listPaperPerpPositionsWithMark(paperInitialCash);
              const unrealizedPnl = paperPositions.reduce((sum, p) => sum + p.unrealizedPnlUsd, 0);
              const paperEquity = paperSummary.cashBalanceUsdc + unrealizedPnl;
              if (paperEquity <= 0) {
                return {
                  success: false,
                  error: `[Paper] Account bankrupt: equity=$${paperEquity.toFixed(2)}. Reset paper account to trade again.`,
                };
              }
            } catch {
              // Best-effort: don't block on equity check failure.
            }
          }
          const limitCheck = await ctx.limiter.checkAndReserve(size);
          if (!limitCheck.allowed) {
            const blockedSnapshot = buildPerpTradeSnapshot({
              capturedAtMs: Date.now(),
              bookMode,
              symbol,
              side: side as 'buy' | 'sell',
              size,
              requestedSize,
              reduceOnly,
              markPrice: market.markPrice ?? null,
              hypothesisId,
              signalClass: effectiveSignalClass,
              marketRegime,
              volatilityBucket,
              liquidityBucket,
              expectedEdge,
              entryTrigger,
              newsSubtype,
              newsSources,
              noveltyScore,
              marketConfirmationScore,
              thesisExpiresAtMs,
              invalidationPrice,
              timeStopAtMs,
              tradeArchetype,
              planContext,
              reasoning: limitCheck.reason ?? 'limit exceeded',
              estimatedNotionalUsd: feeEstimate.estimated_notional_usd,
              estimatedFeeUsd: feeEstimate.estimated_fee_usd,
            });
            try {
              recordPerpTradeJournal({
                kind: 'perp_trade_journal',
                execution_mode: bookMode,
                tradeId: null,
                hypothesisId,
                symbol,
                side: side as 'buy' | 'sell',
                size,
                leverage: leverage ?? null,
                orderType,
                reduceOnly,
                markPrice: market.markPrice ?? null,
                confidence: null,
                reasoning:
                  `Spending limiter blocked: ${limitCheck.reason ?? 'limit exceeded'}` +
                  (policyReasoning ? ` | ${policyReasoning}` : ''),
                estimatedNotionalUsd: feeEstimate.estimated_notional_usd,
                estimatedFeeRate: feeEstimate.estimated_fee_rate,
                estimatedFeeType: feeEstimate.estimated_fee_type,
                estimatedFeeUsd: feeEstimate.estimated_fee_usd,
                signalClass: effectiveSignalClass,
                marketRegime,
                volatilityBucket,
                liquidityBucket,
                expectedEdge,
                entryTrigger,
                newsSubtype,
                newsSources,
                newsSourceCount,
                noveltyScore,
                marketConfirmationScore,
                thesisExpiresAtMs,
                ...tradeContractJournalFields,
                thesisInvalidationHit: exitAssessment.thesisInvalidationHit,
                exitMode: exitAssessment.exitMode,
                emotionalExitFlag: exitAssessment.emotionalExitFlag,
                thesisEvaluationReason: exitAssessment.thesisEvaluationReason,
                snapshot: blockedSnapshot,
                planContext,
                outcome: 'blocked',
                error: limitCheck.reason ?? 'limit exceeded',
              });
              persistPerpTradeEvidence({
                symbol,
                fingerprint: tradeEvidenceBaseFingerprint,
                outcome: 'blocked',
                snapshot: blockedSnapshot,
                signalClass: effectiveSignalClass,
                confidence: null,
              });
            } catch {
              // Best-effort journaling: never block trading due to local DB issues.
            }
            return { success: false, error: limitCheck.reason ?? 'limit exceeded' };
          }
        }
        const decision: TradeDecision = {
          action: side as 'buy' | 'sell',
          symbol,
          side: side as 'buy' | 'sell',
          size,
          orderType,
          price,
          leverage,
          reduceOnly,
          confidence: 'medium' as const,
        };
        const paperInitialCashUsdc = ctx.config.paper?.initialCashUsdc ?? 200;
        const positionBefore = await getPerpPositionSnapshotForLifecycle({
          config: ctx.config,
          symbol,
          mode: bookMode,
          isNativePaperExecutor,
          paperInitialCashUsdc,
        });
        const paperReduceOnlyBefore =
          bookMode === 'paper' && isNativePaperExecutor && reduceOnly
            ? getPaperPositionSnapshot(symbol, paperInitialCashUsdc)
            : null;
        const executionStartMs = Date.now();
        const baseSlippageBps = Math.max(0, Number(ctx.config.hyperliquid?.defaultSlippageBps ?? 10));
        const execution = await executePerpWithRetry({
          executor: perpExecutor,
          marketClient: ctx.marketClient,
          market,
          symbol,
          decision,
          baseSlippageBps,
        });
        const result = execution.result;
        if (!result.executed) {
          ctx.limiter.release(size);
          const retrySummary =
            execution.attempts.length > 1
              ? ` Retry attempts=${execution.attempts.length}; slippage_bps=[${execution.attempts
                  .map((attempt) => String(attempt.slippage_bps))
                  .join(',')}].`
              : '';
          try {
            const tradeId = recordPerpTrade({
              hypothesisId,
              symbol,
              side: side as 'buy' | 'sell',
              size,
              executionMode: bookMode,
              price: market.markPrice ?? null,
              leverage: leverage ?? null,
              orderType,
              status: 'failed',
            });
            const failedSnapshot = buildPerpTradeSnapshot({
              capturedAtMs: executionStartMs,
              bookMode,
              symbol,
              side: side as 'buy' | 'sell',
              size,
              requestedSize,
              reduceOnly,
              markPrice: market.markPrice ?? null,
              hypothesisId,
              signalClass: effectiveSignalClass,
              marketRegime,
              volatilityBucket,
              liquidityBucket,
              expectedEdge,
              entryTrigger,
              newsSubtype,
              newsSources,
              noveltyScore,
              marketConfirmationScore,
              thesisExpiresAtMs,
              invalidationPrice,
              timeStopAtMs,
              tradeArchetype,
              planContext,
              reasoning: policyReasoning,
              estimatedNotionalUsd: feeEstimate.estimated_notional_usd,
              estimatedFeeUsd: feeEstimate.estimated_fee_usd,
              lifecycleTradeId: tradeId,
            });
            recordPerpTradeJournal({
              kind: 'perp_trade_journal',
              execution_mode: bookMode,
              tradeId,
              hypothesisId,
              symbol,
              side: side as 'buy' | 'sell',
              size,
              leverage: leverage ?? null,
              orderType,
              reduceOnly,
              markPrice: market.markPrice ?? null,
              confidence: 'medium',
              reasoning: policyReasoning,
              estimatedNotionalUsd: feeEstimate.estimated_notional_usd,
              estimatedFeeRate: feeEstimate.estimated_fee_rate,
              estimatedFeeType: feeEstimate.estimated_fee_type,
              estimatedFeeUsd: feeEstimate.estimated_fee_usd,
              signalClass: effectiveSignalClass,
              marketRegime,
              volatilityBucket,
              liquidityBucket,
              expectedEdge,
              entryTrigger,
              newsSubtype,
              newsSources,
              newsSourceCount,
              noveltyScore,
              marketConfirmationScore,
              thesisExpiresAtMs,
              ...tradeContractJournalFields,
              thesisCorrect: exitAssessment.thesisCorrect,
              thesisInvalidationHit: exitAssessment.thesisInvalidationHit,
              exitMode: exitAssessment.exitMode,
              emotionalExitFlag: exitAssessment.emotionalExitFlag,
              thesisEvaluationReason: exitAssessment.thesisEvaluationReason,
              snapshot: failedSnapshot,
              planContext,
              outcome: 'failed',
              error: `${result.message}${retrySummary}`,
            });
            persistPerpTradeEvidence({
              symbol,
              fingerprint: `perp:${tradeId}`,
              outcome: 'failed',
              snapshot: failedSnapshot,
              signalClass: effectiveSignalClass,
              confidence: 0.5,
            });
          } catch {
            // Best-effort journaling: never block trading due to local DB issues.
          }
          if (!reduceOnly) {
            try {
              recordDecisionAudit({
                source: 'tool_executor',
                mode: bookMode,
                marketId: symbol,
                tradeAction: `${String(side)} open ${symbol}`,
                tradeOutcome: 'failed',
                tradeAmount: feeEstimate.estimated_notional_usd ?? null,
                edge: typeof expectedEdge === 'number' ? expectedEdge : null,
                notes: { signalClass, marketRegime, exitMode, hypothesisId, reason: result.message },
              });
            } catch { }
          }
          return { success: false, error: `${result.message}${retrySummary}` };
        }
        const paperReduceOnlyPostcondition =
          bookMode === 'paper' && isNativePaperExecutor && reduceOnly
            ? evaluatePaperReduceOnlyPostcondition({
                symbol,
                before: paperReduceOnlyBefore,
                after: getPaperPositionSnapshot(symbol, paperInitialCashUsdc),
              })
            : null;
        if (paperReduceOnlyPostcondition && !paperReduceOnlyPostcondition.verified) {
          return {
            success: false,
            error:
              `Paper reduce-only postcondition failed for ${symbol}: ${paperReduceOnlyPostcondition.reason} ` +
              `(before_size=${paperReduceOnlyPostcondition.before_size}, after_size=${paperReduceOnlyPostcondition.after_size}).`,
          };
        }
        ctx.limiter.confirm(size);
        const positionAfter = await getPerpPositionSnapshotForLifecycle({
          config: ctx.config,
          symbol,
          mode: bookMode,
          isNativePaperExecutor,
          paperInitialCashUsdc,
        });
        let lifecycleTradeId: number | null = null;
        try {
          lifecycleTradeId = await resolvePerpLifecycleTradeId({
            symbol,
            mode: bookMode,
            hypothesisId,
            leverage: leverage ?? null,
            orderType,
            markPrice: market.markPrice ?? null,
            before: positionBefore,
            after: positionAfter,
          });
        } catch {
          lifecycleTradeId = null;
        }
        const inferredOrderId = parseOrderIdFromResultMessage(result.message);
        const realizedFee = await fetchRealizedPerpFee(ctx, {
          symbol,
          side: side as 'buy' | 'sell',
          orderId: inferredOrderId,
          startTimeMs: Math.max(0, executionStartMs - 10_000),
        });
        let componentScores:
          | {
              directionScore: number;
              timingScore: number;
              sizingScore: number;
              exitScore: number;
              capturedR: number | null;
              leftOnTableR: number | null;
              wouldHit2R: boolean | null;
              wouldHit3R: boolean | null;
            }
          | null = null;
        if (reduceOnly) {
          try {
            const entrySide =
              closeReference?.side ?? ((side as 'buy' | 'sell') === 'buy' ? 'sell' : 'buy');
            componentScores = computeClosedTradeComponentScores({
              entrySide,
              thesisCorrect: exitAssessment.thesisCorrect,
              size: closeReference?.size ?? size,
              expectedEdge: closeReference?.expectedEdge ?? expectedEdge,
              entryPrice: closeEntryPriceOverride ?? closeReference?.markPrice ?? null,
              exitPrice: market.markPrice ?? null,
              pricePathHigh: closePathHigh,
              pricePathLow: closePathLow,
              invalidationPrice: closeReference?.invalidationPrice ?? invalidationPrice,
            });
          } catch {
            componentScores = computeClosedTradeComponentScores({
              entrySide: (side as 'buy' | 'sell') === 'buy' ? 'sell' : 'buy',
              thesisCorrect: exitAssessment.thesisCorrect,
              size,
              expectedEdge,
              entryPrice: closeEntryPriceOverride,
              exitPrice: market.markPrice ?? null,
              pricePathHigh: closePathHigh,
              pricePathLow: closePathLow,
              invalidationPrice,
            });
          }
        }
        const executedEvidenceFingerprint =
          lifecycleTradeId != null && lifecycleTradeId > 0
            ? `perp:${lifecycleTradeId}`
            : tradeEvidenceBaseFingerprint;
        const executedSnapshot = buildPerpTradeSnapshot({
          capturedAtMs: executionStartMs,
          bookMode,
          symbol,
          side: side as 'buy' | 'sell',
          size,
          requestedSize,
          reduceOnly,
          markPrice: market.markPrice ?? null,
          hypothesisId,
          direction: learningScopeContext.direction,
          triggerReason: learningScopeContext.triggerReason,
          session: learningScopeContext.session,
          strategySource: learningScopeContext.strategySource,
          signalClass: effectiveSignalClass,
          symbolClass: learningScopeContext.symbolClass,
          marketRegime,
          volatilityBucket,
          liquidityBucket,
          expectedEdge,
          entryTrigger: learningScopeContext.entryTrigger,
          newsSubtype,
          newsSources,
          noveltyScore,
          marketConfirmationScore,
          thesisExpiresAtMs,
          invalidationPrice,
          timeStopAtMs,
          tradeArchetype,
          planContext,
          reasoning: policyReasoning,
          estimatedNotionalUsd: feeEstimate.estimated_notional_usd,
          estimatedFeeUsd: feeEstimate.estimated_fee_usd,
          lifecycleTradeId,
          entryPrice: closeEntryPriceOverride ?? closeReference?.markPrice ?? market.markPrice ?? null,
          exitPrice: reduceOnly ? market.markPrice ?? null : null,
          pricePathHigh: closePathHigh,
          pricePathLow: closePathLow,
          capturedR: componentScores?.capturedR ?? null,
          leftOnTableR: componentScores?.leftOnTableR ?? null,
        });
        try {
          recordPerpTradeJournal({
            kind: 'perp_trade_journal',
            execution_mode: bookMode,
            tradeId: lifecycleTradeId,
            hypothesisId,
            symbol,
            side: side as 'buy' | 'sell',
            size,
            leverage: leverage ?? null,
            orderType,
            reduceOnly,
            markPrice: market.markPrice ?? null,
            confidence: 'medium',
            reasoning: policyReasoning,
            estimatedNotionalUsd: feeEstimate.estimated_notional_usd,
            estimatedFeeRate: feeEstimate.estimated_fee_rate,
            estimatedFeeType: feeEstimate.estimated_fee_type,
            estimatedFeeUsd: feeEstimate.estimated_fee_usd,
            signalClass: effectiveSignalClass,
            marketRegime,
            volatilityBucket,
            liquidityBucket,
            expectedEdge,
            entryTrigger,
            newsSubtype,
            newsSources,
            newsSourceCount,
            noveltyScore,
            marketConfirmationScore,
            thesisExpiresAtMs,
            ...tradeContractJournalFields,
            thesisCorrect: exitAssessment.thesisCorrect,
            thesisInvalidationHit: exitAssessment.thesisInvalidationHit,
            exitMode: exitAssessment.exitMode,
            emotionalExitFlag: exitAssessment.emotionalExitFlag,
            thesisEvaluationReason: exitAssessment.thesisEvaluationReason,
            directionScore: componentScores?.directionScore ?? null,
            timingScore: componentScores?.timingScore ?? null,
            sizingScore: componentScores?.sizingScore ?? null,
            exitScore: componentScores?.exitScore ?? null,
            capturedR: componentScores?.capturedR ?? null,
            leftOnTableR: componentScores?.leftOnTableR ?? null,
            wouldHit2R: componentScores?.wouldHit2R ?? null,
            wouldHit3R: componentScores?.wouldHit3R ?? null,
            direction_score: componentScores?.directionScore ?? null,
            timing_score: componentScores?.timingScore ?? null,
            sizing_score: componentScores?.sizingScore ?? null,
            exit_score: componentScores?.exitScore ?? null,
            captured_r: componentScores?.capturedR ?? null,
            left_on_table_r: componentScores?.leftOnTableR ?? null,
            would_hit_2r: componentScores?.wouldHit2R ?? null,
            would_hit_3r: componentScores?.wouldHit3R ?? null,
            realizedFeeUsd: realizedFee.realized_fee_usd,
            realizedFeeToken: realizedFee.realized_fee_token,
            realizedFillCount: realizedFee.realized_fill_count,
            realizedOrderId: realizedFee.realized_order_id,
            realizedFillTimeMs: realizedFee.realized_fill_time_ms,
            feeObservationError: realizedFee.error ?? null,
            snapshot: executedSnapshot,
            planContext,
            outcome: 'executed',
            message: result.message,
          });
          persistPerpTradeEvidence({
            symbol,
            fingerprint: executedEvidenceFingerprint,
            outcome: 'executed',
            snapshot: executedSnapshot,
            signalClass: effectiveSignalClass,
            confidence: 0.5,
          });
          if (reduceOnly) {
            const learningCase = buildPerpExecutionLearningCase({
              symbol,
              executionMode: bookMode,
              tradeId: lifecycleTradeId,
              hypothesisId,
              capturedAtMs: executionStartMs,
              side: side as 'buy' | 'sell',
              size,
              leverage: leverage ?? null,
              direction: learningScopeContext.direction === 'buy' ? 'long' : learningScopeContext.direction === 'sell' ? 'short' : null,
              signalClass: effectiveSignalClass,
              triggerReason: learningScopeContext.triggerReason,
              symbolClass: learningScopeContext.symbolClass,
              session: learningScopeContext.session,
              strategySource: learningScopeContext.strategySource,
              marketRegime,
              volatilityBucket,
              liquidityBucket,
              tradeArchetype,
              entryTrigger: learningScopeContext.entryTrigger,
              expectedEdge,
              invalidationPrice,
              timeStopAtMs,
              entryPrice: closeEntryPriceOverride ?? closeReference?.markPrice ?? market.markPrice ?? null,
              exitPrice: market.markPrice ?? null,
              pricePathHigh: closePathHigh,
              pricePathLow: closePathLow,
              thesisCorrect: exitAssessment.thesisCorrect,
              thesisInvalidationHit: exitAssessment.thesisInvalidationHit,
              exitMode: exitAssessment.exitMode,
              realizedPnlUsd: result.realizedPnlUsd ?? null,
              netRealizedPnlUsd:
                typeof result.realizedPnlUsd === 'number'
                  ? result.realizedPnlUsd - (realizedFee.realized_fee_usd ?? 0)
                  : null,
              realizedFeeUsd: realizedFee.realized_fee_usd,
              directionScore: componentScores?.directionScore ?? null,
              timingScore: componentScores?.timingScore ?? null,
              sizingScore: componentScores?.sizingScore ?? null,
              exitScore: componentScores?.exitScore ?? null,
              capturedR: componentScores?.capturedR ?? null,
              leftOnTableR: componentScores?.leftOnTableR ?? null,
              wouldHit2R: componentScores?.wouldHit2R ?? null,
              wouldHit3R: componentScores?.wouldHit3R ?? null,
              maeProxy: null,
              mfeProxy: null,
              reasoning: policyReasoning,
              planContext,
              snapshot: executedSnapshot,
            });
            const persistedLearningCase = persistExecutionLearningCase({
              symbol,
              fingerprint: executedEvidenceFingerprint,
              learningCase,
              signalClass: effectiveSignalClass,
            });
            if (positionBefore != null && (positionAfter == null || (positionAfter.size ?? 0) === 0)) {
              try {
                materializeTradePolicyAdjustmentFromLearningCase({
                  config: ctx.config,
                  learningCase: persistedLearningCase,
                });
              } catch {
                // Best-effort adaptive persistence: never block trade finalization.
              }
            }
          }
        } catch {
          // Best-effort journaling: never block trading due to local DB issues.
        }
        if (!reduceOnly) {
          try {
            recordDecisionAudit({
              source: 'tool_executor',
              mode: bookMode,
              marketId: symbol,
              tradeAction: `${String(side)} open ${symbol}`,
              tradeOutcome: 'executed',
              tradeAmount: feeEstimate.estimated_notional_usd ?? null,
              edge: typeof expectedEdge === 'number' ? expectedEdge : null,
              notes: {
                signalClass,
                marketRegime,
                exitMode: exitAssessment.exitMode,
                thesisCorrect: exitAssessment.thesisCorrect,
                hypothesisId,
                capturedR: componentScores?.capturedR ?? null,
                reasoning: policyReasoning,
              },
            });
          } catch { }
        }
        // Maintain per-position exit policy for heartbeat.
        const activeExitPolicy = reduceOnly ? getPositionExitPolicy(symbol) : null;
        if (!reduceOnly) {
          const effectiveTimeStopAtMs = resolvedContract?.timeStopAtMs ?? thesisExpiresAtMs ?? timeStopAtMs;
          const effectiveInvalidationPrice = resolvedContract?.invalidationPrice ?? invalidationPrice;
          if (effectiveTimeStopAtMs != null || effectiveInvalidationPrice != null || policyNotes != null) {
            try {
              upsertPositionExitPolicy(
                symbol,
                (side as string) === 'buy' ? 'long' : 'short',
                effectiveTimeStopAtMs ?? null,
                effectiveInvalidationPrice ?? null,
                policyNotes
              );
            } catch { }
          }
        }
        try {
          await maybeResolvePerpPredictionFromClose({
            ctx,
            mode: bookMode,
            symbol,
            reduceOnly,
            positionBefore,
            positionAfter,
            linkedPredictionId: activeExitPolicy?.predictionId ?? null,
          });
        } catch {
          // Best-effort resolution: never block trading on prediction write failures.
        }
        if (reduceOnly && positionBefore != null && (positionAfter == null || (positionAfter.size ?? 0) === 0)) {
          // Reduce-only that fully closed the position: clear the policy after best-effort finalization.
          try { clearPositionExitPolicy(symbol); } catch { }
        }
        return {
          success: true,
          data: {
            ...result,
            mode: bookMode,
            reduce_only_postcondition: paperReduceOnlyPostcondition,
            policy: {
              reason_code: policyGate.reasonCode ?? null,
              reason: policyGate.reason ?? null,
              size_multiplier: policyGate.sizeMultiplier,
              leverage_cap: policyGate.leverageCap ?? null,
              active_adjustment_ids: policyGate.activeAdjustmentIds,
              active_policies: policyGate.activePolicies,
              size_haircuts: policyGate.sizeHaircuts,
              leverage_caps: policyGate.leverageCaps,
              confirmation_requirements: policyGate.confirmationRequirements,
              triggered_cooldowns: policyGate.triggeredCooldowns,
              adaptation_changed_outcome: policyGate.adaptationChangedOutcome,
              requested_size: requestedSize,
              effective_size: size,
            },
            fees: {
              ...feeEstimate,
              ...realizedFee,
            },
            execution_attempts: execution.attempts,
          },
        };
      }

      case 'perp_open_orders': {
        const mode = resolvePerpBookMode(ctx.config, toolInput);
        const executor = resolvePerpExecutor(ctx, mode);
        if (mode === 'live') {
          const symbol = String(toolInput.symbol ?? '').trim();
          const livePolicyError = validateLiveBookPolicy(ctx.config, symbol);
          if (livePolicyError) return { success: false, error: livePolicyError };
        }
        try {
          const orders = await executor.getOpenOrders();
          return { success: true, data: { mode, orders } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'perp_cancel_order': {
        const mode = resolvePerpBookMode(ctx.config, toolInput);
        const executor = resolvePerpExecutor(ctx, mode);
        const orderId = String(toolInput.order_id ?? '').trim();
        if (!orderId) {
          return { success: false, error: 'Missing order_id' };
        }
        if (mode === 'live') {
          const symbol = String(toolInput.symbol ?? '').trim();
          const livePolicyError = validateLiveBookPolicy(ctx.config, symbol);
          if (livePolicyError) return { success: false, error: livePolicyError };
        }
        try {
          await executor.cancelOrder(orderId, {
            symbol:
              typeof toolInput.symbol === 'string' && toolInput.symbol.trim().length > 0
                ? toolInput.symbol.trim()
                : undefined,
          });
          return { success: true, data: { mode, cancelled: true, order_id: orderId } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'perp_positions': {
        const mode = resolvePerpBookMode(ctx.config, toolInput);
        if (mode === 'paper') {
          const mids = await resolvePaperMids(ctx.marketClient, ctx.config);
          const snapshot = buildPaperPerpSnapshot(ctx.config.paper?.initialCashUsdc ?? 200, mids);
          return {
            success: true,
            data: {
              mode,
              positions: snapshot.positions,
              summary: {
                account_value: snapshot.accountValueUsdc,
                withdrawable: snapshot.cashBalanceUsdc,
                source: 'paper',
              },
            },
          };
        }
        const symbol = String(toolInput.symbol ?? '').trim();
        const livePolicyError = validateLiveBookPolicy(ctx.config, symbol);
        if (livePolicyError) return { success: false, error: livePolicyError };
        try {
          const client = new HyperliquidClient(ctx.config);
          const state = await client.getClearinghouseState();
          const stateObj =
            state && typeof state === 'object' ? (state as Record<string, unknown>) : { state };
          return { success: true, data: { mode, ...stateObj } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'perp_analyze': {
        const symbol = String(toolInput.symbol ?? '').trim();
        const horizon = String(toolInput.horizon ?? '').trim();
        const probabilityMode = String(toolInput.probability_mode ?? '').trim();
        if (!symbol) {
          return { success: false, error: 'Missing symbol' };
        }
        try {
          const analysis = await analyzePerpMarket(
            ctx,
            symbol,
            horizon || undefined,
            probabilityMode || undefined
          );
          return { success: true, data: analysis };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'position_analysis': {
        const minBufferPct = Number(toolInput.min_liq_buffer_pct ?? 10);
        const maxConcentrationPct = Number(toolInput.max_concentration_pct ?? 40);
        const leverageWarning = Number(toolInput.leverage_warning ?? 5);
        try {
          const analysis = await analyzePositions(
            ctx,
            Number.isFinite(minBufferPct) ? minBufferPct : 12,
            Number.isFinite(maxConcentrationPct) ? maxConcentrationPct : 40,
            Number.isFinite(leverageWarning) ? leverageWarning : 5
          );
          return { success: true, data: analysis };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'discovery_report': {
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 5), 1), 20);
        try {
          const report = await buildDiscoveryReport(ctx.config, limit);
          return { success: true, data: report };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'trade_review': {
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 20), 1), 200);
        const symbol = String(toolInput.symbol ?? '').trim();
        try {
          const review = await buildTradeReview(ctx, symbol || undefined, limit);
          return { success: true, data: review };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'perp_trade_journal_list': {
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 50), 1), 200);
        const symbol = String(toolInput.symbol ?? '').trim();
        try {
          const entries = listPerpTradeJournals({ symbol: symbol || undefined, limit });
          return { success: true, data: { entries } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'paper_promotion_report': {
        const symbol = String(toolInput.symbol ?? '').trim().toUpperCase();
        const signalClass = String(toolInput.signal_class ?? '').trim();
        if (!symbol || !signalClass) {
          return { success: false, error: 'Missing symbol or signal_class' };
        }
        try {
          const entries = listPerpTradeJournals({ symbol, limit: 500 });
          const setupKey = `${symbol}:${signalClass}`;
          const gates = {
            minTrades: Number(ctx.config.paper?.promotionGates?.minTrades ?? 25),
            maxDrawdownR: Number(ctx.config.paper?.promotionGates?.maxDrawdownR ?? 6),
            minHitRate: Number(ctx.config.paper?.promotionGates?.minHitRate ?? 0.5),
            minPayoffRatio: Number(ctx.config.paper?.promotionGates?.minPayoffRatio ?? 1.2),
            minExpectancyR: Number(ctx.config.paper?.promotionGates?.minExpectancyR ?? 0.1),
          };
          const report = buildPaperPromotionReport({ entries, setupKey, gates });
          return { success: true, data: report };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'intel_search': {
        const query = String(toolInput.query ?? '');
        const limit = Number(toolInput.limit ?? 5);
        const fromDays = Number(toolInput.from_days ?? 14);
        const items = searchIntel({ query, limit, fromDays });
        return { success: true, data: formatIntelForTool(items) };
      }

      case 'intel_recent': {
        const limit = Number(toolInput.limit ?? 10);
        const items = listRecentIntel(limit);
        return { success: true, data: formatIntelForTool(items) };
      }

      case 'events_list': {
        const domain = String(toolInput.domain ?? '').trim() || undefined;
        const status = String(toolInput.status ?? '').trim() || undefined;
        const limit = Math.max(1, Math.min(100, Number(toolInput.limit ?? 10) || 10));
        const events = listEvents({ domain, status, limit });
        return { success: true, data: { events } };
      }

      case 'event_get': {
        const eventId = String(toolInput.event_id ?? toolInput.eventId ?? '').trim();
        if (!eventId) return { success: false, error: 'Missing event_id' };
        const event = getEventById(eventId);
        if (!event) return { success: false, error: `Event not found: ${eventId}` };
        return { success: true, data: event };
      }

      case 'event_latest_thought': {
        const eventId = String(toolInput.event_id ?? toolInput.eventId ?? '').trim();
        if (!eventId) return { success: false, error: 'Missing event_id' };
        const thought = getLatestThought(eventId);
        return { success: true, data: { thought } };
      }

      case 'event_forecasts': {
        const eventId = String(toolInput.event_id ?? toolInput.eventId ?? '').trim();
        if (!eventId) return { success: false, error: 'Missing event_id' };
        const forecasts = listForecastsForEvent(eventId);
        return { success: true, data: { forecasts } };
      }

      case 'event_outcomes': {
        const eventId = String(toolInput.event_id ?? toolInput.eventId ?? '').trim();
        if (!eventId) return { success: false, error: 'Missing event_id' };
        const outcomes = listOutcomesForEvent(eventId);
        return { success: true, data: { outcomes } };
      }

      case 'historical_case_search': {
        const domain = String(toolInput.domain ?? '').trim() || undefined;
        const mechanismQuery = String(toolInput.mechanism_query ?? toolInput.mechanismQuery ?? '').trim() || undefined;
        const tagsRaw = toolInput.tags;
        const tags = Array.isArray(tagsRaw) ? tagsRaw.map(String).filter(Boolean) : [];
        const limit = Math.max(1, Math.min(20, Number(toolInput.limit ?? 5) || 5));
        const results = searchHistoricalCases({ domain, mechanismQuery, tags, limit });
        return { success: true, data: { results } };
      }

      case 'proactive_search_run': {
        const { runProactiveSearch, formatProactiveSummary } = await import('./proactive_search.js');

        const toNumber = (value: unknown): number | undefined => {
          if (value === undefined || value === null || value === '') return undefined;
          const n = Number(value);
          return Number.isFinite(n) ? n : undefined;
        };
        const toBoolean = (value: unknown): boolean | undefined => {
          if (value === undefined || value === null) return undefined;
          if (typeof value === 'boolean') return value;
          if (typeof value === 'string') {
            const v = value.trim().toLowerCase();
            if (v === 'true') return true;
            if (v === 'false') return false;
          }
          return undefined;
        };

        const extraQueriesRaw =
          toolInput.extra_queries ?? toolInput.extraQueries ?? [];
        const extraQueries = Array.isArray(extraQueriesRaw)
          ? extraQueriesRaw.map((entry) => String(entry).trim()).filter(Boolean)
          : [];

        const result = await runProactiveSearch(ctx.config, {
          maxQueries: toNumber(toolInput.max_queries ?? toolInput.maxQueries),
          iterations: toNumber(toolInput.iterations),
          watchlistLimit: toNumber(toolInput.watchlist_limit ?? toolInput.watchlistLimit),
          useLlm: toBoolean(toolInput.use_llm ?? toolInput.useLlm),
          recentIntelLimit: toNumber(
            toolInput.recent_intel_limit ?? toolInput.recentIntelLimit
          ),
          extraQueries,
          includeLearnedQueries: toBoolean(
            toolInput.include_learned_queries ?? toolInput.includeLearnedQueries
          ),
          learnedQueryLimit: toNumber(
            toolInput.learned_query_limit ?? toolInput.learnedQueryLimit
          ),
          webLimitPerQuery: toNumber(
            toolInput.web_limit_per_query ?? toolInput.webLimitPerQuery
          ),
          fetchPerQuery: toNumber(toolInput.fetch_per_query ?? toolInput.fetchPerQuery),
          fetchMaxChars: toNumber(toolInput.fetch_max_chars ?? toolInput.fetchMaxChars),
        });

        return {
          success: true,
          data: {
            ...result,
            summary: formatProactiveSummary(result),
          },
        };
      }

      case 'signal_price_vol_regime': {
        const symbol = String(toolInput.symbol ?? '');
        if (!symbol) {
          return { success: false, error: 'Missing symbol' };
        }
        const { signalPriceVolRegime } = await import('../discovery/signals.js');
        const signal = await signalPriceVolRegime(ctx.config, symbol);
        if (!signal) {
          return { success: false, error: 'Insufficient data for signal' };
        }
        return { success: true, data: signal };
      }

      case 'signal_cross_asset_divergence': {
        const symbols = Array.isArray(toolInput.symbols) ? toolInput.symbols.map(String) : [];
        if (symbols.length < 2) {
          return { success: false, error: 'Need at least two symbols' };
        }
        const { signalCrossAssetDivergence } = await import('../discovery/signals.js');
        const signals = await signalCrossAssetDivergence(ctx.config, symbols);
        return { success: true, data: signals };
      }

      case 'signal_hyperliquid_funding_oi_skew': {
        const symbol = String(toolInput.symbol ?? '');
        if (!symbol) {
          return { success: false, error: 'Missing symbol' };
        }
        const { signalHyperliquidFundingOISkew } = await import('../discovery/signals.js');
        const signal = await signalHyperliquidFundingOISkew(ctx.config, symbol);
        if (!signal) {
          return { success: false, error: 'Insufficient data for signal' };
        }
        return { success: true, data: signal };
      }

      case 'signal_hyperliquid_orderflow_imbalance': {
        const symbol = String(toolInput.symbol ?? '');
        if (!symbol) {
          return { success: false, error: 'Missing symbol' };
        }
        const { signalHyperliquidOrderflowImbalance } = await import('../discovery/signals.js');
        const signal = await signalHyperliquidOrderflowImbalance(ctx.config, symbol);
        if (!signal) {
          return { success: false, error: 'Insufficient data for signal' };
        }
        return { success: true, data: signal };
      }

      case 'discovery_run': {
        const { runDiscovery } = await import('../discovery/engine.js');
        const limit = Number(toolInput.limit ?? undefined);
        const result = await runDiscovery(ctx.config, {
          preselectLimit: Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : undefined,
        });
        return { success: true, data: result };
      }

      case 'discovery_select_markets': {
        const { selectDiscoveryMarkets } = await import('../discovery/market_selector.js');
        const limit = Number(toolInput.limit ?? undefined);
        const minOpenInterestUsd = Number(toolInput.min_open_interest_usd ?? undefined);
        const minDayVolumeUsd = Number(toolInput.min_day_volume_usd ?? undefined);
        const result = await selectDiscoveryMarkets(ctx.config, {
          limit: Number.isFinite(limit) ? limit : undefined,
          minOpenInterestUsd: Number.isFinite(minOpenInterestUsd) ? minOpenInterestUsd : undefined,
          minDayVolumeUsd: Number.isFinite(minDayVolumeUsd) ? minDayVolumeUsd : undefined,
        });
        return { success: true, data: result };
      }

      case 'calibration_stats': {
        const domain = toolInput.domain ? String(toolInput.domain) : undefined;
        const summaries = listCalibrationSummaries();
        const filtered = domain
          ? summaries.filter((summary) => summary.domain === domain)
          : summaries;
        return { success: true, data: filtered };
      }

      case 'evaluation_summary': {
        const { getEvaluationSummary } = await import('./evaluation.js');
        const windowDays =
          toolInput.window_days !== undefined ? Number(toolInput.window_days) : undefined;
        const domain = toolInput.domain ? String(toolInput.domain) : undefined;
        const summary = getEvaluationSummary({ windowDays, domain });
        return { success: true, data: summary };
      }

      case 'current_time': {
        const timezone = String(toolInput.timezone ?? 'UTC');
        const now = new Date();
        let formatted: string;
        try {
          formatted = now.toLocaleString('en-US', {
            timeZone: timezone,
            dateStyle: 'full',
            timeStyle: 'long',
          });
        } catch {
          formatted = now.toUTCString();
        }

        return {
          success: true,
          data: {
            iso: now.toISOString(),
            unix: Math.floor(now.getTime() / 1000),
            formatted,
            timezone,
            day_of_week: now.toLocaleDateString('en-US', { weekday: 'long' }),
          },
        };
      }

      case 'system_exec': {
        const policy = getSystemToolPolicy(ctx.config);
        if (!policy.enabled) {
          return { success: false, error: 'System tools are disabled in config (agent.systemTools.enabled=false)' };
        }

        const command = String(toolInput.command ?? '').trim();
        if (!isSafeCommandName(command)) {
          return { success: false, error: 'Invalid command' };
        }
        if (!policy.allowedCommands.has(command)) {
          return { success: false, error: `Command not allowed: ${command}` };
        }

        const argsInput = Array.isArray(toolInput.args) ? toolInput.args : [];
        const args = argsInput.map((arg) => String(arg)).map((arg) => arg.trim());
        if (args.length > 50) {
          return { success: false, error: 'Too many arguments' };
        }
        for (const arg of args) {
          if (arg.length > 1000 || /[\r\n]/.test(arg)) {
            return { success: false, error: 'Invalid argument content' };
          }
        }

        const cwdRaw = typeof toolInput.cwd === 'string' ? toolInput.cwd.trim() : '';
        const cwd = cwdRaw.length > 0 ? cwdRaw : undefined;
        const run = await runCommand(command, args, {
          timeoutMs: policy.timeoutMs,
          maxOutputChars: policy.maxOutputChars,
          cwd,
        });
        if (run.exitCode !== 0) {
          const error = [
            `Command failed (exit ${run.exitCode})`,
            run.timedOut ? 'Timed out' : '',
            run.stderr,
          ]
            .filter(Boolean)
            .join(': ');
          return { success: false, error };
        }
        return {
          success: true,
          data: {
            command,
            args,
            stdout: run.stdout,
            stderr: run.stderr,
            exitCode: run.exitCode,
            timedOut: run.timedOut,
          },
        };
      }

      case 'system_install': {
        const policy = getSystemToolPolicy(ctx.config);
        if (!policy.enabled) {
          return { success: false, error: 'System tools are disabled in config (agent.systemTools.enabled=false)' };
        }

        const manager = String(toolInput.manager ?? 'pnpm').trim().toLowerCase() as InstallManager;
        if (!policy.allowedManagers.has(manager)) {
          return { success: false, error: `Package manager not allowed: ${manager}` };
        }

        const isGlobal = Boolean(toolInput.global ?? false);
        if (isGlobal && !policy.allowGlobalInstall) {
          return { success: false, error: 'Global installs are disabled (agent.systemTools.allowGlobalInstall=false)' };
        }

        const packages = Array.isArray(toolInput.packages)
          ? toolInput.packages.map((entry) => String(entry).trim()).filter(Boolean)
          : [];
        if (packages.length === 0) {
          return { success: false, error: 'Missing packages' };
        }
        if (packages.length > 20) {
          return { success: false, error: 'Too many packages' };
        }
        if (!packages.every(isSafePackageSpec)) {
          return { success: false, error: 'Package spec contains invalid characters' };
        }

        let args: string[];
        switch (manager) {
          case 'pnpm':
            args = ['add', ...(isGlobal ? ['-g'] : []), ...packages];
            break;
          case 'npm':
            args = ['install', ...(isGlobal ? ['-g'] : []), ...packages];
            break;
          case 'bun':
            args = ['add', ...(isGlobal ? ['-g'] : []), ...packages];
            break;
          default:
            return { success: false, error: `Unsupported manager: ${manager}` };
        }

        const cwdRaw = typeof toolInput.cwd === 'string' ? toolInput.cwd.trim() : '';
        const cwd = cwdRaw.length > 0 ? cwdRaw : undefined;
        const run = await runCommand(manager, args, {
          timeoutMs: policy.timeoutMs,
          maxOutputChars: policy.maxOutputChars,
          cwd,
        });

        if (run.exitCode !== 0) {
          const error = [
            `Install failed (exit ${run.exitCode})`,
            run.timedOut ? 'Timed out' : '',
            run.stderr,
          ]
            .filter(Boolean)
            .join(': ');
          return { success: false, error };
        }

        return {
          success: true,
          data: {
            manager,
            packages,
            global: isGlobal,
            args,
            stdout: run.stdout,
            stderr: run.stderr,
            exitCode: run.exitCode,
            timedOut: run.timedOut,
          },
        };
      }

      case 'get_wallet_info': {
        return getWalletInfo(ctx);
      }

      case 'twitter_search': {
        const query = String(toolInput.query ?? '').trim();
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 10), 1), 50);
        if (!query) {
          return { success: false, error: 'Missing query' };
        }

        // Try Twitter API v2 first
        const twitterResult = await searchTwitterDirect(query, limit, ctx);
        if (twitterResult.success) {
          return twitterResult;
        }

        // Fallback to SerpAPI
        const serpResult = await searchTwitterViaSerpApi(query, limit);
        if (serpResult.success) {
          return serpResult;
        }

        // Both failed
        return {
          success: false,
          error: `Twitter search failed: ${twitterResult.error}. SerpAPI fallback: ${serpResult.error}`,
        };
      }

      case 'web_search': {
        const query = String(toolInput.query ?? '').trim();
        const limit = Math.min(Math.max(Number(toolInput.limit ?? 5), 1), 10);
        if (!query) {
          return { success: false, error: 'Missing query' };
        }

        const searchResult = await resilientWebSearch(query, limit, ctx.config);
        if (!searchResult.success) {
          return searchResult;
        }
        if (ctx.config.qmd?.enabled && ctx.config.qmd?.autoIndexWebSearch) {
          autoIndexWebSearchResults(query, searchResult.data, ctx).catch(() => {});
        }
        return searchResult;
      }

      case 'get_portfolio': {
        return getPortfolio(ctx, toolInput);
      }

      case 'get_fills': {
        const mode = resolvePerpBookMode(ctx.config, toolInput);
        const symbol = typeof toolInput.symbol === 'string' && toolInput.symbol.trim().length > 0
          ? toolInput.symbol.trim()
          : undefined;
        const limit = Math.min(Math.max(toolInput.limit != null ? Number(toolInput.limit) : 20, 1), 100);

        if (mode === 'paper') {
          const fills = listPaperPerpFills({ symbol, limit }, ctx.config.paper?.initialCashUsdc ?? 200);
          const totalRealizedPnl = fills.reduce((sum, f) => sum + f.realizedPnlUsd, 0);
          return {
            success: true,
            data: {
              mode,
              fills: fills.map((f) => ({
                symbol: f.symbol,
                side: f.side,
                size: f.size,
                fill_price: f.fillPrice,
                realized_pnl_usd: f.realizedPnlUsd,
                fee_usd: f.feeUsd,
                reduce_only: f.reduceOnly,
                leverage: f.leverage,
                order_type: f.orderType,
                filled_at: f.createdAt,
                order_id: f.orderId,
              })),
              summary: {
                count: fills.length,
                total_realized_pnl_usd: totalRealizedPnl,
              },
            },
          };
        }

        // Live mode: fetch from Hyperliquid
        if (ctx.config.execution?.provider !== 'hyperliquid') {
          return { success: false, error: 'get_fills live mode requires hyperliquid provider' };
        }
        try {
          const client = new HyperliquidClient(ctx.config);
          if (!client.getAccountAddress()) {
            return { success: false, error: 'Hyperliquid account address not configured' };
          }
          const lookbackDays = Math.min(Math.max(toolInput.lookback_days != null ? Number(toolInput.lookback_days) : 30, 1), 90);
          const startTime = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
          const rawFills = await client.getUserFillsByTime({ startTime, aggregateByTime: false });
          const allFills = (Array.isArray(rawFills) ? rawFills : []) as Array<Record<string, unknown>>;
          const filtered = symbol
            ? allFills.filter((f) => String(f.coin ?? '').toUpperCase() === symbol.toUpperCase())
            : allFills;
          const limited = filtered.slice(0, limit);
          const mapped = limited.map((f) => {
            const sideRaw = String(f.side ?? '');
            const side = sideRaw === 'B' ? 'buy' : 'sell';
            const fillPrice = Number(f.px ?? NaN);
            const size = Number(f.sz ?? NaN);
            const realizedPnl = Number(f.closedPnl ?? 0);
            const fee = Number(f.fee ?? 0);
            const filledAt = Number.isFinite(Number(f.time)) ? new Date(Number(f.time)).toISOString() : '';
            const orderId = f.oid != null ? String(f.oid) : '';
            return {
              symbol: String(f.coin ?? ''),
              side,
              size: Number.isFinite(size) ? size : null,
              fill_price: Number.isFinite(fillPrice) ? fillPrice : null,
              realized_pnl_usd: Number.isFinite(realizedPnl) ? realizedPnl : 0,
              fee_usd: Number.isFinite(fee) ? fee : 0,
              reduce_only: null,
              leverage: null,
              order_type: null,
              filled_at: filledAt,
              order_id: orderId,
              dir: f.dir != null ? String(f.dir) : null,
            };
          });
          const totalRealizedPnl = mapped.reduce((sum, f) => sum + (f.realized_pnl_usd ?? 0), 0);
          return {
            success: true,
            data: {
              mode,
              fills: mapped,
              summary: {
                count: mapped.length,
                total_realized_pnl_usd: totalRealizedPnl,
              },
            },
          };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
        }
      }

      case 'get_positions': {
        const mode = resolvePerpBookMode(ctx.config, toolInput);
        if (mode === 'paper') {
          const mids = await resolvePaperMids(ctx.marketClient, ctx.config);
          const snapshot = buildPaperPerpSnapshot(ctx.config.paper?.initialCashUsdc ?? 200, mids);
          return {
            success: true,
            data: {
              mode,
              positions: snapshot.positions,
              summary: {
                account_value: snapshot.accountValueUsdc,
                withdrawable: snapshot.cashBalanceUsdc,
                source: 'paper',
              },
            },
          };
        }
        try {
          const data = await loadPerpPositions(ctx);
          return { success: true, data: { mode, ...data } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'get_open_orders': {
        const mode = resolvePerpBookMode(ctx.config, toolInput);
        const executor = resolvePerpExecutor(ctx, mode);
        try {
          const orders = await executor.getOpenOrders();
          return { success: true, data: { mode, orders } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      }

      case 'web_fetch': {
        const url = String(toolInput.url ?? '').trim();
        const maxChars = Math.min(Math.max(Number(toolInput.max_chars ?? 10000), 100), 50000);
        if (!url) {
          return { success: false, error: 'Missing URL' };
        }
        if (!isSafeUrl(url)) {
          return { success: false, error: 'URL is not allowed' };
        }
        const fetchResult = await fetchAndExtract(url, maxChars);
        // Auto-index to QMD if enabled (fire-and-forget)
        if (fetchResult.success && ctx.config.qmd?.enabled && ctx.config.qmd?.autoIndexWebFetch) {
          autoIndexWebFetchResult(fetchResult.data, ctx).catch(() => {});
        }
        return fetchResult;
      }

      
      case 'qmd_query': {
        return qmdQuery(toolInput, ctx);
      }

      case 'qmd_index': {
        return qmdIndex(toolInput, ctx);
      }

      case 'mentat_store_assumption': {
        return mentatStoreAssumption(toolInput, ctx);
      }

      case 'mentat_store_fragility': {
        return mentatStoreFragility(toolInput, ctx);
      }

      case 'mentat_store_mechanism': {
        return mentatStoreMechanism(toolInput, ctx);
      }

      case 'mentat_query': {
        return mentatQuery(toolInput, ctx);
      }

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

function normalizePrice(market: Market, outcome: 'Yes' | 'No'): number | null {
  const fromMap =
    market.prices?.[outcome] ??
    market.prices?.[outcome.toUpperCase()] ??
    market.prices?.[outcome.toLowerCase()] ??
    undefined;
  if (typeof fromMap === 'number') {
    return fromMap;
  }
  if (typeof fromMap === 'string') {
    const parsed = Number(fromMap);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (market.prices && typeof market.prices === 'object') {
    const key = outcome === 'Yes' ? '0' : '1';
    const indexed = (market.prices as Record<string, unknown>)[key];
    if (typeof indexed === 'number') {
      return indexed;
    }
    if (typeof indexed === 'string') {
      const parsed = Number(indexed);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  if (Array.isArray(market.prices)) {
    const index = outcome === 'Yes' ? 0 : 1;
    const value = market.prices[index];
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
  return null;
}

function formatMarketsForTool(markets: Market[]): object[] {
  return markets.map((market) => ({
    id: market.id,
    question: market.question,
    outcomes: market.outcomes,
    yes_price: normalizePrice(market, 'Yes'),
    no_price: normalizePrice(market, 'No'),
    volume: market.volume ?? null,
    category: market.category ?? null,
    symbol: market.symbol ?? null,
    mark_price: market.markPrice ?? null,
    kind: market.kind ?? null,
    platform: market.platform ?? null,
  }));
}

function formatMarketForTool(market: Market): object {
  return {
    id: market.id,
    question: market.question,
    outcomes: market.outcomes,
    yes_price: normalizePrice(market, 'Yes'),
    no_price: normalizePrice(market, 'No'),
    volume: market.volume ?? null,
    liquidity: market.liquidity ?? null,
    category: market.category ?? null,
    end_date: market.endDate ?? null,
    resolved: market.resolved ?? false,
    symbol: market.symbol ?? null,
    mark_price: market.markPrice ?? null,
    kind: market.kind ?? null,
    platform: market.platform ?? null,
  };
}

function formatIntelForTool(items: StoredIntel[]): object[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    source: item.source,
    timestamp: item.timestamp,
    url: item.url,
    summary: item.content?.slice(0, 500) ?? null,
  }));
}

function getWalletInfo(ctx: ToolExecutorContext): ToolResult {
  try {
    if (ctx.config.execution?.provider === 'hyperliquid') {
      const address =
        ctx.config.hyperliquid?.accountAddress ??
        process.env.HYPERLIQUID_ACCOUNT_ADDRESS ??
        null;
      return {
        success: true,
        data: {
          address,
          chain: 'hyperliquid',
          token: 'USDC',
          rpc_url: ctx.config.hyperliquid?.baseUrl ?? null,
          keystore_path: null,
        },
      };
    }
    const keystorePath =
      ctx.config.wallet?.keystorePath ??
      process.env.THUFIR_KEYSTORE_PATH ??
      `${process.env.HOME ?? ''}/.thufir/keystore.json`;
    const store = loadKeystore(keystorePath);
    const address = store.address
      ? store.address.startsWith('0x')
        ? store.address
        : `0x${store.address}`
      : null;

    return {
      success: true,
      data: {
        address,
        chain: null,
        token: null,
        keystore_path: keystorePath,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

async function getPortfolio(
  ctx: ToolExecutorContext,
  toolInput: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const mode = resolvePerpBookMode(ctx.config, toolInput);
    const balances = await getBalances(ctx, mode);
    const limiterState = ctx.limiter?.getState?.();
    const dailyLimit = ctx.config.wallet?.limits?.daily ?? 100;
    const remainingDaily =
      limiterState != null
        ? Math.max(0, dailyLimit - limiterState.todaySpent - limiterState.reserved)
        : null;
    const hasHyperliquidConfigured =
      Boolean(ctx.config.hyperliquid?.enabled) ||
      Boolean(ctx.config.hyperliquid?.accountAddress) ||
      Boolean(ctx.config.hyperliquid?.privateKey) ||
      Boolean(process.env.HYPERLIQUID_ACCOUNT_ADDRESS) ||
      Boolean(process.env.HYPERLIQUID_PRIVATE_KEY);
    const hasHyperliquid = mode === 'live' && hasHyperliquidConfigured;
    let perpPositions: {
      positions: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    } | null = null;
    let perpError: string | null = null;
    let spotBalances: {
      balances: Array<Record<string, unknown>>;
      escrows: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    } | null = null;
    let spotError: string | null = null;
    let hyperliquidFees: Record<string, unknown> | null = null;
    let hyperliquidFeesError: string | null = null;
    let hyperliquidPortfolio: Record<string, unknown> | null = null;
    let hyperliquidPortfolioError: string | null = null;
    let dexAbstraction: boolean | null = null;
    let dexAbstractionError: string | null = null;
    if (mode === 'paper') {
      const mids = await resolvePaperMids(ctx.marketClient, ctx.config);
      const snapshot = buildPaperPerpSnapshot(ctx.config.paper?.initialCashUsdc ?? 200, mids);
      perpPositions = {
        positions: snapshot.positions,
        summary: {
          account_value: snapshot.accountValueUsdc,
          total_notional: snapshot.totalNotionalUsdc,
          total_margin_used: null,
          cross_account_value: snapshot.accountValueUsdc,
          cross_total_notional: null,
          cross_total_margin_used: null,
          cross_maintenance_margin_used: null,
          withdrawable: snapshot.cashBalanceUsdc,
          source: 'paper',
        },
      };
    } else if (hasHyperliquid) {
      try {
        const client = new HyperliquidClient(ctx.config);
        dexAbstraction = await client.getUserDexAbstraction();
      } catch (error) {
        dexAbstractionError = error instanceof Error ? error.message : 'Unknown error';
      }
      try {
        perpPositions = await loadPerpPositions(ctx);
      } catch (error) {
        perpError = error instanceof Error ? error.message : 'Unknown error';
      }
      try {
        spotBalances = await loadSpotBalances(ctx);
      } catch (error) {
        spotError = error instanceof Error ? error.message : 'Unknown error';
      }
      try {
        hyperliquidFees = await loadHyperliquidFees(ctx);
      } catch (error) {
        hyperliquidFeesError = error instanceof Error ? error.message : 'Unknown error';
      }
      try {
        hyperliquidPortfolio = await loadHyperliquidPortfolio(ctx);
      } catch (error) {
        hyperliquidPortfolioError = error instanceof Error ? error.message : 'Unknown error';
      }
    }

    const spotUsdcRow = (spotBalances?.balances ?? []).find((b) => String(b.coin).toUpperCase() === 'USDC');
    const spotUsdcTotal =
      spotUsdcRow && typeof spotUsdcRow.total === 'number' && Number.isFinite(spotUsdcRow.total)
        ? spotUsdcRow.total
        : null;
    const spotUsdcHold =
      spotUsdcRow && typeof spotUsdcRow.hold === 'number' && Number.isFinite(spotUsdcRow.hold)
        ? spotUsdcRow.hold
        : null;
    const spotUsdcFree =
      spotUsdcRow && typeof spotUsdcRow.free === 'number' && Number.isFinite(spotUsdcRow.free)
        ? spotUsdcRow.free
        : spotUsdcTotal != null && spotUsdcHold != null
          ? Math.max(0, spotUsdcTotal - spotUsdcHold)
          : null;

    const perpWithdrawable =
      perpPositions?.summary && typeof (perpPositions.summary as any).withdrawable === 'number'
        ? ((perpPositions.summary as any).withdrawable as number)
        : null;
    const perpAccountValue =
      perpPositions?.summary && typeof (perpPositions.summary as any).account_value === 'number'
        ? ((perpPositions.summary as any).account_value as number)
        : null;

    // Determine available perp collateral for Hyperliquid.
    // When dex abstraction is enabled (HIP-3), spot USDC free IS perp collateral.
    // When dex abstraction is disabled/unknown, prefer perp withdrawable, but fall
    // back to spot USDC free when perp withdrawable is zero — many accounts function
    // as unified even when the legacy dexAbstraction flag returns false.  The exchange
    // itself enforces collateral requirements, so reporting the best-available figure
    // prevents the agent from refusing to trade when funds are clearly present.
    let availableBalance: number;
    let availableBalanceNote: string;
    if (!hasHyperliquid) {
      availableBalance = balances.usdc ?? 0;
      availableBalanceNote =
        mode === 'paper'
          ? 'available_balance reflects paper cash balance in the paper perp book.'
          : 'available_balance reflects on-chain wallet/memory cash balance (not exchange collateral).';
    } else if (dexAbstraction === true) {
      availableBalance = spotUsdcFree ?? 0;
      availableBalanceNote =
        'Hyperliquid DEX abstraction is enabled; available_balance reflects Hyperliquid spot USDC free (unified collateral).';
    } else {
      // dexAbstraction is false or null.  Use perp withdrawable when it has
      // funds; otherwise fall back to spot USDC free (covers unified accounts
      // whose dexAbstraction flag is not yet set).
      const perpFunds = perpWithdrawable ?? 0;
      const spotFunds = spotUsdcFree ?? 0;
      if (perpFunds > 0) {
        availableBalance = perpFunds;
        availableBalanceNote =
          'available_balance reflects Hyperliquid perp withdrawable USDC (free collateral). Spot USDC is also present but tracked separately.';
      } else {
        availableBalance = spotFunds;
        availableBalanceNote =
          'Perp withdrawable is 0; available_balance reflects Hyperliquid spot USDC free. On unified accounts spot USDC serves as perp collateral — place orders normally and the exchange will validate.';
      }
    }

    return {
      success: true,
      data: {
        // Legacy field: this is on-chain wallet (or memory/paper) balances, not Hyperliquid Spot/Perp balances.
        balances,
        onchain_balances: balances,
        onchain_balances_note:
          'On-chain wallet (or memory/paper) balances. Do not confuse with Hyperliquid Spot/Perp USDC collateral.',
        positions: [],
        summary: {
          execution_mode: mode,
          available_balance: availableBalance,
          available_balance_note: availableBalanceNote,
          onchain_usdc: balances.usdc ?? 0,
          hyperliquid_dex_abstraction: dexAbstraction,
          hyperliquid_dex_abstraction_note:
            dexAbstraction === true
              ? 'DEX abstraction (HIP-3) enabled: spot and perp USDC are unified for collateral.'
              : 'Use available_balance as your trading collateral. Place orders normally — the exchange validates collateral at order time.',
          hyperliquid_spot_usdc_free: spotUsdcFree,
          hyperliquid_spot_usdc_total: spotUsdcTotal,
          hyperliquid_perp_withdrawable_usdc: perpWithdrawable,
          hyperliquid_perp_account_value: perpAccountValue,
          remaining_daily_limit: remainingDaily,
          positions_source: 'none',
          perp_enabled: hasHyperliquid,
          perp_mode: mode,
        },
        hyperliquid_balances: hasHyperliquid
          ? {
              spot: {
                usdc: { total: spotUsdcTotal, hold: spotUsdcHold, free: spotUsdcFree },
              },
              perp: {
                withdrawable: perpWithdrawable,
                account_value: perpAccountValue,
              },
              dexAbstraction,
            }
          : null,
        perp_positions: perpPositions?.positions ?? [],
        perp_summary: perpPositions?.summary ?? null,
        perp_error: perpError,
        spot_balances: spotBalances?.balances ?? [],
        spot_escrows: spotBalances?.escrows ?? [],
        spot_summary: spotBalances?.summary ?? null,
        spot_error: spotError,
        hyperliquid_fees: hyperliquidFees,
        hyperliquid_fees_error: hyperliquidFeesError,
        hyperliquid_portfolio: hyperliquidPortfolio,
        hyperliquid_portfolio_error: hyperliquidPortfolioError,
        hyperliquid_dex_abstraction_error: dexAbstractionError,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

async function loadPerpPositions(
  ctx: ToolExecutorContext
): Promise<{
  positions: Array<{
    symbol: string;
    side: string;
    size: number;
    entry_price: number | null;
    position_value: number | null;
    unrealized_pnl: number | null;
    return_on_equity: number | null;
    liquidation_price: number | null;
    margin_used: number | null;
    leverage_type: string | null;
    leverage: number | null;
    max_leverage: number | null;
  }>;
  summary: {
    account_value: number | null;
    total_notional: number | null;
    total_margin_used: number | null;
    cross_account_value: number | null;
    cross_total_notional: number | null;
    cross_total_margin_used: number | null;
    cross_maintenance_margin_used: number | null;
    withdrawable: number | null;
  };
}> {
  const client = new HyperliquidClient(ctx.config);
  const state = (await client.getClearinghouseState()) as {
    assetPositions?: Array<{ position?: Record<string, unknown> }>;
    marginSummary?: Record<string, unknown>;
    crossMarginSummary?: Record<string, unknown>;
    withdrawable?: string | number;
    crossMaintenanceMarginUsed?: string | number;
  };

  const toNumber = (value: unknown): number | null => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const positions = (state.assetPositions ?? [])
    .map((entry) => entry?.position ?? {})
    .map((position) => {
      const size = toNumber((position as { szi?: unknown }).szi);
      if (size == null || size === 0) return null;
      const side = size > 0 ? 'long' : 'short';
      const leverage = (position as { leverage?: { type?: string; value?: number | string } })
        .leverage;
      const leverageValue = toNumber(leverage?.value);
      const positionValue = toNumber((position as { positionValue?: unknown }).positionValue);
      const marginUsed = toNumber((position as { marginUsed?: unknown }).marginUsed);
      const unrealizedPnl = toNumber((position as { unrealizedPnl?: unknown }).unrealizedPnl);
      const returnOnEquity = toNumber((position as { returnOnEquity?: unknown }).returnOnEquity);
      const coin = String((position as { coin?: unknown }).coin ?? '');

      // Tier 1: API field
      let effectiveLeverage: number | null = leverageValue;
      // Tier 2: positionValue / marginUsed (cross positions where margin is reported)
      if (effectiveLeverage == null && positionValue != null && marginUsed != null && marginUsed > 0) {
        effectiveLeverage = Math.round((positionValue / marginUsed) * 10) / 10;
      }
      // Tier 3: derive margin from ROE (returnOnEquity = unrealizedPnl / marginUsed)
      if (effectiveLeverage == null && positionValue != null && returnOnEquity != null && returnOnEquity !== 0 && unrealizedPnl != null && unrealizedPnl !== 0) {
        const derivedMargin = unrealizedPnl / returnOnEquity;
        if (Number.isFinite(derivedMargin) && derivedMargin > 0) {
          effectiveLeverage = Math.round((positionValue / derivedMargin) * 10) / 10;
        }
      }
      // Tier 4: look up from perp trade journal (for Thufir-placed positions)
      if (effectiveLeverage == null && coin) {
        const journalEntry = listPerpTrades({ symbol: coin, limit: 20 })
          .find((t) => t.leverage != null);
        if (journalEntry?.leverage != null) {
          effectiveLeverage = Number(journalEntry.leverage);
        }
      }
      return {
        symbol: coin,
        side,
        size: Math.abs(size),
        entry_price: toNumber((position as { entryPx?: unknown }).entryPx),
        position_value: positionValue,
        unrealized_pnl: unrealizedPnl,
        return_on_equity: returnOnEquity,
        liquidation_price: toNumber((position as { liquidationPx?: unknown }).liquidationPx),
        margin_used: marginUsed,
        leverage_type: leverage?.type ?? null,
        leverage: effectiveLeverage,
        max_leverage: toNumber((position as { maxLeverage?: unknown }).maxLeverage),
      };
    })
    .filter((position): position is NonNullable<typeof position> => Boolean(position));

  const marginSummary = state.marginSummary ?? {};
  const crossSummary = state.crossMarginSummary ?? {};
  return {
    positions,
    summary: {
      account_value: toNumber((marginSummary as { accountValue?: unknown }).accountValue),
      total_notional: toNumber((marginSummary as { totalNtlPos?: unknown }).totalNtlPos),
      total_margin_used: toNumber(
        (marginSummary as { totalMarginUsed?: unknown }).totalMarginUsed
      ),
      cross_account_value: toNumber((crossSummary as { accountValue?: unknown }).accountValue),
      cross_total_notional: toNumber((crossSummary as { totalNtlPos?: unknown }).totalNtlPos),
      cross_total_margin_used: toNumber(
        (crossSummary as { totalMarginUsed?: unknown }).totalMarginUsed
      ),
      cross_maintenance_margin_used: toNumber(state.crossMaintenanceMarginUsed),
      withdrawable: toNumber(state.withdrawable),
    },
  };
}

function computeMaxDrawdownPct(series: Array<[number, number]>): number | null {
  if (!Array.isArray(series) || series.length < 2) return null;
  let peak = series[0]![1];
  let maxDd = 0;
  for (const [, value] of series) {
    if (!Number.isFinite(value)) continue;
    if (value > peak) peak = value;
    if (peak > 0) {
      const dd = (peak - value) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return Number.isFinite(maxDd) ? maxDd * 100 : null;
}

async function estimatePerpOrderFee(
  ctx: ToolExecutorContext,
  params: {
    orderType: 'market' | 'limit';
    size: number;
    inputPrice?: number;
    markPrice: number | null;
  }
): Promise<PerpOrderFeeEstimate> {
  const estimatedNotional =
    Number.isFinite(params.inputPrice) && (params.inputPrice as number) > 0
      ? params.size * (params.inputPrice as number)
      : Number.isFinite(params.markPrice) && (params.markPrice as number) > 0
        ? params.size * (params.markPrice as number)
        : null;
  const feeType: 'taker' | 'maker' = params.orderType === 'market' ? 'taker' : 'maker';
  const fallback: PerpOrderFeeEstimate = {
    estimated_notional_usd: Number.isFinite(estimatedNotional) ? estimatedNotional : null,
    estimated_fee_rate: null,
    estimated_fee_type: feeType,
    estimated_fee_usd: null,
  };
  if (ctx.config.execution?.provider !== 'hyperliquid') {
    return fallback;
  }
  try {
    const client = new HyperliquidClient(ctx.config);
    if (!client.getAccountAddress()) return fallback;
    const fees = (await client.getUserFees()) as {
      userCrossRate?: string | number;
      userAddRate?: string | number;
    };
    const rateRaw = feeType === 'taker' ? fees.userCrossRate : fees.userAddRate;
    const rate = Number(rateRaw);
    const estimatedFee =
      Number.isFinite(rate) && Number.isFinite(estimatedNotional)
        ? rate * (estimatedNotional as number)
        : null;
    return {
      estimated_notional_usd: Number.isFinite(estimatedNotional) ? estimatedNotional : null,
      estimated_fee_rate: Number.isFinite(rate) ? rate : null,
      estimated_fee_type: feeType,
      estimated_fee_usd: Number.isFinite(estimatedFee) ? estimatedFee : null,
    };
  } catch {
    return fallback;
  }
}

function parseOrderIdFromResultMessage(message: string | undefined): number | null {
  if (typeof message !== 'string') return null;
  const match = message.match(/oid=(\d+)/i);
  if (!match) return null;
  const orderId = Number(match[1]);
  return Number.isFinite(orderId) ? orderId : null;
}

function parseTimestampMs(value: string | null | undefined): number {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return NaN;
  }
  const sqliteLike = value.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
  if (sqliteLike) {
    return Date.parse(`${sqliteLike[1]}T${sqliteLike[2]}Z`);
  }
  return Date.parse(value);
}

async function fetchRealizedPerpFee(
  ctx: ToolExecutorContext,
  params: {
    symbol: string;
    side: 'buy' | 'sell';
    startTimeMs: number;
    orderId?: number | null;
  }
): Promise<PerpOrderRealizedFee> {
  const summary = await fetchRealizedPerpCloseSummary(ctx, params);
  return {
    realized_fee_usd: summary.realized_fee_usd,
    realized_fee_token: summary.realized_fee_token,
    realized_fill_count: summary.realized_fill_count,
    realized_order_id: summary.realized_order_id,
    realized_fill_time_ms: summary.realized_fill_time_ms,
    error: summary.error ?? null,
  };
}

async function fetchRealizedPerpCloseSummary(
  ctx: ToolExecutorContext,
  params: {
    symbol: string;
    startTimeMs: number;
    orderId?: number | null;
  }
): Promise<PerpOrderRealizedCloseSummary> {
  const fallback: PerpOrderRealizedFee = {
    realized_fee_usd: null,
    realized_fee_token: null,
    realized_fill_count: 0,
    realized_order_id: params.orderId ?? null,
    realized_fill_time_ms: null,
    error: null,
  };
  const closeFallback: PerpOrderRealizedCloseSummary = {
    ...fallback,
    realized_pnl_usd: null,
    net_realized_pnl_usd: null,
  };
  if (ctx.config.execution?.provider !== 'hyperliquid') {
    return closeFallback;
  }
  try {
    const client = new HyperliquidClient(ctx.config);
    if (!client.getAccountAddress()) return closeFallback;
    const fillsRaw = await client.getUserFillsByTime({
      startTime: Math.max(0, params.startTimeMs),
      endTime: Date.now(),
      aggregateByTime: false,
    });
    const fills = (Array.isArray(fillsRaw) ? fillsRaw : []).filter((fill) => {
      if (!fill || typeof fill !== 'object') return false;
      const coin = String((fill as { coin?: unknown }).coin ?? '').toUpperCase();
      return coin === params.symbol.toUpperCase();
    }) as Array<Record<string, unknown>>;

    if (fills.length === 0) return closeFallback;

    const firstFill = fills[0]!;
    let selected = fills;
    if (params.orderId != null) {
      const byOrder = fills.filter((fill) => Number(fill.oid) === params.orderId);
      if (byOrder.length > 0) {
        selected = byOrder;
      }
    } else {
      const newest = fills.reduce((acc, fill) => {
        const t = Number(fill.time ?? 0);
        const accT = Number(acc?.time ?? 0);
        return t > accT ? fill : acc;
      }, firstFill);
      const newestOrderId = Number(newest?.oid ?? NaN);
      if (Number.isFinite(newestOrderId)) {
        const byNewestOrder = fills.filter((fill) => Number(fill.oid) === newestOrderId);
        if (byNewestOrder.length > 0) {
          selected = byNewestOrder;
        } else {
          selected = [newest];
        }
      } else {
        selected = [newest];
      }
    }

    const totalFee = selected.reduce((sum, fill) => {
      const fee = Number(fill.fee ?? NaN);
      return Number.isFinite(fee) ? sum + fee : sum;
    }, 0);
    const newestFill = selected.reduce((acc, fill) => {
      const t = Number(fill.time ?? 0);
      const accT = Number(acc?.time ?? 0);
      return t > accT ? fill : acc;
    }, selected[0]!);
    const tokenRaw = newestFill?.feeToken;
    const token = typeof tokenRaw === 'string' ? tokenRaw : null;
    const selectedOrderId = Number(newestFill?.oid ?? NaN);
    const selectedFillTime = Number(newestFill?.time ?? NaN);
    const totalRealizedPnl = selected.reduce((sum, fill) => {
      const realizedPnl = Number(fill.closedPnl ?? NaN);
      return Number.isFinite(realizedPnl) ? sum + realizedPnl : sum;
    }, 0);
    const normalizedFee = Number.isFinite(totalFee) ? totalFee : null;
    const normalizedRealizedPnl = Number.isFinite(totalRealizedPnl) ? totalRealizedPnl : null;
    return {
      realized_fee_usd: Number.isFinite(totalFee) ? totalFee : null,
      realized_fee_token: token,
      realized_fill_count: selected.length,
      realized_order_id: Number.isFinite(selectedOrderId)
        ? selectedOrderId
        : (params.orderId ?? null),
      realized_fill_time_ms: Number.isFinite(selectedFillTime) ? selectedFillTime : null,
      realized_pnl_usd: normalizedRealizedPnl,
      net_realized_pnl_usd:
        normalizedRealizedPnl == null
          ? null
          : normalizedRealizedPnl - (normalizedFee ?? 0),
      error: null,
    };
  } catch (error) {
    return {
      ...closeFallback,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function computePnlForPeriod(series: Array<[number, number]>): number | null {
  if (!Array.isArray(series) || series.length < 2) return null;
  const first = series[0]![1];
  const last = series[series.length - 1]![1];
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return last - first;
}

async function loadHyperliquidFees(ctx: ToolExecutorContext): Promise<Record<string, unknown>> {
  const client = new HyperliquidClient(ctx.config);
  const fees = (await client.getUserFees()) as {
    feeSchedule?: Record<string, unknown>;
    dailyUserVlm?: Array<{ date?: string; userCross?: string | number; userAdd?: string | number }>;
    userCrossRate?: string | number;
    userAddRate?: string | number;
    userSpotCrossRate?: string | number;
    userSpotAddRate?: string | number;
  };

  const daily = Array.isArray(fees.dailyUserVlm) ? fees.dailyUserVlm : [];
  const toNum = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const dailyWithTotals = daily.map((d) => {
    const cross = toNum(d.userCross);
    const add = toNum(d.userAdd);
    return { date: d.date ?? null, user_cross: cross, user_add: add, user_total: cross + add };
  });

  const last14 = dailyWithTotals.slice(-14);
  const volume14d = last14.reduce((sum, d) => sum + (d.user_total ?? 0), 0);

  return {
    rates: {
      perps: { taker: toNum(fees.userCrossRate), maker: toNum(fees.userAddRate) },
      spot: { taker: toNum(fees.userSpotCrossRate), maker: toNum(fees.userSpotAddRate) },
    },
    fee_schedule: fees.feeSchedule ?? null,
    volume_14d: volume14d,
    daily_volume: dailyWithTotals,
  };
}

async function loadHyperliquidPortfolio(
  ctx: ToolExecutorContext
): Promise<Record<string, unknown>> {
  const client = new HyperliquidClient(ctx.config);
  const response = (await client.getPortfolioMetrics()) as unknown;
  const tuples = (Array.isArray(response) ? response : []) as Array<
    [string, { accountValueHistory?: Array<[number, string | number]>; pnlHistory?: Array<[number, string | number]>; vlm?: string | number }]
  >;

  const toNumSeries = (
    series: Array<[number, string | number]> | undefined
  ): Array<[number, number]> =>
    (series ?? [])
      .map((pair) => [Number(pair[0]), Number(pair[1])] as [number, number])
      .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));

  const periods: Record<string, unknown> = {};
  for (const [name, data] of tuples) {
    const account = toNumSeries(data?.accountValueHistory);
    const pnl = toNumSeries(data?.pnlHistory);
    const vlm = Number(data?.vlm ?? 0);
    periods[name] = {
      volume: Number.isFinite(vlm) ? vlm : 0,
      pnl_delta: computePnlForPeriod(pnl),
      max_drawdown_pct: computeMaxDrawdownPct(account),
      points: {
        account_value: account.length,
        pnl: pnl.length,
      },
    };
  }

  return { periods };
}

async function loadSpotBalances(
  ctx: ToolExecutorContext
): Promise<{
  balances: Array<{
    coin: string;
    token: number | null;
    total: number | null;
    hold: number | null;
    free: number | null;
    entry_notional: number | null;
  }>;
  escrows: Array<{
    coin: string;
    token: number | null;
    total: number | null;
  }>;
  summary: {
    tokens: number;
    total_free: number;
    total_hold: number;
  };
}> {
  const client = new HyperliquidClient(ctx.config);
  const state = (await client.getSpotClearinghouseState()) as {
    balances?: Array<Record<string, unknown>>;
    evmEscrows?: Array<Record<string, unknown>>;
  };

  const toNumber = (value: unknown): number | null => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const balances = (state.balances ?? []).map((b) => {
    const total = toNumber((b as { total?: unknown }).total);
    const hold = toNumber((b as { hold?: unknown }).hold);
    const free =
      total != null && hold != null ? Math.max(0, total - hold) : null;
    return {
      coin: String((b as { coin?: unknown }).coin ?? ''),
      token: toNumber((b as { token?: unknown }).token),
      total,
      hold,
      free,
      entry_notional: toNumber((b as { entryNtl?: unknown }).entryNtl),
    };
  });

  const escrows = (state.evmEscrows ?? []).map((e) => ({
    coin: String((e as { coin?: unknown }).coin ?? ''),
    token: toNumber((e as { token?: unknown }).token),
    total: toNumber((e as { total?: unknown }).total),
  }));

  const totalFree = balances.reduce((sum, b) => sum + (b.free ?? 0), 0);
  const totalHold = balances.reduce((sum, b) => sum + (b.hold ?? 0), 0);

  return {
    balances,
    escrows,
    summary: {
      tokens: balances.length,
      total_free: totalFree,
      total_hold: totalHold,
    },
  };
}

function formatSignalSymbol(symbol: string): string {
  if (!symbol) return symbol;
  if (symbol.includes('/')) return symbol;
  return `${symbol}/USDT`;
}

function biasToScore(bias?: string | null): number {
  if (!bias) return 0;
  if (bias === 'up') return 1;
  if (bias === 'down') return -1;
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function analyzePerpMarket(
  ctx: ToolExecutorContext,
  symbol: string,
  horizon?: string,
  probabilityMode?: string
): Promise<Record<string, unknown>> {
  const market = await ctx.marketClient.getMarket(symbol);
  const baseSymbol = market.symbol ?? market.id;
  const signalSymbol = formatSignalSymbol(baseSymbol);

  const [priceVol, funding, orderflow] = await Promise.all([
    signalPriceVolRegime(ctx.config, signalSymbol),
    signalHyperliquidFundingOISkew(ctx.config, signalSymbol),
    signalHyperliquidOrderflowImbalance(ctx.config, signalSymbol),
  ]);

  const signals = [priceVol, funding, orderflow].filter(Boolean) as Array<{
    kind: string;
    directionalBias: string;
    confidence: number;
    metrics?: Record<string, unknown>;
  }>;

  const biasScore = signals.reduce(
    (acc, s) => acc + biasToScore(s.directionalBias) * (s.confidence ?? 0),
    0
  );
  const avgConfidence = signals.length
    ? signals.reduce((acc, s) => acc + (s.confidence ?? 0), 0) / signals.length
    : 0;
  const mode = probabilityMode?.toLowerCase() ?? 'balanced';
  const [capLow, capHigh] =
    mode === 'conservative'
      ? [0.35, 0.65]
      : mode === 'aggressive'
        ? [0.1, 0.9]
        : [0.2, 0.8];
  const probUp =
    signals.length === 0 ? 0.5 : clamp(0.5 + biasScore * 0.15, capLow, capHigh);
  const direction =
    probUp > 0.55 ? 'up' : probUp < 0.45 ? 'down' : 'neutral';

  const risks: string[] = [];
  if (signals.length === 0) {
    risks.push('No signal data available for this symbol.');
  }
  if (avgConfidence < 0.25) {
    risks.push('Low signal confidence; consider smaller sizing.');
  }
  if (!market.markPrice) {
    risks.push('Missing mark price; verify market data.');
  }

  return {
    symbol: baseSymbol,
    horizon: horizon ?? 'hours',
    mark_price: market.markPrice ?? null,
    max_leverage: market.metadata?.maxLeverage ?? null,
    probability_mode: mode,
    direction,
    prob_up: Number(probUp.toFixed(2)),
    confidence: Number(avgConfidence.toFixed(2)),
    signals: signals.map((s) => ({
      kind: s.kind,
      bias: s.directionalBias,
      confidence: s.confidence,
      metrics: s.metrics ?? null,
    })),
    risks,
  };
}

async function analyzePositions(
  ctx: ToolExecutorContext,
  minLiqBufferPct: number,
  maxConcentrationPct: number,
  leverageWarning: number
): Promise<Record<string, unknown>> {
  const data = await loadPerpPositions(ctx);
  const positions = data.positions ?? [];
  const enriched = await Promise.all(
    positions.map(async (pos) => {
      const symbol = pos.symbol;
      let markPrice: number | null = null;
      try {
        const market = await ctx.marketClient.getMarket(symbol);
        markPrice = market.markPrice ?? null;
      } catch {
        markPrice = null;
      }
      const liq = pos.liquidation_price ?? null;
      const side = pos.side ?? 'long';
      let bufferPct: number | null = null;
      if (markPrice != null && liq != null) {
        const distance = side === 'long' ? markPrice - liq : liq - markPrice;
        bufferPct = markPrice > 0 ? (distance / markPrice) * 100 : null;
      }
      const notional =
        pos.position_value ??
        (markPrice != null ? Math.abs(pos.size) * markPrice : null);
      const leverageFlag =
        typeof pos.leverage === 'number' && pos.leverage > leverageWarning;
      return {
        ...pos,
        mark_price: markPrice,
        notional,
        liq_buffer_pct: bufferPct,
        liq_risk: bufferPct != null && bufferPct < minLiqBufferPct,
        leverage_warning: leverageFlag,
      };
    })
  );

  const totalNotional = enriched.reduce((sum, p) => sum + (p.notional ?? 0), 0);
  const concentration = enriched
    .map((p) => ({
      symbol: p.symbol,
      share: totalNotional > 0 ? (p.notional ?? 0) / totalNotional : 0,
    }))
    .sort((a, b) => b.share - a.share);

  const warnings: string[] = [];
  for (const p of enriched) {
    if (p.liq_risk) {
      warnings.push(`${p.symbol}: liquidation buffer ${p.liq_buffer_pct?.toFixed(1)}%`);
    }
    if (p.leverage_warning) {
      warnings.push(`${p.symbol}: leverage ${p.leverage}x exceeds ${leverageWarning}x`);
    }
  }
  if ((concentration[0]?.share ?? 0) * 100 > maxConcentrationPct) {
    warnings.push(
      `Concentration risk: ${concentration[0]!.symbol} at ${(concentration[0]!.share * 100).toFixed(
        1
      )}%`
    );
  }

  return {
    summary: {
      total_positions: enriched.length,
      total_notional: totalNotional,
      max_concentration: concentration[0]?.share ?? 0,
      min_liq_buffer_pct: minLiqBufferPct,
      max_concentration_pct: maxConcentrationPct,
      leverage_warning: leverageWarning,
    },
    concentration,
    warnings,
    positions: enriched,
  };
}

async function buildDiscoveryReport(
  config: ThufirConfig,
  limit: number
): Promise<Record<string, unknown>> {
  const result = await runDiscovery(config);
  const expressions = result.expressions.slice(0, limit);
  return {
    clusters: result.clusters.map((cluster) => ({
      symbol: cluster.symbol,
      bias: cluster.directionalBias,
      confidence: cluster.confidence,
      time_horizon: cluster.timeHorizon,
      signals: cluster.signals.map((s) => s.kind),
    })),
    hypotheses: result.hypotheses.slice(0, limit),
    expressions,
  };
}

async function buildTradeReview(
  ctx: ToolExecutorContext,
  symbol?: string,
  limit = 20
): Promise<Record<string, unknown>> {
  const trades = listPerpTrades({ symbol, limit });
  const reviewed = await Promise.all(
    trades.map(async (trade) => {
      let markPrice: number | null = null;
      try {
        const market = await ctx.marketClient.getMarket(trade.symbol);
        markPrice = market.markPrice ?? null;
      } catch {
        markPrice = null;
      }
      const entry = trade.price ?? null;
      let unrealizedPnl: number | null = null;
      if (entry != null && markPrice != null) {
        const delta = trade.side === 'buy' ? markPrice - entry : entry - markPrice;
        unrealizedPnl = delta * trade.size;
      }
      return {
        id: trade.id,
        created_at: trade.createdAt,
        symbol: trade.symbol,
        side: trade.side,
        size: trade.size,
        entry_price: entry,
        mark_price: markPrice,
        leverage: trade.leverage ?? null,
        order_type: trade.orderType ?? null,
        status: trade.status ?? null,
        unrealized_pnl: unrealizedPnl,
      };
    })
  );

  const totalPnl = reviewed.reduce((sum, t) => sum + (t.unrealized_pnl ?? 0), 0);

  return {
    count: reviewed.length,
    total_unrealized_pnl: totalPnl,
    trades: reviewed,
    note: 'Unrealized PnL uses current mark price; realized PnL not tracked yet.',
  };
}

async function getBalances(ctx: ToolExecutorContext, modeOverride?: PerpBookMode): Promise<{
  usdc?: number;
  matic?: number;
  source: string;
}> {
  const mode = modeOverride ?? (ctx.config.execution?.mode === 'live' ? 'live' : 'paper');
  if (mode !== 'live') {
    const paperBook = getPaperPerpBookSummary(ctx.config.paper?.initialCashUsdc ?? 200);
    return { usdc: paperBook.cashBalanceUsdc, matic: 0, source: 'paper' };
  }

  const password = process.env.THUFIR_WALLET_PASSWORD;
  if (!password) {
    return { usdc: getCashBalance(), matic: 0, source: 'memory' };
  }

  try {
    const wallet = loadWallet(ctx.config, password);
    const balances = await getWalletBalances(wallet);
    if (!balances) {
      return { usdc: getCashBalance(), matic: 0, source: 'memory' };
    }
    return { usdc: balances.usdc ?? 0, matic: balances.matic ?? 0, source: 'chain' };
  } catch {
    return { usdc: getCashBalance(), matic: 0, source: 'memory' };
  }
}

/**
 * Search Twitter directly via Twitter API v2
 */
async function searchTwitterDirect(
  query: string,
  limit: number,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const bearer =
    ctx.config.intel?.sources?.twitter?.bearerToken ?? process.env.TWITTER_BEARER;
  if (!bearer) {
    return { success: false, error: 'Twitter bearer token not configured' };
  }

  try {
    const baseUrl =
      ctx.config.intel?.sources?.twitter?.baseUrl ?? 'https://api.twitter.com/2';
    const url = new URL(`${baseUrl}/tweets/search/recent`);
    url.searchParams.set('query', `${query} -is:retweet lang:en`);
    url.searchParams.set('max_results', String(Math.max(10, limit)));
    url.searchParams.set('tweet.fields', 'created_at,author_id,public_metrics');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'username,name');

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${bearer}` },
    });

    if (!response.ok) {
      return { success: false, error: `Twitter API: ${response.status}` };
    }

    const data = (await response.json()) as {
      data?: Array<{
        id: string;
        text: string;
        created_at?: string;
        author_id?: string;
        public_metrics?: {
          like_count: number;
          retweet_count: number;
          reply_count: number;
        };
      }>;
      includes?: {
        users?: Array<{ id: string; username: string; name: string }>;
      };
    };

    const users = new Map(
      (data.includes?.users ?? []).map((u) => [u.id, u])
    );

    const tweets = (data.data ?? []).map((tweet) => {
      const text = (tweet.text ?? '').replace(/\s+/g, ' ').trim();
      return {
        id: tweet.id,
        text,
        author: users.get(tweet.author_id ?? '')?.username ?? 'unknown',
        likes: tweet.public_metrics?.like_count ?? 0,
        retweets: tweet.public_metrics?.retweet_count ?? 0,
        url: `https://twitter.com/i/status/${tweet.id}`,
        timestamp: tweet.created_at ?? null,
      };
    });

    return { success: true, data: tweets };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Search Twitter via SerpAPI (fallback)
 */
async function searchTwitterViaSerpApi(
  query: string,
  limit: number
): Promise<ToolResult> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return { success: false, error: 'SerpAPI key not configured' };
  }

  try {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'twitter');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      return { success: false, error: `SerpAPI: ${response.status}` };
    }

    const data = (await response.json()) as {
      tweets?: Array<{
        text?: string;
        user?: { screen_name?: string };
        created_at?: string;
        likes?: number;
        retweets?: number;
        link?: string;
      }>;
    };

    const tweets = (data.tweets ?? []).slice(0, limit).map((tweet) => ({
      text: (tweet.text ?? '').replace(/\s+/g, ' ').trim(),
      author: tweet.user?.screen_name ?? 'unknown',
      likes: tweet.likes ?? 0,
      retweets: tweet.retweets ?? 0,
      url: tweet.link ?? null,
      timestamp: tweet.created_at ?? null,
    }));

    return { success: true, data: tweets };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

function isSafeUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return false;
  }
  if (hostname === 'metadata.google.internal') {
    return false;
  }

  const ipType = isIP(hostname);
  if (ipType === 0) {
    return true;
  }

  if (ipType === 4) {
    const parts = hostname.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
      return false;
    }
    const [a, b] = parts;
    if (a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && typeof b === 'number' && b >= 16 && b <= 31) return false;
    return true;
  }

  if (ipType === 6) {
    const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '');
    if (normalized === '::1') return false;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
    if (normalized.startsWith('fe80')) return false;
  }

  return true;
}

async function fetchAndExtract(url: string, maxChars: number): Promise<ToolResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Thufir/1.0; +https://github.com/thufir)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      return { success: false, error: `Fetch failed: ${response.status}` };
    }

    const maxBytes = 2_000_000;
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
      return { success: false, error: 'Response too large' };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      return { success: false, error: 'Response too large' };
    }

    const body = new TextDecoder().decode(buffer);

    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      const truncated = body.length > maxChars;
      return {
        success: true,
        data: {
          url,
          title: null,
          content: body.slice(0, maxChars),
          truncated,
        },
      };
    }

    const dom = new JSDOM(body, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) {
      const text = dom.window.document.body?.textContent ?? '';
      const cleaned = text.replace(/\s+/g, ' ').trim();
      return {
        success: true,
        data: {
          url,
          title: dom.window.document.title ?? null,
          content: cleaned.slice(0, maxChars),
          truncated: cleaned.length > maxChars,
        },
      };
    }

    const content = article.textContent.replace(/\s+/g, ' ').trim();
    return {
      success: true,
      data: {
        url,
        title: article.title ?? null,
        byline: article.byline ?? null,
        content: content.slice(0, maxChars),
        truncated: content.length > maxChars,
        length: article.length,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check if QMD is available on the system.
 */
async function resolveQmdCommand(): Promise<string | null> {
  const candidates = [
    process.env.QMD_BIN,
    'qmd',
    join(homedir(), '.local', 'bin', 'qmd'),
    join(homedir(), '.bun', 'bin', 'qmd'),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      if (candidate.includes('/')) {
        await access(candidate, fsConstants.X_OK);
      } else {
        await execAsync(`${candidate} --version`);
      }
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

async function isQmdAvailable(): Promise<boolean> {
  try {
    return (await resolveQmdCommand()) !== null;
  } catch {
    return false;
  }
}

/**
 * Get QMD knowledge base path from config or default.
 */
function getQmdKnowledgePath(ctx: ToolExecutorContext): string {
  return ctx.config.qmd?.knowledgePath ?? join(homedir(), '.thufir', 'knowledge');
}

function buildQmdCliArgs(
  mode: 'query' | 'search' | 'vsearch',
  query: string,
  limit: number,
  collection?: string
): string[] {
  const args = [mode, JSON.stringify(query), '--json', '-n', String(limit)];
  if (collection) {
    args.push('-c', collection);
  }
  return args;
}

async function runQmdCommand(
  qmdCommand: string,
  args: string[],
  timeout = 30000
): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`${JSON.stringify(qmdCommand)} ${args.join(' ')}`, {
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function isQmdDeepQueryCrash(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('segmentation fault') ||
    lower.includes('bun has crashed') ||
    lower.includes('panic:') ||
    lower.includes('timed out') ||
    lower.includes('exit code 124') ||
    lower.includes('exit code 137') ||
    lower.includes(' killed') ||
    lower.includes('dumped core')
  );
}

function parseQmdOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'No results found.') {
    return [];
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

/**
 * Search the local knowledge base using QMD hybrid search.
 */
async function qmdQuery(
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const query = String(toolInput.query ?? '').trim();
  const mode = String(toolInput.mode ?? 'query');
  const limit = Math.min(Math.max(Number(toolInput.limit ?? 10), 1), 50);
  const collection = toolInput.collection ? String(toolInput.collection) : undefined;

  if (!query) {
    return { success: false, error: 'Missing query' };
  }

  if (!['query', 'search', 'vsearch'].includes(mode)) {
    return { success: false, error: 'Invalid mode. Use: query, search, or vsearch' };
  }

  if (!ctx.config.qmd?.enabled) {
    return { success: false, error: 'QMD is not enabled in config' };
  }

  const available = await isQmdAvailable();
  if (!available) {
    return { success: false, error: 'QMD is not installed. Run: bun install -g github:tobi/qmd' };
  }
  const qmdCommand = await resolveQmdCommand();
  if (!qmdCommand) {
    return { success: false, error: 'QMD is not installed. Run: bun install -g github:tobi/qmd' };
  }

  try {
    const args = buildQmdCliArgs(mode as 'query' | 'search' | 'vsearch', query, limit, collection);
    const { stdout, stderr } = await runQmdCommand(qmdCommand, args);

    if (stderr && !stdout) {
      return { success: false, error: stderr.trim() };
    }

    return {
      success: true,
      data: {
        query,
        mode,
        collection: collection ?? 'all',
        results: parseQmdOutput(stdout),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (mode === 'query') {
      try {
        const fallbackMode: 'search' = 'search';
        const fallbackArgs = buildQmdCliArgs(fallbackMode, query, limit, collection);
        const { stdout, stderr } = await runQmdCommand(qmdCommand, fallbackArgs, 15000);
        if (stderr && !stdout) {
          return { success: false, error: stderr.trim() };
        }

        return {
          success: true,
          data: {
            query,
            mode: fallbackMode,
            requestedMode: mode,
            degraded: true,
            warning: isQmdDeepQueryCrash(message)
              ? 'QMD deep query failed; fell back to keyword search.'
              : 'QMD query failed; fell back to keyword search.',
            originalError: message,
            collection: collection ?? 'all',
            results: parseQmdOutput(stdout),
          },
        };
      } catch (fallbackError) {
        const fallbackMessage =
          fallbackError instanceof Error ? fallbackError.message : 'Unknown error';
        return {
          success: false,
          error: `QMD query failed: ${message}. Fallback search failed: ${fallbackMessage}`,
        };
      }
    }
    return { success: false, error: `QMD query failed: ${message}` };
  }
}

/**
 * Index content into the QMD knowledge base.
 */
async function qmdIndex(
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const content = String(toolInput.content ?? '').trim();
  const title = String(toolInput.title ?? 'Untitled');
  const collection = String(toolInput.collection ?? 'thufir-research');
  const source = toolInput.source ? String(toolInput.source) : undefined;

  if (!content) {
    return { success: false, error: 'Missing content' };
  }

  if (!ctx.config.qmd?.enabled) {
    return { success: false, error: 'QMD is not enabled in config' };
  }

  const available = await isQmdAvailable();
  if (!available) {
    return { success: false, error: 'QMD is not installed. Run: bun install -g github:tobi/qmd' };
  }
  const qmdCommand = await resolveQmdCommand();
  if (!qmdCommand) {
    return { success: false, error: 'QMD is not installed. Run: bun install -g github:tobi/qmd' };
  }

  const knowledgePath = getQmdKnowledgePath(ctx);

  try {
    // Create a temporary markdown file for QMD to index
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.md`;
    const collectionPath = join(knowledgePath, collection.replace('thufir-', ''));
    await mkdir(collectionPath, { recursive: true });
    const filepath = join(collectionPath, filename);

    // Build markdown content with frontmatter
    const frontmatter = [
      '---',
      `title: "${title.replace(/"/g, '\\"')}"`,
      `indexed: ${new Date().toISOString()}`,
    ];
    if (source) {
      frontmatter.push(`source: "${source.replace(/"/g, '\\"')}"`);
    }
    frontmatter.push('---', '', content);

    await writeFile(filepath, frontmatter.join('\n'), 'utf-8');

    // Run qmd embed to update embeddings
    try {
      await execAsync(`${JSON.stringify(qmdCommand)} embed --collection ${collection}`, {
        timeout: 60000,
      });
    } catch {
      // Embedding failure is non-fatal, content is still indexed for BM25 search
    }

    return {
      success: true,
      data: {
        indexed: true,
        title,
        collection,
        filepath,
        source: source ?? null,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: `QMD index failed: ${message}` };
  }
}

/**
 * Auto-index web search results into QMD (fire-and-forget).
 * Combines all search results into a single document for efficient storage.
 */
async function autoIndexWebSearchResults(
  query: string,
  data: unknown,
  ctx: ToolExecutorContext
): Promise<void> {
  const available = await isQmdAvailable();
  if (!available) return;

  const searchData = data as {
    query?: string;
    provider?: string;
    results?: Array<{
      title?: string;
      url?: string;
      snippet?: string;
      date?: string;
      source?: string;
    }>;
  };

  const results = searchData.results ?? [];
  if (results.length === 0) return;

  // Build markdown content from search results
  const lines: string[] = [
    `# Web Search: ${query}`,
    '',
    `**Provider:** ${searchData.provider ?? 'unknown'}`,
    `**Date:** ${new Date().toISOString()}`,
    `**Results:** ${results.length}`,
    '',
    '---',
    '',
  ];

  for (const result of results) {
    lines.push(`## ${result.title ?? 'Untitled'}`);
    if (result.url) {
      lines.push(`**URL:** ${result.url}`);
    }
    if (result.date) {
      lines.push(`**Date:** ${result.date}`);
    }
    if (result.snippet) {
      lines.push('', result.snippet);
    }
    lines.push('', '---', '');
  }

  const content = lines.join('\n');
  const title = `Web Search: ${query}`;

  // Index using qmdIndex internally
  await qmdIndex(
    {
      content,
      title,
      collection: 'thufir-research',
      source: `web_search:${searchData.provider ?? 'unknown'}`,
    },
    ctx
  );
}

/**
 * Auto-index web fetch result into QMD (fire-and-forget).
 */
async function autoIndexWebFetchResult(
  data: unknown,
  ctx: ToolExecutorContext
): Promise<void> {
  const available = await isQmdAvailable();
  if (!available) return;

  const fetchData = data as {
    url?: string;
    title?: string;
    byline?: string;
    content?: string;
    truncated?: boolean;
  };

  const content = fetchData.content;
  if (!content || content.length < 100) return; // Skip very short content

  const title = fetchData.title ?? fetchData.url ?? 'Web Page';
  const url = fetchData.url ?? '';

  // Build markdown with metadata
  const lines: string[] = [
    `# ${title}`,
    '',
  ];
  if (fetchData.byline) {
    lines.push(`**Author:** ${fetchData.byline}`);
  }
  if (url) {
    lines.push(`**Source:** ${url}`);
  }
  lines.push(`**Fetched:** ${new Date().toISOString()}`);
  if (fetchData.truncated) {
    lines.push(`**Note:** Content was truncated`);
  }
  lines.push('', '---', '', content);

  const fullContent = lines.join('\n');

  // Index using qmdIndex internally
  await qmdIndex(
    {
      content: fullContent,
      title,
      collection: 'thufir-research',
      source: url || 'web_fetch',
    },
    ctx
  );
}

/**
 * Store an assumption in the mentat knowledge base.
 */
async function mentatStoreAssumption(
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const statement = String(toolInput.statement ?? '').trim();
  const system = String(toolInput.system ?? '').trim();
  const evidenceFor = Array.isArray(toolInput.evidence_for) ? toolInput.evidence_for : [];
  const evidenceAgainst = Array.isArray(toolInput.evidence_against) ? toolInput.evidence_against : [];
  const dependencies = Array.isArray(toolInput.dependencies) ? toolInput.dependencies : [];
  const stressScore = toolInput.stress_score === undefined ? null : Number(toolInput.stress_score);
  const lastTested = toolInput.last_tested ? String(toolInput.last_tested) : null;
  const criticality = String(toolInput.criticality ?? 'medium');

  if (!statement) {
    return { success: false, error: 'Missing statement' };
  }
  if (!system) {
    return { success: false, error: 'Missing system' };
  }

  const assumptionId = upsertAssumption({
    system,
    statement,
    dependencies,
    evidenceFor,
    evidenceAgainst,
    stressScore: Number.isFinite(stressScore ?? undefined) ? stressScore : null,
    lastTested,
  });

  // Build markdown content for the assumption
  const lines: string[] = [
    '---',
    'type: assumption',
    `system: "${system}"`,
    `criticality: "${criticality}"`,
    `stress_score: ${typeof stressScore === 'number' ? stressScore.toFixed(2) : 'null'}`,
    `last_tested: ${lastTested ?? 'null'}`,
    `created: ${new Date().toISOString()}`,
    `validated: false`,
    '---',
    '',
    `# Assumption: ${statement}`,
    '',
    `**System:** ${system}`,
    `**Criticality:** ${criticality}`,
    '',
  ];

  if (evidenceFor.length > 0) {
    lines.push('## Evidence For');
    for (const e of evidenceFor) {
      lines.push(`- ${e}`);
    }
    lines.push('');
  }

  if (evidenceAgainst.length > 0) {
    lines.push('## Evidence Against');
    for (const e of evidenceAgainst) {
      lines.push(`- ${e}`);
    }
    lines.push('');
  }

  if (dependencies.length > 0) {
    lines.push('## Dependencies');
    for (const d of dependencies) {
      lines.push(`- ${d}`);
    }
    lines.push('');
  }

  const content = lines.join('\n');
  const title = `Assumption: ${statement.slice(0, 50)}${statement.length > 50 ? '...' : ''}`;

  if (!ctx.config.qmd?.enabled) {
    return {
      success: true,
      data: {
        id: assumptionId,
        stored: 'db',
        indexed: false,
      },
    };
  }

  const qmdResult = await qmdIndex(
    {
      content,
      title,
      collection: 'thufir-markets',
      source: `mentat:assumption:${system}`,
    },
    ctx
  );

  if (!qmdResult.success) {
    return qmdResult;
  }

  return {
    success: true,
    data: {
      id: assumptionId,
      stored: 'db',
      indexed: true,
      qmd: qmdResult.data,
    },
  };
}

/**
 * Store a fragility card in the mentat knowledge base.
 */
async function mentatStoreFragility(
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const system = String(toolInput.system ?? '').trim();
  const mechanism = String(toolInput.mechanism ?? '').trim();
  const exposureSurface = String(toolInput.exposure_surface ?? '').trim();
  const earlySignals = Array.isArray(toolInput.early_signals) ? toolInput.early_signals : [];
  const falsifiers = Array.isArray(toolInput.falsifiers) ? toolInput.falsifiers : [];
  const downside = String(toolInput.downside ?? '');
  const convexity = toolInput.convexity ? String(toolInput.convexity) : '';
  const recoveryCapacity = toolInput.recovery_capacity ? String(toolInput.recovery_capacity) : '';
  const score = Number(toolInput.score ?? 0);

  if (!system) {
    return { success: false, error: 'Missing system' };
  }
  if (!mechanism) {
    return { success: false, error: 'Missing mechanism' };
  }
  if (!exposureSurface) {
    return { success: false, error: 'Missing exposure_surface' };
  }

  const cardId = upsertFragilityCard({
    system,
    mechanismId: null,
    exposureSurface,
    convexity: convexity || null,
    earlySignals,
    falsifiers,
    downside: downside || null,
    recoveryCapacity: recoveryCapacity || null,
    score: Number.isFinite(score) ? score : null,
  });

  // Build markdown content for the fragility card
  const lines: string[] = [
    '---',
    'type: fragility_card',
    `system: "${system}"`,
    `score: ${score.toFixed(2)}`,
    `convexity: "${convexity || 'unknown'}"`,
    `recovery_capacity: "${recoveryCapacity || 'unknown'}"`,
    `created: ${new Date().toISOString()}`,
    '---',
    '',
    `# Fragility Card: ${system}`,
    '',
    `**Mechanism:** ${mechanism}`,
    '',
    `**Exposure Surface:** ${exposureSurface}`,
    '',
    `**Fragility Score:** ${score.toFixed(2)}`,
    '',
  ];

  if (downside) {
    lines.push(`## Downside`);
    lines.push(downside);
    lines.push('');
  }

  if (convexity) {
    lines.push('## Convexity');
    lines.push(convexity);
    lines.push('');
  }

  if (recoveryCapacity) {
    lines.push('## Recovery Capacity');
    lines.push(recoveryCapacity);
    lines.push('');
  }

  if (earlySignals.length > 0) {
    lines.push('## Early Warning Signals');
    for (const s of earlySignals) {
      lines.push(`- ${s}`);
    }
    lines.push('');
  }

  if (falsifiers.length > 0) {
    lines.push('## Falsifiers');
    lines.push('*Conditions that would invalidate this fragility assessment:*');
    for (const f of falsifiers) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  const content = lines.join('\n');
  const title = `Fragility: ${system} - ${mechanism.slice(0, 30)}`;

  if (!ctx.config.qmd?.enabled) {
    return {
      success: true,
      data: {
        id: cardId,
        stored: 'db',
        indexed: false,
      },
    };
  }

  const qmdResult = await qmdIndex(
    {
      content,
      title,
      collection: 'thufir-intel',
      source: `mentat:fragility:${system}`,
    },
    ctx
  );

  if (!qmdResult.success) {
    return qmdResult;
  }

  return {
    success: true,
    data: {
      id: cardId,
      stored: 'db',
      indexed: true,
      qmd: qmdResult.data,
    },
  };
}

/**
 * Store a mechanism in the mentat knowledge base.
 */
async function mentatStoreMechanism(
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const name = String(toolInput.name ?? '').trim();
  const system = String(toolInput.system ?? '').trim();
  const causalChain = Array.isArray(toolInput.causal_chain) ? toolInput.causal_chain : [];
  const triggerClass = toolInput.trigger_class ? String(toolInput.trigger_class) : '';
  const propagationPath = Array.isArray(toolInput.propagation_path) ? toolInput.propagation_path : [];

  if (!name) {
    return { success: false, error: 'Missing name' };
  }
  if (!system) {
    return { success: false, error: 'Missing system' };
  }

  const mechanismId = upsertMechanism({
    system,
    name,
    causalChain,
    triggerClass: triggerClass || null,
    propagationPath,
  });

  const lines: string[] = [
    '---',
    'type: mechanism',
    `system: "${system}"`,
    `trigger_class: "${triggerClass || 'unknown'}"`,
    `created: ${new Date().toISOString()}`,
    '---',
    '',
    `# Mechanism: ${name}`,
    '',
    `**System:** ${system}`,
  ];

  if (causalChain.length > 0) {
    lines.push('', '## Causal Chain');
    for (const step of causalChain) {
      lines.push(`- ${step}`);
    }
  }

  if (propagationPath.length > 0) {
    lines.push('', '## Propagation Path');
    for (const step of propagationPath) {
      lines.push(`- ${step}`);
    }
  }

  const content = lines.join('\n');
  const title = `Mechanism: ${name.slice(0, 50)}${name.length > 50 ? '...' : ''}`;

  if (!ctx.config.qmd?.enabled) {
    return {
      success: true,
      data: {
        id: mechanismId,
        stored: 'db',
        indexed: false,
      },
    };
  }

  const qmdResult = await qmdIndex(
    {
      content,
      title,
      collection: 'thufir-markets',
      source: `mentat:mechanism:${system}`,
    },
    ctx
  );

  if (!qmdResult.success) {
    return qmdResult;
  }

  return {
    success: true,
    data: {
      id: mechanismId,
      stored: 'db',
      indexed: true,
      qmd: qmdResult.data,
    },
  };
}

/**
 * Query the mentat knowledge base for assumptions, fragility cards, or mechanisms.
 */
async function mentatQuery(
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
): Promise<ToolResult> {
  const query = String(toolInput.query ?? '').trim();
  const type = String(toolInput.type ?? 'all');
  const system = toolInput.system ? String(toolInput.system) : undefined;
  const limit = Math.min(Math.max(Number(toolInput.limit ?? 10), 1), 50);

  if (!query) {
    return { success: false, error: 'Missing query' };
  }

  if (!ctx.config.qmd?.enabled) {
    return { success: false, error: 'QMD is not enabled in config' };
  }

  // Build enhanced query with type filter
  let enhancedQuery = query;
  if (type !== 'all') {
    enhancedQuery = `type:${type} ${query}`;
  }
  if (system) {
    enhancedQuery = `system:${system} ${enhancedQuery}`;
  }

  // Determine which collection to search
  let collection: string | undefined;
  if (type === 'assumption') {
    collection = 'thufir-markets';
  } else if (type === 'fragility') {
    collection = 'thufir-intel';
  }
  // 'all' or 'mechanism' searches all collections

  // Use qmd_query internally
  return qmdQuery(
    {
      query: enhancedQuery,
      mode: 'query',
      limit,
      collection,
    },
    ctx
  );
}
