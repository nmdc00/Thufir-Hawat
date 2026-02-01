#!/usr/bin/env node
import 'dotenv/config';
import http from 'node:http';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

import { loadConfig } from '../core/config.js';

const execAsync = promisify(exec);
import { Logger } from '../core/logger.js';
import { TelegramAdapter } from '../interface/telegram.js';
import { WhatsAppAdapter } from '../interface/whatsapp.js';
import { resolveOutcomes } from '../core/resolver.js';
import { runIntelPipelineDetailed } from '../intel/pipeline.js';
import { pruneChatMessages } from '../memory/chat.js';
import { listWatchlist } from '../memory/watchlist.js';
import { PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { pruneIntel } from '../intel/store.js';
import { rankIntelAlerts } from '../intel/alerts.js';
import { refreshMarketPrices, syncMarketCache } from '../core/markets_sync.js';
import { formatProactiveSummary, runProactiveSearch } from '../core/proactive_search.js';
import { buildAgentPeerSessionKey, resolveThreadSessionKeys } from './session_keys.js';
import { PolymarketStreamClient } from '../execution/polymarket/stream.js';
import { upsertMarketCache } from '../memory/market_cache.js';
import { getMarketCache } from '../memory/market_cache.js';
import { createAgentRegistry } from './agent_router.js';
import { createLlmClient } from '../core/llm.js';

const config = loadConfig();
const rawLevel = (process.env.THUFIR_LOG_LEVEL ?? 'info').toLowerCase();
const level =
  rawLevel === 'debug' || rawLevel === 'info' || rawLevel === 'warn' || rawLevel === 'error'
    ? rawLevel
    : 'info';
const logger = new Logger(level);
const agentRegistry = createAgentRegistry(config, logger);
const defaultAgent =
  agentRegistry.agents.get(agentRegistry.defaultAgentId) ??
  agentRegistry.agents.values().next().value;
if (!defaultAgent) {
  throw new Error('No agents configured');
}

const telegram = config.channels.telegram.enabled ? new TelegramAdapter(config) : null;
const whatsapp = config.channels.whatsapp.enabled ? new WhatsAppAdapter(config) : null;

for (const instance of agentRegistry.agents.values()) {
  instance.start();
}

// Market stream (watchlist-only)
const streamConfig = config.polymarket?.stream;
const streamClient =
  streamConfig?.enabled && streamConfig.wsUrl ? new PolymarketStreamClient(config) : null;
const streamMarketClient = new PolymarketMarketClient(config);

if (streamClient) {
  streamClient.on('connected', () => logger.info('Market stream connected.'));
  streamClient.on('disconnected', () => logger.warn('Market stream disconnected.'));
  streamClient.on('error', (err) => logger.error('Market stream error', err));
  streamClient.on('update', async (update) => {
    const marketId = update.marketId ? update.marketId : '';
    if (!marketId) return;
    let question = '';
    let outcomes: string[] = [];
    let category: string | undefined;
    if (marketId) {
      const cachedMarket = getMarketCache(marketId);
      if (cachedMarket) {
        question = cachedMarket.question;
        outcomes = cachedMarket.outcomes ?? [];
        category = cachedMarket.category ?? undefined;
      } else {
        try {
          const market = await streamMarketClient.getMarket(marketId);
          question = market.question;
          outcomes = market.outcomes ?? [];
          category = market.category ?? undefined;
        } catch {
          return;
        }
      }
    }
    if (!question) return;
    upsertMarketCache({
      id: update.marketId,
      question,
      outcomes,
      prices: update.prices ?? {},
      category,
    });
  });
  streamClient.connect();
}

const onIncoming = async (
  message: {
    channel: 'telegram' | 'whatsapp' | 'cli';
    senderId: string;
    text: string;
    peerKind?: 'dm' | 'group' | 'channel';
    threadId?: string;
  }
) => {
  const { agentId, agent: activeAgent } = agentRegistry.resolveAgent(message);
  const sessionKey = buildAgentPeerSessionKey({
    agentId,
    mainKey: config.session?.mainKey,
    channel: message.channel,
    peerKind: message.peerKind ?? 'dm',
    peerId: message.senderId,
    dmScope: config.session?.dmScope,
    identityLinks: config.session?.identityLinks,
  });
  const session = resolveThreadSessionKeys({
    baseSessionKey: sessionKey,
    threadId: message.threadId,
  }).sessionKey;
  const reply = await activeAgent.handleMessage(session, message.text);
  if (!reply || reply.trim().length === 0) {
    logger.warn(`Empty reply for ${message.channel}:${message.senderId}`);
    return;
  }
  if (message.channel === 'telegram' && telegram) {
    try {
      await telegram.sendMessage(message.senderId, reply);
      logger.info(`Telegram reply sent to ${message.senderId}`);
    } catch (error) {
      logger.error(`Telegram send failed for ${message.senderId}`, error);
    }
  }
  if (message.channel === 'whatsapp' && whatsapp) {
    try {
      await whatsapp.sendMessage(message.senderId, reply);
      logger.info(`WhatsApp reply sent to ${message.senderId}`);
    } catch (error) {
      logger.error(`WhatsApp send failed for ${message.senderId}`, error);
    }
  }
};

const briefingConfig = config.notifications?.briefing;
let lastBriefingDate = '';
if (briefingConfig?.enabled) {
  setInterval(async () => {
    const now = new Date();
    const [hours, minutes] = briefingConfig.time.split(':').map((part) => Number(part));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return;
    }
    const today = now.toISOString().split('T')[0]!;
    if (lastBriefingDate === today) {
      return;
    }
    if (now.getHours() !== hours || now.getMinutes() !== minutes) {
      return;
    }

    const message = await defaultAgent.generateBriefing();
    const channels = briefingConfig.channels ?? [];
    if (channels.includes('telegram') && telegram) {
      for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
        try {
          await telegram.sendMessage(String(chatId), message);
          logger.info(`Telegram briefing sent to ${chatId}`);
        } catch (error) {
          logger.error(`Telegram briefing failed for ${chatId}`, error);
        }
      }
    }
    if (channels.includes('whatsapp') && whatsapp) {
      for (const number of config.channels.whatsapp.allowedNumbers ?? []) {
        try {
          await whatsapp.sendMessage(number, message);
          logger.info(`WhatsApp briefing sent to ${number}`);
        } catch (error) {
          logger.error(`WhatsApp briefing failed for ${number}`, error);
        }
      }
    }
    lastBriefingDate = today;
  }, 60_000);
}

