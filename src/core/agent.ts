import type { ThufirConfig } from './config.js';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createAgenticExecutorClient,
  createLlmClient,
  createTrivialTaskClient,
  clearIdentityCache,
  OrchestratorClient,
} from './llm.js';
import type { LlmClient } from './llm.js';
import { Logger } from './logger.js';
import { createMarketClient, type MarketClient } from '../execution/market-client.js';
import { PaperExecutor } from '../execution/modes/paper.js';
import { WebhookExecutor } from '../execution/modes/webhook.js';
import { HyperliquidLiveExecutor } from '../execution/modes/hyperliquid-live.js';
import { UnsupportedLiveExecutor } from '../execution/modes/unsupported-live.js';
import type { ExecutionAdapter } from '../execution/executor.js';
import { DbSpendingLimitEnforcer } from '../execution/wallet/limits_db.js';
import { addWatchlist, listWatchlist } from '../memory/watchlist.js';
import { runIntelPipeline } from '../intel/pipeline.js';
import { buildBriefing } from './briefing.js';
import { getUserContext, updateUserContext } from '../memory/user.js';
import { ConversationHandler } from './conversation.js';
import { AutonomousManager } from './autonomous.js';
import { runDiscovery } from '../discovery/engine.js';
import type { ToolExecutorContext } from './tool-executor.js';
import { withExecutionContext } from './llm_infra.js';

export class ThufirAgent {
  private llm: ReturnType<typeof createLlmClient>;
  private infoLlm?: LlmClient;
  private autonomyLlm: ReturnType<typeof createLlmClient>;
  private marketClient: MarketClient;
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
    this.marketClient = createMarketClient(this.config);
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
      if (config.execution.provider === 'hyperliquid') {
        return new HyperliquidLiveExecutor({ config });
      }
      return new UnsupportedLiveExecutor();
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
    const isQuestion = this.isQuestion(trimmed);
    const isCapabilityQuestion = this.isCapabilityQuestion(trimmed);
    const isAccessQuestion = this.isAccessQuestion(trimmed);

    const tradeIntent = /\b(trade|buy|sell|long|short)\b/i.test(trimmed);
    if (tradeIntent && !trimmed.startsWith('/perp ')) {
      const autoEnabled =
        (this.config.autonomy as any)?.enabled === true &&
        (this.config.autonomy as any)?.fullAuto === true;
      if (!autoEnabled && !isCapabilityQuestion && !isAccessQuestion && !isQuestion) {
        if (this.config.execution?.provider === 'hyperliquid') {
          return 'To place a live perp trade, use `/perp <symbol> <buy|sell> <sizeUsd> [leverage]` (example: `/perp BTC buy 25 3`).';
        }
      }
    }

    if (this.isSetupRequest(trimmed)) {
      return this.buildLiveTradingSetupPrompt();
    }

    if (isCapabilityQuestion || isAccessQuestion) {
      return this.buildAccessReport();
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
      if (key === 'probability_mode') {
        updateUserContext(sender, { preferences: { probability_mode: value } });
        return 'Updated probability mode.';
      }
      updateUserContext(sender, { preferences: { [key]: value } });
      return `Updated preference: ${key}`;
    }

    const probModeMatch = trimmed.match(/\bprobability\s+mode\b.*\b(conservative|balanced|aggressive)\b/i);
    if (probModeMatch) {
      const mode = probModeMatch[1]!.toLowerCase();
      updateUserContext(sender, { preferences: { probability_mode: mode } });
      return `Probability mode set to ${mode}.`;
    }

