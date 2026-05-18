import type { ExecutionLearningCase } from './execution_learning.js';
import type { ThufirConfig } from './config.js';
import type { Market } from '../execution/markets.js';
import type { MarketClient } from '../execution/market-client.js';
import type { ExecutionAdapter, TradeDecision, TradeResult } from '../execution/executor.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import {
  clearActivePerpPositionLifecycle,
  getActivePerpPositionTradeId,
  recordPerpTrade,
  setActivePerpPositionLifecycle,
} from '../memory/perp_trades.js';
import { findOpenPerpPrediction } from '../memory/predictions.js';
import { recordOutcome } from '../memory/calibration.js';
import type { LearningCaseInput } from '../memory/learning_cases.js';
import { listPaperPerpFills } from '../memory/paper_perps.js';
import { getPaperPositionSnapshot } from './tool_executor_paper.js';
import type { ExitReasonCode, TradeArchetype } from './trade_contract.js';

export type PerpBookMode = 'paper' | 'live';
export type PerpExitMode = ExitReasonCode;

export interface PerpLifecycleContext {
  config: ThufirConfig;
}

type PerpExecutionAttempt = {
  attempt: number;
  slippage_bps: number;
  executed: boolean;
  message: string;
};

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

function isNoImmediateMatchError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /could not immediately match against any resting orders/i.test(message);
}

