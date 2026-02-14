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
import type { ExpressionPlan } from '../discovery/types.js';
import { recordPerpTrade } from '../memory/perp_trades.js';
import { recordPerpTradeJournal } from '../memory/perp_trade_journal.js';
import { checkPerpRiskLimits } from '../execution/perp-risk.js';
import { getDailyPnLRollup } from './daily_pnl.js';
import { openDatabase } from '../memory/db.js';
import { listOpenPositionsFromTrades } from '../memory/trades.js';
import { Logger } from './logger.js';
import { buildTradeEnvelopeFromExpression } from '../trade-management/envelope.js';
import {
  countTradeEntriesToday,
  getLastCloseForSymbol,
  listOpenTradeEnvelopes,
  listRecentClosePnl,
  recordTradeEnvelope,
  recordTradeSignals,
} from '../trade-management/db.js';
import { placeExchangeSideTpsl } from '../trade-management/hyperliquid-stops.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import { buildTradeJournalSummary } from '../trade-management/summary.js';
import { reconcileEntryFill } from '../trade-management/reconcile.js';
import { createHyperliquidCloid } from '../execution/hyperliquid/cloid.js';

export interface AutonomousConfig {
  enabled: boolean;
  fullAuto: boolean;
  minEdge: number;
  requireHighConfidence: boolean;
  pauseOnLossStreak: number;
  dailyReportTime: string;
  maxTradesPerScan: number;
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

export interface AutonomousEvents {
  'daily-report': (report: string) => void;
  'paused': (reason: string) => void;
  'resumed': () => void;
  'error': (error: Error) => void;
}

export class AutonomousManager extends EventEmitter<AutonomousEvents> {
  private config: AutonomousConfig;
  private marketClient: MarketClient;
  private executor: ExecutionAdapter;
  private limiter: DbSpendingLimitEnforcer;
  private logger: Logger;
  private thufirConfig: ThufirConfig;
  private llm: LlmClient;

  private isPaused = false;
  private pauseReason = '';
  private consecutiveLosses = 0;
  private scanTimer: NodeJS.Timeout | null = null;
  private reportTimer: NodeJS.Timeout | null = null;
  private pauseTimer: NodeJS.Timeout | null = null;

  constructor(
    llm: LlmClient,
    marketClient: MarketClient,
    executor: ExecutionAdapter,
    limiter: DbSpendingLimitEnforcer,
    thufirConfig: ThufirConfig,
    logger?: Logger
  ) {
    super();
    this.llm = llm;
    this.marketClient = marketClient;
    this.executor = executor;
    this.limiter = limiter;
    this.thufirConfig = thufirConfig;
    this.logger = logger ?? new Logger('info');

    // Load autonomous config with defaults
    this.config = {
      enabled: thufirConfig.autonomy?.enabled ?? false,
      fullAuto: (thufirConfig.autonomy as any)?.fullAuto ?? false,
      minEdge: (thufirConfig.autonomy as any)?.minEdge ?? 0.05,
      requireHighConfidence: (thufirConfig.autonomy as any)?.requireHighConfidence ?? false,
      pauseOnLossStreak: (thufirConfig.autonomy as any)?.pauseOnLossStreak ?? 3,
      dailyReportTime: (thufirConfig.autonomy as any)?.dailyReportTime ?? '20:00',
      maxTradesPerScan: (thufirConfig.autonomy as any)?.maxTradesPerScan ?? 3,
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

    const scanInterval = this.thufirConfig.autonomy?.scanIntervalSeconds ?? 900;

    // Start periodic scanning
    this.scanTimer = setInterval(async () => {
      try {
        await this.runScan();
      } catch (error) {
        this.logger.error('Autonomous scan failed', error);
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      }
    }, scanInterval * 1000);

    // Schedule daily report
    this.scheduleDailyReport();

    this.logger.info(`Autonomous mode started. Full auto: ${this.config.fullAuto}. Scan interval: ${scanInterval}s`);
  }

  /**
   * Stop autonomous mode
   */
  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.reportTimer) {
      clearTimeout(this.reportTimer);
      this.reportTimer = null;
    }
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
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
  async runScan(): Promise<string> {
    if (this.isPaused) {
      return `Autonomous trading is paused: ${this.pauseReason}`;
    }

    const remaining = this.limiter.getRemainingDaily();
    if (remaining <= 0) {
      return 'Daily spending limit reached. No trades executed.';
    }

    return this.runDiscoveryScan();
  }

