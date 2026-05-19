/**
 * Autonomous Mode Manager
 *
 * Handles fully autonomous trading:
 * - On/off toggle
 * - Auto-execute trades when edge detected
 * - Track P&L and generate daily reports
 * - Pause on loss streaks
 */

import { EventEmitter } from 'eventemitter3';
import type { LlmClient } from './llm.js';
import type { ThufirConfig } from './config.js';
import type { MarketClient } from '../execution/market-client.js';
import type { ExecutionAdapter, TradeDecision } from '../execution/executor.js';
import { DbSpendingLimitEnforcer } from '../execution/wallet/limits_db.js';
import { runDiscovery } from '../discovery/engine.js';
import { selectDiscoveryMarkets } from '../discovery/market_selector.js';
import { countFinalPredictions } from '../memory/calibration.js';
import { createLearningCase } from '../memory/learning_cases.js';
import { createPrediction } from '../memory/predictions.js';
import { recordPerpTrade } from '../memory/perp_trades.js';
import { listPerpTradeJournals, recordPerpTradeJournal } from '../memory/perp_trade_journal.js';
import { checkPerpRiskLimits } from '../execution/perp-risk.js';
import { getDailyPnLRollup } from './daily_pnl.js';
import { openDatabase } from '../memory/db.js';
import { listOpenPositionsFromTrades, type OpenTradePosition } from '../memory/trades.js';
import { Logger } from './logger.js';
import {
  applyReflectionMutation,
  classifyMarketRegime,
  classifySignalClass,
  computeFractionalKellyFraction,
  evaluateGlobalTradeGate,
  evaluateNewsEntryGate,
  isSignalClassAllowedForRegime,
  resolveLiquidityBucket,
  resolveVolatilityBucket,
} from './autonomy_policy.js';
import { getAutonomyPolicyState } from '../memory/autonomy_policy_state.js';
import { summarizeComparableSignalPerformance } from './signal_performance.js';
import { SchedulerControlPlane } from './scheduler_control_plane.js';
import { resolveSessionWeightContext } from './session-weight.js';
import { AutonomousScanTelemetry } from './performance_metrics.js';
import { withExecutionContext } from './llm_infra.js';
import { getPaperPerpBookSummary } from '../memory/paper_perps.js';
import { upsertPositionExitPolicy } from '../memory/position_exit_policy.js';
import { getCashBalance } from '../memory/portfolio.js';
import { PositionBook } from './position_book.js';
import { LlmEntryGate } from './llm_entry_gate.js';
import { buildLegacyExitContract, serializeExitContract } from './exit_contract.js';
import { TaSurface } from './ta_surface.js';
import { OriginationTrigger } from './origination_trigger.js';
import { LlmTradeOriginator } from './llm_trade_originator.js';
import { listEvents } from '../memory/events.js';
import { updateTradeProposalOutcome, updateTradeProposalStatus } from '../memory/llm_trade_proposals.js';
import { recordDecisionAudit } from '../memory/decision_audit.js';
import { getSignalWeightsWithFallback, type SignalWeights } from '../memory/learning.js';
import type { ToolExecutorContext } from './tool-executor.js';
import { inferTradeSymbolClass } from './trade_similarity.js';

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const DEFAULT_PREDICTION_SIGNAL_WEIGHTS: SignalWeights = {
  technical: 0.5,
  news: 0.3,
  onChain: 0.2,
};

