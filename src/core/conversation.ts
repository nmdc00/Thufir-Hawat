/**
 * Conversational Chat Handler
 *
 * Enables free-form conversation with Bijaz about prediction markets,
 * future events, opinions, and market analysis.
 */

import type { LlmClient, ChatMessage } from './llm.js';
import type { BijazConfig } from './config.js';
import type { Market, PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { listCalibrationSummaries } from '../memory/calibration.js';
import { listPredictions } from '../memory/predictions.js';
import { listWatchlist } from '../memory/watchlist.js';
import { getUserContext, updateUserContext } from '../memory/user.js';
import { listRecentIntel, listIntelByIds } from '../intel/store.js';
import { IntelVectorStore } from '../intel/vectorstore.js';
import { SessionStore } from '../memory/session_store.js';
import { storeChatMessage, listChatMessagesByIds, clearChatMessages } from '../memory/chat.js';
import { ChatVectorStore } from '../memory/chat_vectorstore.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'yaml';
import { createResearchPlan, runResearchPlan } from './research_planner.js';
import { ToolRegistry } from './tools.js';

export interface ConversationContext {
  userId: string;
  conversationHistory: ChatMessage[];
}

const SYSTEM_PROMPT = `You are Bijaz, an AI prediction market companion. You help users think clearly about the future by:

1. **Discussing future events** - Share thoughtful analysis of what might happen and why
2. **Finding relevant markets** - When discussing events, mention if there are prediction markets for them
3. **Giving probability estimates** - Provide your honest probability estimates with reasoning
4. **Tracking calibration** - You have access to the user's historical prediction accuracy
5. **Being intellectually honest** - Acknowledge uncertainty, update on new information, and disagree when warranted

## Your personality:
- Thoughtful and analytical, like a smart friend who's into forecasting
- Direct and honest - you give your real opinion, not just what users want to hear
- Calibrated - you express appropriate uncertainty and reference base rates
- Curious - you ask clarifying questions when needed

## When discussing predictions:
- Always provide a probability estimate when asked about future events
- Explain the key factors driving your estimate
- Mention what would change your mind
- Reference relevant prediction markets when available
- If you've been wrong in a domain before (shown in calibration data), acknowledge it

## Available tools (use when relevant):
- You can search for Polymarket markets on any topic
- You have access to the user's watchlist and past predictions
- You can see recent news/intel that's been collected

## Response format:
- Be conversational, not robotic
- Use markdown for formatting when helpful
- Keep responses focused but thorough
- If showing market data, format it clearly

Remember: You're a companion for thinking about the future, not just a trading bot. Engage with ideas, challenge assumptions, and help the user become a better forecaster.`;

/**
 * Build context about the user and their prediction history
 */
function buildUserContext(userId: string, _config: BijazConfig): string {
  const lines: string[] = [];

  // User profile
  const profile = getUserContext(userId);
  if (profile) {
    lines.push('## User Profile');
    if (profile.domainsOfInterest && profile.domainsOfInterest.length > 0) {
      lines.push(`Interested in: ${profile.domainsOfInterest.join(', ')}`);
    }
    if (profile.riskTolerance) {
      lines.push(`Risk tolerance: ${profile.riskTolerance}`);
    }
    lines.push('');
  }

  // Calibration data
  const calibration = listCalibrationSummaries();
  if (calibration.length > 0 && calibration.some((c) => c.resolvedPredictions > 0)) {
    lines.push('## User\'s Prediction Track Record');
    for (const summary of calibration) {
      if (summary.resolvedPredictions === 0) continue;
      const accuracy =
        summary.accuracy !== null ? `${(summary.accuracy * 100).toFixed(0)}%` : 'N/A';
      const brier = summary.avgBrier !== null ? summary.avgBrier.toFixed(3) : 'N/A';
      lines.push(
        `- ${summary.domain ?? 'general'}: ${accuracy} accuracy, Brier ${brier} (${summary.resolvedPredictions} resolved)`
      );
    }
    lines.push('');
  }

  // Recent predictions
  const recentPredictions = listPredictions({ limit: 5 });
  if (recentPredictions.length > 0) {
    lines.push('## Recent Predictions');
    for (const pred of recentPredictions) {
      const status = pred.outcome
        ? pred.predictedOutcome === pred.outcome
          ? 'correct'
          : 'wrong'
        : 'pending';
      const prob = pred.predictedProbability
        ? `${(pred.predictedProbability * 100).toFixed(0)}%`
        : '?';
      lines.push(`- "${pred.marketTitle.slice(0, 60)}..." → ${pred.predictedOutcome} @ ${prob} (${status})`);
    }
    lines.push('');
  }

  // Watchlist
  const watchlist = listWatchlist(5);
  if (watchlist.length > 0) {
    lines.push('## Watchlist');
    lines.push(`User is watching ${watchlist.length} market(s)`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build context from recent intel/news
 */
function buildIntelContext(): string {
  const intel = listRecentIntel(10);
  if (intel.length === 0) {
    return '';
  }

  const lines: string[] = ['## Recent News/Intel'];
  for (const item of intel) {
    const date = item.timestamp ? new Date(item.timestamp).toLocaleDateString() : '';
    lines.push(`- [${date}] ${item.title} (${item.source})`);
  }
  lines.push('');
  return lines.join('\n');
}

async function buildSemanticIntelContext(message: string, config: BijazConfig): Promise<string> {
  if (!config.intel?.embeddings?.enabled) {
    return '';
  }

  const vectorStore = new IntelVectorStore(config);
  const hits = await vectorStore.query(message, 5);
  if (hits.length === 0) {
    return '';
  }

  const items = listIntelByIds(hits.map((hit) => hit.id));
  if (items.length === 0) {
    return '';
  }

  const lines: string[] = ['## Relevant Intel (semantic search)'];
  for (const item of items) {
    const date = item.timestamp ? new Date(item.timestamp).toLocaleDateString() : '';
    lines.push(`- [${date}] ${item.title} (${item.source})`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Format markets for display in conversation
 */
function formatMarketsForChat(markets: Market[]): string {
  if (markets.length === 0) {
    return 'No relevant markets found.';
  }

  const lines: string[] = [];
  for (const market of markets) {
    const yesPrice =
      market.prices['Yes'] ?? market.prices['YES'] ?? market.prices[0] ?? '?';
    const noPrice =
      market.prices['No'] ?? market.prices['NO'] ?? market.prices[1] ?? '?';

    const yesPct = typeof yesPrice === 'number' ? `${(yesPrice * 100).toFixed(0)}%` : yesPrice;
    const noPct = typeof noPrice === 'number' ? `${(noPrice * 100).toFixed(0)}%` : noPrice;

    lines.push(`**${market.question}**`);
    lines.push(`  YES: ${yesPct} | NO: ${noPct}`);
    if (market.volume) {
      lines.push(`  Volume: $${market.volume.toLocaleString()}`);
    }
    lines.push(`  ID: \`${market.id}\``);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Detect if the user's message is asking about markets or events that we should search for
 */
function extractSearchTopics(message: string): string[] {
  const topics: string[] = [];

  // Common patterns that suggest market search
  const patterns = [
    /what (?:do you think|are the odds|is the probability|are the chances).*?(?:of|that|about) (.+?)(?:\?|$)/i,
    /will (.+?)(?:\?|$)/i,
    /is (.+?) going to/i,
    /(?:markets?|predictions?) (?:for|about|on) (.+?)(?:\?|$)/i,
    /(?:any|find) markets? (?:for|about|on) (.+?)(?:\?|$)/i,
    /what(?:'s| is) (?:the market|polymarket) (?:saying|think)/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match && match[1]) {
      // Clean up the extracted topic
      let topic = match[1].trim();
      // Remove common filler words at the end
      topic = topic.replace(/\s+(happen|occur|win|lose|pass|fail)\s*$/i, '');
      if (topic.length > 3 && topic.length < 100) {
        topics.push(topic);
      }
    }
  }

  // Also extract quoted topics
  const quotedMatches = message.match(/"([^"]+)"/g);
  if (quotedMatches) {
    for (const quoted of quotedMatches) {
      topics.push(quoted.replace(/"/g, ''));
    }
  }

  return [...new Set(topics)]; // Dedupe
}

/**
 * Main conversation handler
 */
export class ConversationHandler {
  private llm: LlmClient;
  private infoLlm?: LlmClient;
  private marketClient: PolymarketMarketClient;
  private config: BijazConfig;
  private sessions: SessionStore;
  private chatVectorStore: ChatVectorStore;

  constructor(
    llm: LlmClient,
    marketClient: PolymarketMarketClient,
    config: BijazConfig,
    infoLlm?: LlmClient
  ) {
    this.llm = llm;
    this.infoLlm = infoLlm;
    this.marketClient = marketClient;
    this.config = config;
    this.sessions = new SessionStore(config);
    this.chatVectorStore = new ChatVectorStore(config);
  }

  /**
   * Handle a conversational message from the user
   */
  async chat(userId: string, message: string): Promise<string> {
    const alertResponse = await this.handleIntelAlertSetup(userId, message);
    if (alertResponse) {
      return alertResponse;
    }

    const summary = this.sessions.getSummary(userId);
    const maxHistory = this.config.memory?.maxHistoryMessages ?? 50;
    const compactAfterTokens = this.config.memory?.compactAfterTokens ?? 12000;
    const keepRecent = this.config.memory?.keepRecentMessages ?? 12;

    await this.sessions.compactIfNeeded({
      userId,
      llm: this.llm,
      maxMessages: maxHistory,
      compactAfterTokens,
      keepRecent,
    });

    const history = this.sessions.buildContextMessages(userId, maxHistory);

    // Build context
    const userContext = buildUserContext(userId, this.config);
    const intelContext = buildIntelContext();
    const semanticIntelContext = await buildSemanticIntelContext(message, this.config);
    const semanticChatContext = await this.buildSemanticChatContext(message, userId);

    // Check if we should search for markets
    const searchTopics = extractSearchTopics(message);
    let marketContext = '';

    if (searchTopics.length > 0) {
      const allMarkets: Market[] = [];
      for (const topic of searchTopics.slice(0, 2)) {
        // Limit to 2 searches
        try {
          const markets = await this.marketClient.searchMarkets(topic, 5);
          allMarkets.push(...markets);
        } catch {
          // Ignore search failures
        }
      }

      // Dedupe by ID
      const uniqueMarkets = Array.from(
        new Map(allMarkets.map((m) => [m.id, m])).values()
      ).slice(0, 5);

      if (uniqueMarkets.length > 0) {
        marketContext = `\n## Relevant Prediction Markets\n${formatMarketsForChat(uniqueMarkets)}`;
      }
    }

    // Build the full context for this turn
    const contextBlock = [
      userContext,
      summary ? `## Conversation Summary\n${summary}` : '',
      intelContext,
      semanticIntelContext,
      semanticChatContext,
      marketContext,
    ]
      .filter(Boolean)
      .join('\n');

    const systemMessage = await this.buildPlannerSystemMessage({
      contextBlock,
      userMessage: message,
    });

    // Build messages array
    const messages: ChatMessage[] = [
      { role: 'system', content: systemMessage },
      ...history,
      { role: 'user', content: message },
    ];

    // Call LLM
    const response = await this.llm.complete(messages, { temperature: 0.7 });

    const userEntry: ChatMessage = { role: 'user', content: message };
    const assistantEntry: ChatMessage = { role: 'assistant', content: response.content };

    this.sessions.appendEntry(userId, {
      type: 'message',
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    });
    this.sessions.appendEntry(userId, {
      type: 'message',
      role: 'assistant',
      content: response.content,
      timestamp: new Date().toISOString(),
    });

    const sessionId = this.sessions.getSessionId(userId);
    const userMessageId = storeChatMessage({
      sessionId,
      role: 'user',
      content: message,
    });
    const assistantMessageId = storeChatMessage({
      sessionId,
      role: 'assistant',
      content: response.content,
    });

    await this.chatVectorStore.add({
      id: userMessageId,
      text: userEntry.content,
    });
    await this.chatVectorStore.add({
      id: assistantMessageId,
      text: assistantEntry.content,
    });

    let reply = response.content;
    const prompt = this.maybePromptIntelAlerts(userId);
    if (prompt) {
      reply = `${reply}\n\n${prompt}`;
    }

    return reply;
  }

  /**
   * Clear conversation history for a user
   */
  clearHistory(userId: string): void {
    const sessionId = this.sessions.getSessionId(userId);
    this.sessions.clearSession(userId);
    clearChatMessages(sessionId);
  }

  private async buildSemanticChatContext(message: string, _userId: string): Promise<string> {
    if (!this.config.memory?.embeddings?.enabled) {
      return '';
    }
    const hits = await this.chatVectorStore.query(message, 5);
    if (hits.length === 0) {
      return '';
    }
    const items = listChatMessagesByIds(hits.map((hit) => hit.id));
    if (items.length === 0) {
      return '';
    }
    const lines: string[] = ['## Relevant Past Conversation'];
    for (const item of items) {
      lines.push(`- ${item.role}: ${item.content.slice(0, 200)}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private async buildPlannerSystemMessage(params: {
    contextBlock: string;
    userMessage: string;
  }): Promise<string> {
    const { contextBlock, userMessage } = params;
    if (!contextBlock) {
      return SYSTEM_PROMPT;
    }

    if (!this.infoLlm || contextBlock.length < 600) {
      return SYSTEM_PROMPT + `\n\n---\n\n${contextBlock}`;
    }

    const prompt = `Summarize the context into a compact brief for the planner.
Include: user preferences, recent decisions/positions, key intel, and relevant markets.
Do not speculate or add new information. Max 120 words.

User message: ${userMessage}

Context:
${contextBlock}`.trim();

    try {
      const response = await this.infoLlm.complete(
        [
          { role: 'system', content: 'You are a concise information gatherer.' },
          { role: 'user', content: prompt },
        ],
        { temperature: 0.1 }
      );
      const digest = response.content.trim();
      if (!digest) {
        return SYSTEM_PROMPT + `\n\n---\n\n${contextBlock}`;
      }
      return SYSTEM_PROMPT + `\n\n---\n\n## Info Digest\n${digest}`;
    } catch {
      return SYSTEM_PROMPT + `\n\n---\n\n${contextBlock}`;
    }
  }

  private maybePromptIntelAlerts(userId: string): string | null {
    const preferences = getUserContext(userId)?.preferences ?? {};
    const alreadyConfigured =
      (preferences as Record<string, unknown>).intelAlertsConfigured === true;
    const prompted =
      (preferences as Record<string, unknown>).intelAlertsPrompted === true;
    const enabled = this.config.notifications?.intelAlerts?.enabled ?? false;

    if (enabled || alreadyConfigured || prompted) {
      return null;
    }

    updateUserContext(userId, {
      preferences: {
        intelAlertsPrompted: true,
        intelAlertsPending: 'confirm',
      },
    });

    return 'Would you like to set up intel alerts? Reply "yes" or "no".';
  }

  private async handleIntelAlertSetup(
    userId: string,
    message: string
  ): Promise<string | null> {
    const preferences = getUserContext(userId)?.preferences ?? {};
    const pending = (preferences as Record<string, unknown>).intelAlertsPending as
      | 'confirm'
      | 'watchlist'
      | 'keywords'
      | 'sentiment'
      | 'sources'
      | undefined;

    if (!pending) {
      return null;
    }

    const normalized = message.trim().toLowerCase();
    const isYes = ['yes', 'y', 'sure', 'ok', 'okay'].includes(normalized);
    const isNo = ['no', 'n', 'nope', 'nah'].includes(normalized);

    if (pending === 'confirm') {
      if (isNo) {
        updateUserContext(userId, {
          preferences: {
            intelAlertsPending: undefined,
            intelAlertsConfigured: false,
          },
        });
        return 'No problem. You can enable intel alerts anytime by saying "set alerts".';
      }
      if (isYes) {
        updateUserContext(userId, {
          preferences: {
            intelAlertsPending: 'watchlist',
          },
        });
        return 'Great. Should alerts be watchlist-only? Reply "yes" or "no".';
      }
      return 'Please reply "yes" or "no" if you want to set up intel alerts.';
    }

    if (pending === 'watchlist') {
      if (!isYes && !isNo) {
        return 'Please reply "yes" or "no". Should alerts be watchlist-only?';
      }
      updateUserContext(userId, {
        preferences: {
          intelAlertsPending: 'keywords',
          intelAlertsDraft: {
            watchlistOnly: isYes,
          },
        },
      });
      return 'Any keywords to include? Reply with a comma-separated list or "none".';
    }

    if (pending === 'keywords') {
      const keywords = normalized === 'none'
        ? []
        : message
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);

      updateUserContext(userId, {
        preferences: {
          intelAlertsPending: 'sentiment',
          intelAlertsDraft: {
            ...(preferences as Record<string, any>).intelAlertsDraft,
            includeKeywords: keywords,
          },
        },
      });
      return 'Do you want alerts for positive, negative, neutral, or any sentiment? Reply with one of: positive | negative | neutral | any.';
    }

    if (pending === 'sentiment') {
      const preset = normalized;
      const allowed = ['positive', 'negative', 'neutral', 'any'];
      if (!allowed.includes(preset)) {
        return 'Please reply with one of: positive | negative | neutral | any.';
      }
      updateUserContext(userId, {
        preferences: {
          intelAlertsPending: 'sources',
          intelAlertsDraft: {
            ...(preferences as Record<string, any>).intelAlertsDraft,
            sentimentPreset: preset,
          },
        },
      });
      return 'Any sources to include? Reply with comma-separated names (e.g., NewsAPI, Google News, Twitter/X) or "none".';
    }

    if (pending === 'sources') {
      const sources = normalized === 'none'
        ? []
        : message
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);

      const draft = (preferences as Record<string, any>).intelAlertsDraft ?? {};
      const updated = {
        watchlistOnly: draft.watchlistOnly ?? true,
        includeKeywords: draft.includeKeywords ?? [],
        includeSources: sources,
        sentimentPreset: draft.sentimentPreset ?? 'any',
      };

      const saved = this.applyIntelAlertConfig(updated);
      updateUserContext(userId, {
        preferences: {
          intelAlertsPending: undefined,
          intelAlertsConfigured: saved,
          intelAlertsDraft: undefined,
        },
      });

      if (!saved) {
        return 'I could not update the config file. Please edit your config to enable intel alerts.';
      }

      return 'Intel alerts enabled. I will notify you when relevant news appears.';
    }

    return null;
  }

  private applyIntelAlertConfig(settings: {
    watchlistOnly: boolean;
    includeKeywords: string[];
    includeSources: string[];
    sentimentPreset: 'any' | 'positive' | 'negative' | 'neutral';
  }): boolean {
    try {
      const path =
        process.env.BIJAZ_CONFIG_PATH ?? join(homedir(), '.bijaz', 'config.yaml');
      if (!existsSync(path)) {
        return false;
      }
      const raw = readFileSync(path, 'utf-8');
      const parsed = (yaml.parse(raw) ?? {}) as Record<string, unknown>;

      const notifications = (parsed.notifications ?? {}) as Record<string, any>;
      const intelFetch = notifications.intelFetch ?? {};
      const intelAlerts = notifications.intelAlerts ?? {};

      intelFetch.enabled = true;
      intelAlerts.enabled = true;
      intelAlerts.watchlistOnly = settings.watchlistOnly;
      intelAlerts.includeKeywords = settings.includeKeywords;
      intelAlerts.includeSources = settings.includeSources;
      intelAlerts.sentimentPreset = settings.sentimentPreset;
      intelAlerts.maxItems = intelAlerts.maxItems ?? 10;
      intelAlerts.minKeywordOverlap = intelAlerts.minKeywordOverlap ?? 1;
      intelAlerts.minTitleLength = intelAlerts.minTitleLength ?? 8;

      notifications.intelFetch = intelFetch;
      notifications.intelAlerts = intelAlerts;
      parsed.notifications = notifications;

      writeFileSync(path, yaml.stringify(parsed));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get a specific market analysis
   */
  async analyzeMarket(userId: string, marketId: string): Promise<string> {
    try {
      const market = await this.marketClient.getMarket(marketId);
      const userContext = buildUserContext(userId, this.config);
      const intelContext = buildIntelContext();
      const summary = this.sessions.getSummary(userId);
      const semanticChatContext = await this.buildSemanticChatContext(
        market.question ?? marketId,
        userId
      );
      const tools = new ToolRegistry();
      const plan = await createResearchPlan({
        llm: this.llm,
        subject: market.question ?? marketId,
      });
      const research = await runResearchPlan({
        config: this.config,
        marketClient: this.marketClient,
        subject: {
          id: market.id,
          question: market.question ?? marketId,
          category: market.category,
        },
        plan,
        tools,
      });

      const prompt = `Please analyze this prediction market and give me your probability estimate with reasoning:

**${market.question}**
- Outcomes: ${market.outcomes.join(', ')}
- Current prices: YES ${((market.prices['Yes'] ?? market.prices['YES'] ?? market.prices[0] ?? 0) * 100).toFixed(0)}% / NO ${((market.prices['No'] ?? market.prices['NO'] ?? market.prices[1] ?? 0) * 100).toFixed(0)}%
- Volume: $${(market.volume ?? 0).toLocaleString()}
- Category: ${market.category ?? 'unknown'}

Give me:
1. Your probability estimate (be specific, e.g., "65%")
2. Key factors driving your estimate
3. What would change your mind
4. Whether you see edge vs. the market price`;

      const contextBlock = [
        userContext,
        summary ? `## Conversation Summary\n${summary}` : '',
        semanticChatContext,
        intelContext,
        research.context,
      ]
        .filter(Boolean)
        .join('\n');
      const systemMessage = await this.buildPlannerSystemMessage({
        contextBlock,
        userMessage: market.question ?? marketId,
      });

      const response = await this.llm.complete(
        [
          { role: 'system', content: systemMessage },
          { role: 'user', content: prompt },
        ],
        { temperature: 0.5 }
      );

      return response.content;
    } catch (error) {
      return `Failed to analyze market: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  /**
   * Structured market analysis for UI consumption.
   */
  async analyzeMarketStructured(
    userId: string,
    marketId: string
  ): Promise<{
    marketId: string;
    question: string;
    plan: { steps: Array<{ action: string; query?: string }> };
    analysis: Record<string, unknown>;
    context: string;
  }> {
    const market = await this.marketClient.getMarket(marketId);
    const summary = this.sessions.getSummary(userId);
    const userContext = buildUserContext(userId, this.config);
    const intelContext = buildIntelContext();
    const semanticChatContext = await this.buildSemanticChatContext(
      market.question ?? marketId,
      userId
    );
    const tools = new ToolRegistry();
    const plan = await createResearchPlan({
      llm: this.llm,
      subject: market.question ?? marketId,
    });
    const research = await runResearchPlan({
      config: this.config,
      marketClient: this.marketClient,
      subject: {
        id: market.id,
        question: market.question ?? marketId,
        category: market.category,
      },
      plan,
      tools,
    });

    const prompt = `Return JSON only with fields:
{
  "probability": number,          // 0-1
  "summary": string,              // 1-2 sentences
  "keyFactors": string[],
  "mindChange": string[],
  "edge": string,                 // e.g., "market 42% vs estimate 55%"
  "confidence": "low"|"medium"|"high"
}

Market:
${market.question}
Outcomes: ${market.outcomes.join(', ')}
Prices: YES ${((market.prices['Yes'] ?? market.prices['YES'] ?? market.prices[0] ?? 0) * 100).toFixed(0)}% / NO ${((market.prices['No'] ?? market.prices['NO'] ?? market.prices[1] ?? 0) * 100).toFixed(0)}%
Volume: $${(market.volume ?? 0).toLocaleString()}
Category: ${market.category ?? 'unknown'}
`;

    const contextBlock = [
      userContext,
      summary ? `## Conversation Summary\n${summary}` : '',
      semanticChatContext,
      intelContext,
      research.context,
    ]
      .filter(Boolean)
      .join('\n');
    const systemMessage = await this.buildPlannerSystemMessage({
      contextBlock,
      userMessage: market.question ?? marketId,
    });

    const response = await this.llm.complete(
      [
        { role: 'system', content: systemMessage },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.3 }
    );

    const analysis = safeParseJson(response.content) ?? {
      summary: response.content.trim(),
    };

    return {
      marketId: market.id,
      question: market.question ?? marketId,
      plan: research.plan,
      analysis,
      context: research.context,
    };
  }

  /**
   * Ask about a topic and find relevant markets
   */
  async askAbout(userId: string, topic: string): Promise<string> {
    // Search for markets
    let markets: Market[] = [];
    try {
      markets = await this.marketClient.searchMarkets(topic, 5);
    } catch {
      // Continue without markets
    }

    const userContext = buildUserContext(userId, this.config);
    const summary = this.sessions.getSummary(userId);
    const semanticChatContext = await this.buildSemanticChatContext(topic, userId);
    const tools = new ToolRegistry();
    const plan = await createResearchPlan({
      llm: this.llm,
      subject: topic,
    });
    const research = await runResearchPlan({
      config: this.config,
      marketClient: this.marketClient,
      subject: {
        question: topic,
      },
      plan,
      tools,
    });
    const marketContext =
      markets.length > 0
        ? `\n## Relevant Prediction Markets\n${formatMarketsForChat(markets)}`
        : '\n(No prediction markets found for this topic)';

    const prompt = `The user wants to know about: "${topic}"

Please:
1. Share your analysis and probability estimates for outcomes related to this topic
2. Reference the prediction markets shown below if relevant
3. Explain your reasoning and key uncertainties
4. Suggest what information would help refine the estimate

${marketContext}`;

    const systemContext = [
      userContext,
      summary ? `## Conversation Summary\n${summary}` : '',
      semanticChatContext,
      research.context,
    ]
      .filter(Boolean)
      .join('\n');

    const systemMessage = await this.buildPlannerSystemMessage({
      contextBlock: systemContext,
      userMessage: topic,
    });

    const response = await this.llm.complete(
      [
        { role: 'system', content: systemMessage },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.6 }
    );

    return response.content;
  }
}

function safeParseJson(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}