  private async runDiscoveryScan(): Promise<string> {
    const tm = this.thufirConfig.tradeManagement;
    if (tm?.enabled) {
      const lossCfg = tm.antiOvertrading?.lossStreakPause;
      const streakN = Number(lossCfg?.consecutiveLosses ?? 0);
      const pauseSeconds = Number(lossCfg?.pauseSeconds ?? 0);
      if (!this.isPaused && streakN > 0 && pauseSeconds > 0) {
        const recent = listRecentClosePnl(Math.max(10, streakN + 2));
        let streak = 0;
        for (const row of recent) {
          if (row.pnlUsd > 0) break;
          streak += 1;
          if (streak >= streakN) break;
        }
        if (streak >= streakN) {
          this.pause(`Loss streak pause triggered (${streak}/${streakN})`);
          this.pauseTimer = setTimeout(() => this.resume(), pauseSeconds * 1000);
          return `Autonomous trading paused for ${pauseSeconds}s due to loss streak (${streak}/${streakN}).`;
        }
      }
    }

    const result = await runDiscovery(this.thufirConfig);
    if (result.expressions.length === 0) {
      return 'No discovery expressions generated.';
    }

    if (!this.config.fullAuto) {
      const top = result.expressions.slice(0, 5);
      const lines = top.map(
        (expr) =>
          `- ${expr.symbol} ${expr.side} probe=${expr.probeSizeUsd.toFixed(2)} leverage=${expr.leverage} (${expr.expectedMove})`
      );
      return `Discovery scan completed:\n${lines.join('\n')}`;
    }

    const eligible = result.expressions.filter((expr) => {
      if (expr.expectedEdge < this.config.minEdge) {
        return false;
      }
      if (this.config.requireHighConfidence && expr.confidence < 0.7) {
        return false;
      }
      return true;
    });
    if (eligible.length === 0) {
      return 'No expressions met autonomy thresholds (minEdge/confidence).';
    }

    const toExecute = await this.selectExpressionsToExecute(eligible, this.config.maxTradesPerScan);
    const outputs: string[] = [];
    let cachedEquityUsd: number | null = null;
    let equityFetched = false;

    for (const expr of toExecute) {
      const tmCfg = this.thufirConfig.tradeManagement;
      if (tmCfg?.enabled) {
        const openCount = listOpenTradeEnvelopes().length;
        const maxConcurrent = Number(tmCfg.antiOvertrading?.maxConcurrentPositions ?? 2);
        if (openCount >= maxConcurrent) {
          outputs.push(`${expr.symbol}: Skipped (max concurrent positions reached: ${openCount}/${maxConcurrent})`);
          continue;
        }

        const dailyCap = Number(tmCfg.antiOvertrading?.maxDailyEntries ?? 0);
        if (dailyCap > 0) {
          const today = countTradeEntriesToday();
          if (today >= dailyCap) {
            outputs.push(`${expr.symbol}: Skipped (daily entry cap reached: ${today}/${dailyCap})`);
            continue;
          }
        }

        const cooldown = Number(tmCfg.antiOvertrading?.cooldownAfterCloseSeconds ?? 0);
        if (cooldown > 0) {
          const symbolNorm = expr.symbol.includes('/') ? expr.symbol.split('/')[0]! : expr.symbol;
          const lastClose = getLastCloseForSymbol(symbolNorm.toUpperCase());
          if (lastClose) {
            const ageSec = (Date.now() - Date.parse(lastClose.closedAt)) / 1000;
            if (Number.isFinite(ageSec) && ageSec >= 0 && ageSec < cooldown) {
              outputs.push(`${expr.symbol}: Skipped (cooldown active: ${Math.round(ageSec)}s/${cooldown}s)`);
              continue;
            }
          }
        }
      }

      const symbol = expr.symbol.includes('/') ? expr.symbol.split('/')[0]! : expr.symbol;
      const market = await this.marketClient.getMarket(symbol);
      const markPrice = market.markPrice ?? 0;
      let probeUsd = Math.min(expr.probeSizeUsd, this.limiter.getRemainingDaily());
      if (probeUsd <= 0) {
        outputs.push(`${symbol}: Skipped (insufficient daily budget)`);
        continue;
      }

      // Risk-based sizing (live mode): cap account equity risk per trade.
      const tmRiskCfg = this.thufirConfig.tradeManagement;
      const maxRiskPct = Number(tmRiskCfg?.maxAccountRiskPct ?? 0);
      const stopLossPct = Number(expr.stopLossPct ?? tmRiskCfg?.defaults?.stopLossPct ?? 3.0);
      if (
        maxRiskPct > 0 &&
        stopLossPct > 0 &&
        this.thufirConfig.execution?.mode === 'live' &&
        this.thufirConfig.execution?.provider === 'hyperliquid'
      ) {
        try {
          if (!equityFetched) {
            equityFetched = true;
            const client = new HyperliquidClient(this.thufirConfig);
            const state = (await client.getClearinghouseState()) as any;
            const raw = state?.marginSummary?.accountValue ?? state?.crossMarginSummary?.accountValue ?? null;
            const num = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
            cachedEquityUsd = Number.isFinite(num) && num > 0 ? num : null;
          }
          if (cachedEquityUsd != null) {
            const maxLossUsd = (maxRiskPct / 100) * cachedEquityUsd;
            const capNotional = maxLossUsd / (stopLossPct / 100);
            if (Number.isFinite(capNotional) && capNotional > 0) {
              probeUsd = Math.min(probeUsd, capNotional);
            }
          }
        } catch {
          // Best-effort; if equity fetch fails, proceed with the probe size.
        }
      }
      const size = markPrice > 0 ? probeUsd / markPrice : probeUsd;
      const riskCheck = await checkPerpRiskLimits({
        config: this.thufirConfig,
        symbol,
        side: expr.side,
        size,
        leverage: expr.leverage,
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

      const decision: TradeDecision = {
        action: expr.side,
        side: expr.side,
        symbol,
        size,
        orderType: expr.orderType,
        leverage: expr.leverage,
        clientOrderId: createHyperliquidCloid(),
        reasoning: `${expr.expectedMove} | edge=${(expr.expectedEdge * 100).toFixed(2)}% confidence=${(
          expr.confidence * 100
        ).toFixed(1)}%`,
      };
      const decisionStartMs = Date.now();

      const tradeResult = await this.executor.execute(market, decision);
      if (tradeResult.executed) {
        this.limiter.confirm(probeUsd);
      } else {
        this.limiter.release(probeUsd);
      }
      try {
        const tradeId = recordPerpTrade({
          hypothesisId: expr.hypothesisId,
          symbol,
          side: expr.side,
          size,
          price: markPrice || null,
          leverage: expr.leverage,
          orderType: expr.orderType,
          status: tradeResult.executed ? 'executed' : 'failed',
        });
        recordPerpTradeJournal({
          kind: 'perp_trade_journal',
          tradeId,
          hypothesisId: expr.hypothesisId ?? null,
          symbol,
          side: expr.side,
          size,
          leverage: expr.leverage ?? null,
          orderType: expr.orderType ?? null,
          reduceOnly: false,
          markPrice: markPrice || null,
          confidence: expr.confidence != null ? String(expr.confidence) : null,
          reasoning: decision.reasoning ?? null,
          outcome: tradeResult.executed ? 'executed' : 'failed',
          message: tradeResult.message,
        });

        if (tradeResult.executed && typeof markPrice === 'number' && markPrice > 0) {
          let entryPrice = markPrice;
          let entryFeesUsd: number | null = null;
          if (decision.clientOrderId && this.thufirConfig.execution?.mode === 'live') {
            const rec = await reconcileEntryFill({
              config: this.thufirConfig,
              symbol,
              entryCloid: decision.clientOrderId,
              startTimeMs: decisionStartMs,
            });
            if (rec.avgPx != null) entryPrice = rec.avgPx;
            entryFeesUsd = rec.feesUsd;
          }
          const envelope = buildTradeEnvelopeFromExpression({
            config: this.thufirConfig,
            tradeId: `perp_${tradeId}`,
            expr,
            entryPrice,
            size,
            notionalUsd: probeUsd,
            entryCloid: decision.clientOrderId ?? null,
            entryFeesUsd,
          });
          recordTradeEnvelope(envelope);
          recordTradeSignals({
            tradeId: envelope.tradeId,
            symbol: envelope.symbol,
            signals: (expr.signalKinds ?? []).map((kind: string) => ({ kind })),
          });

          const stops = await placeExchangeSideTpsl({ config: this.thufirConfig, envelope });
          if (stops.tpOid || stops.slOid) {
            envelope.tpOid = stops.tpOid;
            envelope.slOid = stops.slOid;
            recordTradeEnvelope(envelope);
          }
        }
      } catch {
        // Best-effort journaling: never block trading due to local DB issues.
      }
      outputs.push(tradeResult.message);
    }

    return outputs.join('\n');
  }

  private async selectExpressionsToExecute(
    eligible: ExpressionPlan[],
    maxTrades: number
  ): Promise<ExpressionPlan[]> {
    if (maxTrades <= 0) return [];
    if (eligible.length <= maxTrades) return eligible;
    if (this.thufirConfig.tradeManagement?.enabled !== true) {
      return eligible.slice(0, maxTrades);
    }

    const journalSummary = buildTradeJournalSummary({ limit: 20 });
    const payload = {
      N: maxTrades,
      journalSummary,
      eligibleExpressions: eligible.map((e) => ({
        id: e.id,
        symbol: e.symbol,
        side: e.side,
        expectedEdge: e.expectedEdge,
        confidence: e.confidence,
        leverage: e.leverage,
        probeSizeUsd: e.probeSizeUsd,
        stopLossPct: e.stopLossPct ?? null,
        takeProfitPct: e.takeProfitPct ?? null,
        maxHoldSeconds: e.maxHoldSeconds ?? null,
        trailingStopPct: e.trailingStopPct ?? null,
        trailingActivationPct: e.trailingActivationPct ?? null,
        signalKinds: e.signalKinds ?? [],
        thesis: e.thesis ?? '',
      })),
    };

    const system =
      'You are selecting which (if any) expressions to execute in full autonomous mode.\n' +
      'Default state is NO TRADE. Most scans should result in no action.\n' +
      'Return ONLY JSON: {"selectedExpressionIds":[...], "rationale":"..."}.\n' +
      'Rules:\n' +
      '- Never select more than N.\n' +
      '- Prefer selectivity over action.\n';

    try {
      const res = await this.llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(payload, null, 2) },
        ],
        { temperature: 0.2, maxTokens: 600 }
      );
      const parsed = safeJson(res.content) as any;
      const ids = Array.isArray(parsed?.selectedExpressionIds)
        ? parsed.selectedExpressionIds.map((x: any) => String(x)).filter(Boolean)
        : [];
      if (ids.length === 0) return [];
      const allow = new Set(eligible.map((e) => e.id));
      const filtered = ids.filter((id: string) => allow.has(id)).slice(0, maxTrades);
      const byId = new Map(eligible.map((e) => [e.id, e] as const));
      return filtered.map((id: string) => byId.get(id)!).filter(Boolean);
    } catch (err) {
      this.logger.warn('LLM entry selection failed; falling back to top expressions', err);
      return eligible.slice(0, maxTrades);
    }
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

  /**
   * Schedule the daily report
   */
  private scheduleDailyReport(): void {
    const scheduleNext = () => {
      const now = new Date();
      const timeParts = this.config.dailyReportTime.split(':').map(Number);
      const hours = timeParts[0] ?? 20;
      const minutes = timeParts[1] ?? 0;

      const target = new Date(now);
      target.setHours(hours, minutes, 0, 0);

      if (target <= now) {
        target.setDate(target.getDate() + 1);
      }

      const delay = target.getTime() - now.getTime();

      this.reportTimer = setTimeout(async () => {
        try {
          const report = await this.generateDailyPnLReport();
          this.emit('daily-report', report);
        } catch (error) {
          this.logger.error('Failed to generate daily report', error);
        }
        scheduleNext();
      }, delay);
    };

    scheduleNext();
  }

  private calculateUnrealizedPnl(): number {
    const positions = listOpenPositionsFromTrades(200);
    let total = 0;

    for (const position of positions) {
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
        continue;
      }
      const shares = positionSize / averagePrice;
      const price = currentPrice ?? averagePrice;
      const value = shares * price;
      total += value - positionSize;
    }

    return total;
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
}

function safeJson(text: string): unknown | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}
