import type { BijazConfig } from './config.js';
import { createLlmClient, createOpenAiClient } from './llm.js';
import { decideTrade } from './decision.js';
import { Logger } from './logger.js';
import { PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { PaperExecutor } from '../execution/modes/paper.js';
import { WebhookExecutor } from '../execution/modes/webhook.js';
import { LiveExecutor } from '../execution/modes/live.js';
import type { ExecutionAdapter } from '../execution/executor.js';
import { DbSpendingLimitEnforcer } from '../execution/wallet/limits_db.js';
import { addWatchlist, listWatchlist } from '../memory/watchlist.js';
import { runIntelPipeline } from '../intel/pipeline.js';
import { resolveOutcomes } from './resolver.js';
import { buildBriefing } from './briefing.js';
import { getUserContext, updateUserContext } from '../memory/user.js';
import { ConversationHandler } from './conversation.js';
import { AutonomousManager } from './autonomous.js';
import { generateDailyReport, formatDailyReport } from './opportunities.js';
import { explainPrediction } from './explain.js';
import { checkExposureLimits } from './exposure.js';

export class BijazAgent {
  private llm: ReturnType<typeof createLlmClient>;
  private infoLlm: ReturnType<typeof createOpenAiClient>;
  private executorLlm: ReturnType<typeof createOpenAiClient>;
  private marketClient: PolymarketMarketClient;
  private executor: ExecutionAdapter;
  private limiter: DbSpendingLimitEnforcer;
  private logger: Logger;
  private scanTimer: NodeJS.Timeout | null = null;
  private conversation: ConversationHandler;
  private autonomous: AutonomousManager;

  constructor(private config: BijazConfig, logger?: Logger) {
    this.logger = logger ?? new Logger('info');
    if (config.memory?.dbPath) {
      process.env.BIJAZ_DB_PATH = config.memory.dbPath;
    }
    this.llm = createLlmClient(this.config);
    this.infoLlm = createOpenAiClient(this.config, this.config.agent.openaiModel);
    this.executorLlm = createOpenAiClient(this.config, this.config.agent.openaiModel);
    this.marketClient = new PolymarketMarketClient(this.config);
    this.executor = this.createExecutor(config);

    this.limiter = new DbSpendingLimitEnforcer({
      daily: config.wallet?.limits?.daily ?? 100,
      perTrade: config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
    });

    this.conversation = new ConversationHandler(
      this.llm,
      this.marketClient,
      this.config,
      this.infoLlm
    );

    this.autonomous = new AutonomousManager(
      this.llm,
      this.marketClient,
      this.executor,
      this.limiter,
      this.config,
      this.logger
    );
  }

  private createExecutor(config: BijazConfig): ExecutionAdapter {
    if (config.execution.mode === 'live') {
      const password = process.env.BIJAZ_WALLET_PASSWORD;
      if (!password) {
        throw new Error(
          'Live execution mode requires BIJAZ_WALLET_PASSWORD environment variable'
        );
      }
      return new LiveExecutor({ config, password });
    }

    if (config.execution.mode === 'webhook' && config.execution.webhookUrl) {
      return new WebhookExecutor(config.execution.webhookUrl);
    }

    return new PaperExecutor();
  }

  start(): void {
    // Start autonomous manager (handles its own scheduling)
    this.autonomous.start();

    // Set up event handlers for autonomous mode
    this.autonomous.on('daily-report', (_report) => {
      this.logger.info('Daily report generated');
      // Reports will be pushed to channels by the gateway
    });

    this.autonomous.on('trade-executed', (trade) => {
      this.logger.info(`Auto-trade executed: ${trade.marketTitle} ${trade.direction} $${trade.amount}`);
    });

    // Legacy scan loop (for backwards compatibility when fullAuto is off)
    if (this.config.autonomy.enabled && !(this.config.autonomy as any).fullAuto) {
      const interval = this.config.autonomy.scanIntervalSeconds * 1000;
      this.scanTimer = setInterval(() => {
        this.autonomousScan().catch((err) =>
          this.logger.error('Autonomous scan failed', err)
        );
      }, interval);
      this.logger.info(`Legacy scan enabled: scanning every ${interval / 1000}s`);
    }
  }

  stop(): void {
    this.autonomous.stop();
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /**
   * Get the autonomous manager for external access
   */
  getAutonomous(): AutonomousManager {
    return this.autonomous;
  }

  async handleMessage(sender: string, text: string): Promise<string> {
    const trimmed = text.trim();

    // Command: /watch <marketId>
    if (trimmed.startsWith('/watch ')) {
      const marketId = trimmed.replace('/watch ', '').trim();
      addWatchlist(marketId);
      return `Added ${marketId} to watchlist.`;
    }

    // Command: /watchlist
    if (trimmed === '/watchlist') {
      const watchlist = listWatchlist(50);
      if (watchlist.length === 0) {
        return 'Watchlist is empty.';
      }
      return watchlist.map((item) => `- ${item.marketId}`).join('\n');
    }

    // Command: /scan
    if (trimmed === '/scan') {
      const result = await this.autonomousScan();
      return result;
    }

    // Command: /briefing
    if (trimmed === '/briefing') {
      return this.generateBriefing();
    }

    // Command: /intel
    if (trimmed === '/intel') {
      const stored = await runIntelPipeline(this.config);
      return `Intel updated. New items stored: ${stored}.`;
    }

    // Command: /resolve
    if (trimmed === '/resolve') {
      const updated = await resolveOutcomes(this.config);
      return `Resolved ${updated} prediction(s).`;
    }

    // Command: /explain <predictionId>
    if (trimmed.startsWith('/explain ')) {
      const predictionId = trimmed.replace('/explain ', '').trim();
      if (!predictionId) {
        return 'Usage: /explain <predictionId>';
      }
      return this.explainPrediction(predictionId);
    }

    // Command: /profile
    if (trimmed === '/profile') {
      const profile = getUserContext(sender);
      if (!profile) {
        return 'No profile yet. Use /setpref key=value to set preferences.';
      }
      return JSON.stringify(profile, null, 2);
    }

    // Command: /setpref key=value
    if (trimmed.startsWith('/setpref ')) {
      const payload = trimmed.replace('/setpref ', '').trim();
      const [key, rawValue] = payload.split('=');
      if (!key || rawValue === undefined) {
        return 'Usage: /setpref key=value';
      }
      const value = rawValue.trim();
      if (key === 'domains') {
        updateUserContext(sender, {
          domainsOfInterest: value.split(',').map((item) => item.trim()),
        });
        return 'Updated domains of interest.';
      }
      if (key === 'risk') {
        updateUserContext(sender, { riskTolerance: value as 'conservative' | 'moderate' | 'aggressive' });
        return 'Updated risk tolerance.';
      }
      updateUserContext(sender, { preferences: { [key]: value } });
      return `Updated preference: ${key}`;
    }

    // Command: /trade <marketId> <YES|NO> <amount>
    if (trimmed.startsWith('/trade ')) {
      const [, marketId, outcome, amountRaw] = trimmed.split(' ');
      const amount = Number(amountRaw);
      if (!marketId || !outcome || Number.isNaN(amount)) {
        return 'Usage: /trade <marketId> <YES|NO> <amount>';
      }
      const market = await this.marketClient.getMarket(marketId);
      const decision = {
        action: 'buy' as const,
        outcome: outcome.toUpperCase() as 'YES' | 'NO',
        amount,
        confidence: 'medium' as const,
        reasoning: `Manual command from ${sender}`,
      };

      const exposureCheck = checkExposureLimits({
        config: this.config,
        market,
        outcome: decision.outcome,
        amount,
        side: decision.action,
      });
      if (!exposureCheck.allowed) {
        return `Trade blocked: ${exposureCheck.reason ?? 'exposure limit exceeded'}`;
      }

      const limitCheck = await this.limiter.checkAndReserve(amount);
      if (!limitCheck.allowed) {
        return `Trade blocked: ${limitCheck.reason ?? 'limit exceeded'}`;
      }

      const result = await this.executor.execute(market, decision);
      if (result.executed) {
        this.limiter.confirm(amount);
      } else {
        this.limiter.release(amount);
      }
      return result.message;
    }

    // Command: /analyze <marketId> - Deep analysis of a specific market
    if (trimmed.startsWith('/analyze ')) {
      const marketId = trimmed.replace('/analyze ', '').trim();
      this.logger.info(`Analyzing market ${marketId} for ${sender}`);
      return this.conversation.analyzeMarket(sender, marketId);
    }

    // Command: /analyze-json <marketId>
    if (trimmed.startsWith('/analyze-json ')) {
      const marketId = trimmed.replace('/analyze-json ', '').trim();
      const result = await this.conversation.analyzeMarketStructured(sender, marketId);
      return JSON.stringify(result, null, 2);
    }

    // Command: /ask <topic> - Ask about a topic and find relevant markets
    if (trimmed.startsWith('/ask ')) {
      const topic = trimmed.replace('/ask ', '').trim();
      this.logger.info(`User ${sender} asking about: ${topic}`);
      return this.conversation.askAbout(sender, topic);
    }

    // Command: /markets <query> - Search for markets
    if (trimmed.startsWith('/markets ')) {
      const query = trimmed.replace('/markets ', '').trim();
      try {
        const markets = await this.marketClient.searchMarkets(query, 10);
        if (markets.length === 0) {
          return `No markets found for "${query}"`;
        }
        const lines = markets.map((m) => {
          const yesPrice = m.prices['Yes'] ?? m.prices['YES'] ?? m.prices[0] ?? 0;
          const pct = typeof yesPrice === 'number' ? `${(yesPrice * 100).toFixed(0)}%` : '?';
          return `**${m.question}**\n  YES: ${pct} | ID: \`${m.id}\``;
        });
        return `Found ${markets.length} market(s):\n\n${lines.join('\n\n')}`;
      } catch (error) {
        return `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    }

    // Command: /clear - Clear conversation history
    if (trimmed === '/clear') {
      this.conversation.clearHistory(sender);
      return 'Conversation history cleared.';
    }

    // Command: /alerts - show or start intel alert setup
    if (trimmed === '/alerts') {
      return 'Want to set up intel alerts? Reply "yes" or "no".';
    }

    // Command: /top10 - Get daily top 10 opportunities
    if (trimmed === '/top10' || trimmed === '/opportunities') {
      this.logger.info(`Generating top 10 opportunities for ${sender}`);
      try {
        const report = await generateDailyReport(this.llm, this.marketClient, this.config);
        return formatDailyReport(report);
      } catch (error) {
        return `Failed to generate opportunities: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    }

    // Command: /fullauto [on|off] - Toggle full autonomous mode
    if (trimmed.startsWith('/fullauto')) {
      const arg = trimmed.replace('/fullauto', '').trim().toLowerCase();
      if (arg === 'on' || arg === 'enable' || arg === 'true') {
        this.autonomous.setFullAuto(true);
        return '🤖 Full autonomous mode ENABLED. Bijaz will now auto-execute trades when edge is detected.';
      } else if (arg === 'off' || arg === 'disable' || arg === 'false') {
        this.autonomous.setFullAuto(false);
        return '🛑 Full autonomous mode DISABLED. Bijaz will only report opportunities.';
      } else {
        const status = this.autonomous.getStatus();
        return `Full auto mode is currently: ${status.fullAuto ? 'ON' : 'OFF'}\nUse \`/fullauto on\` or \`/fullauto off\` to toggle.`;
      }
    }

    // Command: /pause - Pause autonomous trading
    if (trimmed === '/pause') {
      this.autonomous.pause('Manual pause by user');
      return '⏸️ Autonomous trading paused. Use `/resume` to continue.';
    }

    // Command: /resume - Resume autonomous trading
    if (trimmed === '/resume') {
      this.autonomous.resume();
      return '▶️ Autonomous trading resumed.';
    }

    // Command: /status - Get autonomous mode status
    if (trimmed === '/status') {
      const status = this.autonomous.getStatus();
      const pnl = this.autonomous.getDailyPnL();

      const lines: string[] = [];
      lines.push('**Bijaz Status**');
      lines.push('');
      lines.push('**Autonomous Mode:**');
      lines.push(`• Enabled: ${status.enabled ? 'YES' : 'NO'}`);
      lines.push(`• Full auto: ${status.fullAuto ? 'ON' : 'OFF'}`);
      lines.push(`• Paused: ${status.isPaused ? `YES (${status.pauseReason})` : 'NO'}`);
      lines.push(`• Consecutive losses: ${status.consecutiveLosses}`);
      lines.push('');
      lines.push('**Today\'s Activity:**');
      lines.push(`• Trades: ${pnl.tradesExecuted} (W:${pnl.wins} L:${pnl.losses} P:${pnl.pending})`);
      lines.push(`• Realized P&L: ${pnl.realizedPnl >= 0 ? '+' : ''}$${pnl.realizedPnl.toFixed(2)}`);
      lines.push(`• Remaining budget: $${status.remainingDaily.toFixed(2)}`);

      return lines.join('\n');
    }

    // Command: /report - Get full daily report
    if (trimmed === '/report') {
      this.logger.info(`Generating daily report for ${sender}`);
      try {
        const report = await this.autonomous.generateDailyPnLReport();
        return report;
      } catch (error) {
        return `Failed to generate report: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    }

    // Command: /help
    if (trimmed === '/help') {
      return `**Bijaz Commands**

**Conversation:**
Just type naturally to chat about predictions, events, or markets.
/ask <topic> - Ask about a topic and find relevant markets
/analyze <id> - Deep analysis of a specific market
/analyze-json <id> - Structured analysis (JSON)
/explain <predictionId> - Explain a prediction decision
/markets <query> - Search for prediction markets
/clear - Clear conversation history

**Autonomous Mode:**
/top10 - Get today's top 10 trading opportunities
/status - Show autonomous mode status and P&L
/report - Full daily report with opportunities
/fullauto [on|off] - Toggle autonomous execution
/pause - Pause autonomous trading
/resume - Resume autonomous trading

**Trading:**
/watch <id> - Add market to watchlist
/watchlist - Show watched markets
/scan - Run autonomous market scan
/trade <id> <YES|NO> <amount> - Execute a trade

**Info:**
/briefing - Daily briefing
/intel - Fetch latest news
/resolve - Resolve pending predictions
/profile - Show your profile
/setpref key=value - Set preferences

**Examples:**
"What do you think about the Fed raising rates?"
"Will AI cause significant unemployment by 2030?"
/top10
/fullauto on`;
    }

    // No command matched - treat as conversational message
    // Route to the conversation handler for free-form chat
    this.logger.info(`Chat from ${sender}: ${trimmed.slice(0, 50)}...`);
    try {
      return await this.conversation.chat(sender, trimmed);
    } catch (error) {
      this.logger.error('Conversation error', error);
      return `Sorry, I encountered an error. Try again or use /help for commands.`;
    }
  }

  generateBriefing(): string {
    return buildBriefing(10);
  }

  private async explainPrediction(predictionId: string): Promise<string> {
    return explainPrediction({ predictionId, config: this.config, llm: this.llm });
  }


  private async autonomousScan(): Promise<string> {
    const markets = await this.getMarketsForScan();
    if (markets.length === 0) {
      return 'No markets found to scan.';
    }

    const decisions: string[] = [];
    for (const market of markets) {
      const remaining = this.limiter.getRemainingDaily();
      if (remaining <= 0) {
        decisions.push('Daily limit reached; skipping remaining markets.');
        break;
      }

      const decision = await decideTrade(this.llm, this.executorLlm, market, remaining);
      if (decision.action === 'hold') {
        decisions.push(`${market.id}: hold`);
        continue;
      }

      const amount = decision.amount ?? Math.min(10, remaining);
      const limitCheck = await this.limiter.checkAndReserve(amount);
      if (!limitCheck.allowed) {
        decisions.push(`${market.id}: blocked (${limitCheck.reason})`);
        continue;
      }

      const result = await this.executor.execute(market, {
        action: decision.action,
        outcome: decision.outcome,
        amount,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
      });

      if (result.executed) {
        this.limiter.confirm(amount);
        decisions.push(`${market.id}: executed (${decision.action} ${decision.outcome})`);
      } else {
        this.limiter.release(amount);
        decisions.push(`${market.id}: ${result.message}`);
      }
    }

    return decisions.join('\n');
  }

  private async getMarketsForScan() {
    if (this.config.autonomy.watchlistOnly) {
      const watchlist = listWatchlist(this.config.autonomy.maxMarketsPerScan);
      const markets = [];
      for (const item of watchlist) {
        markets.push(await this.marketClient.getMarket(item.marketId));
      }
      return markets;
    }
    return this.marketClient.listMarkets(this.config.autonomy.maxMarketsPerScan);
  }
}
