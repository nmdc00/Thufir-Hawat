import type { ThufirConfig } from './config.js';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createAgenticExecutorClient,
  createExecutorClient,
  createLlmClient,
  createTrivialTaskClient,
  clearIdentityCache,
  OrchestratorClient,
} from './llm.js';
import type { LlmClient } from './llm.js';
import { decideTrade, buildDecisionPrompts, parseDecisionFromText, EXECUTOR_PROMPT } from './decision.js';
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
import type { ToolExecutorContext } from './tool-executor.js';
import { runOrchestrator } from '../agent/orchestrator/orchestrator.js';
import { AgentToolRegistry } from '../agent/tools/registry.js';
import { registerAllTools } from '../agent/tools/adapters/index.js';
import { loadThufirIdentity } from '../agent/identity/identity.js';
import { withExecutionContext } from './llm_infra.js';

export class ThufirAgent {
  private llm: ReturnType<typeof createLlmClient>;
  private infoLlm?: LlmClient;
  private executorLlm: ReturnType<typeof createExecutorClient>;
  private autonomyLlm: ReturnType<typeof createLlmClient>;
  private marketClient: PolymarketMarketClient;
  private executor: ExecutionAdapter;
  private limiter: DbSpendingLimitEnforcer;
  private logger: Logger;
  private scanTimer: NodeJS.Timeout | null = null;
  private conversation: ConversationHandler;
  private autonomous: AutonomousManager;
  private toolContext: ToolExecutorContext;

  constructor(private config: ThufirConfig, logger?: Logger) {
    this.logger = logger ?? new Logger('info');
    if (config.memory?.dbPath) {
      process.env.THUFIR_DB_PATH = config.memory.dbPath;
    }
    bootstrapWorkspaceIdentity(this.config);
    this.llm = createLlmClient(this.config);
    this.infoLlm = createTrivialTaskClient(this.config) ?? undefined;
    this.executorLlm = createExecutorClient(this.config);
    this.marketClient = new PolymarketMarketClient(this.config);
    this.executor = this.createExecutor(config);

    this.limiter = new DbSpendingLimitEnforcer({
      daily: config.wallet?.limits?.daily ?? 100,
      perTrade: config.wallet?.limits?.perTrade ?? 25,
      confirmationThreshold: config.wallet?.limits?.confirmationThreshold ?? 10,
    });

    this.toolContext = {
      config: this.config,
      marketClient: this.marketClient,
      executor: this.executor,
      limiter: this.limiter,
    };

    this.conversation = new ConversationHandler(
      this.llm,
      this.marketClient,
      this.config,
      this.infoLlm,
      this.toolContext,
      this.logger
    );

    const autonomyExecutorConfig = {
      ...this.config,
      agent: {
        ...(this.config.agent ?? {}),
        executorProvider: 'openai' as const,
      },
    } satisfies ThufirConfig;
    const executor = createAgenticExecutorClient(autonomyExecutorConfig, this.toolContext);
    this.autonomyLlm = new OrchestratorClient(this.llm, executor, this.llm, this.logger);

    this.autonomous = new AutonomousManager(
      this.autonomyLlm,
      this.marketClient,
      this.executor,
      this.limiter,
      this.config,
      this.logger
    );
  }

