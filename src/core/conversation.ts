/**
 * Conversational Chat Handler
 *
 * Enables free-form conversation with Thufir about perp markets,
 * macro/crypto conditions, and market analysis.
 */

import type { LlmClient, ChatMessage } from './llm.js';
import type { ThufirConfig } from './config.js';
import type { Market } from '../execution/markets.js';
import type { MarketClient } from '../execution/market-client.js';
import { listCalibrationSummaries } from '../memory/calibration.js';
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
import {
  AgenticAnthropicClient,
  AgenticOpenAiClient,
  FallbackLlmClient,
  OrchestratorClient,
  createAgenticExecutorClient,
  isRateLimitError,
  wrapWithLimiter,
  shouldUseExecutorModel,
  wrapWithInfra,
} from './llm.js';
import { loadIdentityPrelude } from '../agent/identity/identity.js';
import { runOrchestrator } from '../agent/orchestrator/orchestrator.js';
import { AgentToolRegistry } from '../agent/tools/registry.js';
import { registerAllTools } from '../agent/tools/adapters/index.js';
import { loadThufirIdentity } from '../agent/identity/identity.js';
import type { AgentIdentity } from '../agent/identity/types.js';
import type { CriticResult } from '../agent/critic/types.js';
import type { ToolExecution } from '../agent/tools/types.js';
import type { AgentPlan } from '../agent/planning/types.js';
import type { ToolExecutorContext } from './tool-executor.js';
import { executeToolCall } from './tool-executor.js';
import { Logger } from './logger.js';
import { withExecutionContext } from './llm_infra.js';
import {
  appendProactiveAttribution,
  buildFailClosedMessage,
  runProactiveRefresh,
  type CachedProactiveSnapshot,
  type ProactiveRefreshSettings,
  type ProactiveRefreshSnapshot,
} from './proactive_refresh.js';
import { classifyMarketContextDomain, gatherMarketContext } from '../markets/context.js';

export interface ConversationContext {
  userId: string;
  conversationHistory: ChatMessage[];
}

export interface ConversationChatOptions {
  mode?: 'default' | 'heartbeat';
  timeoutMs?: number;
  storeHistory?: boolean;
}

// Base system prompt is minimal - identity comes from workspace files
const SYSTEM_PROMPT_BASE = `## Operating Rules

- Never claim a trade was placed unless a trading tool returned success
- Never say you lack wallet/trade access without first using get_portfolio/get_positions/get_open_orders
- When interpreting get_portfolio: balances/onchain_balances are on-chain wallet or paper/memory cash, NOT Hyperliquid collateral. For Hyperliquid, use summary.available_balance as the collateral you can trade with — it already accounts for unified/separate account modes. Do NOT refuse to trade because perp withdrawable is 0 if available_balance shows funds.
- If you need perp prices or liquidity, prefer exchange-native tools first: use perp_market_get for exact symbol pricing and perp_market_list for universe context (do not ask the user to paste exports)
- On Hyperliquid, spot USDC and perp collateral are typically unified. Place orders directly using available_balance as your collateral figure — the exchange validates collateral at order time. Only use hyperliquid_usd_class_transfer if orders are explicitly rejected for insufficient collateral.
- Provide probability estimates when asked about directional outcomes
- Reference relevant perp markets or instruments when discussing events
- If tool outputs are JSON, interpret them and respond with a concise narrative summary
- Be conversational, not robotic - use markdown when helpful
- Generic encouragement to trade ("go trade", "learn and iterate", "make money", "you pick", "trade when ready") is NOT a trade order. Acknowledge it and let the autonomous scan pipeline handle entry decisions. Only place a trade through chat when the user gives a concrete instruction (specific symbol, direction, and size) or uses \`/trade confirm\`. Never place a trade just because the user expressed enthusiasm or gave permission.
- Before stating any directional view (price target, bias, likely outcome), you MUST cite the specific tool call made in this response that supports it — prior context or memory does not count
- When a tool call returns an error, surface it explicitly before continuing: state the tool name, the full error message, and what you will do next
- When proposing any trade in conversation, always include all four: stop level price, position size ($), % of current equity at risk on stop, and target R:R — call get_portfolio for current equity if not already in context`;


const THUFIR_QUOTES = [
  "I don't speak... I operate a machine called language.",
  "I'm weak of muscle, but strong of mouth; cheap to feed, but costly to fill.",
  "There's but a thin line between many an enemy and many a friend.",
  "I know when we should leave. There's a time for endings.",
  "I'm the well-trained fruit tree, all grafted for another to pick.",
  "Forgetting is not having till the words are right.",
  "Bygones, bygones. Let bygones fall where they may.",
  "I have heard there is nothing firm, nothing balanced, nothing durable.",
];

const PERSONALITY_MODES: Record<string, { label: string; instruction: string }> = {
  thufir: {
    label: 'Thufir (Dune oracle)',
    instruction:
      'Adopt a Dune-inspired oracle voice: concise, calm, prescient, and cryptic. Use occasional riddling phrasing or light rhyme, but keep the answer clear and actionable. Sound incisive and worldly, with measured certainty. Avoid slang and avoid roleplay. Ground claims in evidence. You may use at most one short quote per reply, and only if it fits.',
  },
};