const resolverConfig = config.notifications?.resolver;
let lastResolverDate = '';
if (resolverConfig?.enabled) {
  setInterval(async () => {
    const now = new Date();
    const [hours, minutes] = resolverConfig.time.split(':').map((part) => Number(part));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return;
    }
    const today = now.toISOString().split('T')[0]!;
    if (lastResolverDate === today) {
      return;
    }
    if (now.getHours() !== hours || now.getMinutes() !== minutes) {
      return;
    }

    try {
      const updated = await resolveOutcomes(config, resolverConfig.limit);
      logger.info(`Resolved ${updated} prediction(s).`);
    } catch (error) {
      logger.error('Outcome resolver failed', error);
    }
    lastResolverDate = today;
  }, 60_000);
}

const intelFetchConfig = config.notifications?.intelFetch;
let lastIntelFetchDate = '';
if (intelFetchConfig?.enabled) {
  setInterval(async () => {
    const now = new Date();
    const [hours, minutes] = intelFetchConfig.time.split(':').map((part) => Number(part));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return;
    }
    const today = now.toISOString().split('T')[0]!;
    if (lastIntelFetchDate === today) {
      return;
    }
    if (now.getHours() !== hours || now.getMinutes() !== minutes) {
      return;
    }

    try {
      const result = await runIntelPipelineDetailed(config);
      logger.info(`Intel fetch stored ${result.storedCount} item(s).`);

      if (config.autonomy?.eventDriven) {
        const minItems = config.autonomy?.eventDrivenMinItems ?? 1;
        if (result.storedCount >= minItems) {
          const scanResult = await defaultAgent.getAutonomous().runScan();
          logger.info(`Event-driven scan: ${scanResult}`);
        }
      }

      const alertsConfig = config.notifications?.intelAlerts;
      if (alertsConfig?.enabled && result.storedItems.length > 0) {
        await sendIntelAlerts(result.storedItems, alertsConfig);
      }
    } catch (error) {
      logger.error('Intel fetch failed', error);
    }
    lastIntelFetchDate = today;
  }, 60_000);
}