    // Command: /perp <symbol> <buy|sell> <sizeUsd> [leverage]
    if (trimmed.startsWith('/perp ')) {
      const [, symbolRaw, sideRaw, sizeRaw, leverageRaw] = trimmed.split(' ');
      const symbol = symbolRaw?.trim();
      const side = sideRaw?.toLowerCase();
      const sizeUsd = Number(sizeRaw);
      const leverage = leverageRaw ? Number(leverageRaw) : undefined;
      if (!symbol || (side !== 'buy' && side !== 'sell') || !Number.isFinite(sizeUsd)) {
        return 'Usage: /perp <symbol> <buy|sell> <sizeUsd> [leverage]';
      }
      try {
        const market = await this.marketClient.getMarket(symbol);
        const markPrice = market.markPrice ?? 0;
        const size = markPrice > 0 ? sizeUsd / markPrice : sizeUsd;
        const { checkPerpRiskLimits } = await import('../execution/perp-risk.js');
        const riskCheck = await checkPerpRiskLimits({
          config: this.config,
          symbol,
          side: side as 'buy' | 'sell',
          size,
          leverage,
          reduceOnly: false,
          markPrice: markPrice || null,
          notionalUsd: Number.isFinite(sizeUsd) ? sizeUsd : undefined,
          marketMaxLeverage:
            typeof market.metadata?.maxLeverage === 'number'
              ? (market.metadata.maxLeverage as number)
              : null,
        });
        if (!riskCheck.allowed) {
          return `Trade blocked: ${riskCheck.reason ?? 'perp risk limits exceeded'}`;
        }
        const limitCheck = await this.limiter.checkAndReserve(sizeUsd);
        if (!limitCheck.allowed) {
          return `Trade blocked: ${limitCheck.reason}`;
        }
        const decision = {
          action: side as 'buy' | 'sell',
          side: side as 'buy' | 'sell',
          symbol,
          size,
          leverage,
          orderType: 'market' as const,
          reasoning: `Manual perp command from ${sender}`,
        };
        const result = await this.executor.execute(market, decision);
        if (result.executed) {
          this.limiter.confirm(sizeUsd);
        } else {
          this.limiter.release(sizeUsd);
        }
        return result.message;
      } catch (error) {
        return `Perp trade failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
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

    // Command: /markets <query> - Search for perp markets
    if (trimmed.startsWith('/markets ')) {
      const query = trimmed.replace('/markets ', '').trim();
      try {
        const markets = await this.marketClient.searchMarkets(query, 10);
        if (markets.length === 0) {
          return `No perp symbols found for "${query}"`;
        }
        const lines = markets.map((m) => {
          const price = m.markPrice ?? 'N/A';
          return `**${m.question}**\n  Symbol: \`${m.symbol ?? m.id}\` | Mark: ${price}`;
        });
        return `Found ${markets.length} perp market(s):\n\n${lines.join('\n\n')}`;
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

