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
import type { PolymarketMarketClient } from '../execution/polymarket/markets.js';
import type { ExecutionAdapter, TradeDecision } from '../execution/executor.js';
import { DbSpendingLimitEnforcer } from '../execution/wallet/limits_db.js';
import { checkExposureLimits } from './exposure.js';
import {
  scanForOpportunities,
  generateDailyReport,
  formatDailyReport,
  type Opportunity,
  type OrchestratorAssets,
} from './opportunities.js';
import { getDailyPnLRollup } from './daily_pnl.js';
import { createPrediction, listOpenPositions } from '../memory/predictions.js';
import { openDatabase } from '../memory/db.js';
import { Logger } from './logger.js';
import { AgentToolRegistry } from '../agent/tools/registry.js';
import { registerAllTools } from '../agent/tools/adapters/index.js';
import { loadThufirIdentity } from '../agent/identity/identity.js';

export interface AutonomousConfig {
  enabled: boolean;
  fullAuto: boolean;
  minEdge: number;
  requireHighConfidence: boolean;
  pauseOnLossStreak: number;
  dailyReportTime: string;
  maxTradesPerScan: number;
}

export interface TradeRecord {
  id: string;
  marketId: string;
  marketTitle: string;
  direction: string;
  amount: number;
  entryPrice: number;
  confidence: string;
  reasoning: string;
  timestamp: Date;
  outcome?: 'win' | 'loss' | 'pending';
  pnl?: number;
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
  'trade-executed': (trade: TradeRecord) => void;
  'opportunity-found': (opportunities: Opportunity[]) => void;
  'daily-report': (report: string) => void;
  'paused': (reason: string) => void;
  'resumed': () => void;
  'error': (error: Error) => void;
}

export class AutonomousManager extends EventEmitter<AutonomousEvents> {
  private config: AutonomousConfig;
  private llm: LlmClient;
  private marketClient: PolymarketMarketClient;
  private executor: ExecutionAdapter;
  private limiter: DbSpendingLimitEnforcer;
  private logger: Logger;
  private thufirConfig: ThufirConfig;
  private orchestratorAssets?: OrchestratorAssets;

  private isPaused = false;
  private pauseReason = '';
  private consecutiveLosses = 0;
  private scanTimer: NodeJS.Timeout | null = null;
  private reportTimer: NodeJS.Timeout | null = null;

  constructor(
    llm: LlmClient,
    marketClient: PolymarketMarketClient,
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

    if (thufirConfig.agent?.useOrchestrator) {
      const registry = new AgentToolRegistry();
      registerAllTools(registry);
      const identity = loadThufirIdentity({
        workspacePath: thufirConfig.agent?.workspace,
      }).identity;
      this.orchestratorAssets = { registry, identity };
    }

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

    // Find opportunities
    const opportunities = await scanForOpportunities(
      this.llm,
      this.marketClient,
      this.thufirConfig,
      50,
      { orchestrator: this.orchestratorAssets }
    );

    this.emit('opportunity-found', opportunities);

    if (opportunities.length === 0) {
      return 'No significant opportunities found.';
    }

    // Filter by config requirements
    let validOpportunities = opportunities.filter(o => o.edge >= this.config.minEdge);

    if (this.config.requireHighConfidence) {
      validOpportunities = validOpportunities.filter(o => o.confidence === 'high');
    }

    if (validOpportunities.length === 0) {
      return `Found ${opportunities.length} opportunities but none meet criteria (minEdge: ${this.config.minEdge * 100}%, requireHigh: ${this.config.requireHighConfidence})`;
    }

    // If not full auto, just report
    if (!this.config.fullAuto) {
      return this.formatOpportunitySummary(validOpportunities.slice(0, 10));
    }

    // Execute trades (full auto mode)
    const results: string[] = [];
    const toExecute = validOpportunities.slice(0, this.config.maxTradesPerScan);

    for (const opp of toExecute) {
      const tradeResult = await this.executeTrade(opp);
      results.push(tradeResult);

      // Check if we should pause
      if (this.consecutiveLosses >= this.config.pauseOnLossStreak) {
        this.pause(`${this.consecutiveLosses} consecutive losses`);
        break;
      }
    }

    return results.join('\n');
  }