function clampSignedScore(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function resolvePredictionSignalWeights(config: ThufirConfig): SignalWeights {
  const learned = getSignalWeightsWithFallback(['perp', 'global']);
  if (learned) return learned;
  const configured = config.technical?.signals?.weights;
  if (configured) {
    return {
      technical: Number(configured.technical ?? DEFAULT_PREDICTION_SIGNAL_WEIGHTS.technical),
      news: Number(configured.news ?? DEFAULT_PREDICTION_SIGNAL_WEIGHTS.news),
      onChain: Number(configured.onChain ?? DEFAULT_PREDICTION_SIGNAL_WEIGHTS.onChain),
    };
  }
  return DEFAULT_PREDICTION_SIGNAL_WEIGHTS;
}

function buildOriginatorSignalScores(proposal: {
  side: 'long' | 'short';
  confidence: number;
  expectedRMultiple: number;
  tradeType: 'scalp' | 'tactical' | 'structural';
}): SignalWeights {
  const direction = proposal.side === 'long' ? 1 : -1;
  const conviction = clamp01(proposal.confidence);
  const rrBoost = clamp01((proposal.expectedRMultiple - 1) / 3);
  const technicalBase =
    proposal.tradeType === 'scalp' ? 0.85 : proposal.tradeType === 'tactical' ? 0.65 : 0.4;
  const newsBase =
    proposal.tradeType === 'structural' ? 0.8 : proposal.tradeType === 'tactical' ? 0.35 : 0.15;
  const onChainBase =
    proposal.tradeType === 'structural' ? 0.25 : proposal.tradeType === 'tactical' ? 0.15 : 0.05;
  return {
    technical: direction * clampSignedScore(technicalBase * conviction + rrBoost * 0.15),
    news: direction * clampSignedScore(newsBase * conviction),
    onChain: direction * clampSignedScore(onChainBase * conviction),
  };
}

function buildDiscoverySignalScores(params: {
  side: 'buy' | 'sell';
  signalClass: string;
  confidenceRaw: number;
  confidenceWeighted: number;
  noveltyScore?: number | null;
  marketConfirmationScore?: number | null;
  executionStatus?: string | null;
  portfolioPosture?: string | null;
}): SignalWeights {
  const direction = params.side === 'buy' ? 1 : -1;
  const technicalConfidence = Math.max(params.confidenceRaw, params.confidenceWeighted * 0.85);
  const newsConfidence =
    params.noveltyScore != null || params.marketConfirmationScore != null
      ? ((params.noveltyScore ?? 0) + (params.marketConfirmationScore ?? 0)) / 2
      : 0.05;
  const executionBoost =
    params.executionStatus === 'good' ? 0.1 : params.executionStatus === 'poor' ? -0.1 : 0;
  const onChainBase =
    params.signalClass === 'liquidation_cascade'
      ? 0.65
      : params.portfolioPosture === 'risk_on'
        ? 0.25
        : 0.1;
  return {
    technical: direction * clampSignedScore(technicalConfidence + executionBoost),
    news: direction * clampSignedScore(newsConfidence),
    onChain: direction * clampSignedScore(onChainBase * Math.max(params.confidenceWeighted, 0.5)),
  };
}

interface ScanCycleSnapshot {
  id: string;
  capturedAtMs: number;
  capturedAtIso: string;
  clusterBySymbol: Map<string, (Awaited<ReturnType<typeof runDiscovery>>['clusters'])[number]>;
}

function formatContextPackTrace(input: {
  marketRegime: string;
  volatilityBucket: string;
  liquidityBucket: string;
  executionStatus: string;
  eventKind: string;
  portfolioPosture: string;
  missing: string[];
}): string {
  const missing = input.missing.length > 0 ? input.missing.join(',') : 'none';
  return `context_pack{regime=${input.marketRegime};vol=${input.volatilityBucket};liq=${input.liquidityBucket};exec=${input.executionStatus};event=${input.eventKind};portfolio=${input.portfolioPosture};missing=${missing}}`;
}

function createScanCycleSnapshot(discovery: Awaited<ReturnType<typeof runDiscovery>>): ScanCycleSnapshot {
  const capturedAtMs = Date.now();
  return {
    id: `scan_${capturedAtMs}`,
    capturedAtMs,
    capturedAtIso: new Date(capturedAtMs).toISOString(),
    clusterBySymbol: new Map(discovery.clusters.map((cluster) => [cluster.symbol, cluster])),
  };
}

export interface AutonomousConfig {
  enabled: boolean;
  fullAuto: boolean;
  minEdge: number;
  requireHighConfidence: boolean;
  pauseOnLossStreak: number;
  dailyReportTime: string;
  maxTradesPerScan: number;
  maxTradesPerDay: number;
}

export interface DailyPnL {
  date: string;
  tradesExecuted: number;
  wins: number;
  losses: number;
  pending: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export interface OperatorPositionSnapshot {
  marketId: string;
  outcome: 'YES' | 'NO';
  exposureUsd: number;
  unrealizedPnlUsd: number | null;
}

export interface OperatorTradeSnapshot {
  marketId: string;
  outcome: string;
  pnlUsd: number | null;
  timestamp: string;
}

export interface OperatorStatusSnapshot {
  asOf: string;
  equityUsd: number | null;
  openPositions: OperatorPositionSnapshot[];
  policyState: {
    observationOnly: boolean;
    reason: string | null;
    minEdgeOverride: number | null;
    maxTradesPerScanOverride: number | null;
    leverageCapOverride: number | null;
    tradeContractEnforced: boolean;
    decisionQualityGateEnabled: boolean;
  };
  lastTrade: OperatorTradeSnapshot | null;
  nextScanAt: string | null;
  uptimeMs: number;
  runtime: {
    enabled: boolean;
    fullAuto: boolean;
    isPaused: boolean;
    pauseReason: string;
    consecutiveLosses: number;
    remainingDaily: number;
  };
  dailyPnl: DailyPnL & { totalPnl: number };
}

export interface AutonomousEvents {
  'daily-report': (report: string) => void;
  'paused': (reason: string) => void;
  'resumed': () => void;
  'error': (error: Error) => void;
}

// Fires a one-time Telegram notification when learning_examples reaches the Phase 2 threshold.
// Resets on process restart — intentional, as the system should remind on each deploy until acted on.
let plilPhase2NotifiedThisRun = false;
const PLIL_PHASE2_THRESHOLD = 50;

export class AutonomousManager extends EventEmitter<AutonomousEvents> {
  private config: AutonomousConfig;
  private llm: LlmClient;
  private fallbackLlm: LlmClient;
  private marketClient: MarketClient;
  private executor: ExecutionAdapter;
  private limiter: DbSpendingLimitEnforcer;
  private logger: Logger;
  private thufirConfig: ThufirConfig;
  private readonly schedulerNamespace: string;
  private readonly startedAtMs: number;
  private notify?: (message: string) => Promise<void>;
  private entryGate: LlmEntryGate;

  private isPaused = false;
  private pauseReason = '';
  private consecutiveLosses = 0;
  private scheduler: SchedulerControlPlane | null = null;

  // LLM origination pipeline (v1.98)
  private taSurface: TaSurface;
  private originationTrigger: OriginationTrigger;
  private originator: LlmTradeOriginator;
  private lastFiredMs = 0;
  private symbolCooldownMap = new Map<string, number>();
  private marketContextCache: { key: string; value: string; expiresAt: number } | null = null;
  private toolContext?: ToolExecutorContext;

  constructor(
    llm: LlmClient,
    fallbackLlm: LlmClient,
    marketClient: MarketClient,
    executor: ExecutionAdapter,
    limiter: DbSpendingLimitEnforcer,
    thufirConfig: ThufirConfig,
    logger?: Logger,
    notify?: (message: string) => Promise<void>,
    toolContext?: ToolExecutorContext
  ) {
    super();
    this.llm = llm;
    this.fallbackLlm = fallbackLlm;
    this.marketClient = marketClient;
    this.executor = executor;
    this.limiter = limiter;
    this.thufirConfig = thufirConfig;
    this.logger = logger ?? new Logger('info');
    this.notify = notify;
    this.toolContext = toolContext;
    this.schedulerNamespace = this.buildSchedulerNamespace();
    this.startedAtMs = Date.now();
    this.entryGate = new LlmEntryGate(
      this.llm,
      this.fallbackLlm,
      async (msg) => { if (this.notify) await this.notify(msg); },
      PositionBook.getInstance(),
      this.thufirConfig,
    );

    this.taSurface = new TaSurface(this.thufirConfig);
    this.originationTrigger = new OriginationTrigger(this.thufirConfig);
    this.originator = new LlmTradeOriginator(
      this.llm,
      this.fallbackLlm,
      this.thufirConfig,
      this.toolContext
    );

    // Load autonomous config with defaults
    this.config = {
      enabled: thufirConfig.autonomy?.enabled ?? false,
      fullAuto: (thufirConfig.autonomy as any)?.fullAuto ?? false,
      minEdge: (thufirConfig.autonomy as any)?.minEdge ?? 0.05,
      requireHighConfidence: (thufirConfig.autonomy as any)?.requireHighConfidence ?? false,
      pauseOnLossStreak: (thufirConfig.autonomy as any)?.pauseOnLossStreak ?? 3,
      dailyReportTime: (thufirConfig.autonomy as any)?.dailyReportTime ?? '20:00',
      maxTradesPerScan: (thufirConfig.autonomy as any)?.maxTradesPerScan ?? 3,
      maxTradesPerDay: (thufirConfig.autonomy as any)?.maxTradesPerDay ?? 25,
    };

    this.ensureTradesTable();
  }

  /**
   * Start autonomous mode
   */
  start(): void {
    if (!this.config.enabled) {
      this.logger.info('Autonomous mode is disabled in config');
      return;
    }
    if (this.scheduler) {
      return;
    }

    const scanInterval = this.thufirConfig.autonomy?.scanIntervalSeconds ?? 900;
    const scheduler = new SchedulerControlPlane({
      ownerId: `autonomous:${process.pid}`,
      pollIntervalMs: 1_000,
      defaultLeaseMs: Math.max(30_000, scanInterval * 2_000),
    });

    scheduler.registerJob(
      {
        name: `${this.schedulerNamespace}:scan`,
        schedule: { kind: 'interval', intervalMs: scanInterval * 1_000 },
        leaseMs: Math.max(30_000, scanInterval * 2_000),
      },
      async () => {
        try {
          const result = await this.runScan();
          this.logger.info(`Autonomous scan result: ${result}`);
        } catch (error) {
          this.logger.error('Autonomous scan failed', error);
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      }
    );

    scheduler.registerJob(
      {
        name: `${this.schedulerNamespace}:report`,
        schedule: { kind: 'daily', time: this.config.dailyReportTime },
        leaseMs: 60_000,
      },
      async () => {
        await this.runDailyReportTick();
      }
    );

    scheduler.start();
    this.scheduler = scheduler;

    this.logger.info(`Autonomous mode started. Full auto: ${this.config.fullAuto}. Scan interval: ${scanInterval}s`);
  }

  /**
   * Stop autonomous mode
   */
  stop(): void {
    this.scheduler?.stop();
    this.scheduler = null;
    this.logger.info('Autonomous mode stopped');
  }

  /**
   * Pause autonomous trading
   */
  pause(reason: string): void {
    this.isPaused = true;
    this.pauseReason = reason;
    this.emit('paused', reason);
    this.logger.info(`Autonomous trading paused: ${reason}`);
  }

  /**
   * Resume autonomous trading
   */
  resume(): void {
    this.isPaused = false;
    this.pauseReason = '';
    this.consecutiveLosses = 0;
    this.emit('resumed');
    this.logger.info('Autonomous trading resumed');
  }

  setNotify(fn: (message: string) => Promise<void>): void {
    this.notify = fn;
  }

  /**
   * Get current status
   */
  getStatus(): {
    enabled: boolean;
    fullAuto: boolean;
    isPaused: boolean;
    pauseReason: string;
    consecutiveLosses: number;
    remainingDaily: number;
  } {
    return {
      enabled: this.config.enabled,
      fullAuto: this.config.fullAuto,
      isPaused: this.isPaused,
      pauseReason: this.pauseReason,
      consecutiveLosses: this.consecutiveLosses,
      remainingDaily: this.limiter.getRemainingDaily(),
    };
  }

  /**
   * Toggle full auto mode
   */
  setFullAuto(enabled: boolean): void {
    this.config.fullAuto = enabled;
    this.logger.info(`Full auto mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Run a scan and optionally execute trades
   */
  async runScan(options?: { forceExecute?: boolean; maxTrades?: number }): Promise<string> {
    if (this.isPaused) {
      return `Autonomous trading is paused: ${this.pauseReason}`;
    }

    if (!plilPhase2NotifiedThisRun && this.notify) {
      const count = countFinalPredictions();
      if (count >= PLIL_PHASE2_THRESHOLD) {
        plilPhase2NotifiedThisRun = true;
        this.notify(
          `🧠 PLIL Phase 2 threshold reached: ${count} confirmed predictions in learning_examples.\n` +
          `PLIL metrics and calibration-aware gate wiring are live in release-v2.00.`
        ).catch(() => {});
      }
    }

    const remaining = this.limiter.getRemainingDaily();
    if (remaining <= 0) {
      return 'Daily spending limit reached. No trades executed.';
    }

    const forceExecute = Boolean(options?.forceExecute);
    const executeTrades = forceExecute || this.config.fullAuto;
    const maxTrades = options?.maxTrades;
    const scanInput = { executeTrades, maxTrades, ignoreThresholds: forceExecute };

    // Try LLM originator path first; null means "use quant fallback"
    try {
      const originatorResult = await this.runOriginatorScan(scanInput);
      if (originatorResult !== null) {
        return originatorResult;
      }
    } catch (error) {
      this.logger.warn('Originator scan failed, falling through to quant path', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    return this.runDiscoveryScan(scanInput);
  }

  private async getMarketContextCached(signalSymbols: string[] = []): Promise<string> {
    const now = Date.now();
    const normalizedSymbols = signalSymbols
      .map((symbol) => String(symbol ?? '').trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 3);
    const cacheKey = normalizedSymbols.join(',') || 'default';
    if (
      this.marketContextCache &&
      this.marketContextCache.key === cacheKey &&
      this.marketContextCache.expiresAt > now
    ) {
      return this.marketContextCache.value;
    }
    try {
      const { gatherMarketContext } = await import('../markets/context.js');
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
              ? `crypto perpetual markets overview for ${normalizedSymbols.join(', ')}`
              : 'crypto perpetual markets overview',
          domain: 'crypto',
          marketLimit: 20,
          signalSymbols: normalizedSymbols,
        },
        executeTool
      );
      const successful = snapshot.results.filter((r: any) => r.success);
      const value = successful
        .map((r: any) => {
          const payload = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
          return `${r.label}: ${payload}`;
        })
        .join('\n')
        .slice(0, 1000);
      this.marketContextCache = {
        key: cacheKey,
        value,
        expiresAt: now + 10 * 60 * 1000,
      };
      return value;
    } catch {
      return '';
    }
  }

  private async runOriginatorScan(input: {
    executeTrades: boolean;
    maxTrades?: number;
    ignoreThresholds?: boolean;
  }): Promise<string | null> {
    // Only run when origination is explicitly configured (Zod default sets this; raw test configs won't have it)
    if (this.thufirConfig.autonomy?.origination == null) {
      return null;
    }

    const book = PositionBook.getInstance();
    const topMarketsCount = this.thufirConfig.autonomy?.origination?.topMarketsCount ?? 20;
    const cooldownMs = (this.thufirConfig.autonomy?.origination?.cooldownMinutes ?? 30) * 60 * 1000;
    const quantFallbackEnabled = this.thufirConfig.autonomy?.origination?.quantFallbackEnabled !== false;

    // Get top markets
    let topMarkets: string[];
    try {
      const selected = await selectDiscoveryMarkets(this.thufirConfig, { limit: topMarketsCount });
      topMarkets = selected.candidates.map((c) => c.symbol);
    } catch {
      topMarkets = this.thufirConfig.hyperliquid?.symbols?.length
        ? (this.thufirConfig.hyperliquid.symbols as string[])
        : ['BTC', 'ETH'];
    }

    // Compute TA surface for all top markets
    const allSnapshots = await this.taSurface.computeAll(topMarkets);

    // Filter out symbols already in the book or on cooldown
    const now = Date.now();
    const taSnapshots = allSnapshots.filter((snap) => {
      if (book.hasPosition(snap.symbol, 'long') || book.hasPosition(snap.symbol, 'short')) {
        return false;
      }
      const lastCooldown = this.symbolCooldownMap.get(snap.symbol);
      if (lastCooldown !== undefined && now - lastCooldown < cooldownMs) {
        return false;
      }
      return true;
    });

    // Get pending events for trigger
    const pendingEvents = listEvents({ limit: 10 });

    // Check if trigger fires
    const triggerResult = this.originationTrigger.shouldFire(
      this.lastFiredMs,
      taSnapshots,
      pendingEvents
    );

    if (!triggerResult.fire) {
      return null; // no-op — return null to fall through to quant path if desired
    }

    // Assemble recent events text
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const recentRaw = listEvents({ limit: 20 });
    const recent = recentRaw.filter((e) => e.createdAt > twoHoursAgo);
    const recentEvents =
      recent.length === 0
        ? '(none)'
        : recent
            .map((e) => `[${e.domain}] ${e.title}`)
            .join('\n')
            .slice(0, 500);

    // Fetch market context (10-min cached)
    const marketContext = await this.getMarketContextCached(topMarkets);

    // Assemble bundle and propose
    const bundle = {
      book: book.getAll(),
      taSnapshots,
      marketContext,
      recentEvents,
      alertedSymbols: triggerResult.alertedSymbols,
      triggerReason: triggerResult.reason,
    };

    const proposal = await this.originator.propose(bundle);

    // Track cooldown for proposed symbol regardless of outcome
    if (proposal !== null) {
      this.symbolCooldownMap.set(proposal.symbol, now);
      if (proposal.proposalRecordId != null) {
        updateTradeProposalStatus(proposal.proposalRecordId, {
          executeTrades: input.executeTrades,
          originatorExitStage: 'proposed',
          requestedLeverage: proposal.leverage,
        });
      }
    }

    // Update lastFiredMs
    this.lastFiredMs = now;

    if (proposal === null) {
      // Quant fallback only on cadence trigger
      if (triggerResult.reason === 'cadence' && quantFallbackEnabled) {
        return null; // signal caller to run quant path
      }
      return `Originator returned null (trigger=${triggerResult.reason}). No trade.`;
    }

    // Proposal is non-null — run through entry gate and execute
    if (!input.executeTrades) {
      if (proposal.proposalRecordId != null) {
        updateTradeProposalStatus(proposal.proposalRecordId, {
          executeTrades: false,
          originatorExitStage: 'execute_disabled',
          originatorExitReason: 'runScan invoked with executeTrades=false',
        });
      }
      return `Originator proposed ${proposal.symbol} ${proposal.side} (confidence=${proposal.confidence.toFixed(2)}) but execute=false.`;
    }

    // Size the trade using existing Kelly logic (simplified for originator proposals)
    const symbol = proposal.symbol;
    const side = proposal.side === 'long' ? 'buy' : 'sell';
    const market = await this.marketClient.getMarket(symbol);
    const markPrice = market.markPrice ?? 0;

    const minOrderUsd =
      typeof (this.thufirConfig as any)?.hyperliquid?.minOrderNotionalUsd === 'number'
        ? Number((this.thufirConfig as any).hyperliquid.minOrderNotionalUsd)
        : 10;

    const remainingDaily = (() => {
      const limiterRemaining = this.limiter.getRemainingDaily();
      const executionMode = this.thufirConfig.execution?.mode === 'live' ? 'live' : 'paper';
      try {
        if (executionMode === 'paper') {
          const paperInitialCash = this.thufirConfig.paper?.initialCashUsdc ?? 200;
          const freeCash = getPaperPerpBookSummary(paperInitialCash).cashBalanceUsdc;
          return Math.min(limiterRemaining, Math.max(0, freeCash));
        } else {
          const cashBalance = getCashBalance();
          if (cashBalance != null && Number.isFinite(cashBalance)) {
            return Math.min(limiterRemaining, Math.max(0, cashBalance));
          }
        }
      } catch { /* fallback */ }
      return limiterRemaining;
    })();

    const sessionContext = resolveSessionWeightContext(new Date());
    const recentJournals = listPerpTradeJournals({ limit: 200 });
    const perf = summarizeComparableSignalPerformance(recentJournals, {
      signalClass: 'llm_originator',
      symbolClass: inferTradeSymbolClass(symbol),
    });
    const kellyFraction = computeFractionalKellyFraction({
      expectedEdge: 0.1,
      signalExpectancy: Math.max(0.01, perf.expectancy + 0.5),
      signalVariance: Math.max(0.1, perf.variance),
      sampleCount: perf.sampleCount,
      maxFraction: Number((this.thufirConfig.autonomy as any)?.newsEntry?.maxKellyFraction ?? 0.25),
    });
    const baseSizeUsd = minOrderUsd * 2; // modest base for LLM originator
    const signalAdjustedUsd = baseSizeUsd * Math.max(0.25, kellyFraction * 4) * sessionContext.sessionWeight;
    let probeUsd = Math.min(Math.max(minOrderUsd, signalAdjustedUsd), remainingDaily);

    if (probeUsd <= 0 || probeUsd < minOrderUsd) {
      if (proposal.proposalRecordId != null) {
        updateTradeProposalStatus(proposal.proposalRecordId, {
          executeTrades: true,
          originatorExitStage: 'budget_blocked',
          originatorExitReason: `insufficient daily budget ${remainingDaily.toFixed(2)} below min order ${minOrderUsd.toFixed(2)}`,
        });
      }
      return `${symbol}: Skipped originator proposal (insufficient daily budget $${remainingDaily.toFixed(2)})`;
    }

    let targetLeverage = proposal.leverage;

    const riskCheck = await checkPerpRiskLimits({
      config: this.thufirConfig,
      symbol,
      side,
      size: markPrice > 0 ? probeUsd / markPrice : probeUsd,
      leverage: targetLeverage,
      reduceOnly: false,
      markPrice: markPrice || null,
      notionalUsd: probeUsd,
      marketMaxLeverage:
        typeof market.metadata?.maxLeverage === 'number'
          ? (market.metadata.maxLeverage as number)
          : null,
    });

    if (!riskCheck.allowed) {
      if (proposal.proposalRecordId != null) {
        updateTradeProposalStatus(proposal.proposalRecordId, {
          executeTrades: true,
          originatorExitStage: 'risk_blocked',
          originatorExitReason: riskCheck.reason ?? 'perp risk limits exceeded',
          requestedLeverage: targetLeverage,
        });
      }
      return `${symbol}: Originator proposal blocked (${riskCheck.reason ?? 'perp risk limits exceeded'})`;
    }

    const limitCheck = await this.limiter.checkAndReserve(probeUsd);
    if (!limitCheck.allowed) {
      if (proposal.proposalRecordId != null) {
        updateTradeProposalStatus(proposal.proposalRecordId, {
          executeTrades: true,
          originatorExitStage: 'wallet_limit_blocked',
          originatorExitReason: limitCheck.reason ?? 'wallet spending limiter blocked proposal',
          requestedLeverage: targetLeverage,
        });
      }
      return `${symbol}: Originator proposal blocked (${limitCheck.reason})`;
    }

    // LLM entry gate
    const originatorLeverageMax =
      typeof this.thufirConfig.hyperliquid?.maxLeverage === 'number' &&
      Number.isFinite(this.thufirConfig.hyperliquid.maxLeverage)
        ? Math.max(1, Number(this.thufirConfig.hyperliquid.maxLeverage))
        : 50;
    const gateCandidate = {
      symbol,
      side: side as 'buy' | 'sell',
      notionalUsd: probeUsd,
      leverage: targetLeverage,
      leverageMax: originatorLeverageMax,
      edge: 0.1,
      confidence: proposal.confidence,
      symbolClass: inferTradeSymbolClass(symbol),
      signalClass: 'llm_originator',
      regime: 'unknown',
      session: sessionContext.session,
      entryReasoning: proposal.thesisText,
      mechanicalMinEdge: this.config.minEdge,
      mechanicalMinConfidence: this.config.requireHighConfidence ? 0.7 : 0,
      invalidationPrice: proposal.invalidationPrice,
      suggestedTtlMinutes: proposal.suggestedTtlMinutes,
      expectedRMultiple: proposal.expectedRMultiple,
    };

    let originatorGateVerdict: 'approve' | 'reject' | 'resize' | null = null;
    let originatorGateReasonCode: string | null = null;
    if (this.thufirConfig.autonomy?.llmEntryGate?.enabled !== false) {
      if (proposal.proposalRecordId != null) {
        updateTradeProposalStatus(proposal.proposalRecordId, {
          executeTrades: true,
          originatorExitStage: 'entry_gate_pending',
          requestedLeverage: targetLeverage,
        });
      }
      const gateDecision = await this.entryGate.evaluate(gateCandidate, markPrice);
      originatorGateVerdict = gateDecision.verdict;
      originatorGateReasonCode = gateDecision.reasonCode ?? null;
      if (gateDecision.verdict === 'reject') {
        try {
          recordPerpTradeJournal({
            kind: 'perp_trade_journal',
            execution_mode: this.thufirConfig.execution?.mode === 'live' ? 'live' : 'paper',
            tradeId: null,
            symbol,
            side,
            size: markPrice > 0 ? probeUsd / markPrice : probeUsd,
            leverage: targetLeverage ?? null,
            orderType: 'market',
            reduceOnly: false,
            markPrice: markPrice || null,
            confidence: String(proposal.confidence),
            reasoning: `LLM entry gate rejected: ${gateDecision.reasoning}`,
            signalClass: 'llm_originator',
            symbolClass: inferTradeSymbolClass(symbol),
            expectedEdge: 0.1,
            entryGateVerdict: originatorGateVerdict,
            entryGateReasonCode: originatorGateReasonCode,
            outcome: 'blocked',
            error: gateDecision.reasoning,
          });
        } catch { /* best-effort */ }
        this.limiter.release(probeUsd);
        if (proposal.proposalRecordId != null) {
          updateTradeProposalStatus(proposal.proposalRecordId, {
            executeTrades: true,
            originatorExitStage: 'entry_gate_rejected',
            originatorExitReason: gateDecision.reasoning,
            requestedLeverage: targetLeverage,
          });
          updateTradeProposalOutcome(proposal.proposalRecordId, gateDecision.verdict, false);
        }
        return `${symbol}: Originator proposal rejected by LLM entry gate — ${gateDecision.reasoning}`;
      }
      if (gateDecision.verdict === 'resize' && gateDecision.adjustedSizeUsd) {
        probeUsd = gateDecision.adjustedSizeUsd;
      }
      if (gateDecision.suggestedLeverage != null) {
        targetLeverage = gateDecision.suggestedLeverage;
      }
      if (proposal.proposalRecordId != null) {
        updateTradeProposalStatus(proposal.proposalRecordId, {
          executeTrades: true,
          originatorExitStage: gateDecision.verdict === 'resize' ? 'entry_gate_resized' : 'entry_gate_approved',
          originatorExitReason: gateDecision.reasoning,
          requestedLeverage: targetLeverage,
        });
      }
    }

    let size = markPrice > 0 ? probeUsd / markPrice : probeUsd;

    const decision: TradeDecision = {
      action: side,
      side,
      symbol,
      size,
      orderType: 'market',
      leverage: targetLeverage,
      modelProbability: proposal.confidence,
      reasoning: `LLM originator: ${proposal.thesisText} | confidence=${proposal.confidence.toFixed(2)} invalidation=${proposal.invalidationCondition} ttl=${proposal.suggestedTtlMinutes}min`,
    };

    const tradeResult = await this.executor.execute(market, decision);
    if (proposal.proposalRecordId != null) {
      updateTradeProposalStatus(proposal.proposalRecordId, {
        executeTrades: true,
        originatorExitStage: tradeResult.executed ? 'executed' : 'execution_failed',
        originatorExitReason: tradeResult.message,
        requestedLeverage: targetLeverage,
      });
      updateTradeProposalOutcome(proposal.proposalRecordId, 'approve', tradeResult.executed);
    }
    if (tradeResult.executed) {
      this.limiter.confirm(probeUsd);

      // Record learning prediction — resolved when position closes
      let predictionId: string | null = null;
      try {
        const predictedOutcome = side === 'buy' ? 'YES' : 'NO';
        const signalWeightsSnapshot = resolvePredictionSignalWeights(this.thufirConfig);
        const signalScores = buildOriginatorSignalScores(proposal);
        predictionId = createPrediction({
          marketId: `perp:${symbol}`,
          marketTitle: `${symbol} ${side === 'buy' ? 'long' : 'short'}: ${proposal.thesisText.slice(0, 100)}`,
          predictedOutcome,
          predictedProbability: proposal.confidence,
          modelProbability: proposal.confidence,
          signalScores,
          signalWeightsSnapshot,
          sessionTag: resolveSessionWeightContext(new Date()).session,
          regimeTag: undefined,
          strategyClass: undefined,
          symbol,
          domain: 'perp',
          learningComparable: false,
          horizonMinutes: proposal.suggestedTtlMinutes,
          reasoning: proposal.thesisText,
          executed: true,
          executionPrice: markPrice || undefined,
          positionSize: size,
        });
        createLearningCase({
          caseType: 'comparable_forecast',
          domain: 'perp',
          entityType: 'symbol',
          entityId: symbol,
          comparable: false,
          comparatorKind: null,
          exclusionReason: 'missing_comparator',
          sourcePredictionId: predictionId,
          belief: {
            modelProbability: proposal.confidence,
            predictedOutcome,
          },
          baseline: {
            marketProbability: null,
          },
          context: {
            horizonMinutes: proposal.suggestedTtlMinutes,
            mode: this.thufirConfig.execution?.mode === 'live' ? 'live' : 'paper',
          },
          action: {
            side,
            executed: true,
            executionPrice: markPrice || null,
            positionSize: size,
          },
        });
      } catch { }

      try {
        recordDecisionAudit({
          source: 'autonomous',
          mode: 'autonomous',
          marketId: symbol,
          tradeAction: `${side} open ${symbol}`,
          tradeOutcome: 'executed',
          confidence: proposal.confidence,
          notes: {
            tradeType: proposal.tradeType,
            expectedRMultiple: proposal.expectedRMultiple,
            thesisText: proposal.thesisText.slice(0, 200),
            suggestedTtlMinutes: proposal.suggestedTtlMinutes,
          },
        });
      } catch { }

      // Write exit policy using proposal TTL and invalidation price
      const ttlMs = proposal.suggestedTtlMinutes * 60_000;
      const timeStopAtMs = now + ttlMs;
      try {
        const positionSide = proposal.side === 'long' ? 'long' : 'short';
        const exitContract = buildLegacyExitContract({
          thesis: decision.reasoning ?? `${symbol} ${positionSide} thesis`,
          side: positionSide,
          tradeType: proposal.tradeType,
        });
        upsertPositionExitPolicy(
          symbol,
          positionSide,
          timeStopAtMs,
          proposal.invalidationPrice,
          serializeExitContract(exitContract),
          predictionId
        );
      } catch { }

      if (this.notify) {
        const sideEmoji = side === 'buy' ? '📈' : '📉';
        const mode = this.thufirConfig.execution?.mode === 'live' ? 'live' : 'paper';
        this.notify(
          `${sideEmoji} [LLM-ORIG] ${side === 'buy' ? 'LONG' : 'SHORT'} ${symbol}` +
          ` @ $${markPrice > 0 ? markPrice.toFixed(2) : '?'}` +
          ` | notional=$${probeUsd.toFixed(2)} lev=${targetLeverage}x` +
          ` | ttl=${proposal.suggestedTtlMinutes}min conf=${(proposal.confidence * 100).toFixed(0)}% mode=${mode}`
        ).catch(() => {});
      }
    } else {
      this.limiter.release(probeUsd);
    }

    return tradeResult.message;
  }

  private async runDiscoveryScan(input: {
    executeTrades: boolean;
    maxTrades?: number;
    ignoreThresholds?: boolean;
  }): Promise<string> {
    await PositionBook.getInstance().refresh();
    const telemetry = new AutonomousScanTelemetry();
    const recentJournal = listPerpTradeJournals({ limit: 50 });
    const reflectionMutation = applyReflectionMutation(this.thufirConfig, recentJournal);
    const policyState = getAutonomyPolicyState();
    const observationActive =
      policyState.observationOnlyUntilMs != null && policyState.observationOnlyUntilMs > Date.now();

    const result = await runDiscovery(this.thufirConfig);
    telemetry.markDiscoveryDone();
    const cycleSnapshot = createScanCycleSnapshot(result);
    if (result.expressions.length === 0) {
      telemetry.markFilterDone();
      telemetry.markFinished();
      this.logger.info('Autonomous performance metrics', telemetry.summarize({
        expressions: 0,
        eligible: 0,
        executed: 0,
      }));
      return 'No discovery expressions generated.';
    }

    if (!input.executeTrades || observationActive) {
      const top = result.expressions.slice(0, 5);
      if (observationActive) {
        for (const expr of top) {
          const symbol = expr.symbol.includes('/') ? expr.symbol.split('/')[0]! : expr.symbol;
          const cluster = cycleSnapshot.clusterBySymbol.get(expr.symbol);
          const regime = cluster ? classifyMarketRegime(cluster) : 'choppy';
          const signalClass = classifySignalClass(expr);
          const symbolClass = inferTradeSymbolClass(symbol);
          const volatilityBucket = cluster ? resolveVolatilityBucket(cluster) : 'medium';
          const liquidityBucket = cluster ? resolveLiquidityBucket(cluster) : 'normal';
          const contextTrace = formatContextPackTrace({
            marketRegime: expr.contextPack?.regime.marketRegime ?? regime,
            volatilityBucket: expr.contextPack?.regime.volatilityBucket ?? volatilityBucket,
            liquidityBucket: expr.contextPack?.regime.liquidityBucket ?? liquidityBucket,
            executionStatus: expr.contextPack?.executionQuality.status ?? 'unknown',
            eventKind: expr.contextPack?.event.kind ?? (expr.newsTrigger?.enabled ? 'news_event' : 'technical'),
            portfolioPosture: expr.contextPack?.portfolioState.posture ?? 'unknown',
            missing: expr.contextPack?.missing ?? ['contextPack.provider'],
          });
          try {
            const executionMode = this.thufirConfig.execution?.mode === 'live' ? 'live' : 'paper';
            recordPerpTradeJournal({
              kind: 'perp_trade_journal',
              execution_mode: executionMode,
              tradeId: null,
              hypothesisId: expr.hypothesisId ?? null,
              symbol,
              side: expr.side,
              size: null,
              leverage: expr.leverage ?? null,
              orderType: expr.orderType ?? null,
              reduceOnly: false,
              markPrice: null,
              confidence: expr.confidence != null ? String(expr.confidence) : null,
              reasoning: `Observation-only mode: would execute ${expr.side} ${symbol} (edge=${(expr.expectedEdge * 100).toFixed(2)}%) ${contextTrace}`,
              signalClass,
              symbolClass,
              marketRegime: regime,
              volatilityBucket,
              liquidityBucket,
              expectedEdge: expr.expectedEdge,
              thesisCorrect: null,
              entryTrigger: expr.newsTrigger?.enabled ? 'news' : 'technical',
              newsSubtype: expr.newsTrigger?.subtype ?? null,
              newsSources: Array.isArray(expr.newsTrigger?.sources)
                ? expr.newsTrigger?.sources
                    .map((source) => String(source.ref ?? source.source ?? '').trim())
                    .filter((source) => source.length > 0)
                : null,
              newsSourceCount: Array.isArray(expr.newsTrigger?.sources) ? expr.newsTrigger.sources.length : null,
              noveltyScore: expr.newsTrigger?.noveltyScore ?? null,
              marketConfirmationScore: expr.newsTrigger?.marketConfirmationScore ?? null,
              thesisExpiresAtMs: expr.newsTrigger?.expiresAtMs ?? null,
              outcome: 'blocked',
              message: 'Observation-only mode active; live execution suppressed.',
            });
          } catch {
            // Best-effort journaling.
          }
        }
      }
      const lines = top.map(
        (expr) => {
          const contextTrace = formatContextPackTrace({
            marketRegime: expr.contextPack?.regime.marketRegime ?? expr.marketRegime ?? 'choppy',
            volatilityBucket: expr.contextPack?.regime.volatilityBucket ?? expr.volatilityBucket ?? 'medium',
            liquidityBucket: expr.contextPack?.regime.liquidityBucket ?? expr.liquidityBucket ?? 'normal',
            executionStatus: expr.contextPack?.executionQuality.status ?? 'unknown',
            eventKind: expr.contextPack?.event.kind ?? (expr.newsTrigger?.enabled ? 'news_event' : 'technical'),
            portfolioPosture: expr.contextPack?.portfolioState.posture ?? 'unknown',
            missing: expr.contextPack?.missing ?? ['contextPack.provider'],
          });
          return `- ${expr.symbol} ${expr.side} probe=${expr.probeSizeUsd.toFixed(2)} leverage=${expr.leverage} (${expr.expectedMove}) ${contextTrace}`;
        }
      );
      const header = observationActive
        ? `Discovery scan completed in observation-only mode (${policyState.reason ?? 'adaptive policy active'}).`
        : 'Discovery scan completed:';
      telemetry.markFilterDone();
      telemetry.markFinished();
      this.logger.info('Autonomous performance metrics', telemetry.summarize({
        expressions: result.expressions.length,
        eligible: Math.min(5, result.expressions.length),
        executed: 0,
      }));
      return `${header}\n${lines.join('\n')}`;
    }

    const baseMinEdge = this.config.minEdge;
    const adaptiveMinEdge = policyState.minEdgeOverride ?? baseMinEdge;
    const adaptiveMaxTrades = policyState.maxTradesPerScanOverride ?? this.config.maxTradesPerScan;

    const eligible = result.expressions.filter((expr) => {
      const cluster = cycleSnapshot.clusterBySymbol.get(expr.symbol);
      const symbol = expr.symbol.includes('/') ? expr.symbol.split('/')[0]! : expr.symbol;
      const sessionContext = resolveSessionWeightContext(new Date());
      const regime = cluster ? classifyMarketRegime(cluster) : 'choppy';
      const signalClass = classifySignalClass(expr);
      const symbolClass = inferTradeSymbolClass(symbol);
      const globalGate = evaluateGlobalTradeGate(this.thufirConfig, {
        symbol,
        direction: expr.side,
        strategySource: expr.newsTrigger?.enabled ? 'discovery_news' : 'discovery_quant',
        triggerReason: expr.newsTrigger?.enabled ? 'news' : 'technical',
        signalClass,
        symbolClass,
        session: sessionContext.session,
        marketRegime: regime,
        expectedEdge: expr.expectedEdge,
        requestedLeverage: expr.leverage ?? null,
        confirmationSatisfied: true,
      });
      if (!globalGate.allowed) {
        return false;
      }
      if (!isSignalClassAllowedForRegime(signalClass, regime)) {
        return false;
      }
      const newsGate = evaluateNewsEntryGate(this.thufirConfig, expr);
      if (!newsGate.allowed) {
        return false;
      }
      if (input.ignoreThresholds) {
        return true;
      }
      if (expr.expectedEdge < adaptiveMinEdge) {
        return false;
      }
      const { sessionWeight } = sessionContext;
      const weightedConfidence = clamp01(expr.confidence * sessionWeight);
      if (this.config.requireHighConfidence && weightedConfidence < 0.7) {
        return false;
      }
      return true;
    });
    telemetry.markFilterDone();
    if (eligible.length === 0) {
      telemetry.markFinished();
      this.logger.info('Autonomous performance metrics', telemetry.summarize({
        expressions: result.expressions.length,
        eligible: 0,
        executed: 0,
      }));
      return 'No expressions met autonomy thresholds (minEdge/confidence).';
    }

    // Deterministic mechanical ranking for execution selection.
    // This keeps selection off the LLM path and stable across equivalent runs.
    const ranked = [...eligible].sort((a, b) => {
      const edgeDelta = (b.expectedEdge ?? 0) - (a.expectedEdge ?? 0);
      if (Math.abs(edgeDelta) > 1e-12) {
        return edgeDelta;
      }
      const confidenceDelta = (b.confidence ?? 0) - (a.confidence ?? 0);
      if (Math.abs(confidenceDelta) > 1e-12) {
        return confidenceDelta;
      }
      return String(a.symbol ?? '').localeCompare(String(b.symbol ?? ''));
    });

    const maxTrades = Number.isFinite(input.maxTrades)
      ? Math.min(Math.max(Number(input.maxTrades), 1), 10)
      : adaptiveMaxTrades;
    const toExecute = ranked.slice(0, maxTrades);
    const outputs: string[] = [];
    let executedCount = 0;

    for (const expr of toExecute) {
      const symbol = expr.symbol.includes('/') ? expr.symbol.split('/')[0]! : expr.symbol;
      const sessionContext = resolveSessionWeightContext(new Date());
      const confidenceRaw = clamp01(expr.confidence ?? 0);
      const confidenceWeighted = clamp01(confidenceRaw * sessionContext.sessionWeight);
      const sizingModifier = sessionContext.sessionWeight;
      const market = await this.marketClient.getMarket(symbol);
      const cluster = cycleSnapshot.clusterBySymbol.get(expr.symbol);
      const snapshotAgeMs = Math.max(0, Date.now() - cycleSnapshot.capturedAtMs);
      const regime = cluster ? classifyMarketRegime(cluster) : 'choppy';
      const signalClass = classifySignalClass(expr);
      const symbolClass = inferTradeSymbolClass(symbol);
      const volatilityBucket = cluster ? resolveVolatilityBucket(cluster) : 'medium';
      const liquidityBucket = cluster ? resolveLiquidityBucket(cluster) : 'normal';
      const globalGate = evaluateGlobalTradeGate(this.thufirConfig, {
        symbol,
        direction: expr.side,
        strategySource: expr.newsTrigger?.enabled ? 'discovery_news' : 'discovery_quant',
        triggerReason: expr.newsTrigger?.enabled ? 'news' : 'technical',
        signalClass,
        symbolClass,
        session: sessionContext.session,
        marketRegime: regime,
        expectedEdge: expr.expectedEdge,
        requestedLeverage: expr.leverage ?? null,
        confirmationSatisfied: true,
      });
      if (!globalGate.allowed) {
        outputs.push(`${symbol}: Blocked (${globalGate.reason ?? 'policy gate'})`);
        continue;
      }
      const newsGate = evaluateNewsEntryGate(this.thufirConfig, expr);
      if (!newsGate.allowed) {
        outputs.push(`${symbol}: Blocked (${newsGate.reason ?? 'news gate'})`);
        continue;
      }
      const markPrice = market.markPrice ?? 0;
      const minOrderUsd =
        typeof (this.thufirConfig as any)?.hyperliquid?.minOrderNotionalUsd === 'number'
          ? Number((this.thufirConfig as any).hyperliquid.minOrderNotionalUsd)
          : 10;
      const remainingDaily = (() => {
        const limiterRemaining = this.limiter.getRemainingDaily();
        const executionMode = this.thufirConfig.execution?.mode === 'live' ? 'live' : 'paper';
        try {
          if (executionMode === 'paper') {
            const paperInitialCash = this.thufirConfig.paper?.initialCashUsdc ?? 200;
            // Cap by free cash only — not equity (cash + unrealized). Unrealized PnL is not
            // spendable until closed; including it caused the equity guard to under-report
            // risk while positions were winning, allowing dangerous concentration to build.
            const freeCash = getPaperPerpBookSummary(paperInitialCash).cashBalanceUsdc;
            return Math.min(limiterRemaining, Math.max(0, freeCash));
          } else {
            // Live mode: cap by actual account balance so Thufir can't spend more than he has.
            const cashBalance = getCashBalance();
            if (cashBalance != null && Number.isFinite(cashBalance)) {
              return Math.min(limiterRemaining, Math.max(0, cashBalance));
            }
          }
        } catch { /* fallback to limiter value */ }
        return limiterRemaining;
      })();
      const desiredUsd = Number.isFinite(expr.probeSizeUsd) ? expr.probeSizeUsd : 0;
      const policySizeMultiplierRaw = Number(globalGate.sizeMultiplier ?? 1);
      const policySizeMultiplier =
        Number.isFinite(policySizeMultiplierRaw) && policySizeMultiplierRaw > 0
          ? Math.max(0.05, Math.min(1, policySizeMultiplierRaw))
          : 1;
      const policyReasoning =
        policySizeMultiplier < 1
          ? `policy=${globalGate.reasonCode ?? 'policy.size_adjust'} size_multiplier=${policySizeMultiplier.toFixed(2)} reason=${globalGate.reason ?? 'size adjustment applied'}`
          : null;
      const perf = summarizeComparableSignalPerformance(listPerpTradeJournals({ limit: 200 }), {
        signalClass,
        symbolClass,
        marketRegime: regime,
      });
      const kellyFraction = computeFractionalKellyFraction({
        expectedEdge: expr.expectedEdge,
        signalExpectancy: Math.max(0.01, perf.expectancy + 0.5),
        signalVariance: Math.max(0.1, perf.variance),
        sampleCount: perf.sampleCount,
        maxFraction: Number((this.thufirConfig.autonomy as any)?.newsEntry?.maxKellyFraction ?? 0.25),
      });
      const signalAdjustedUsd =
        desiredUsd * Math.max(0.25, kellyFraction * 4) * sizingModifier * policySizeMultiplier;
      const newsSizeCapFraction = Number((this.thufirConfig.autonomy as any)?.newsEntry?.sizeCapFraction ?? 0.5);
      const cappedForNews =
        expr.newsTrigger?.enabled === true
          ? Math.min(signalAdjustedUsd, remainingDaily * clamp01(newsSizeCapFraction))
          : signalAdjustedUsd;
      let probeUsd = Math.min(Math.max(minOrderUsd, cappedForNews), remainingDaily);
      this.logger.info('Session weighting applied to autonomous decision inputs', {
        symbol,
        session: sessionContext.session,
        sessionWeight: Number(sessionContext.sessionWeight.toFixed(4)),
        confidenceBefore: Number(confidenceRaw.toFixed(4)),
        confidenceAfter: Number(confidenceWeighted.toFixed(4)),
        sizingModifier: Number(sizingModifier.toFixed(4)),
        sizeUsdBefore: Number(desiredUsd.toFixed(4)),
        sizeUsdAfter: Number(signalAdjustedUsd.toFixed(4)),
      });
      if (probeUsd <= 0) {
        outputs.push(`${symbol}: Skipped (insufficient daily budget)`);
        continue;
      }
      if (probeUsd < minOrderUsd) {
        outputs.push(`${symbol}: Skipped (remaining daily budget $${remainingDaily.toFixed(2)} below min order $${minOrderUsd.toFixed(2)})`);
        continue;
      }
      let size = markPrice > 0 ? probeUsd / markPrice : probeUsd;
      let targetLeverage =
        globalGate.leverageCap != null ? Math.min(expr.leverage, globalGate.leverageCap) : expr.leverage;

      const riskCheck = await checkPerpRiskLimits({
        config: this.thufirConfig,
        symbol,
        side: expr.side,
        size,
        leverage: targetLeverage,
        reduceOnly: false,
        markPrice: markPrice || null,
        notionalUsd: Number.isFinite(probeUsd) ? probeUsd : undefined,
        marketMaxLeverage:
          typeof market.metadata?.maxLeverage === 'number'
            ? (market.metadata.maxLeverage as number)
            : null,
      });
      if (!riskCheck.allowed) {
        outputs.push(`${symbol}: Blocked (${riskCheck.reason ?? 'perp risk limits exceeded'})`);
        continue;
      }

      const limitCheck = await this.limiter.checkAndReserve(probeUsd);
      if (!limitCheck.allowed) {
        outputs.push(`${symbol}: Blocked (${limitCheck.reason})`);
        continue;
      }

      // LLM entry gate — reviews candidate before execution
      const leverageMax =
        typeof this.thufirConfig.hyperliquid?.maxLeverage === 'number' &&
        Number.isFinite(this.thufirConfig.hyperliquid.maxLeverage)
          ? Math.max(1, Number(this.thufirConfig.hyperliquid.maxLeverage))
          : 50;
      const gateCandidate = {
        symbol,
        side: expr.side,
        notionalUsd: probeUsd,
        leverage: targetLeverage,
        leverageMax,
        edge: expr.expectedEdge,
        confidence: confidenceWeighted,
        symbolClass,
        signalClass,
        regime,
        session: sessionContext.session,
        entryReasoning: expr.expectedMove ?? '',
        mechanicalMinEdge: adaptiveMinEdge,
        mechanicalMinConfidence: this.config.requireHighConfidence ? 0.7 : 0,
      };
      let entryGateVerdict: 'approve' | 'reject' | 'resize' | null = null;
      let entryGateReasonCode: string | null = null;
      if (this.thufirConfig.autonomy?.llmEntryGate?.enabled !== false) {
        const gateDecision = await this.entryGate.evaluate(gateCandidate, markPrice);
        entryGateVerdict = gateDecision.verdict;
        entryGateReasonCode = gateDecision.reasonCode ?? null;
        if (gateDecision.verdict === 'reject') {
          try {
            recordPerpTradeJournal({
              kind: 'perp_trade_journal',
              execution_mode: this.thufirConfig.execution?.mode === 'live' ? 'live' : 'paper',
              tradeId: null,
              hypothesisId: expr.hypothesisId ?? null,
              symbol,
              side: expr.side,
              size,
              leverage: targetLeverage ?? null,
              orderType: expr.orderType ?? null,
              reduceOnly: false,
              markPrice: markPrice || null,
              confidence: String(confidenceWeighted),
              reasoning: `LLM entry gate rejected: ${gateDecision.reasoning}${policyReasoning ? ` | ${policyReasoning}` : ''}`,
              signalClass,
              symbolClass,
              marketRegime: regime,
              volatilityBucket,
              liquidityBucket,
              expectedEdge: expr.expectedEdge,
              policyReasonCode: globalGate.reasonCode ?? null,
              policyReason: globalGate.reason ?? null,
              policySizeMultiplier: policySizeMultiplier < 1 ? policySizeMultiplier : null,
              entryGateVerdict,
              entryGateReasonCode,
              outcome: 'blocked',
              error: gateDecision.reasoning,
            });
          } catch { /* best-effort */ }
          outputs.push(`${symbol}: Rejected by LLM entry gate — ${gateDecision.reasoning}`);
          this.limiter.release(probeUsd);
          continue;
        }
        if (gateDecision.verdict === 'resize' && gateDecision.adjustedSizeUsd) {
          probeUsd = gateDecision.adjustedSizeUsd;
          size = markPrice > 0 ? probeUsd / markPrice : probeUsd;
        }
        if (gateDecision.suggestedLeverage != null) {
          targetLeverage = gateDecision.suggestedLeverage;
        }
      }
      // gate approved or was disabled; fall through to executor.execute()

      const decision: TradeDecision = {
        action: expr.side,
        side: expr.side,
        symbol,
        size,
        orderType: expr.orderType,
        leverage: targetLeverage,
        reasoning: `${expr.expectedMove} | edge=${(expr.expectedEdge * 100).toFixed(2)}% confidence=${(
          confidenceWeighted * 100
        ).toFixed(1)}% regime=${regime} signal=${signalClass} kelly=${(kellyFraction * 100).toFixed(
          1
        )}% snapshotId=${cycleSnapshot.id} snapshotTs=${cycleSnapshot.capturedAtIso} snapshotAgeMs=${snapshotAgeMs} session=${sessionContext.session} sessionWeight=${sessionContext.sessionWeight.toFixed(
          2
        )} confidenceRaw=${confidenceRaw.toFixed(3)} confidenceWeighted=${confidenceWeighted.toFixed(
          3
        )} sizingModifier=${sizingModifier.toFixed(2)}${policyReasoning ? ` ${policyReasoning}` : ''} ${formatContextPackTrace({
          marketRegime: expr.contextPack?.regime.marketRegime ?? regime,
          volatilityBucket: expr.contextPack?.regime.volatilityBucket ?? volatilityBucket,
          liquidityBucket: expr.contextPack?.regime.liquidityBucket ?? liquidityBucket,
          executionStatus: expr.contextPack?.executionQuality.status ?? 'unknown',
          eventKind: expr.contextPack?.event.kind ?? (expr.newsTrigger?.enabled ? 'news_event' : 'technical'),
          portfolioPosture: expr.contextPack?.portfolioState.posture ?? 'unknown',
          missing: expr.contextPack?.missing ?? ['contextPack.provider'],
        })}`,
      };

      const tradeResult = await this.executor.execute(market, decision);
      if (tradeResult.executed) {
        executedCount += 1;
        this.limiter.confirm(probeUsd);
        // Write per-position exit policy so the heartbeat knows when to close.
        const defaultThesisTtlMs =
          ((this.thufirConfig.autonomy as any)?.newsEntry?.thesisTtlMinutes ?? 120) * 60_000;
        const timeStopAtMs = expr.newsTrigger?.expiresAtMs ?? Date.now() + defaultThesisTtlMs;
        let predictionId: string | null = null;
        try {
          const predictedOutcome = expr.side === 'buy' ? 'YES' : 'NO';
          const signalWeightsSnapshot = resolvePredictionSignalWeights(this.thufirConfig);
          const signalScores = buildDiscoverySignalScores({
            side: expr.side,
            signalClass,
            confidenceRaw,
            confidenceWeighted,
            noveltyScore: expr.newsTrigger?.noveltyScore ?? null,
            marketConfirmationScore: expr.newsTrigger?.marketConfirmationScore ?? null,
            executionStatus: expr.contextPack?.executionQuality.status ?? null,
            portfolioPosture: expr.contextPack?.portfolioState.posture ?? null,
          });
          predictionId = createPrediction({
            marketId: `perp:${symbol}`,
            marketTitle: `${symbol} ${expr.side === 'buy' ? 'long' : 'short'}: quant scan`,
            predictedOutcome,
            predictedProbability: confidenceWeighted,
            modelProbability: confidenceWeighted,
            signalScores,
            signalWeightsSnapshot,
            sessionTag: sessionContext.session,
            regimeTag: regime,
            strategyClass: signalClass,
            symbol,
            domain: 'perp',
            learningComparable: false,
            horizonMinutes: Math.round((timeStopAtMs - Date.now()) / 60_000),
            executed: true,
            executionPrice: markPrice || undefined,
            positionSize: size,
          });
          createLearningCase({
            caseType: 'comparable_forecast',
            domain: 'perp',
            entityType: 'symbol',
            entityId: symbol,
            comparable: false,
            comparatorKind: null,
            exclusionReason: 'missing_comparator',
            sourcePredictionId: predictionId,
            belief: {
              modelProbability: confidenceWeighted,
              predictedOutcome,
            },
            baseline: {
              marketProbability: null,
            },
            context: {
              horizonMinutes: Math.round((timeStopAtMs - Date.now()) / 60_000),
              mode: this.thufirConfig.execution?.mode === 'live' ? 'live' : 'paper',
            },
            action: {
              side: expr.side,
              executed: true,
              executionPrice: markPrice || null,
              positionSize: size,
            },
          });
        } catch { }
        try {
          const side = expr.side === 'buy' ? 'long' : 'short';
          const exitContract = buildLegacyExitContract({
            thesis: decision.reasoning ?? `${symbol} ${side} thesis`,
            side,
            tradeType: expr.newsTrigger?.enabled ? 'structural' : 'tactical',
          });
          upsertPositionExitPolicy(
            symbol,
            side,
            timeStopAtMs,
            null,
            serializeExitContract(exitContract),
            predictionId
          );
        } catch { }
        // Notify on position open.
        if (this.notify) {
          const sideEmoji = expr.side === 'buy' ? '📈' : '📉';
          const ttlMinutes = Math.round((timeStopAtMs - Date.now()) / 60_000);
          const mode = this.thufirConfig.execution?.mode === 'live' ? 'live' : 'paper';
          const notifyMsg =
            `${sideEmoji} Opened ${expr.side === 'buy' ? 'LONG' : 'SHORT'} ${symbol}` +
            ` @ $${markPrice > 0 ? markPrice.toFixed(2) : '?'}` +
            ` | size=${size.toPrecision(4)} notional=$${probeUsd.toFixed(2)}` +
            ` | lev=${targetLeverage}x edge=${(expr.expectedEdge * 100).toFixed(1)}%` +
            ` | ttl=${ttlMinutes}min mode=${mode}`;
          this.notify(notifyMsg).catch(() => {});
        }
      } else {
        this.limiter.release(probeUsd);
      }
      this.scheduleAsyncExecutionEnrichment({
        symbol,
        side: expr.side,
        executed: tradeResult.executed,
        message: tradeResult.message,
        reasoning: decision.reasoning ?? null,
      });
      try {
        const executionMode = this.thufirConfig.execution?.mode === 'live' ? 'live' : 'paper';
        const tradeId = recordPerpTrade({
          hypothesisId: expr.hypothesisId,
          symbol,
          side: expr.side,
          size,
          executionMode,
          price: markPrice || null,
          leverage: expr.leverage,
          orderType: expr.orderType,
          status: tradeResult.executed ? 'executed' : 'failed',
        });
        const db = openDatabase();
        db.prepare(`
          INSERT INTO autonomous_trades (
            id,
            market_id,
            market_title,
            direction,
            amount,
            entry_price,
            confidence,
            reasoning,
            timestamp,
            outcome,
            pnl
          ) VALUES (
            @id,
            @marketId,
            @marketTitle,
            @direction,
            @amount,
            @entryPrice,
            @confidence,
            @reasoning,
            @timestamp,
            @outcome,
            @pnl
          )
        `).run({
          id: String(tradeId),
          marketId: symbol,
          marketTitle: `${symbol} perp`,
          direction: expr.side,
          amount: probeUsd,
          entryPrice: markPrice || 0,
          confidence: expr.confidence != null ? String(expr.confidence) : null,
          reasoning: decision.reasoning ?? null,
          timestamp: new Date().toISOString(),
          outcome: tradeResult.executed ? 'pending' : 'failed',
          pnl: null,
        });
        recordPerpTradeJournal({
          kind: 'perp_trade_journal',
          execution_mode: executionMode,
          tradeId,
          hypothesisId: expr.hypothesisId ?? null,
          symbol,
          side: expr.side,
          size,
          leverage: targetLeverage ?? null,
          orderType: expr.orderType ?? null,
          reduceOnly: false,
          markPrice: markPrice || null,
          confidence: String(confidenceWeighted),
          reasoning: decision.reasoning ?? null,
          policyReasonCode: globalGate.reasonCode ?? null,
          policyReason: globalGate.reason ?? null,
          policySizeMultiplier: policySizeMultiplier < 1 ? policySizeMultiplier : null,
          entryGateVerdict,
          entryGateReasonCode,
          signalClass,
          symbolClass,
          marketRegime: regime,
          volatilityBucket,
          liquidityBucket,
          expectedEdge: expr.expectedEdge,
          thesisCorrect: tradeResult.executed ? null : false,
          entryTrigger: expr.newsTrigger?.enabled ? 'news' : 'technical',
          newsSubtype: expr.newsTrigger?.subtype ?? null,
          newsSources: Array.isArray(expr.newsTrigger?.sources)
            ? expr.newsTrigger?.sources
                .map((source) => String(source.ref ?? source.source ?? '').trim())
                .filter((source) => source.length > 0)
            : null,
          newsSourceCount: Array.isArray(expr.newsTrigger?.sources) ? expr.newsTrigger.sources.length : null,
          noveltyScore: expr.newsTrigger?.noveltyScore ?? null,
          marketConfirmationScore: expr.newsTrigger?.marketConfirmationScore ?? null,
          thesisExpiresAtMs: expr.newsTrigger?.expiresAtMs ?? null,
          outcome: tradeResult.executed ? 'executed' : 'failed',
          message: tradeResult.message,
        });
      } catch {
        // Best-effort journaling: never block trading due to local DB issues.
      }
      outputs.push(tradeResult.message);
    }

    if (reflectionMutation.mutated) {
      outputs.push(`Adaptive policy updated: ${reflectionMutation.reason ?? 'performance mutation applied'}`);
    }

    telemetry.markFinished();
    this.logger.info('Autonomous performance metrics', telemetry.summarize({
      expressions: result.expressions.length,
      eligible: eligible.length,
      executed: executedCount,
    }));

    return outputs.join('\n');
  }

  /**
   * Update trade outcome and track losses
   */
  updateTradeOutcome(tradeId: string, outcome: 'win' | 'loss', pnl: number): void {
    const db = openDatabase();
    db.prepare(`
      UPDATE autonomous_trades SET outcome = @outcome, pnl = @pnl WHERE id = @tradeId
    `).run({ tradeId, outcome, pnl });

    if (outcome === 'loss') {
      this.consecutiveLosses++;
    } else {
      this.consecutiveLosses = 0;
    }

    if (
      this.config.pauseOnLossStreak > 0 &&
      this.consecutiveLosses >= this.config.pauseOnLossStreak &&
      !this.isPaused
    ) {
      this.pause(
        `Loss streak threshold reached (${this.consecutiveLosses}/${this.config.pauseOnLossStreak})`
      );
    }
  }

  /**
   * Get today's P&L summary
   */
  getDailyPnL(): DailyPnL {
    const today = new Date().toISOString().split('T')[0] ?? new Date().toISOString().slice(0, 10);
    const db = openDatabase();

    const trades = db.prepare(`
      SELECT outcome, pnl FROM autonomous_trades
      WHERE date(timestamp) = @today
    `).all({ today }) as Array<{ outcome: string; pnl: number | null }>;

    const wins = trades.filter(t => t.outcome === 'win').length;
    const losses = trades.filter(t => t.outcome === 'loss').length;
    const pending = trades.filter(t => t.outcome === 'pending').length;
    const realizedPnl = trades
      .filter(t => t.pnl !== null)
      .reduce((sum, t) => sum + (t.pnl ?? 0), 0);

    const unrealizedPnl = this.calculateUnrealizedPnl();

    return {
      date: today,
      tradesExecuted: trades.length,
      wins,
      losses,
      pending,
      realizedPnl,
      unrealizedPnl,
    };
  }

  getOperatorSnapshot(): OperatorStatusSnapshot {
    const dailyPnl = this.getDailyPnL();
    const runtime = this.getStatus();
    const policyState = getAutonomyPolicyState();
    const observationOnly =
      policyState.observationOnlyUntilMs != null && policyState.observationOnlyUntilMs > Date.now();
    const openPositions = listOpenPositionsFromTrades(20).map((position) => ({
      marketId: position.marketId,
      outcome: position.predictedOutcome ?? 'YES',
      exposureUsd: Number(position.positionSize ?? 0),
      unrealizedPnlUsd: this.computePositionUnrealizedPnl(position),
    }));
    const totalPnl = dailyPnl.realizedPnl + dailyPnl.unrealizedPnl;

    return {
      asOf: new Date().toISOString(),
      equityUsd: null,
      openPositions,
      policyState: {
        observationOnly,
        reason: policyState.reason,
        minEdgeOverride: policyState.minEdgeOverride,
        maxTradesPerScanOverride: policyState.maxTradesPerScanOverride,
        leverageCapOverride: policyState.leverageCapOverride,
        tradeContractEnforced: Boolean((this.thufirConfig.autonomy as any)?.tradeContract?.enabled),
        decisionQualityGateEnabled: Boolean((this.thufirConfig.autonomy as any)?.tradeQuality?.enabled),
      },
      lastTrade: this.getLastTradeSnapshot(),
      nextScanAt: this.getNextScanAt(),
      uptimeMs: Math.max(0, Date.now() - this.startedAtMs),
      runtime,
      dailyPnl: {
        ...dailyPnl,
        totalPnl,
      },
    };
  }

  /**
   * Generate daily P&L report
   */
  async generateDailyPnLReport(): Promise<string> {
    const pnl = this.getDailyPnL();
    const rollup = getDailyPnLRollup(pnl.date);
    const discovery = await runDiscovery(this.thufirConfig);
    const expressions = discovery.expressions.slice(0, 5);

    const lines: string[] = [];
    lines.push(`📈 **Daily Autonomous Trading Report** (${pnl.date})`);
    lines.push('');
    lines.push('**Today\'s Activity:**');
    lines.push(`• Trades executed: ${pnl.tradesExecuted}`);
    lines.push(`• Wins: ${pnl.wins} | Losses: ${pnl.losses} | Pending: ${pnl.pending}`);
    lines.push(`• Realized P&L: ${pnl.realizedPnl >= 0 ? '+' : ''}$${pnl.realizedPnl.toFixed(2)}`);
    lines.push('');
    lines.push('**Status:**');
    const status = this.getStatus();
    lines.push(`• Full auto: ${status.fullAuto ? 'ON' : 'OFF'}`);
    lines.push(`• Paused: ${status.isPaused ? `YES (${status.pauseReason})` : 'NO'}`);
    lines.push(`• Remaining daily budget: $${status.remainingDaily.toFixed(2)}`);
    lines.push('');
    lines.push('**PnL Rollup:**');
    lines.push(`• Realized: ${rollup.realizedPnl >= 0 ? '+' : ''}$${rollup.realizedPnl.toFixed(2)}`);
    lines.push(`• Unrealized: ${rollup.unrealizedPnl >= 0 ? '+' : ''}$${rollup.unrealizedPnl.toFixed(2)}`);
    lines.push(`• Total: ${rollup.totalPnl >= 0 ? '+' : ''}$${rollup.totalPnl.toFixed(2)}`);
    if (rollup.byDomain.length > 0) {
      lines.push('• By domain:');
      for (const row of rollup.byDomain) {
        lines.push(
          `  - ${row.domain}: ${row.totalPnl >= 0 ? '+' : ''}$${row.totalPnl.toFixed(2)}`
        );
      }
    }
    lines.push('');
    lines.push('**Discovery Snapshot:**');
    if (expressions.length === 0) {
      lines.push('• No discovery expressions generated.');
    } else {
      for (const expr of expressions) {
        lines.push(
          `• ${expr.symbol} ${expr.side.toUpperCase()} probe=$${expr.probeSizeUsd.toFixed(2)} leverage=${expr.leverage}`
        );
      }
    }

    return lines.join('\n');
  }

  async runDailyReportTick(): Promise<void> {
    try {
      const report = await this.generateDailyPnLReport();
      this.emit('daily-report', report);
    } catch (error) {
      this.logger.error('Failed to generate daily report', error);
      throw error;
    }
  }

  private isAsyncEnrichmentEnabled(): boolean {
    return Boolean((this.thufirConfig.autonomy as any)?.asyncEnrichment?.enabled ?? false);
  }

  private getAsyncEnrichmentTimeoutMs(): number {
    const raw = Number((this.thufirConfig.autonomy as any)?.asyncEnrichment?.timeoutMs ?? 4000);
    return Number.isFinite(raw) ? Math.max(250, Math.min(raw, 20_000)) : 4000;
  }

  private getAsyncEnrichmentMaxChars(): number {
    const raw = Number((this.thufirConfig.autonomy as any)?.asyncEnrichment?.maxChars ?? 280);
    return Number.isFinite(raw) ? Math.max(80, Math.min(raw, 2000)) : 280;
  }

  private scheduleAsyncExecutionEnrichment(input: {
    symbol: string;
    side: 'buy' | 'sell';
    executed: boolean;
    message: string;
    reasoning: string | null;
  }): void {
    if (!this.isAsyncEnrichmentEnabled()) {
      return;
    }
    const timeoutMs = this.getAsyncEnrichmentTimeoutMs();
    const maxChars = this.getAsyncEnrichmentMaxChars();
    const startedAt = Date.now();

    void (async () => {
      try {
        const response = await Promise.race([
          withExecutionContext(
            {
              mode: 'LIGHT_REASONING',
              critical: false,
              reason: 'autonomous_async_execution_enrichment',
              source: 'autonomous',
            },
            () =>
              this.llm.complete(
                [
                  {
                    role: 'system',
                    content:
                      'You are a concise trading execution annotator. Return one short line with thesis, invalidation posture, and next check.',
                  },
                  {
                    role: 'user',
                    content: [
                      `symbol=${input.symbol}`,
                      `side=${input.side}`,
                      `executed=${input.executed}`,
                      `message=${input.message}`,
                      `reasoning=${input.reasoning ?? 'n/a'}`,
                    ].join('\n'),
                  },
                ],
                { maxTokens: 120 }
              )
          ),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`async enrichment timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
        const textRaw =
          typeof (response as any)?.content === 'string'
            ? (response as any).content
            : JSON.stringify((response as any)?.content ?? '');
        const text = textRaw.trim().slice(0, maxChars);
        this.logger.info('Async execution enrichment completed', {
          symbol: input.symbol,
          side: input.side,
          executed: input.executed,
          latencyMs: Date.now() - startedAt,
          enrichment: text,
        });
      } catch (error) {
        this.logger.warn(
          `Async execution enrichment failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();
  }

  private calculateUnrealizedPnl(): number {
    const positions = listOpenPositionsFromTrades(200);
    let total = 0;

    for (const position of positions) {
      const pnl = this.computePositionUnrealizedPnl(position);
      if (pnl == null) continue;
      total += pnl;
    }

    return total;
  }

  private computePositionUnrealizedPnl(position: OpenTradePosition): number | null {
    const outcome = position.predictedOutcome ?? 'YES';
    const prices = position.currentPrices ?? null;
    let currentPrice: number | null = null;
    if (Array.isArray(prices)) {
      currentPrice = outcome === 'YES' ? prices[0] ?? null : prices[1] ?? null;
    } else if (prices) {
      currentPrice =
        prices[outcome] ??
        prices[outcome.toUpperCase()] ??
        prices[outcome.toLowerCase()] ??
        prices[outcome === 'YES' ? 'Yes' : 'No'] ??
        prices[outcome === 'YES' ? 'yes' : 'no'] ??
        null;
    }

    const averagePrice = position.executionPrice ?? currentPrice ?? 0;
    const positionSize = position.positionSize ?? 0;
    if (averagePrice <= 0 || positionSize <= 0) {
      return null;
    }
    const shares = positionSize / averagePrice;
    const price = currentPrice ?? averagePrice;
    const value = shares * price;
    return value - positionSize;
  }

  private getLastTradeSnapshot(): OperatorTradeSnapshot | null {
    try {
      const db = openDatabase();
      const row = db
        .prepare(
          `
          SELECT
            market_id as marketId,
            outcome,
            pnl as pnlUsd,
            timestamp
          FROM autonomous_trades
          ORDER BY datetime(timestamp) DESC
          LIMIT 1
        `
        )
        .get() as
        | { marketId?: string; outcome?: string; pnlUsd?: number | null; timestamp?: string }
        | undefined;
      if (!row?.marketId || !row?.timestamp) {
        return null;
      }
      return {
        marketId: String(row.marketId),
        outcome: String(row.outcome ?? 'unknown'),
        pnlUsd: typeof row.pnlUsd === 'number' ? row.pnlUsd : null,
        timestamp: String(row.timestamp),
      };
    } catch {
      return null;
    }
  }

  private getNextScanAt(): string | null {
    try {
      const db = openDatabase();
      const row = db
        .prepare(
          `
          SELECT next_run_at as nextRunAt
          FROM scheduler_jobs
          WHERE name = @name
          LIMIT 1
        `
        )
        .get({ name: `${this.schedulerNamespace}:scan` }) as { nextRunAt?: string } | undefined;
      if (!row?.nextRunAt) {
        return null;
      }
      return String(row.nextRunAt);
    } catch {
      return null;
    }
  }

  /**
   * Ensure the trades table exists
   */
  private ensureTradesTable(): void {
    const db = openDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS autonomous_trades (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        market_title TEXT NOT NULL,
        direction TEXT NOT NULL,
        amount REAL NOT NULL,
        entry_price REAL NOT NULL,
        confidence TEXT,
        reasoning TEXT,
        timestamp TEXT NOT NULL,
        outcome TEXT DEFAULT 'pending',
        pnl REAL
      );

      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON autonomous_trades(timestamp);
      CREATE INDEX IF NOT EXISTS idx_trades_outcome ON autonomous_trades(outcome);
    `);
  }

  private buildSchedulerNamespace(): string {
    const seed =
      this.thufirConfig.memory?.sessionsPath ??
      this.thufirConfig.memory?.dbPath ??
      this.thufirConfig.agent?.workspace ??
      'default';
    const hash = Buffer.from(seed).toString('base64url').slice(0, 16);
    return `autonomy:${hash}`;
  }
}