    // Command: /top10 - Get discovery expressions snapshot
    if (trimmed === '/top10' || trimmed === '/opportunities') {
      this.logger.info(`Generating top 10 opportunities for ${sender}`);
      try {
        const discovery = await runDiscovery(this.config);
        const expressions = discovery.expressions.slice(0, 10);
        if (expressions.length === 0) {
          return 'No discovery expressions generated.';
        }
        const lines = expressions.map(
          (expr) =>
            `- ${expr.symbol} ${expr.side.toUpperCase()} probe=$${expr.probeSizeUsd.toFixed(2)} leverage=${expr.leverage}`
        );
        return `Top discovery expressions:\n${lines.join('\n')}`;
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
Just type naturally to chat about markets, risks, or positioning.
/ask <topic> - Ask about a topic and find relevant perp markets
/analyze <symbol> - Deep analysis of a specific perp market
/analyze-json <symbol> - Structured analysis (JSON)
/markets <query> - Search for perp symbols
/clear - Clear conversation history

**Autonomous Mode:**
/top10 - Get today's top 10 discovery expressions
/status - Show autonomous mode status and P&L
/report - Full daily report
/fullauto [on|off] - Toggle autonomous execution
/pause - Pause autonomous trading
/resume - Resume autonomous trading

**Trading:**
/watch <symbol> - Add symbol to watchlist
/watchlist - Show watched symbols
/scan - Run autonomous discovery scan
/perp <symbol> <buy|sell> <sizeUsd> [leverage] - Execute a perp trade

**Info:**
/briefing - Daily briefing
/intel - Fetch latest news
/profile - Show your profile
/persona [mode|list|off] - Set personality mode
/setpref key=value - Set preferences

**Examples:**
"What do you think about BTC volatility?"
"What matters most for ETH this week?"
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

  private async autonomousScan(): Promise<string> {
    return withExecutionContext(
      { mode: 'FULL_AGENT', critical: true, reason: 'autonomous_scan', source: 'agent' },
      async () => {
        return this.autonomous.runScan();
      }
    );
  }

  private async maybeHandleNaturalLanguageTrade(
    sender: string,
    message: string
  ): Promise<string | null> {
    const autoEnabled =
      (this.config.autonomy as any)?.enabled === true &&
      (this.config.autonomy as any)?.fullAuto === true;
    const wantsAutoScan =
      /\b(find|look\s+for|scan|search|identify)\b.*\b(trade|trades|opportunit|edge)\b/i.test(message) ||
      /\b(start|begin|run|kick\s*off)\b.*\b(trading|auto|autonomous)\b/i.test(message);

    if (wantsAutoScan) {
      if (!autoEnabled) {
        return 'Autonomous trading is disabled. Enable with /fullauto on and ensure autonomy.enabled: true.';
      }
      return this.autonomousScan();
    }

    void sender;
    void message;
    return null;
  }

  private buildAccessReport(): string {
    const executionMode = this.config.execution?.mode ?? 'paper';
    const marketDataReady = this.marketClient.isAvailable();
    const provider = this.config.execution?.provider ?? 'hyperliquid';
    const hasHyperKey =
      Boolean(this.config.hyperliquid?.privateKey) ||
      Boolean(process.env.HYPERLIQUID_PRIVATE_KEY);

    const lines: string[] = [];
    lines.push('Access status (Markets):');
    lines.push(`- Market data: ${marketDataReady ? 'enabled' : 'not configured'}.`);
    lines.push(`- Execution mode: ${executionMode}.`);
    lines.push(`- Execution provider: ${provider}.`);
    if (provider === 'hyperliquid') {
      lines.push(`- Hyperliquid key: ${hasHyperKey ? 'set' : 'missing'} (HYPERLIQUID_PRIVATE_KEY).`);
    }

    const tradingReady = executionMode === 'live' && (provider !== 'hyperliquid' || hasHyperKey);
    lines.push(`- Live trading: ${tradingReady ? 'ready' : 'not ready'}.`);

    if (!tradingReady) {
      lines.push('');
      lines.push('To enable live trading:');
      lines.push('- Set `execution.mode: live` in config.');
      if (provider === 'hyperliquid') {
        lines.push('- Export `HYPERLIQUID_PRIVATE_KEY` (not stored in config).');
      } else {
        lines.push('- Ensure the keystore exists (or set `wallet.keystorePath`).');
        lines.push('- Export `THUFIR_WALLET_PASSWORD` (not stored in config).');
      }
      lines.push('');
      lines.push('If you want, tell me "set up live trading" and I will guide the setup.');
    }

    return lines.join('\n');
  }

  private buildLiveTradingSetupPrompt(): string {
    const configPath =
      process.env.THUFIR_CONFIG_PATH ?? join(homedir(), '.thufir', 'config.yaml');
    const provider = this.config.execution?.provider ?? 'hyperliquid';
    const keystorePath =
      this.config.wallet?.keystorePath ??
      process.env.THUFIR_KEYSTORE_PATH ??
      `${process.env.HOME ?? ''}/.thufir/keystore.json`;

    return [
      'Live trading setup:',
      `- Config file: ${configPath}`,
      '- I can guide the steps, but I will not store secrets.',
      '',
      'Please provide:',
      provider === 'hyperliquid'
        ? '- Confirmation that you will export `HYPERLIQUID_PRIVATE_KEY` in your environment.'
        : `- Keystore path (default: ${keystorePath}) or confirm the default.`,
      provider === 'hyperliquid'
        ? '- Confirm your Hyperliquid account address (optional).'
        : '- Confirmation that you will export `THUFIR_WALLET_PASSWORD` in your environment.',
      '',
      'Once set, I will use `execution.mode: live` and verify access.',
    ].join('\n');
  }

  private isQuestion(message: string): boolean {
    return (
      /\?\s*$/.test(message) ||
      /^(should|can|could|would|do|does|did|are|is|am|will|may)\b/i.test(message)
    );
  }

  private isCapabilityQuestion(message: string): boolean {
    return (
      this.isQuestion(message) &&
      /\b(suited|capable|able)\b/i.test(message) &&
      /\b(trade|buy|sell|long|short)\b/i.test(message)
    );
  }

  private isAccessQuestion(message: string): boolean {
    return (
      this.isQuestion(message) &&
      (/\baccess\b/i.test(message) ||
        /\bwhere\b.*\baccess\b/i.test(message) ||
        /\bcan you\b.*\b(trade|buy|sell|long|short)\b/i.test(message) ||
        /\bdo you\b.*\b(access|trade)\b/i.test(message))
    );
  }

  private isSetupRequest(message: string): boolean {
    return /\b(set\s*up|enable|configure)\b.*\b(live|trading|trade)\b/i.test(message);
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
