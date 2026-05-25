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
import type { LearningCaseInput } from '../memory/learning_cases.js';
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