export async function executePerpWithRetry(params: {
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

export function resolvePerpBookMode(config: ThufirConfig, toolInput: Record<string, unknown>): PerpBookMode {
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

export function normalizeTradeArchetype(input: unknown): TradeArchetype | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (value === 'scalp' || value === 'intraday' || value === 'swing') {
    return value;
  }
  return null;
}

export function validatePerpOrderContract(input: {
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

export async function getPerpPositionSnapshotForLifecycle(params: {
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

export async function getLiveReduceOnlyPositionSnapshot(
  config: ThufirConfig,
  symbol: string
): Promise<ReduceOnlyPositionSnapshot | null> {
  return getReduceOnlyPositionSnapshot(config, symbol);
}

export async function maybeResolvePerpPredictionFromClose(params: {
  ctx: PerpLifecycleContext;
  mode: 'live' | 'paper';
  symbol: string;
  reduceOnly: boolean;
  positionBefore: ReduceOnlyPositionSnapshot | null;
  positionAfter: ReduceOnlyPositionSnapshot | null;
}): Promise<void> {
  if (!params.reduceOnly || params.positionBefore == null) {
    return;
  }
  if (params.positionAfter != null && (params.positionAfter.size ?? 0) > 0) {
    return;
  }

  const openPrediction = findOpenPerpPrediction(params.symbol);
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
  ctx: PerpLifecycleContext;
  mode: 'live' | 'paper';
  symbol: string;
  predictionCreatedAt: string;
}): Promise<PerpCloseResolutionSummary> {
  const predictionStartMs = parseTimestampMs(params.predictionCreatedAt);
  const effectiveStartMs = Number.isFinite(predictionStartMs)
    ? Math.max(0, predictionStartMs - 5_000)
    : Date.now() - 86_400_000;

  if (params.mode === 'paper') {
    const fills = listPaperPerpFills({ symbol: params.symbol, limit: 100 }, params.ctx.config.paper?.initialCashUsdc ?? 200)
      .filter((fill) => parseTimestampMs(fill.createdAt) >= effectiveStartMs);
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
    const netRealizedPnlUsd = realizedPnlUsd - feeUsd;
    return {
      netRealizedPnlUsd,
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

export async function resolvePerpLifecycleTradeId(params: {
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

function toFiniteOrNull(input: unknown): number | null {
  const value = Number(input);
  return Number.isFinite(value) ? value : null;
}

function meanOrNull(values: Array<number | null>): number | null {
  const usable = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (usable.length === 0) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

export interface PerpExecutionLearningCaseInput {
  symbol: string;
  executionMode: 'paper' | 'live';
  tradeId: number | null;
  hypothesisId: string | null;
  capturedAtMs: number;
  side: 'buy' | 'sell';
  size: number;
  leverage: number | null;
  direction: 'long' | 'short' | null;
  signalClass: string | null;
  triggerReason: string | null;
  symbolClass: string | null;
  session: string | null;
  strategySource: string | null;
  marketRegime: string | null;
  volatilityBucket: string | null;
  liquidityBucket: string | null;
  tradeArchetype: TradeArchetype | null;
  entryTrigger: 'news' | 'technical' | 'hybrid' | null;
  expectedEdge: number | null;
  invalidationPrice: number | null;
  timeStopAtMs: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  pricePathHigh: number | null;
  pricePathLow: number | null;
  thesisCorrect: boolean | null;
  thesisInvalidationHit: boolean | null;
  exitMode: string | null;
  realizedPnlUsd: number | null;
  netRealizedPnlUsd: number | null;
  realizedFeeUsd: number | null;
  directionScore: number | null;
  timingScore: number | null;
  sizingScore: number | null;
  exitScore: number | null;
  capturedR: number | null;
  leftOnTableR: number | null;
  wouldHit2R: boolean | null;
  wouldHit3R: boolean | null;
  maeProxy: number | null;
  mfeProxy: number | null;
  reasoning: string | null;
  planContext: Record<string, unknown> | null;
  snapshot: Record<string, unknown> | null;
}

export function buildPerpExecutionLearningCase(
  input: PerpExecutionLearningCaseInput
): ExecutionLearningCase {
  const directionScore = toFiniteOrNull(input.directionScore);
  const timingScore = toFiniteOrNull(input.timingScore);
  const sizingScore = toFiniteOrNull(input.sizingScore);
  const exitScore = toFiniteOrNull(input.exitScore);

  return {
    kind: 'execution_learning_case',
    caseType: 'execution_quality',
    comparable: false,
    domain: 'perp',
    entityType: 'symbol',
    entityId: input.symbol,
    executionMode: input.executionMode,
    sourceTradeId: input.tradeId,
    sourceDossierId: null,
    sourceHypothesisId: input.hypothesisId,
    createdAtMs: input.capturedAtMs,
    context: {
      symbol: input.symbol,
      direction: input.direction,
      signalClass: input.signalClass,
      triggerReason: input.triggerReason,
      symbolClass: input.symbolClass,
      session: input.session,
      strategySource: input.strategySource,
      marketRegime: input.marketRegime,
      volatilityBucket: input.volatilityBucket,
      liquidityBucket: input.liquidityBucket,
      tradeArchetype: input.tradeArchetype,
      entryTrigger: input.entryTrigger,
    },
    action: {
      side: input.side,
      reduceOnly: true,
      size: input.size,
      leverage: input.leverage,
      expectedEdge: input.expectedEdge,
      invalidationPrice: input.invalidationPrice,
      timeStopAtMs: input.timeStopAtMs,
      entryPrice: input.entryPrice,
      exitPrice: input.exitPrice,
    },
    outcome: {
      thesisCorrect: input.thesisCorrect,
      thesisInvalidationHit: input.thesisInvalidationHit,
      exitMode: input.exitMode,
      realizedPnlUsd: input.realizedPnlUsd,
      netRealizedPnlUsd: input.netRealizedPnlUsd,
      realizedFeeUsd: input.realizedFeeUsd,
      pricePathHigh: input.pricePathHigh,
      pricePathLow: input.pricePathLow,
    },
    quality: {
      directionScore,
      timingScore,
      sizingScore,
      exitScore,
      capturedR: toFiniteOrNull(input.capturedR),
      leftOnTableR: toFiniteOrNull(input.leftOnTableR),
      wouldHit2R: input.wouldHit2R,
      wouldHit3R: input.wouldHit3R,
      maeProxy: toFiniteOrNull(input.maeProxy),
      mfeProxy: toFiniteOrNull(input.mfeProxy),
      compositeScore: meanOrNull([directionScore, timingScore, sizingScore, exitScore]),
    },
    policyInputs: {
      reasoning: input.reasoning,
      planContext: input.planContext,
    },
    sourceLinks: {
      snapshot: input.snapshot,
    },
  };
}

export function toPerpExecutionLearningCaseInput(
  learningCase: ExecutionLearningCase
): LearningCaseInput {
  return {
    caseType: 'execution_quality',
    domain: learningCase.domain,
    entityType: learningCase.entityType,
    entityId: learningCase.entityId,
    comparable: false,
    comparatorKind: null,
    sourceTradeId: learningCase.sourceTradeId,
    belief: null,
    baseline: null,
    context: learningCase.context as unknown as Record<string, unknown>,
    action: learningCase.action as unknown as Record<string, unknown>,
    outcome: learningCase.outcome as unknown as Record<string, unknown>,
    qualityScores: learningCase.quality as unknown as Record<string, unknown>,
    policyInputs: learningCase.policyInputs as unknown as Record<string, unknown>,
    exclusionReason: 'execution_quality_case',
  };
}

export async function fetchRealizedPerpFee(
  ctx: PerpLifecycleContext,
  params: {
    symbol: string;
    side: 'buy' | 'sell';
    startTimeMs: number;
    orderId?: number | null;
  }
): Promise<{
  realized_fee_usd: number | null;
  realized_fee_token: string | null;
  realized_fill_count: number;
  realized_order_id: number | null;
  realized_fill_time_ms: number | null;
  error?: string | null;
}> {
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
  ctx: PerpLifecycleContext,
  params: {
    symbol: string;
    startTimeMs: number;
    orderId?: number | null;
  }
): Promise<{
  realized_fee_usd: number | null;
  realized_fee_token: string | null;
  realized_fill_count: number;
  realized_order_id: number | null;
  realized_fill_time_ms: number | null;
  realized_pnl_usd: number | null;
  net_realized_pnl_usd: number | null;
  error?: string | null;
}> {
  const fallback = {
    realized_fee_usd: null,
    realized_fee_token: null,
    realized_fill_count: 0,
    realized_order_id: params.orderId ?? null,
    realized_fill_time_ms: null,
    error: null,
  };
  const closeFallback = {
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