function isSkippedToolExecution(execution: ToolExecution): boolean {
  if (!execution.result.success) return false;
  const data = (execution.result as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return false;
  return (data as { skipped?: unknown }).skipped === true;
}

function hasVerifiedHeartbeatAction(toolExecutions: ToolExecution[]): boolean {
  const mutatingTools = new Set([
    'perp_place_order',
    'perp_cancel_order',
    'hyperliquid_usd_class_transfer',
    'cctp_bridge_usdc',
    'hyperliquid_deposit_usdc',
  ]);
  return toolExecutions.some((execution) => {
    if (!mutatingTools.has(execution.toolName)) return false;
    if (isSkippedToolExecution(execution)) return false;
    if (!execution.result.success) return false;
    if (execution.toolName !== 'perp_place_order') return true;
    const message = (
      execution.result as { data?: { message?: unknown } }
    )?.data?.message;
    const normalized = typeof message === 'string' ? message.toLowerCase() : '';
    return /oid=|order\s+(filled|resting|placed)/.test(normalized);
  });
}

function normalizeHeartbeatResponse(response: string, toolExecutions: ToolExecution[]): string {
  const text = response.trim();
  const hasVerifiedAction = hasVerifiedHeartbeatAction(toolExecutions);
  if (hasVerifiedAction) {
    if (text.toUpperCase().startsWith('HEARTBEAT_ACTION:')) return response;
    return `HEARTBEAT_ACTION: ${text}`;
  }
  return 'HEARTBEAT_OK';
}

/**
 * Build context about the user and their trading preferences
 */
function buildUserContext(userId: string, _config: ThufirConfig): string {
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
    const probMode = profile.preferences?.probability_mode;
    if (typeof probMode === 'string' && probMode) {
      lines.push(`Probability mode: ${probMode}`);
    }
    lines.push('');
  }

  const preferencePersonality = profile?.preferences?.personality;
  if (typeof preferencePersonality === 'string') {
    const mode = PERSONALITY_MODES[preferencePersonality];
    if (mode) {
      lines.push('## Personality Preference');
      lines.push(`Mode: ${mode.label}`);
      lines.push('');
    }
  }

  // Calibration data
  const calibration = listCalibrationSummaries();
  if (calibration.length > 0 && calibration.some((c) => c.resolvedPredictions > 0)) {
    lines.push('## User Track Record');
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

async function buildSemanticIntelContext(message: string, config: ThufirConfig): Promise<string> {
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

// Tool calling now handles market lookup; no regex extraction needed.

/**
 * Main conversation handler
 */
export class ConversationHandler {
  private llm: LlmClient;
  private infoLlm?: LlmClient;
  private agenticLlm?: LlmClient;
  private agenticOpenAi?: LlmClient;
  private marketClient: MarketClient;
  private config: ThufirConfig;
  private sessions: SessionStore;
  private chatVectorStore: ChatVectorStore;
  private logger?: Logger;
  private toolContext: ToolExecutorContext;
  private orchestratorRegistry?: AgentToolRegistry;
  private orchestratorIdentity?: AgentIdentity;
  private liveAccountSnapshotCache = new Map<string, { ts: number; text: string }>();
  private proactiveSnapshotCache = new Map<string, CachedProactiveSnapshot>();
  private proactiveFailureCache = new Map<string, number>(); // userId → last failure ts

  constructor(
    llm: LlmClient,
    marketClient: MarketClient,
    config: ThufirConfig,
    infoLlm?: LlmClient,
    toolContext?: ToolExecutorContext,
    logger?: Logger
  ) {
    this.llm = llm;
    this.infoLlm = infoLlm;
    this.marketClient = marketClient;
    this.config = config;
    this.sessions = new SessionStore(config);
    this.chatVectorStore = new ChatVectorStore(config);
    this.logger = logger;
    const context = toolContext ?? { config, marketClient };
    this.toolContext = context;
    const provider = config.agent?.provider ?? 'anthropic';
    const hasAgentModel = Boolean(config.agent?.model);
    if (provider === 'anthropic' && hasAgentModel) {
      const primary = new AgenticAnthropicClient(config, context);
      const fallbackModel = config.agent?.fallbackModel;
      const fallback = new AgenticAnthropicClient(config, context, fallbackModel);
      this.agenticLlm = wrapWithLimiter(
        new FallbackLlmClient(
          wrapWithInfra(primary, config),
          wrapWithInfra(fallback, config),
          isRateLimitError,
          config
        )
      );
    }
    if (provider === 'openai' && hasAgentModel) {
      this.agenticLlm = wrapWithLimiter(
        wrapWithInfra(new AgenticOpenAiClient(config, context), config)
      );
    }
    if (config.agent?.model) {
      this.agenticOpenAi = provider === 'anthropic'
        ? wrapWithLimiter(wrapWithInfra(new AgenticAnthropicClient(config, context, config.agent?.fallbackModel), config))
        : wrapWithLimiter(wrapWithInfra(new AgenticOpenAiClient(config, context), config));
    }
    if (shouldUseExecutorModel(config)) {
      const executor = createAgenticExecutorClient(config, context, undefined, 'chat');
      const fallback = this.agenticLlm ?? this.agenticOpenAi;
      this.agenticLlm = new OrchestratorClient(this.llm, executor, fallback, this.logger);
    }

    if (config.agent?.useOrchestrator) {
      const registry = new AgentToolRegistry();
      registerAllTools(registry);
      this.orchestratorRegistry = registry;
      this.orchestratorIdentity = loadThufirIdentity({
        workspacePath: config.agent?.workspace,
      }).identity;
    }
  }

  private async getMemoryContextForOrchestrator(userId: string, message: string): Promise<string | null> {
    const summary = this.sessions.getSummary(userId);
    const semanticChatContext = await this.buildSemanticChatContext(message, userId);
    const sections = [
      summary ? `## Conversation Summary\n${summary}` : '',
      semanticChatContext,
    ].filter(Boolean);
    return sections.length > 0 ? sections.join('\n') : null;
  }

  /**
   * Handle a conversational message from the user
   */
  async chat(
    userId: string,
    message: string,
    onProgress?: (message: string) => Promise<void> | void,
    options?: ConversationChatOptions
  ): Promise<string> {
    const chatMode = options?.mode ?? 'default';
    const isHeartbeatMode = chatMode === 'heartbeat';
    const shouldStoreHistory = options?.storeHistory ?? !isHeartbeatMode;
    return withExecutionContext(
      {
        mode: isHeartbeatMode ? 'LIGHT_REASONING' : 'FULL_AGENT',
        critical: false,
        reason: isHeartbeatMode ? 'heartbeat' : 'chat',
        source: 'conversation',
      },
      async () => {
        if (!isHeartbeatMode) {
          const alertResponse = await this.handleIntelAlertSetup(userId, message);
          if (alertResponse) {
            return alertResponse;
          }
        }

        const timeContext = await this.buildCurrentTimeContext();
        const liveAccountSnapshot = await this.buildLiveAccountSnapshot(userId);
        const proactive = await this.prepareProactiveRefresh(userId, message);
        if (proactive.failClosed) {
          return buildFailClosedMessage(proactive.failReason ?? 'fresh data unavailable');
        }
        const proactiveContext = proactive.contextText;
        const proactiveSnapshot = proactive.snapshot;

        if (this.config.agent?.useOrchestrator && this.orchestratorRegistry && this.orchestratorIdentity) {
          const manualTradeOverridePrefix = /^\s*\/trade\s+confirm\b[:\s-]*/i;
          const manualTradeOverride = manualTradeOverridePrefix.exec(message);
          const orchestratorMessage = manualTradeOverride
            ? message.slice(manualTradeOverride[0].length).trim()
            : message;
          const autoApproveTrades = Boolean(this.config.autonomy?.fullAuto);
          const isManualTradeOverride = Boolean(manualTradeOverride && orchestratorMessage.length > 0);
          const executionOrigin =
            isManualTradeOverride
              ? 'manual_override'
              : userId === '__heartbeat__'
                ? 'autonomous'
                : 'chat';
          const allowTradeMutations = Boolean(autoApproveTrades || isManualTradeOverride);
          if (manualTradeOverride && orchestratorMessage.length === 0) {
            return 'Manual override requires a concrete instruction after `/trade confirm`, e.g. `/trade confirm buy BTC 0.001 market`.';
          }

          const memorySystem = {
            getRelevantContext: async (query: string) => {
              const base = await this.getMemoryContextForOrchestrator(userId, query);
              return [base, timeContext, liveAccountSnapshot, proactiveContext].filter(Boolean).join('\n\n');
            },
          };

    const tradeToolNames = new Set([
      'perp_place_order',
      'perp_cancel_order',
      'hyperliquid_usd_class_transfer',
    ]);
    const fundingToolNames = new Set([
      'cctp_bridge_usdc',
      'hyperliquid_deposit_usdc',
      'hyperliquid_order_roundtrip',
      'playbook_upsert',
    ]);
          const autoApproveFunding = Boolean(
            this.config.autonomy?.fullAuto && this.config.autonomy?.allowFundingActions
          );
          const resumePlan = this.shouldResumePlan(orchestratorMessage);
          const priorPlan = resumePlan ? this.sessions.getPlan(userId) : null;

          let lastProgressKey = '';
          let planningStarted = false;
          let planningReady = false;
          let synthesisStarted = false;
          const emitProgress = async (key: string, text: string): Promise<void> => {
            if (!onProgress || !text || key === lastProgressKey) {
              return;
            }
            lastProgressKey = key;
            try {
              await onProgress(text);
            } catch {
              // Best-effort progress updates must not affect the main flow.
            }
          };

          let lastToolCount = 0;
          const result = await runOrchestrator(orchestratorMessage, {
            llm: this.llm,
            toolRegistry: this.orchestratorRegistry,
            identity: this.orchestratorIdentity,
            toolContext: {
              ...(this.toolContext as any),
              agentToolRegistry: this.orchestratorRegistry,
            },
            memorySystem,
            onConfirmation: async (_prompt, toolName, input) => {
              if (tradeToolNames.has(toolName)) {
                if (
                  executionOrigin === 'autonomous' &&
                  toolName === 'perp_place_order' &&
                  input &&
                  typeof input === 'object' &&
                  (input as Record<string, unknown>).reduce_only === true
                ) {
                  return true;
                }
                if (executionOrigin === 'autonomous' && toolName === 'perp_cancel_order') {
                  return true;
                }
                return allowTradeMutations;
              }
              if (fundingToolNames.has(toolName)) {
                return autoApproveFunding;
              }
              return false;
            },
            onUpdate: (state) => {
              if (!state.plan) {
                if (!planningStarted) {
                  planningStarted = true;
                  void emitProgress('planning:start', 'Working: analyzing request...');
                }
                return;
              }
              if (!state.plan.complete) {
                if (!planningReady) {
                  planningReady = true;
                  void emitProgress('planning:ready', 'Working: building execution plan...');
                }
              }
              if (state.toolExecutions.length > lastToolCount) {
                const latest = state.toolExecutions[state.toolExecutions.length - 1];
                lastToolCount = state.toolExecutions.length;
                if (latest?.toolName) {
                  void emitProgress(
                    `tool:${lastToolCount}:${latest.toolName}`,
                    `Working: running ${latest.toolName}...`
                  );
                }
              }
              if (state.plan.complete) {
                if (!synthesisStarted) {
                  synthesisStarted = true;
                  void emitProgress('synthesis', 'Working: finalizing response...');
                }
              }
            },
          }, {
            initialPlan: priorPlan ?? undefined,
            resumePlan,
            executionOrigin,
            allowTradeMutations,
          });

          if (result.state.plan && !result.state.plan.complete) {
            this.sessions.setPlan(userId, result.state.plan);
          } else {
            this.sessions.clearPlan(userId);
          }

          let response = this.maybeAttachOrchestratorNotes(
            result.response,
            result.state.toolExecutions,
            result.state.criticResult,
            result.state.plan,
            result.summary.fragility
          );
          response = await this.maybeAttachMentatReport(response, result.state.mode);

          if (!response || response.trim() === '') {
            response = await this.buildCooldownSafeFallbackResponse();
          }
          if (userId === '__heartbeat__') {
            response = normalizeHeartbeatResponse(response, result.state.toolExecutions);
          }
          response = appendProactiveAttribution(response, proactiveSnapshot ?? null);

          if (shouldStoreHistory) {
            this.sessions.appendEntry(userId, {
              type: 'message',
              role: 'user',
              content: message,
              timestamp: new Date().toISOString(),
            });
            this.sessions.appendEntry(userId, {
              type: 'message',
              role: 'assistant',
              content: response,
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
              content: response,
            });

            await this.chatVectorStore.add({
              id: userMessageId,
              text: message,
            });
            await this.chatVectorStore.add({
              id: assistantMessageId,
              text: response,
            });
          }

          return response;
        }

        const toolFirstContext = proactiveContext ? '' : await this.runToolFirstGuard(message);
        const messages: ChatMessage[] = [];
        if (isHeartbeatMode) {
          const contextBlock = [
            timeContext,
            liveAccountSnapshot,
            proactiveContext,
            toolFirstContext,
          ]
            .filter(Boolean)
            .join('\n');
          const systemMessage = contextBlock
            ? `${this.getSystemPrompt(userId)}\n\n---\n\n${contextBlock}`
            : this.getSystemPrompt(userId);
          messages.push(
            { role: 'system', content: systemMessage },
            { role: 'user', content: message }
          );
        } else {
          const summary = this.sessions.getSummary(userId);
          const maxHistory = this.config.memory?.maxHistoryMessages ?? 50;
          const compactAfterTokens = this.config.memory?.compactAfterTokens ?? 12000;
          const keepRecent = this.config.memory?.keepRecentMessages ?? 12;

          await this.sessions.compactIfNeeded({
            userId,
            llm: this.infoLlm ?? this.llm,
            maxMessages: maxHistory,
            compactAfterTokens,
            keepRecent,
          });

          const history = this.sessions.buildContextMessages(userId, maxHistory);

          const userContext = buildUserContext(userId, this.config);
          const intelContext = buildIntelContext();
          const semanticIntelContext = await buildSemanticIntelContext(message, this.config);
          const semanticChatContext = await this.buildSemanticChatContext(message, userId);

          const contextBlock = [
            userContext,
            timeContext,
            liveAccountSnapshot,
            proactiveContext,
            toolFirstContext,
            summary ? `## Conversation Summary\n${summary}` : '',
            intelContext,
            semanticIntelContext,
            semanticChatContext,
          ]
            .filter(Boolean)
            .join('\n');

          const systemMessage = await this.buildPlannerSystemMessage({
            basePrompt: this.getSystemPrompt(userId),
            contextBlock,
            userMessage: message,
          });
          messages.push(
            { role: 'system', content: systemMessage },
            ...history,
            { role: 'user', content: message }
          );
        }

        const response = await this.completeWithFallback(messages, {
          temperature: isHeartbeatMode ? 0.3 : 0.7,
          timeoutMs: options?.timeoutMs,
        });

        // Don't store empty responses (prevents history corruption from failed calls)
        if (!response.content || response.content.trim() === '') {
          throw new Error('LLM returned empty response');
        }

        const userEntry: ChatMessage = { role: 'user', content: message };
        const assistantEntry: ChatMessage = { role: 'assistant', content: response.content };

        if (shouldStoreHistory) {
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
        }

        let reply = response.content;
        reply = appendProactiveAttribution(reply, proactiveSnapshot ?? null);
        if (!isHeartbeatMode) {
          const prompt = this.maybePromptIntelAlerts(userId);
          if (prompt) {
            reply = `${reply}\n\n${prompt}`;
          }
        }

        return reply;
      }
    );
  }

  private getProactiveRefreshSettings(): ProactiveRefreshSettings {
    const configured = this.config.agent?.proactiveRefresh;
    const fundingSymbols = Array.isArray(configured?.fundingSymbols)
      ? configured.fundingSymbols.filter((symbol) => typeof symbol === 'string' && symbol.trim().length > 0)
      : [];
    return {
      enabled: configured?.enabled ?? false,
      intentMode: configured?.intentMode ?? 'time_sensitive',
      ttlSeconds: Math.max(0, configured?.ttlSeconds ?? 900),
      maxLatencyMs: Math.max(250, configured?.maxLatencyMs ?? 4500),
      marketLimit: Math.min(200, Math.max(1, configured?.marketLimit ?? 20)),
      intelLimit: Math.min(20, Math.max(1, configured?.intelLimit ?? 5)),
      webLimit: Math.min(10, Math.max(1, configured?.webLimit ?? 5)),
      strictFailClosed: configured?.strictFailClosed ?? true,
      fundingSymbols:
        fundingSymbols.length > 0
          ? fundingSymbols
          : this.config.hyperliquid?.symbols?.slice(0, 2) ?? ['BTC', 'ETH'],
    };
  }

  private async prepareProactiveRefresh(
    userId: string,
    message: string
  ): Promise<{
    failClosed: boolean;
    failReason?: string;
    contextText: string;
    snapshot?: ProactiveRefreshSnapshot;
  }> {
    const settings = this.getProactiveRefreshSettings();
    const now = Date.now();
    const ttlMs = Math.max(0, settings.ttlSeconds) * 1000;

    // If we failed recently, skip the refresh rather than retrying and spamming the user.
    const lastFailure = this.proactiveFailureCache.get(userId);
    if (lastFailure !== undefined && now - lastFailure < ttlMs) {
      return { failClosed: false, contextText: '' };
    }

    const cached = this.proactiveSnapshotCache.get(userId);
    const outcome = await runProactiveRefresh({
      message,
      settings,
      cached,
      executeTool: (toolName, input) => executeToolCall(toolName, input, this.toolContext),
    });

    if (outcome.snapshot) {
      this.proactiveSnapshotCache.set(userId, { ts: now, snapshot: outcome.snapshot });
    }
    if (outcome.failClosed) {
      this.proactiveFailureCache.set(userId, now);
    }

    return {
      failClosed: outcome.failClosed,
      failReason: outcome.failReason,
      contextText: outcome.contextText,
      snapshot: outcome.snapshot,
    };
  }

  private async buildCurrentTimeContext(): Promise<string> {
    if (!this.config.agent?.alwaysIncludeTime) {
      return '';
    }
    try {
      const timeResult = await executeToolCall('current_time', {}, this.toolContext);
      if (!timeResult.success) {
        return '';
      }
      return `## Current Time\n${JSON.stringify(timeResult.data, null, 2)}`;
    } catch {
      return '';
    }
  }

  private shouldIncludeLiveAccountSnapshot(): boolean {
    // Only inject live state when we're actually configured for live Hyperliquid execution.
    return (
      this.config.execution?.mode === 'live' && this.config.execution?.provider === 'hyperliquid'
    );
  }

  private async buildLiveAccountSnapshot(userId: string): Promise<string> {
    if (!this.shouldIncludeLiveAccountSnapshot()) {
      return '';
    }

    // Cache a short-lived snapshot so natural back-and-forth stays grounded without hammering APIs.
    const ttlMs = 15_000;
    const now = Date.now();
    const cached = this.liveAccountSnapshotCache.get(userId);
    if (cached && now - cached.ts < ttlMs) {
      return cached.text;
    }

    try {
      const [portfolio, positions, orders] = await Promise.all([
        executeToolCall('get_portfolio', {}, this.toolContext),
        executeToolCall('get_positions', {}, this.toolContext),
        executeToolCall('get_open_orders', {}, this.toolContext),
      ]);

      const snapshot = {
        portfolio: portfolio.success ? portfolio.data : { error: (portfolio as any).error ?? 'unknown' },
        positions: positions.success ? positions.data : { error: (positions as any).error ?? 'unknown' },
        open_orders: orders.success ? orders.data : { error: (orders as any).error ?? 'unknown' },
      };

      const text = `## Live Account Snapshot (Hyperliquid)\n${JSON.stringify(snapshot, null, 2)}`;
      this.liveAccountSnapshotCache.set(userId, { ts: now, text });
      return text;
    } catch (error) {
      const text = `## Live Account Snapshot (Hyperliquid)\n(unavailable: ${
        error instanceof Error ? error.message : 'unknown error'
      })`;
      this.liveAccountSnapshotCache.set(userId, { ts: now, text });
      return text;
    }
  }

  private async buildCooldownSafeFallbackResponse(): Promise<string> {
    const [portfolio, positions, orders] = await Promise.all([
      executeToolCall('get_portfolio', {}, this.toolContext),
      executeToolCall('get_positions', {}, this.toolContext),
      executeToolCall('get_open_orders', {}, this.toolContext),
    ]);

    const perpPositions = (positions as any)?.success
      ? Array.isArray((positions as any)?.data?.positions)
        ? (positions as any).data.positions
        : []
      : [];
    const openOrders = (orders as any)?.success
      ? Array.isArray((orders as any)?.data?.orders)
        ? (orders as any).data.orders
        : []
      : [];
    const availableBalance = (portfolio as any)?.success
      ? Number((portfolio as any)?.data?.summary?.available_balance ?? NaN)
      : NaN;

    const positionCount = perpPositions.length;
    const orderCount = openOrders.length;
    const balanceText = Number.isFinite(availableBalance) ? availableBalance.toFixed(4) : 'unknown';

    return [
      'Monitoring is still active; provider cooldown prevented a full reasoning pass this turn.',
      `Book snapshot: ${positionCount} perp position(s), ${orderCount} open order(s), available_balance=${balanceText}.`,
      'I will continue automatic monitoring and de-risk/rebalance on the next cycle when tool/LLM capacity clears.',
    ].join(' ');
  }

  private shouldResumePlan(message: string): boolean {
    if (this.config.agent?.persistPlans === false) {
      return false;
    }
    const text = message.toLowerCase();
    return /\b(continue|resume|next step|next|progress|status|carry on)\b/.test(text);
  }

  private async runToolFirstGuard(message: string): Promise<string> {
    const text = message.toLowerCase();
    const wantsNews = /\b(news|headline|breaking|latest|today|yesterday|current events|recent updates)\b/.test(text);
    const wantsMarket = /\b(price|odds|market|markets|ticker|tickers|probability|volume|liquidity|bid|ask)\b/.test(text);
    const wantsTrade = /\b(perp|perps|trade|trades|buy|sell|long|short|leverage|funding|position|positions)\b/.test(text);
    const wantsTime = /\b(time|date|day)\b/.test(text);
    const wantsCommodityDiscovery = /\b(commodit(?:y|ies)|oil|gold|silver|xau|xag|wti|brent|natgas|copper|hip.?3?)\b/.test(text);
    const wantsFullMarketList = /\b(list all|all markets|what markets|every market|see.*markets|markets.*see|full.*market|market.*list)\b/.test(text);
    const inferredDomain = classifyMarketContextDomain(message);
    const wantsDomainContext =
      inferredDomain !== 'crypto' &&
      /\b(oil|gold|silver|wti|brent|natgas|commodit(?:y|ies)|iran|hormuz|opec|sanction|macro|rates|yield|fed)\b/i.test(message) &&
      !wantsTrade &&
      !/\b(hyperliquid|usdc|usdt|ticker|tickers)\b/.test(text);

    if (!wantsNews && !wantsMarket && !wantsTrade && !wantsTime && !wantsCommodityDiscovery && !wantsDomainContext) {
      return '';
    }

    const sections: string[] = ['## Tool Snapshot'];

    if (wantsTime) {
      const timeResult = await executeToolCall('current_time', {}, this.toolContext);
      if (timeResult.success) {
        sections.push(`### current_time\n${JSON.stringify(timeResult.data, null, 2)}`);
      }
    }

    if (wantsDomainContext) {
      const snapshot = await gatherMarketContext(
        { message, marketLimit: 200 },
        (toolName, input) => executeToolCall(toolName, input, this.toolContext)
      );
      sections.push(
        `### market_context_domain\n${JSON.stringify(
          { domain: snapshot.domain, primarySource: snapshot.primarySource, sources: snapshot.sources },
          null,
          2
        )}`
      );
      for (const result of snapshot.results.filter((item) => item.success)) {
        sections.push(`### ${result.label}\n${JSON.stringify(result.data, null, 2)}`);
      }
    } else if (wantsNews) {
      const intelResult = await executeToolCall('intel_search', { query: message, limit: 5 }, this.toolContext);
      if (intelResult.success) {
        sections.push(`### intel_search\n${JSON.stringify(intelResult.data, null, 2)}`);
      }
      const webResult = await executeToolCall('web_search', { query: message, limit: 5 }, this.toolContext);
      if (webResult.success) {
        sections.push(`### web_search\n${JSON.stringify(webResult.data, null, 2)}`);
      }
    }

    if ((wantsMarket || wantsTrade) && !wantsDomainContext) {
      const symbols = new Set<string>();
      const positionsResult = await executeToolCall('get_positions', {}, this.toolContext);
      if (positionsResult.success) {
        sections.push(`### get_positions\n${JSON.stringify(positionsResult.data, null, 2)}`);
        const positionRows = (positionsResult.data as { positions?: Array<{ symbol?: string }> } | null)?.positions ?? [];
        for (const row of positionRows) {
          const symbol = String(row?.symbol ?? '').trim().toUpperCase();
          if (symbol.length > 0) symbols.add(symbol);
        }
      }

      const marketListLimit = (wantsCommodityDiscovery || wantsFullMarketList) ? 200 : 50;
      const marketResult = await executeToolCall('perp_market_list', { limit: marketListLimit }, this.toolContext);
      if (marketResult.success) {
        sections.push(`### perp_market_list\n${JSON.stringify(marketResult.data, null, 2)}`);
      }

      // Prefer exchange market data for direct symbol price requests before web search.
      const symbolCandidates = Array.from(
        new Set(
          [
            ...(Array.isArray(this.config.hyperliquid?.symbols) ? this.config.hyperliquid.symbols : []),
            'BTC',
            'ETH',
            'SOL',
            'XRP',
            'DOGE',
            'BNB',
            'SUI',
            'ADA',
            'AVAX',
            'DOT',
            'LINK',
            'LTC',
          ].map((item) => String(item || '').trim().toUpperCase()).filter((item) => item.length > 0)
        )
      );
      const symbolRegex = symbolCandidates.length > 0
        ? new RegExp(
            `\\b(${symbolCandidates.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
            'i'
          )
        : null;
      const symbolMatch = symbolRegex ? message.match(symbolRegex) : null;
      if (symbolMatch?.[1]) {
        symbols.add(symbolMatch[1].toUpperCase());
      }
      const explicitTickerMatches = message.match(/\b[A-Z]{2,12}\/(?:USDC|USDT|USD)\b/g) ?? [];
      for (const symbol of explicitTickerMatches) {
        symbols.add(symbol.toUpperCase());
      }
      const uppercaseTickerMatches = message.match(/\b[A-Z]{2,10}\b/g) ?? [];
      for (const symbol of uppercaseTickerMatches) {
        symbols.add(symbol.toUpperCase());
      }
      for (const symbol of Array.from(symbols).slice(0, 3)) {
        const marketGet = await executeToolCall('perp_market_get', { symbol }, this.toolContext);
        if (marketGet.success) {
          sections.push(`### perp_market_get:${symbol}\n${JSON.stringify(marketGet.data, null, 2)}`);
        }
      }
    }

    if (sections.length === 1) {
      return '';
    }

    return sections.join('\n\n') + '\n';
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
    basePrompt: string;
    contextBlock: string;
    userMessage: string;
  }): Promise<string> {
    const { basePrompt, contextBlock, userMessage } = params;
    if (!contextBlock) {
      return basePrompt;
    }

    const infoLlm = this.infoLlm;
    if (!infoLlm || contextBlock.length < 600) {
      return basePrompt + `\n\n---\n\n${contextBlock}`;
    }
    if (infoLlm.meta?.provider === 'local' && infoLlm.meta?.kind === 'trivial') {
      return basePrompt + `\n\n---\n\n${contextBlock}`;
    }

    const prompt = `Summarize the context into a compact brief for the planner.
Include: user preferences, recent decisions/positions, key intel, and relevant markets.
Do not speculate or add new information. Max 120 words.

User message: ${userMessage}

Context:
${contextBlock}`.trim();

    try {
      const identityPrelude = loadIdentityPrelude({
        workspacePath: this.config.agent?.workspace,
        promptMode: this.config.agent?.internalPromptMode ?? 'minimal',
        bootstrapMaxChars: this.config.agent?.identityBootstrapMaxChars,
        includeMissing: this.config.agent?.identityBootstrapIncludeMissing,
      }).prelude;
      const systemPrompt = identityPrelude
        ? `${identityPrelude}\n\n---\n\nYou are a concise information gatherer.`
        : 'You are a concise information gatherer.';
      const response = await withExecutionContext(
        { mode: 'LIGHT_REASONING', critical: false, reason: 'info_digest', source: 'conversation' },
        () =>
          infoLlm.complete(
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
            { temperature: 0.1 }
          )
      );
      const digest = response.content.trim();
      if (!digest) {
        return basePrompt + `\n\n---\n\n${contextBlock}`;
      }
      return basePrompt + `\n\n---\n\n## Info Digest\n${digest}`;
    } catch {
      return basePrompt + `\n\n---\n\n${contextBlock}`;
    }
  }

  

  private getSystemPrompt(userId: string): string {
    // Moltbot pattern: Identity FIRST, then rules
    // This ensures identity anchors the context before anything else
    const workspaceIdentity = loadIdentityPrelude({
      workspacePath: this.config.agent?.workspace,
      promptMode: this.config.agent?.identityPromptMode ?? 'full',
      bootstrapMaxChars: this.config.agent?.identityBootstrapMaxChars,
      includeMissing: this.config.agent?.identityBootstrapIncludeMissing,
    }).prelude;

    // Identity comes FIRST - this is the critical difference from before
    let systemPrompt = workspaceIdentity
      ? workspaceIdentity + '\n\n---\n\n' + SYSTEM_PROMPT_BASE
      : SYSTEM_PROMPT_BASE;

    const personality = getUserContext(userId)?.preferences?.personality;
    if (typeof personality === 'string') {
      const mode = PERSONALITY_MODES[personality];
      if (mode) {
        const quotes = THUFIR_QUOTES.map((quote) => `- "${quote}"`).join('\n');
        return `${systemPrompt}\n\n## Personality\n${mode.instruction}\n\n## Quote Bank (optional)\n${quotes}`;
      }
    }
    return systemPrompt;
  }

  private async completeWithFallback(
    messages: ChatMessage[],
    options: { temperature?: number; timeoutMs?: number }
  ): Promise<{ content: string; model: string }> {
    try {
      return await (this.agenticLlm ?? this.llm).complete(messages, options);
    } catch (error) {
      if (!this.shouldFallbackToOpenAi(error) || !this.agenticOpenAi) {
        throw error;
      }
      return this.agenticOpenAi.complete(messages, options);
    }
  }

  private shouldFallbackToOpenAi(error: unknown): boolean {
    const err = error as { status?: number; message?: string };
    if (err?.status === 429) return true;
    if (err?.status === 402) return true;
    const message = (err?.message ?? '').toLowerCase();
    return (
      message.includes('rate limit') ||
      message.includes('too many requests') ||
      message.includes('429') ||
      message.includes('credit balance') ||
      message.includes('insufficient credit') ||
      message.includes('billing') ||
      message.includes('payment') ||
      message.includes('quota') ||
      message.includes('insufficient') ||
      message.includes('balance is too low')
    );
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

  private formatToolTrace(toolExecutions: ToolExecution[]): string {
    if (toolExecutions.length === 0) {
      return 'No tools called.';
    }

    const lines = toolExecutions.map((exec) => {
      const status = exec.result.success ? 'ok' : 'error';
      const cached = exec.cached ? 'cached' : 'live';
      return `- ${exec.toolName} (${status}, ${cached}, ${exec.durationMs}ms)`;
    });

    return lines.join('\n');
  }

  private formatCriticNotes(criticResult: CriticResult | null): string {
    if (!criticResult) {
      return 'Critic not run.';
    }

    const lines: string[] = [];
    lines.push(`Approved: ${criticResult.approved ? 'yes' : 'no'}`);
    lines.push(`Assessment: ${criticResult.assessment}`);
    if (criticResult.issues.length === 0) {
      lines.push('Issues: none');
      return lines.join('\n');
    }

    lines.push('Issues:');
    for (const issue of criticResult.issues) {
      const detail = issue.suggestion ? ` (fix: ${issue.suggestion})` : '';
      lines.push(`- [${issue.severity}] ${issue.type}: ${issue.description}${detail}`);
    }

    return lines.join('\n');
  }

  private formatPlanTrace(plan: AgentPlan | null): string {
    if (!plan) {
      return 'No plan available.';
    }

    const lines: string[] = [];
    lines.push(`Goal: ${plan.goal}`);
    lines.push(`Confidence: ${(plan.confidence * 100).toFixed(0)}%`);
    lines.push(`Revisions: ${plan.revisionCount}`);
    if (plan.blockers.length > 0) {
      lines.push(`Blockers: ${plan.blockers.join('; ')}`);
    }
    lines.push('Steps:');
    for (const step of plan.steps) {
      const tool = step.requiresTool ? ` tool=${step.toolName ?? 'unknown'}` : '';
      lines.push(`- [${step.status}] ${step.description}${tool}`);
    }

    return lines.join('\n');
  }

  private maybeAttachOrchestratorNotes(
    response: string,
    toolExecutions: ToolExecution[],
    criticResult: CriticResult | null,
    plan: AgentPlan | null,
    fragility?: {
      fragilityScore: number;
      riskSignalCount: number;
      fragilityCardCount: number;
      topRiskSignals: string[];
      highFragility: boolean;
    }
  ): string {
    const sections: string[] = [];
    if (this.config.agent?.showPlanTrace) {
      sections.push(`## Plan Trace\n${this.formatPlanTrace(plan)}`);
    }
    if (this.config.agent?.showToolTrace) {
      sections.push(`## Tool Trace\n${this.formatToolTrace(toolExecutions)}`);
    }
    if (this.config.agent?.showCriticNotes) {
      sections.push(`## Critic Notes\n${this.formatCriticNotes(criticResult)}`);
    }
    // Always show fragility for high-fragility trades, or if showFragilityTrace is enabled
    if (fragility && (fragility.highFragility || this.config.agent?.showFragilityTrace)) {
      sections.push(`## Fragility Analysis\n${this.formatFragilityTrace(fragility)}`);
    }
    if (sections.length === 0) {
      return response;
    }
    return `${response}\n\n---\n\n${sections.join('\n\n')}`;
  }

  private formatFragilityTrace(fragility: {
    fragilityScore: number;
    riskSignalCount: number;
    fragilityCardCount: number;
    topRiskSignals: string[];
    highFragility: boolean;
  }): string {
    const lines: string[] = [];
    const scorePercent = (fragility.fragilityScore * 100).toFixed(0);
    const warning = fragility.highFragility ? ' ⚠️ HIGH' : '';
    lines.push(`Fragility Score: ${scorePercent}%${warning}`);
    lines.push(`Risk Signals: ${fragility.riskSignalCount}`);
    lines.push(`Fragility Cards: ${fragility.fragilityCardCount}`);

    if (fragility.topRiskSignals.length > 0) {
      lines.push('');
      lines.push('Top Risks:');
      for (const signal of fragility.topRiskSignals) {
        lines.push(`- ${signal}`);
      }
    }

    return lines.join('\n');
  }

  private async maybeAttachMentatReport(
    response: string,
    mode: string
  ): Promise<string> {
    if (!this.config.agent?.mentatAutoScan || mode !== 'mentat') {
      return response;
    }

    try {
      const { runMentatScan } = await import('../mentat/scan.js');
      const { generateMentatReport, formatMentatReport } = await import('../mentat/report.js');

      const scan = await runMentatScan({
        system: this.config.agent?.mentatSystem ?? 'Markets',
        llm: this.llm,
        config: this.config,
        marketClient: this.marketClient,
        marketQuery: this.config.agent?.mentatMarketQuery,
        limit: this.config.agent?.mentatMarketLimit,
        intelLimit: this.config.agent?.mentatIntelLimit,
      });

      const report = generateMentatReport({
        system: scan.system,
        detectors: scan.detectors,
      });

      return `${response}\n\n---\n\n${formatMentatReport(report)}`;
    } catch (error) {
      this.logger?.warn(
        `Mentat auto-scan failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return response;
    }
  }

  private applyIntelAlertConfig(settings: {
    watchlistOnly: boolean;
    includeKeywords: string[];
    includeSources: string[];
    sentimentPreset: 'any' | 'positive' | 'negative' | 'neutral';
  }): boolean {
    try {
      const path =
        process.env.THUFIR_CONFIG_PATH ?? join(homedir(), '.thufir', 'config.yaml');
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
    return withExecutionContext(
      { mode: 'FULL_AGENT', critical: false, reason: 'analyze_market', source: 'conversation' },
      async () => {
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
            llm: this.infoLlm ?? this.llm,
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

          const prompt = `Please analyze this perp market and give me a directional thesis with reasoning:

**${market.question}**
- Symbol: ${market.symbol ?? market.id}
- Mark price: ${market.markPrice ?? 'N/A'}
- Max leverage: ${market.metadata?.maxLeverage ?? 'N/A'}
- Category: ${market.category ?? 'unknown'}

Give me:
1. Your directional probability estimate (e.g., "60% upside")
2. Key factors driving your estimate
3. What would change your mind
4. Whether you see edge vs. current price`;

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
            basePrompt: this.getSystemPrompt(userId),
            contextBlock,
            userMessage: market.question ?? marketId,
          });

          const response = await this.completeWithFallback(
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
    );
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
    return withExecutionContext(
      { mode: 'FULL_AGENT', critical: false, reason: 'analyze_market_structured', source: 'conversation' },
      async () => {
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
          llm: this.infoLlm ?? this.llm,
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
          basePrompt: this.getSystemPrompt(userId),
          contextBlock,
          userMessage: market.question ?? marketId,
        });

        const response = await this.completeWithFallback(
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
    );
  }

  /**
   * Ask about a topic and find relevant markets
   */
  async askAbout(userId: string, topic: string): Promise<string> {
    return withExecutionContext(
      { mode: 'FULL_AGENT', critical: false, reason: 'ask_about', source: 'conversation' },
      async () => {
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
          llm: this.infoLlm ?? this.llm,
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
            ? `\n## Relevant Perp Markets\n${formatMarketsForChat(markets)}`
            : '\n(No relevant perp symbols found for this topic)';

        const prompt = `The user wants to know about: "${topic}"

Please:
1. Share your analysis and directional probability estimates related to this topic
2. Reference the perp markets shown below if relevant
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
          basePrompt: this.getSystemPrompt(userId),
          contextBlock: systemContext,
          userMessage: topic,
        });

        const response = await this.completeWithFallback(
          [
            { role: 'system', content: systemMessage },
            { role: 'user', content: prompt },
          ],
          { temperature: 0.6 }
        );

        return response.content;
      }
    );
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