const marketSyncConfig = config.notifications?.marketSync;
let lastMarketSyncDate = '';
if (marketSyncConfig?.enabled) {
  const runMarketSync = async () => {
    try {
      const result = await syncMarketCache(
        config,
        marketSyncConfig.limit,
        marketSyncConfig.maxPages
      );
      logger.info(`Market cache sync stored ${result.stored} market(s).`);
      const refreshed = await refreshMarketPrices(config, marketSyncConfig.refreshLimit);
      logger.info(`Market price refresh stored ${refreshed.stored} market(s).`);
    } catch (error) {
      logger.error('Market cache sync failed', error);
    }
  };

  if (marketSyncConfig.intervalSeconds && marketSyncConfig.intervalSeconds > 0) {
    runMarketSync();
    setInterval(runMarketSync, marketSyncConfig.intervalSeconds * 1000);
  } else {
    setInterval(async () => {
      const now = new Date();
      const [hours, minutes] = marketSyncConfig.time.split(':').map((part) => Number(part));
      if (Number.isNaN(hours) || Number.isNaN(minutes)) {
        return;
      }
      const today = now.toISOString().split('T')[0]!;
      if (lastMarketSyncDate === today) {
        return;
      }
      if (now.getHours() !== hours || now.getMinutes() !== minutes) {
        return;
      }

      await runMarketSync();
      lastMarketSyncDate = today;
    }, 60_000);
  }
}

const proactiveConfig = config.notifications?.proactiveSearch;
let lastProactiveDate = '';
if (proactiveConfig?.enabled && proactiveConfig.mode !== 'heartbeat') {
  setInterval(async () => {
    const now = new Date();
    const [hours, minutes] = proactiveConfig.time.split(':').map((part) => Number(part));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) {
      return;
    }
    const today = now.toISOString().split('T')[0]!;
    if (lastProactiveDate === today) {
      return;
    }
    if (now.getHours() !== hours || now.getMinutes() !== minutes) {
      return;
    }

    try {
      const result = await runProactiveSearch(config, {
        maxQueries: proactiveConfig.maxQueries,
        watchlistLimit: proactiveConfig.watchlistLimit,
        useLlm: proactiveConfig.useLlm,
        recentIntelLimit: proactiveConfig.recentIntelLimit,
        extraQueries: proactiveConfig.extraQueries,
      });
      logger.info(`Proactive search stored ${result.storedCount} item(s).`);

      const alertsConfig = config.notifications?.intelAlerts;
      if (alertsConfig?.enabled && result.storedItems.length > 0) {
        await sendIntelAlerts(result.storedItems, alertsConfig);
      }

      if (proactiveConfig.mode === 'direct' && result.storedItems.length > 0) {
        const summaryLines = formatProactiveSummary(result);

        const channels = proactiveConfig.channels ?? [];
        if (channels.includes('telegram') && telegram) {
          for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
            try {
              await telegram.sendMessage(String(chatId), summaryLines);
              logger.info(`Telegram proactive summary sent to ${chatId}`);
            } catch (error) {
              logger.error(`Telegram proactive summary failed for ${chatId}`, error);
            }
          }
        }
        if (channels.includes('whatsapp') && whatsapp) {
          for (const number of config.channels.whatsapp.allowedNumbers ?? []) {
            try {
              await whatsapp.sendMessage(number, summaryLines);
              logger.info(`WhatsApp proactive summary sent to ${number}`);
            } catch (error) {
              logger.error(`WhatsApp proactive summary failed for ${number}`, error);
            }
          }
        }
      }
    } catch (error) {
      logger.error('Proactive search failed', error);
    }
    lastProactiveDate = today;
  }, 60_000);
}