  private createExecutor(config: ThufirConfig): ExecutionAdapter {
    if (config.execution.mode === 'live') {
      const password = process.env.THUFIR_WALLET_PASSWORD;
      if (!password) {
        throw new Error(
          'Live execution mode requires THUFIR_WALLET_PASSWORD environment variable'
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

    const tradeIntent = /\b(bet|trade|buy|sell)\b/i.test(trimmed);
    if (tradeIntent && !trimmed.startsWith('/trade ') && !trimmed.startsWith('/bet ')) {
      const autoEnabled =
        (this.config.autonomy as any)?.enabled === true &&
        (this.config.autonomy as any)?.fullAuto === true;
      if (!autoEnabled) {
        const hasAmount = /\b\d+(?:\.\d+)?\b/.test(trimmed);
        const hasOutcome = /\b(yes|no)\b/i.test(trimmed);
        const hasId = /\b\d{4,}\b/.test(trimmed);
        if (!hasAmount || !hasOutcome || !hasId) {
          return 'To place a live trade, use `/trade <marketId> <YES|NO> <amount>` (example: `/trade 12345 YES 5`).';
        }
      }
    }

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

    // Command: /persona [mode|list|off]
    if (trimmed.startsWith('/persona')) {
      const payload = trimmed.replace('/persona', '').trim();
      const current = getUserContext(sender)?.preferences?.personality as string | undefined;
      if (!payload || payload === 'list') {
        return `Available personas: thufir\nCurrent: ${current ?? 'default'}`;
      }
      if (payload === 'off' || payload === 'default') {
        updateUserContext(sender, { preferences: { personality: undefined } });
        return 'Personality reset to default.';
      }
      if (payload === 'thufir') {
        updateUserContext(sender, { preferences: { personality: 'thufir' } });
        return 'Personality set to thufir.';
      }
      return 'Unknown persona. Use /persona list to see options.';
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
      return this.executeManualTrade({
        marketId,
        outcome: outcome.toUpperCase() as 'YES' | 'NO',
        amount,
        sender,
        reason: `Manual command from ${sender}`,
      });
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
        return '🤖 Full autonomous mode ENABLED. Thufir will now auto-execute trades when edge is detected.';
      } else if (arg === 'off' || arg === 'disable' || arg === 'false') {
        this.autonomous.setFullAuto(false);
        return '🛑 Full autonomous mode DISABLED. Thufir will only report opportunities.';
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
      lines.push('**Thufir Status**');
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
      return `**Thufir Commands**

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
/persona [mode|list|off] - Set personality mode
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
    const autoTradeResponse = await this.maybeHandleNaturalLanguageTrade(sender, trimmed);
    if (autoTradeResponse) {
      return autoTradeResponse;
    }
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
    return withExecutionContext(
      { mode: 'FULL_AGENT', critical: true, reason: 'autonomous_scan', source: 'agent' },
      async () => {
        const markets = await this.getMarketsForScan();
        if (markets.length === 0) {
          return 'No markets found to scan.';
        }

        const useOrchestrator = this.config.agent?.useOrchestrator === true;
        let orchestratorRegistry: AgentToolRegistry | null = null;
        let orchestratorIdentity: ReturnType<typeof loadThufirIdentity>['identity'] | null = null;
        if (useOrchestrator) {
          orchestratorRegistry = new AgentToolRegistry();
          registerAllTools(orchestratorRegistry);
          orchestratorIdentity = loadThufirIdentity({
            workspacePath: this.config.agent?.workspace,
          }).identity;
        }

        const decisions: string[] = [];
        for (const market of markets) {
          const remaining = this.limiter.getRemainingDaily();
          if (remaining <= 0) {
            decisions.push('Daily limit reached; skipping remaining markets.');
            break;
          }

          let decision: Awaited<ReturnType<typeof decideTrade>>;
          if (useOrchestrator && orchestratorRegistry && orchestratorIdentity) {
            const { plannerPrompt } = buildDecisionPrompts(market, remaining);
            let plan = '';
            try {
              const plannerResponse = await this.llm.complete(
                [
                  { role: 'system', content: 'You are a concise trading planner.' },
                  { role: 'user', content: plannerPrompt },
                ],
                { temperature: 0.2 }
              );
              plan = plannerResponse.content.trim();
            } catch {
              plan = '';
            }

            const { executorPrompt } = buildDecisionPrompts(market, remaining, plan);
            const result = await runOrchestrator(
              'Return a trade decision JSON for the provided market.',
              {
                llm: this.executorLlm,
                toolRegistry: orchestratorRegistry,
                identity: orchestratorIdentity,
                toolContext: this.toolContext,
              },
              {
                skipPlanning: true,
                skipCritic: true,
                maxIterations: 1,
                synthesisSystemPrompt: `${EXECUTOR_PROMPT}\n\nUser Prompt:\n${executorPrompt}`,
              }
            );

            decision = parseDecisionFromText(result.response) ?? {
              action: 'hold',
              reasoning: 'Failed to parse orchestrator decision JSON',
            };
          } else {
            decision = await decideTrade(this.llm, this.executorLlm, market, remaining, this.logger);
          }
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
    );
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

  private async maybeHandleNaturalLanguageTrade(
    sender: string,
    message: string
  ): Promise<string | null> {
    const autoEnabled =
      (this.config.autonomy as any)?.enabled === true &&
      (this.config.autonomy as any)?.fullAuto === true;
    if (!autoEnabled) return null;

    const hasTradeIntent = /\b(bet|trade|buy|sell)\b/i.test(message);
    if (!hasTradeIntent) return null;

    const amountMatch = message.match(/\$?\s?(\d+(?:\.\d+)?)/);
    const amount = amountMatch ? Number(amountMatch[1]) : NaN;
    const outcomeMatch = message.match(/\b(yes|no)\b/i);
    const outcome = outcomeMatch ? (outcomeMatch[1]!.toUpperCase() as 'YES' | 'NO') : null;
    const idMatch = message.match(/\b(\d{4,})\b/);
    const marketId = idMatch?.[1];

    const amountValid = Number.isFinite(amount) && amount > 0;

    if (marketId) {
      return this.executeAutonomousTrade({
        marketId,
        outcome: outcome ?? undefined,
        amount: amountValid ? amount : undefined,
        sender,
      });
    }

    const query = message
      .replace(/\$?\s?\d+(?:\.\d+)?/g, ' ')
      .replace(/\b(yes|no|bet|trade|buy|sell|on|for|market)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!query) {
      return 'Please include a market ID or a clear market description.';
    }

    const matches = await this.marketClient.searchMarkets(query, 5);
    if (matches.length === 0) {
      return `No markets found for "${query}". Try /markets <query> or provide a market ID.`;
    }
    if (matches.length === 1) {
      return this.executeAutonomousTrade({
        marketId: matches[0]!.id,
        outcome: outcome ?? undefined,
        amount: amountValid ? amount : undefined,
        sender,
      });
    }

    const chosen = matches[0]!;
    const result = await this.executeAutonomousTrade({
      marketId: chosen.id,
      outcome: outcome ?? undefined,
      amount: amountValid ? amount : undefined,
      sender,
    });
    return `Multiple markets matched; auto-selected top result ${chosen.id}: ${chosen.question}\n${result}`;
  }

  private async executeAutonomousTrade(params: {
    marketId: string;
    outcome?: 'YES' | 'NO';
    amount?: number;
    sender: string;
  }): Promise<string> {
    const market = await this.marketClient.getMarket(params.marketId);
    const remaining = this.limiter.getRemainingDaily();
    let outcome = params.outcome;
    let amount = params.amount;

    if (!outcome || !amount) {
      const decision = await decideTrade(this.llm, this.executorLlm, market, remaining, this.logger);
      if (decision.action === 'hold') {
        return decision.reasoning ?? 'No clear edge; holding.';
      }
      outcome = outcome ?? decision.outcome ?? 'YES';
      if (!amount || !Number.isFinite(amount) || amount <= 0) {
        amount =
          decision.amount ??
          Math.min(this.config.wallet?.limits?.perTrade ?? 10, remaining);
      }
    }

    return this.executeManualTrade({
      marketId: params.marketId,
      outcome,
      amount,
      sender: params.sender,
      reason: `Autonomous NL trade from ${params.sender}`,
    });
  }

  private async executeManualTrade(params: {
    marketId: string;
    outcome: 'YES' | 'NO';
    amount: number;
    sender: string;
    reason: string;
  }): Promise<string> {
    const market = await this.marketClient.getMarket(params.marketId);
    const decision = {
      action: 'buy' as const,
      outcome: params.outcome,
      amount: params.amount,
      confidence: 'medium' as const,
      reasoning: params.reason,
    };

    const exposureCheck = checkExposureLimits({
      config: this.config,
      market,
      outcome: decision.outcome,
      amount: decision.amount,
      side: decision.action,
    });
    if (!exposureCheck.allowed) {
      return `Trade blocked: ${exposureCheck.reason ?? 'exposure limit exceeded'}`;
    }

    const limitCheck = await this.limiter.checkAndReserve(decision.amount);
    if (!limitCheck.allowed) {
      return `Trade blocked: ${limitCheck.reason ?? 'limit exceeded'}`;
    }

    const result = await this.executor.execute(market, decision);
    if (result.executed) {
      this.limiter.confirm(decision.amount);
    } else {
      this.limiter.release(decision.amount);
    }
    return result.message;
  }
}

function bootstrapWorkspaceIdentity(config: ThufirConfig): void {
  const workspacePath = config.agent?.workspace ?? join(homedir(), '.thufir');
  const repoWorkspacePath = join(process.cwd(), 'workspace');
  if (workspacePath === repoWorkspacePath) {
    return;
  }

  const anchorPath = join(workspacePath, 'IDENTITY.md');
  if (existsSync(anchorPath)) {
    return;
  }
  if (!existsSync(repoWorkspacePath)) {
    return;
  }

  try {
    mkdirSync(workspacePath, { recursive: true });
  } catch {
    return;
  }

  const identityFiles = ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md'];
  let copied = false;
  for (const filename of identityFiles) {
    const src = join(repoWorkspacePath, filename);
    const dest = join(workspacePath, filename);
    if (existsSync(src) && !existsSync(dest)) {
      try {
        copyFileSync(src, dest);
        copied = true;
      } catch {
        // Skip any unreadable file
      }
    }
  }

  if (copied) {
    clearIdentityCache();
  }
}