  /**
   * Execute a trade for an opportunity
   */
  private async executeTrade(opp: Opportunity): Promise<string> {
    const amount = Math.min(opp.suggestedAmount, this.limiter.getRemainingDaily());

    if (amount < 5) {
      return `${opp.market.id}: Skipped (insufficient budget)`;
    }

    const exposureCheck = checkExposureLimits({
      config: this.thufirConfig,
      market: opp.market,
      outcome: opp.direction.includes('YES') ? 'YES' : 'NO',
      amount,
      side: opp.direction.includes('LONG') ? 'buy' : 'sell',
    });
    if (!exposureCheck.allowed) {
      return `${opp.market.id}: Blocked (${exposureCheck.reason ?? 'exposure limit exceeded'})`;
    }

    // Check limits
    const limitCheck = await this.limiter.checkAndReserve(amount);
    if (!limitCheck.allowed) {
      return `${opp.market.id}: Blocked (${limitCheck.reason})`;
    }

    // Build trade decision
    const decision: TradeDecision = {
      action: opp.direction.includes('LONG') ? 'buy' : 'sell',
      outcome: opp.direction.includes('YES') ? 'YES' : 'NO',
      amount,
      confidence: opp.confidence,
      reasoning: opp.reasoning,
    };

    // Execute
    const result = await this.executor.execute(opp.market, decision);

    if (result.executed) {
      this.limiter.confirm(amount);

      // Record trade
      const trade = this.recordTrade(opp, amount);
      this.emit('trade-executed', trade);

      // Record prediction for calibration
      createPrediction({
        marketId: opp.market.id,
        marketTitle: opp.market.question,
        predictedOutcome: decision.outcome,
        predictedProbability: opp.myEstimate,
        confidenceLevel: opp.confidence,
        domain: opp.market.category,
        reasoning: opp.reasoning,
        executed: true,
        executionPrice: opp.marketPrice,
        positionSize: amount,
      });

      return `✅ ${opp.market.question.slice(0, 40)}... | ${decision.action.toUpperCase()} ${decision.outcome} $${amount} | Edge: ${(opp.edge * 100).toFixed(1)}%`;
    } else {
      this.limiter.release(amount);
      return `❌ ${opp.market.id}: ${result.message}`;
    }
  }

  /**
   * Record a trade in the database
   */
  private recordTrade(opp: Opportunity, amount: number): TradeRecord {
    const trade: TradeRecord = {
      id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      marketId: opp.market.id,
      marketTitle: opp.market.question,
      direction: opp.direction,
      amount,
      entryPrice: opp.marketPrice,
      confidence: opp.confidence,
      reasoning: opp.reasoning,
      timestamp: new Date(),
      outcome: 'pending',
    };

    const db = openDatabase();
    db.prepare(`
      INSERT INTO autonomous_trades (id, market_id, market_title, direction, amount, entry_price, confidence, reasoning, timestamp, outcome)
      VALUES (@id, @marketId, @marketTitle, @direction, @amount, @entryPrice, @confidence, @reasoning, @timestamp, @outcome)
    `).run({
      ...trade,
      timestamp: trade.timestamp.toISOString(),
    });

    return trade;
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
    const report = await generateDailyReport(
      this.llm,
      this.marketClient,
      this.thufirConfig,
      { orchestrator: this.orchestratorAssets }
    );

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
    lines.push('─'.repeat(40));
    lines.push('');
    lines.push(formatDailyReport(report));

    return lines.join('\n');
  }

  /**
   * Format opportunity summary (for non-auto mode)
   */
  private formatOpportunitySummary(opportunities: Opportunity[]): string {
    const lines: string[] = [];
    lines.push(`Found ${opportunities.length} opportunities:`);
    lines.push('');

    for (const opp of opportunities) {
      const emoji = opp.direction.startsWith('LONG') ? '📈' : '📉';
      lines.push(`${emoji} **${opp.market.question.slice(0, 50)}...**`);
      lines.push(`   Edge: ${(opp.edge * 100).toFixed(1)}% | ${opp.confidence} confidence`);
      lines.push(`   ${opp.reasoning.slice(0, 80)}...`);
      lines.push('');
    }

    lines.push('Full auto is OFF. Use `/fullauto on` to enable automatic execution.');
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
    const positions = listOpenPositions(200);
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