const heartbeatConfig = config.notifications?.heartbeat;
if (heartbeatConfig?.enabled) {
  const intervalMs = Math.max(1, heartbeatConfig.intervalMinutes ?? 30) * 60 * 1000;
  const heartbeatUserId = '__heartbeat__';
  const heartbeatPrompt =
    'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. ' +
    'Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.';

  const isHeartbeatEmpty = (content: string | null): boolean => {
    if (!content) return true;
    const stripped = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('<!--'));
    return stripped.length === 0;
  };

  const loadHeartbeatContent = async (): Promise<string | null> => {
    try {
      const workspacePath = config.agent?.workspace ?? join(process.env.HOME ?? '', '.thufir');
      const heartbeatPath = join(workspacePath, 'HEARTBEAT.md');
      const content = await (await import('node:fs/promises')).readFile(heartbeatPath, 'utf-8');
      return content;
    } catch {
      return null;
    }
  };

  const runHeartbeat = async () => {
    let proactiveSummary = '';
    if (proactiveConfig?.enabled && proactiveConfig.mode === 'heartbeat') {
      try {
        const result = await runProactiveSearch(config, {
          maxQueries: proactiveConfig.maxQueries,
          watchlistLimit: proactiveConfig.watchlistLimit,
          useLlm: proactiveConfig.useLlm,
          recentIntelLimit: proactiveConfig.recentIntelLimit,
          extraQueries: proactiveConfig.extraQueries,
        });
        const titles = result.storedItems
          .map((item) => item.title)
          .filter((title): title is string => typeof title === 'string')
          .slice(0, 5);
        proactiveSummary = [
          `Proactive search stored ${result.storedCount} item(s).`,
          result.queries.length > 0 ? `Queries: ${result.queries.join('; ')}` : '',
          titles.length > 0 ? `Top items: ${titles.join(' | ')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      } catch (error) {
        logger.error('Heartbeat proactive search failed', error);
      }
    }

    const content = await loadHeartbeatContent();
    if (isHeartbeatEmpty(content)) {
      return;
    }
    const prompt = proactiveSummary
      ? `${heartbeatPrompt}\n\n${proactiveSummary}`
      : heartbeatPrompt;
    const response = await defaultAgent.handleMessage(heartbeatUserId, prompt);
    if (!response || response.trim().length === 0) {
      return;
    }
    const normalized = response.trim().toUpperCase();
    if (normalized.startsWith('HEARTBEAT_OK')) {
      return;
    }

    const channels = heartbeatConfig.channels ?? [];
    if (channels.includes('telegram') && telegram) {
      for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
        try {
          await telegram.sendMessage(String(chatId), response);
          logger.info(`Telegram heartbeat sent to ${chatId}`);
        } catch (error) {
          logger.error(`Telegram heartbeat failed for ${chatId}`, error);
        }
      }
    }
    if (channels.includes('whatsapp') && whatsapp) {
      for (const number of config.channels.whatsapp.allowedNumbers ?? []) {
        try {
          await whatsapp.sendMessage(number, response);
          logger.info(`WhatsApp heartbeat sent to ${number}`);
        } catch (error) {
          logger.error(`WhatsApp heartbeat failed for ${number}`, error);
        }
      }
    }
  };

  setInterval(() => {
    runHeartbeat().catch((error) => logger.error('Heartbeat failed', error));
  }, intervalMs);
}

const mentatConfig = config.notifications?.mentat;
let lastMentatDate = '';
let lastMentatRunAt = '';
if (mentatConfig?.enabled) {
  const llm = createLlmClient(config);
  const mentatMarketClient = new PolymarketMarketClient(config);

  const runMentatMonitor = async () => {
    const { runMentatScan } = await import('../mentat/scan.js');
    const { generateMentatReport, formatMentatReport } = await import('../mentat/report.js');
    const { listFragilityCardDeltas } = await import('../memory/mentat.js');

    const scan = await runMentatScan({
      system: mentatConfig.system ?? 'Polymarket',
      llm,
      marketClient: mentatMarketClient,
      marketQuery: mentatConfig.marketQuery,
      limit: mentatConfig.marketLimit,
      intelLimit: mentatConfig.intelLimit,
    });

    const report = generateMentatReport({
      system: scan.system,
      detectors: scan.detectors,
    });
    const reportText = formatMentatReport(report);

    const deltas = listFragilityCardDeltas({ limit: 100 })
      .filter((delta) => (lastMentatRunAt ? delta.changedAt > lastMentatRunAt : true));
    const maxDelta = deltas.reduce((max, delta) => {
      const value = delta.scoreDelta ?? 0;
      return value > max ? value : max;
    }, 0);

    const triggerOverall = (report.fragilityScore ?? 0) >= (mentatConfig.minOverallScore ?? 0.7);
    const triggerDelta = maxDelta >= (mentatConfig.minDeltaScore ?? 0.15);
    if (!(triggerOverall || triggerDelta)) {
      lastMentatRunAt = new Date().toISOString();
      return;
    }

    const fragilityScore = report.fragilityScore ?? 0;
    const header = `⚠️ Mentat Alert: ${scan.system}\n` +
      `Fragility Score: ${(fragilityScore * 100).toFixed(1)}%\n` +
      `Max Score Delta: ${(maxDelta * 100).toFixed(1)}%`;
    const message = `${header}\n\n${reportText}`;

    const channels = mentatConfig.channels ?? [];
    if (channels.includes('telegram') && telegram) {
      for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
        try {
          await telegram.sendMessage(String(chatId), message);
          logger.info(`Telegram mentat alert sent to ${chatId}`);
        } catch (error) {
          logger.error(`Telegram mentat alert failed for ${chatId}`, error);
        }
      }
    }
    if (channels.includes('whatsapp') && whatsapp) {
      for (const number of config.channels.whatsapp.allowedNumbers ?? []) {
        try {
          await whatsapp.sendMessage(number, message);
          logger.info(`WhatsApp mentat alert sent to ${number}`);
        } catch (error) {
          logger.error(`WhatsApp mentat alert failed for ${number}`, error);
        }
      }
    }

    lastMentatRunAt = new Date().toISOString();
  };

  if (mentatConfig.intervalMinutes && mentatConfig.intervalMinutes > 0) {
    setInterval(() => {
      runMentatMonitor().catch((error) => logger.error('Mentat monitor failed', error));
    }, mentatConfig.intervalMinutes * 60 * 1000);
  } else {
    setInterval(() => {
      const now = new Date();
      const [hours, minutes] = mentatConfig.time.split(':').map((part) => Number(part));
      if (Number.isNaN(hours) || Number.isNaN(minutes)) {
        return;
      }
      const today = now.toISOString().split('T')[0]!;
      if (lastMentatDate === today) {
        return;
      }
      if (now.getHours() !== hours || now.getMinutes() !== minutes) {
        return;
      }
      runMentatMonitor().catch((error) => logger.error('Mentat monitor failed', error));
      lastMentatDate = today;
    }, 60_000);
  }
}

const dailyReportConfig = config.notifications?.dailyReport;
if (dailyReportConfig?.enabled) {
  defaultAgent.getAutonomous().on('daily-report', async (report) => {
    const channels = dailyReportConfig.channels ?? [];
    if (channels.includes('telegram') && telegram) {
      for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
        try {
          await telegram.sendMessage(String(chatId), report);
          logger.info(`Telegram daily report sent to ${chatId}`);
        } catch (error) {
          logger.error(`Telegram daily report failed for ${chatId}`, error);
        }
      }
    }
    if (channels.includes('whatsapp') && whatsapp) {
      for (const number of config.channels.whatsapp.allowedNumbers ?? []) {
        try {
          await whatsapp.sendMessage(number, report);
          logger.info(`WhatsApp daily report sent to ${number}`);
        } catch (error) {
          logger.error(`WhatsApp daily report failed for ${number}`, error);
        }
      }
    }
  });
}

const retentionDays = config.memory?.retentionDays ?? 90;
if (retentionDays > 0) {
  setInterval(() => {
    const pruned = pruneChatMessages(retentionDays);
    if (pruned > 0) {
      logger.info(`Pruned ${pruned} chat message(s) older than ${retentionDays} days.`);
    }
  }, 6 * 60 * 60 * 1000);
}

const intelRetentionDays = config.intel?.retentionDays ?? 30;
if (intelRetentionDays > 0) {
  setInterval(() => {
    const pruned = pruneIntel(intelRetentionDays);
    if (pruned > 0) {
      logger.info(`Pruned ${pruned} intel item(s) older than ${intelRetentionDays} days.`);
    }
  }, 12 * 60 * 60 * 1000);
}

// QMD embedding scheduler
const qmdEmbedConfig = config.qmd?.embedSchedule;
if (config.qmd?.enabled && qmdEmbedConfig?.enabled) {
  const intervalMs = (qmdEmbedConfig.intervalMinutes ?? 60) * 60 * 1000;

  const runQmdEmbed = async () => {
    try {
      // Check if qmd is available
      await execAsync('qmd --version');
      // Run embedding update for all collections
      const { stderr } = await execAsync('qmd embed', { timeout: 300_000 });
      if (stderr && !stderr.includes('warning')) {
        logger.warn(`QMD embed warning: ${stderr}`);
      }
      logger.info('QMD embeddings updated successfully.');
    } catch (error) {
      // QMD not installed or embed failed - non-fatal
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (!msg.includes('not found') && !msg.includes('ENOENT')) {
        logger.warn(`QMD embed failed: ${msg}`);
      }
    }
  };

  // Run on startup after a delay, then periodically
  setTimeout(runQmdEmbed, 30_000); // 30 seconds after startup
  setInterval(runQmdEmbed, intervalMs);
  logger.info(`QMD embedding scheduler enabled (every ${qmdEmbedConfig.intervalMinutes} minutes).`);
}

if (telegram) {
  telegram.startPolling(async (msg) => {
    logger.info(`Telegram message from ${msg.senderId}: ${msg.text}`);
    await onIncoming(msg);
  });
}

if (streamClient && streamConfig?.watchlistOnly) {
  const refreshStreamSubs = () => {
    const watchlist = listWatchlist(streamConfig.maxWatchlist ?? 50);
    const marketIds = watchlist.map((item) => item.marketId);
    if (marketIds.length > 0) {
      streamClient.subscribe(marketIds);
    }
  };

  refreshStreamSubs();
  setInterval(refreshStreamSubs, 5 * 60 * 1000);

  const staleAfterMs = (streamConfig.staleAfterSeconds ?? 180) * 1000;
  const refreshIntervalMs = (streamConfig.refreshIntervalSeconds ?? 300) * 1000;
  setInterval(async () => {
    const watchlist = listWatchlist(streamConfig.maxWatchlist ?? 50);
    for (const item of watchlist) {
      const lastUpdate = streamClient.getLastUpdate(item.marketId);
      if (!lastUpdate || Date.now() - lastUpdate > staleAfterMs) {
        try {
          const market = await streamMarketClient.getMarket(item.marketId);
          upsertMarketCache({
            id: market.id,
            question: market.question,
            outcomes: market.outcomes ?? [],
            prices: market.prices ?? {},
            volume: market.volume ?? null,
            liquidity: market.liquidity ?? null,
            endDate: market.endDate ?? null,
            category: market.category ?? null,
            resolved: market.resolved ?? false,
            resolution: market.resolution ?? null,
          });
        } catch {
          continue;
        }
      }
    }
  }, refreshIntervalMs);
}

async function sendIntelAlerts(
  items: Array<{ title: string; url?: string; source: string; content?: string }>,
  alertsConfig: {
    channels?: string[];
    watchlistOnly?: boolean;
    maxItems?: number;
    includeSources?: string[];
    excludeSources?: string[];
    includeKeywords?: string[];
    excludeKeywords?: string[];
    minKeywordOverlap?: number;
    minTitleLength?: number;
    minSentiment?: number;
    maxSentiment?: number;
    sentimentPreset?: 'any' | 'positive' | 'negative' | 'neutral';
    includeEntities?: string[];
    excludeEntities?: string[];
    minEntityOverlap?: number;
    useContent?: boolean;
    minScore?: number;
    keywordWeight?: number;
    entityWeight?: number;
    sentimentWeight?: number;
    positiveSentimentThreshold?: number;
    negativeSentimentThreshold?: number;
    showScore?: boolean;
    showReasons?: boolean;
    entityAliases?: Record<string, string[]>;
  }
): Promise<void> {
  const settings = {
    channels: alertsConfig.channels ?? [],
    watchlistOnly: alertsConfig.watchlistOnly ?? true,
    maxItems: alertsConfig.maxItems ?? 10,
    includeSources: alertsConfig.includeSources ?? [],
    excludeSources: alertsConfig.excludeSources ?? [],
    includeKeywords: alertsConfig.includeKeywords ?? [],
    excludeKeywords: alertsConfig.excludeKeywords ?? [],
    minKeywordOverlap: alertsConfig.minKeywordOverlap ?? 1,
    minTitleLength: alertsConfig.minTitleLength ?? 8,
    minSentiment: alertsConfig.minSentiment ?? undefined,
    maxSentiment: alertsConfig.maxSentiment ?? undefined,
    sentimentPreset: alertsConfig.sentimentPreset ?? 'any',
    includeEntities: alertsConfig.includeEntities ?? [],
    excludeEntities: alertsConfig.excludeEntities ?? [],
    minEntityOverlap: alertsConfig.minEntityOverlap ?? 1,
    useContent: alertsConfig.useContent ?? true,
    minScore: alertsConfig.minScore ?? 0,
    keywordWeight: alertsConfig.keywordWeight ?? 1,
    entityWeight: alertsConfig.entityWeight ?? 1,
    sentimentWeight: alertsConfig.sentimentWeight ?? 1,
    positiveSentimentThreshold: alertsConfig.positiveSentimentThreshold ?? 0.05,
    negativeSentimentThreshold: alertsConfig.negativeSentimentThreshold ?? -0.05,
    showScore: alertsConfig.showScore ?? false,
    showReasons: alertsConfig.showReasons ?? false,
    entityAliases: alertsConfig.entityAliases ?? {},
  };

  const marketClient = new PolymarketMarketClient(config);
  let watchlistTitles: string[] = [];

  if (settings.watchlistOnly) {
    const watchlist = listWatchlist(50);
    for (const item of watchlist) {
      try {
        const market = await marketClient.getMarket(item.marketId);
        if (market.question) {
          watchlistTitles.push(market.question);
        }
      } catch {
        continue;
      }
    }
  }

  const alerts = rankIntelAlerts(items, settings, watchlistTitles).map((item) => item.text);

  if (alerts.length === 0) {
    return;
  }

  const message = `📰 **Intel Alert**\n\n${alerts.join('\n')}`;
  if (settings.channels.includes('telegram') && telegram) {
    for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
      try {
        await telegram.sendMessage(String(chatId), message);
        logger.info(`Telegram intel alert sent to ${chatId}`);
      } catch (error) {
        logger.error(`Telegram intel alert failed for ${chatId}`, error);
      }
    }
  }
  if (settings.channels.includes('whatsapp') && whatsapp) {
    for (const number of config.channels.whatsapp.allowedNumbers ?? []) {
      try {
        await whatsapp.sendMessage(number, message);
        logger.info(`WhatsApp intel alert sent to ${number}`);
      } catch (error) {
        logger.error(`WhatsApp intel alert failed for ${number}`, error);
      }
    }
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (!whatsapp) {
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/whatsapp/webhook')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === whatsapp.getVerifyToken()) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge ?? '');
      return;
    }
    res.writeHead(403);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/whatsapp/webhook')) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        await whatsapp.handleWebhook(payload, async (msg) => {
          logger.info(`WhatsApp message from ${msg.senderId}: ${msg.text}`);
          await onIncoming(msg);
        });
        res.writeHead(200);
        res.end('ok');
      } catch (err) {
        logger.error('WhatsApp webhook failed', err);
        res.writeHead(500);
        res.end();
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(config.gateway.port, () => {
  logger.info(`Gateway listening on port ${config.gateway.port}`);
});
