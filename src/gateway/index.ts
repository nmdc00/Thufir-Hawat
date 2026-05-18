#!/usr/bin/env node
import 'dotenv/config';
import http from 'node:http';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

import { loadConfig } from '../core/config.js';

const execAsync = promisify(exec);

async function resolveQmdCommand(): Promise<string | null> {
  const candidates = [
    process.env.QMD_BIN,
    'qmd',
    join(homedir(), '.local', 'bin', 'qmd'),
    join(homedir(), '.bun', 'bin', 'qmd'),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      if (candidate.includes('/')) {
        await access(candidate, fsConstants.X_OK);
      } else {
        await execAsync(`${candidate} --version`);
      }
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}
import { Logger } from '../core/logger.js';
import { TelegramAdapter } from '../interface/telegram.js';
import { WhatsAppAdapter } from '../interface/whatsapp.js';
import { runIntelPipelineDetailed } from '../intel/pipeline.js';
import { pruneChatMessages } from '../memory/chat.js';
import { listWatchlist } from '../memory/watchlist.js';
import { createMarketClient } from '../execution/market-client.js';
import { pruneIntel } from '../intel/store.js';
import { rankIntelAlerts } from '../intel/alerts.js';
import { TelegramChannelMonitor } from '../intel/telegram_monitor.js';
import { refreshMarketPrices, syncMarketCache } from '../core/markets_sync.js';
import { formatProactiveSummary, runProactiveSearch } from '../core/proactive_search.js';
import { buildAgentPeerSessionKey, resolveThreadSessionKeys } from './session_keys.js';
import { createAgentRegistry } from './agent_router.js';
import { createLlmClient } from '../core/llm.js';
import { installConsoleFileMirror } from '../core/unified-logging.js';
import { PositionHeartbeatService } from '../core/position_heartbeat.js';
import { resolveOutcomes } from '../core/resolver.js';
import { LlmExitConsultant } from '../core/llm_exit_consultant.js';
import { SchedulerControlPlane } from '../core/scheduler_control_plane.js';
import type { ScheduleDefinition } from '../core/scheduler_control_plane.js';
import { EscalationPolicyEngine } from './escalation.js';
import {
  createAlert,
  markAlertSent,
  recordAlertDelivery,
  suppressAlert,
} from '../memory/alerts.js';
import {
  createScheduledTask,
  deactivateScheduledTask,
  getScheduledTaskById,
  listActiveScheduledTasks,
  listScheduledTasksByRecipient,
  markScheduledTaskRan,
} from '../memory/scheduled_tasks.js';
import {
  formatScheduledTaskHelp,
  parseScheduledTaskAction,
} from './scheduled_task_commands.js';
import {
  buildScheduledTaskInstruction,
  describeSchedule,
  formatScheduleTarget,
  formatUtcDateTime,
} from './scheduled_task_format.js';
import { enrichEscalationMessage } from './alert_enrichment.js';
import { EventScanTriggerCoordinator } from '../core/event_scan_trigger.js';
import { handleDashboardPageRequest } from './dashboard_page.js';
import { handleDashboardApiRequest } from './dashboard_api.js';

const config = loadConfig();
try {
  const enabled =
    String(process.env.THUFIR_LOG_MIRROR ?? '').trim() === '1' ||
    String(process.env.THUFIR_LOG_FILE ?? '').trim().length > 0;
  if (enabled) {
    const filePath = String(process.env.THUFIR_LOG_FILE ?? '').trim() || '~/.thufir/logs/thufir.log';
    installConsoleFileMirror({ filePath });
  }
} catch {
  // Best-effort: never block startup due to logging.
}
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
const primaryAgent = defaultAgent;

const telegram = config.channels.telegram.enabled ? new TelegramAdapter(config) : null;
const whatsapp = config.channels.whatsapp.enabled ? new WhatsAppAdapter(config) : null;
const escalationPolicy = new EscalationPolicyEngine(config.notifications?.escalation);
const eventScanTrigger = new EventScanTriggerCoordinator({
  enabled: config.autonomy?.eventDriven ?? false,
  cooldownMs: Math.max(0, Number(config.autonomy?.eventDrivenCooldownSeconds ?? 120)) * 1000,
});

// Set by the heartbeat block below; called from maybeRunEventDrivenScan when eventDrivenHeartbeat is on.
let _triggerHeartbeat: (() => Promise<void>) | null = null;

async function maybeRunEventDrivenScan(source: 'intel' | 'proactive', itemCount: number): Promise<void> {
  const minItems = Math.max(1, Number(config.autonomy?.eventDrivenMinItems ?? 1));
  const decision = eventScanTrigger.tryAcquire({
    eventKey: source,
    itemCount,
    minItems,
  });
  if (!decision.allowed) {
    logger.info(
      `Event-driven scan skipped (${source}): ${decision.reason}${
        decision.waitMs != null ? ` waitMs=${decision.waitMs}` : ''
      }`
    );
    return;
  }
  const startedAt = Date.now();
  const scanResult = await primaryAgent.getAutonomous().runScan();
  logger.info(
    `Event-driven scan executed (${source}) in ${Date.now() - startedAt}ms: ${scanResult}`
  );
  if (config.autonomy?.eventDrivenHeartbeat && _triggerHeartbeat) {
    logger.info(`Event-driven heartbeat triggered (${source})`);
    await _triggerHeartbeat().catch((err: unknown) => {
      logger.error('Event-driven heartbeat failed', err);
    });
  }
}

for (const instance of agentRegistry.agents.values()) {
  instance.start();
}

if (telegram) {
  const telegramNotify = async (message: string) => {
    for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
      await telegram.sendMessage(String(chatId), message);
    }
  };
  primaryAgent.getAutonomous().setNotify(telegramNotify);
}

const positionHeartbeatConfig = config.heartbeat;
if (positionHeartbeatConfig?.enabled) {
  try {
    const heartbeatNotify = telegram
      ? async (message: string) => {
          for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
            await telegram.sendMessage(String(chatId), `⚠️ ${message}`);
          }
        }
      : undefined;
    const exitConsultant =
      config.heartbeat?.llmExitConsult?.enabled !== false
        ? new LlmExitConsultant(
            primaryAgent.getLlm(),
            primaryAgent.getInfoLlm() ?? primaryAgent.getLlm(),
            heartbeatNotify ?? (async () => {}),
            config
          )
        : undefined;

    const service = new PositionHeartbeatService(config, primaryAgent.getToolContext(), logger, {
      notify: heartbeatNotify,
      exitConsultant,
    });
    service.start();
  } catch (error) {
    logger.error('PositionHeartbeat failed to start', error);
  }
}

// Market cache is refreshed on schedule (no websocket stream configured).

function stripIdentityIntro(text: string): string {
  // The model sometimes prepends a redundant identity line. Strip only at the start.
  // Keep this narrow to avoid accidentally removing real content.
  return text
    .replace(/^\s*(I['’]m|I am)\s+Thufir\s+Hawat\.\s*(\r?\n)+/i, '')
    .replace(/^\s*(I['’]m|I am)\s+Thufir\s+Hawat\.\s*/i, '');
}

let lastInteractiveMessageAtMs = 0;

function isWithinActiveChatWindow(seconds: number | undefined): boolean {
  const windowSeconds = Math.max(0, Number(seconds ?? 0));
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return false;
  }
  return Date.now() - lastInteractiveMessageAtMs < windowSeconds * 1000;
}

async function sendChannelReply(
  message: {
    channel: 'telegram' | 'whatsapp' | 'cli';
    senderId: string;
  },
  reply: string,
  label: string = 'reply'
): Promise<void> {
  if (message.channel === 'telegram' && telegram) {
    try {
      await telegram.sendMessage(message.senderId, reply);
      logger.info(`Telegram ${label} sent to ${message.senderId}`);
    } catch (error) {
      logger.error(`Telegram ${label} failed for ${message.senderId}`, error);
    }
  }
  if (message.channel === 'whatsapp' && whatsapp) {
    try {
      await whatsapp.sendMessage(message.senderId, reply);
      logger.info(`WhatsApp ${label} sent to ${message.senderId}`);
    } catch (error) {
      logger.error(`WhatsApp ${label} failed for ${message.senderId}`, error);
    }
  }
}

function registerScheduledTaskJob(params: { jobName: string; taskId: string; schedule: ScheduleDefinition }) {
  scheduler.registerJob(
    {
      name: params.jobName,
      schedule: params.schedule,
      leaseMs: 120_000,
    },
    async () => {
      const rec = getScheduledTaskById(params.taskId);
      if (!rec || !rec.active || !rec.instruction) return;

      if (rec.scheduleKind === 'once' && rec.runAt) {
        const dueMs = Date.parse(rec.runAt);
        if (Number.isFinite(dueMs) && Date.now() < dueMs) {
          return;
        }
      }

      const sessionKey = buildAgentPeerSessionKey({
        agentId: agentRegistry.defaultAgentId,
        mainKey: config.session?.mainKey,
        channel: rec.channel as 'telegram' | 'whatsapp' | 'cli',
        peerKind: 'dm',
        peerId: rec.recipientId,
        dmScope: config.session?.dmScope,
        identityLinks: config.session?.identityLinks,
      });
      const scheduledPrompt = buildScheduledTaskInstruction(rec);
      const result = await primaryAgent.handleMessage(sessionKey, scheduledPrompt);
      const header = '📌 Scheduled task delivery';
      const scheduledFor = `Scheduled for (UTC): ${formatScheduleTarget(rec)}`;
      const deliveredAt = `Delivered at (UTC): ${formatUtcDateTime(new Date().toISOString())}`;
      await sendChannelReply(
        { channel: rec.channel as 'telegram' | 'whatsapp' | 'cli', senderId: rec.recipientId },
        `${header}\n${scheduledFor}\n${deliveredAt}\nTask: ${rec.instruction}\n\n${result}`,
        'scheduled task'
      );
      markScheduledTaskRan(rec.id);
      if (rec.scheduleKind === 'once') {
        deactivateScheduledTask(rec.id);
      }
    }
  );
}

async function maybeHandleScheduledTaskAction(message: {
  channel: 'telegram' | 'whatsapp' | 'cli';
  senderId: string;
  text: string;
}): Promise<string | null> {
  const action = parseScheduledTaskAction(message.text);
  if (action.kind === 'none') return null;

  if (action.kind === 'help') {
    return formatScheduledTaskHelp();
  }

  if (action.kind === 'schedule_intent_without_parse') {
    return `${formatScheduledTaskHelp()}\n\nI detected scheduling intent but couldn't parse the time exactly.`;
  }

  if (action.kind === 'list') {
    const rows = listScheduledTasksByRecipient({
      channel: message.channel,
      recipientId: message.senderId,
    });
    if (rows.length === 0) {
      return 'No scheduled tasks configured.';
    }
    return [
      'Scheduled tasks:',
      ...rows.map(
        (row) =>
          `- ${row.id.slice(0, 8)} | ${row.active ? 'active' : 'inactive'} | ${describeSchedule(row)} | ${row.instruction}`
      ),
    ].join('\n');
  }

  if (action.kind === 'cancel') {
    const rows = listScheduledTasksByRecipient({
      channel: message.channel,
      recipientId: message.senderId,
    });
    const target = rows.find(
      (row) => row.id === action.id || row.id.startsWith(action.id)
    );
    if (!target) {
      return `No scheduled task found for id ${action.id}.`;
    }
    const ok = deactivateScheduledTask(target.id);
    return ok ? `Cancelled scheduled task ${target.id.slice(0, 8)}.` : `Scheduled task ${target.id.slice(0, 8)} was already inactive.`;
  }

  if (action.kind === 'create') {
    const shortId = Math.random().toString(36).slice(2, 10);
    const jobName = `gateway:${schedulerNamespace}:scheduled-task:${shortId}`;
    const schedule: ScheduleDefinition =
      action.scheduleKind === 'daily'
        ? { kind: 'daily', time: action.dailyTime ?? '00:00' }
        : {
            kind: 'interval',
            intervalMs:
              action.scheduleKind === 'interval'
                ? Math.max(1, action.intervalMinutes ?? 30) * 60 * 1000
                : 5 * 1000,
          };

    const rec = createScheduledTask({
      schedulerJobName: jobName,
      channel: message.channel,
      recipientId: message.senderId,
      scheduleKind: action.scheduleKind,
      runAt: action.runAtIso ?? null,
      dailyTime: action.dailyTime ?? null,
      intervalMinutes: action.intervalMinutes ?? null,
      instruction: action.instruction,
    });
    registerScheduledTaskJob({ jobName, taskId: rec.id, schedule });
    hasSchedulerJobs = true;
    return `Scheduled task created (${rec.id.slice(0, 8)}): ${describeSchedule(rec)}.\nTask: ${action.instruction}`;
  }

  return null;
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
  if (message.senderId !== '__heartbeat__') {
    lastInteractiveMessageAtMs = Date.now();
  }
  let lastProgressMessage = '';
  let lastProgressAt = 0;
  const sendProgress = async (text: string): Promise<void> => {
    if (!text || text.trim().length === 0) return;
    if (message.channel !== 'telegram' || !telegram) return;
    const now = Date.now();
    if (text === lastProgressMessage) return;
    if (now - lastProgressAt < 3_000) return;
    lastProgressMessage = text;
    lastProgressAt = now;
    try {
      await telegram.sendMessage(message.senderId, text);
      logger.info(`Telegram progress sent to ${message.senderId}: ${text}`);
    } catch (error) {
      logger.warn(`Telegram progress failed for ${message.senderId}`, error);
    }
  };
  const scheduledReply = await maybeHandleScheduledTaskAction(message);
  if (scheduledReply) {
    await sendChannelReply(message, scheduledReply);
    return;
  }
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
  const replyRaw = await activeAgent.handleMessage(session, message.text, sendProgress);
  const reply = stripIdentityIntro(replyRaw);
  if (!reply || reply.trim().length === 0) {
    logger.warn(`Empty reply for ${message.channel}:${message.senderId}`);
    return;
  }
  await sendChannelReply(message, reply);
};

const schedulerSeed = config.memory?.dbPath ?? config.agent?.workspace ?? 'default';
const schedulerNamespace = Buffer.from(schedulerSeed).toString('base64url').slice(0, 16);
const scheduler = new SchedulerControlPlane({
  ownerId: `gateway:${process.pid}:${schedulerNamespace}`,
  pollIntervalMs: 1_000,
});
let hasSchedulerJobs = false;

for (const rec of listActiveScheduledTasks()) {
  const schedule: ScheduleDefinition =
    rec.scheduleKind === 'daily'
      ? { kind: 'daily', time: rec.dailyTime ?? '00:00' }
      : {
          kind: 'interval',
          intervalMs:
            rec.scheduleKind === 'interval'
              ? Math.max(1, rec.intervalMinutes ?? 30) * 60 * 1000
              : 5 * 1000,
        };
  registerScheduledTaskJob({
    jobName: rec.schedulerJobName,
    taskId: rec.id,
    schedule,
  });
  hasSchedulerJobs = true;
}

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

    const message = await primaryAgent.generateBriefing();
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

const intelFetchConfig = config.notifications?.intelFetch;
if (intelFetchConfig?.enabled) {
  scheduler.registerJob(
    {
      name: `gateway:${schedulerNamespace}:intel`,
      schedule: { kind: 'daily', time: intelFetchConfig.time },
      leaseMs: 120_000,
    },
    async () => {
      try {
        const result = await runIntelPipelineDetailed(config);
        logger.info(`Intel fetch stored ${result.storedCount} item(s).`);

        await maybeRunEventDrivenScan('intel', result.storedCount);

        const alertsConfig = config.notifications?.intelAlerts;
        if (alertsConfig?.enabled && result.storedItems.length > 0) {
          await sendIntelAlerts(result.storedItems, alertsConfig);
        }
      } catch (error) {
        logger.error('Intel fetch failed', error);
        throw error;
      }
    }
  );
  hasSchedulerJobs = true;
}

const marketSyncConfig = config.notifications?.marketSync;
let lastMarketSyncDate = '';
if (marketSyncConfig?.enabled) {
  const runMarketSync = async () => {
    try {
      const result = await syncMarketCache(config, marketSyncConfig.limit);
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
      const suppressLlm =
        proactiveConfig.suppressLlmDuringActiveChatSeconds != null &&
        isWithinActiveChatWindow(proactiveConfig.suppressLlmDuringActiveChatSeconds);
      const result = await runProactiveSearch(config, {
        maxQueries: proactiveConfig.maxQueries,
        iterations: proactiveConfig.iterations,
        watchlistLimit: proactiveConfig.watchlistLimit,
        useLlm: suppressLlm ? false : proactiveConfig.useLlm,
        recentIntelLimit: proactiveConfig.recentIntelLimit,
        extraQueries: proactiveConfig.extraQueries,
        includeLearnedQueries: proactiveConfig.includeLearnedQueries,
        learnedQueryLimit: proactiveConfig.learnedQueryLimit,
        webLimitPerQuery: proactiveConfig.webLimitPerQuery,
        fetchPerQuery: proactiveConfig.fetchPerQuery,
        fetchMaxChars: proactiveConfig.fetchMaxChars,
      });
      logger.info(`Proactive search stored ${result.storedCount} item(s).`);
      if (suppressLlm) {
        logger.info('Proactive LLM refinement suppressed due to active chat window');
      }
      await maybeRunEventDrivenScan('proactive', result.storedCount);

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
    'Do not infer or repeat old tasks from prior chats. ' +
    'For perp price/state checks, use exchange-native tools first (get_positions + perp_market_get/perp_market_list). ' +
    'Do not treat web search/proactive intel failures as a blocker for risk management of existing positions. ' +
    'If you execute any action, start the first line with "HEARTBEAT_ACTION:". ' +
    'If nothing needs attention, reply HEARTBEAT_OK.';

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
    const suppressHeartbeatLlm =
      heartbeatConfig.suppressLlmDuringActiveChatSeconds != null &&
      isWithinActiveChatWindow(heartbeatConfig.suppressLlmDuringActiveChatSeconds);
    let proactiveSummary = '';
    if (proactiveConfig?.enabled && proactiveConfig.mode === 'heartbeat') {
      try {
        const suppressProactiveLlm =
          proactiveConfig.suppressLlmDuringActiveChatSeconds != null &&
          isWithinActiveChatWindow(proactiveConfig.suppressLlmDuringActiveChatSeconds);
        const result = await runProactiveSearch(config, {
          maxQueries: proactiveConfig.maxQueries,
          iterations: proactiveConfig.iterations,
          watchlistLimit: proactiveConfig.watchlistLimit,
          useLlm: suppressProactiveLlm ? false : proactiveConfig.useLlm,
          recentIntelLimit: proactiveConfig.recentIntelLimit,
          extraQueries: proactiveConfig.extraQueries,
          includeLearnedQueries: proactiveConfig.includeLearnedQueries,
          learnedQueryLimit: proactiveConfig.learnedQueryLimit,
          webLimitPerQuery: proactiveConfig.webLimitPerQuery,
          fetchPerQuery: proactiveConfig.fetchPerQuery,
          fetchMaxChars: proactiveConfig.fetchMaxChars,
        });
        const titles = result.storedItems
          .map((item) => item.title)
          .filter((title): title is string => typeof title === 'string')
          .slice(0, 5);
        proactiveSummary = [
          `Proactive search stored ${result.storedCount} item(s).`,
          `Rounds: ${result.rounds}`,
          result.learnedSeedQueries.length > 0
            ? `Learned seeds: ${result.learnedSeedQueries.slice(0, 5).join('; ')}`
            : '',
          result.queries.length > 0 ? `Queries: ${result.queries.join('; ')}` : '',
          titles.length > 0 ? `Top items: ${titles.join(' | ')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        if (suppressProactiveLlm) {
          logger.info('Heartbeat proactive LLM refinement suppressed due to active chat window');
        }
        await maybeRunEventDrivenScan('proactive', result.storedCount);
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
    if (suppressHeartbeatLlm) {
      logger.info('Heartbeat LLM message generation suppressed due to active chat window');
      return;
    }
    const response = await primaryAgent.handleMessage(heartbeatUserId, prompt);
    if (!response || response.trim().length === 0) {
      return;
    }
    const summary = response.replace(/\s+/g, ' ').trim().slice(0, 240);
    logger.info(`Heartbeat response summary: ${summary}`);
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

  // Expose for event-driven triggering (must be after runHeartbeat is defined)
  _triggerHeartbeat = async () => runHeartbeat();

  scheduler.registerJob(
    {
      name: `gateway:${schedulerNamespace}:heartbeat`,
      schedule: { kind: 'interval', intervalMs },
      leaseMs: Math.max(30_000, intervalMs),
    },
    async () => {
      try {
        await runHeartbeat();
      } catch (error) {
        logger.error('Heartbeat failed', error);
        throw error;
      }
    }
  );
  hasSchedulerJobs = true;
}

const resolverConfig = config.notifications?.resolver;
if (resolverConfig?.enabled) {
  const resolverIntervalMs = Math.max(60_000, (resolverConfig.intervalSeconds ?? 900) * 1000);
  scheduler.registerJob(
    {
      name: `gateway:${schedulerNamespace}:resolver`,
      schedule: { kind: 'interval', intervalMs: resolverIntervalMs },
      leaseMs: 60_000,
    },
    async () => {
      const updated = await resolveOutcomes(config, resolverConfig.limit ?? 50);
      if (updated > 0) {
        logger.info(`Resolver: resolved ${updated} prediction(s).`);
      }
    }
  );
  hasSchedulerJobs = true;
}

if (hasSchedulerJobs) {
  scheduler.start();
}

const mentatConfig = config.notifications?.mentat;
if (mentatConfig?.enabled) {
  const llm = createLlmClient(config);
  const mentatMarketClient = createMarketClient(config);
  const escalationConfig = config.notifications?.escalation;

  const sendMentatMessage = async (
    channels: string[],
    message: string
  ): Promise<Array<{ channel: string; status: 'sent' | 'failed'; error?: string }>> => {
    const outcomes: Array<{ channel: string; status: 'sent' | 'failed'; error?: string }> = [];
    if (channels.includes('telegram') && telegram) {
      for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
        try {
          await telegram.sendMessage(String(chatId), message);
          logger.info(`Telegram mentat alert sent to ${chatId}`);
          outcomes.push({ channel: 'telegram', status: 'sent' });
        } catch (error) {
          logger.error(`Telegram mentat alert failed for ${chatId}`, error);
          outcomes.push({
            channel: 'telegram',
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (channels.includes('whatsapp') && whatsapp) {
      for (const number of config.channels.whatsapp.allowedNumbers ?? []) {
        try {
          await whatsapp.sendMessage(number, message);
          logger.info(`WhatsApp mentat alert sent to ${number}`);
          outcomes.push({ channel: 'whatsapp', status: 'sent' });
        } catch (error) {
          logger.error(`WhatsApp mentat alert failed for ${number}`, error);
          outcomes.push({
            channel: 'whatsapp',
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return outcomes;
  };

  if (!mentatMarketClient.isAvailable()) {
    logger.warn('Mentat notifications disabled: market client not configured.');
  } else {
    const schedules =
      mentatConfig.schedules && mentatConfig.schedules.length > 0
        ? mentatConfig.schedules
        : [
            {
              name: 'default',
              time: mentatConfig.time,
              intervalMinutes: mentatConfig.intervalMinutes,
              channels: mentatConfig.channels,
              system: mentatConfig.system,
              marketQuery: mentatConfig.marketQuery,
              marketLimit: mentatConfig.marketLimit,
              intelLimit: mentatConfig.intelLimit,
              minOverallScore: mentatConfig.minOverallScore,
              minDeltaScore: mentatConfig.minDeltaScore,
            },
          ];

    const lastMentatDateBySchedule = new Map<string, string>();
    const lastMentatRunAtBySchedule = new Map<string, string>();

    const runMentatMonitor = async (schedule: {
      name?: string;
      time?: string;
      intervalMinutes?: number;
      channels?: string[];
      system?: string;
      marketQuery?: string;
      marketLimit?: number;
      intelLimit?: number;
      minOverallScore?: number;
      minDeltaScore?: number;
    }) => {
      const { runMentatScan } = await import('../mentat/scan.js');
      const { generateMentatReport, formatMentatReport } = await import('../mentat/report.js');
      const { listFragilityCardDeltas } = await import('../memory/mentat.js');

      const system = schedule.system ?? mentatConfig.system ?? 'Markets';
      const marketQuery = schedule.marketQuery ?? mentatConfig.marketQuery;
      const marketLimit = schedule.marketLimit ?? mentatConfig.marketLimit;
      const intelLimit = schedule.intelLimit ?? mentatConfig.intelLimit;
      const minOverallScore = schedule.minOverallScore ?? mentatConfig.minOverallScore ?? 0.7;
      const minDeltaScore = schedule.minDeltaScore ?? mentatConfig.minDeltaScore ?? 0.15;
      const scheduleId = schedule.name ?? `${system}-${marketQuery ?? 'all'}`;

      const scan = await runMentatScan({
        system,
        llm,
        config,
        marketClient: mentatMarketClient,
        marketQuery,
        limit: marketLimit,
        intelLimit,
      });

      const report = generateMentatReport({
        system: scan.system,
        detectors: scan.detectors,
      });
      const reportText = formatMentatReport(report);

      const deltas = listFragilityCardDeltas({ limit: 100 }).filter((delta) => {
        const lastRunAt = lastMentatRunAtBySchedule.get(scheduleId);
        return lastRunAt ? delta.changedAt > lastRunAt : true;
      });
      const maxDelta = deltas.reduce((max, delta) => {
        const value = delta.scoreDelta ?? 0;
        return value > max ? value : max;
      }, 0);

      const triggerOverall = (report.fragilityScore ?? 0) >= minOverallScore;
      const triggerDelta = maxDelta >= minDeltaScore;
      if (!(triggerOverall || triggerDelta)) {
        lastMentatRunAtBySchedule.set(scheduleId, new Date().toISOString());
        return;
      }

      const fragilityScore = report.fragilityScore ?? 0;
      const header =
        `⚠️ Mentat Alert: ${scan.system}\n` +
        `Fragility Score: ${(fragilityScore * 100).toFixed(1)}%\n` +
        `Max Score Delta: ${(maxDelta * 100).toFixed(1)}%`;
      const message = `${header}\n\n${reportText}`;
      const channels =
        schedule.channels && schedule.channels.length > 0
          ? schedule.channels
          : (mentatConfig.channels ?? []);

      const enrichAlert = async (baseMessage: string, severity: 'high' | 'critical') =>
        enrichEscalationMessage({
          llm,
          baseMessage,
          source: `mentat:${scheduleId}`,
          reason: 'high_conviction_setup',
          severity,
          summary:
            `${scan.system} triggered with fragility ${(fragilityScore * 100).toFixed(1)}% ` +
            `and max delta ${(maxDelta * 100).toFixed(1)}%`,
          config: escalationConfig?.llmEnrichment,
          onFallback: (error: unknown) => {
            logger.warn('Alert LLM enrichment failed; sending mechanical fallback', {
              source: `mentat:${scheduleId}`,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        });

      if (escalationConfig?.enabled) {
        const severity =
          fragilityScore >= Math.max(minOverallScore + 0.1, 0.9) ||
          maxDelta >= Math.max(minDeltaScore + 0.15, 0.3)
            ? 'critical'
            : 'high';
        const decision = escalationPolicy.evaluate({
          source: `mentat:${scheduleId}`,
          reason: 'high_conviction_setup',
          severity,
          dedupeKey: `mentat:${scheduleId}:high_conviction_setup`,
          summary:
            `${scan.system} triggered with fragility ${(fragilityScore * 100).toFixed(1)}% ` +
            `and max delta ${(maxDelta * 100).toFixed(1)}%`,
          message,
        });
        const alertId = createAlert({
          dedupeKey: decision.dedupeKey,
          source: `mentat:${scheduleId}`,
          reason: 'high_conviction_setup',
          severity,
          summary:
            `${scan.system} triggered with fragility ${(fragilityScore * 100).toFixed(1)}% ` +
            `and max delta ${(maxDelta * 100).toFixed(1)}%`,
          message: decision.message,
          metadata: {
            scheduleId,
            fragilityScore,
            maxDelta,
          },
        });
        if (decision.shouldSend) {
          const enrichedMessage = await enrichAlert(decision.message, severity);
          const outcomes = await sendMentatMessage(decision.channels, enrichedMessage);
          let hasSent = false;
          for (const outcome of outcomes) {
            recordAlertDelivery({
              alertId,
              channel: outcome.channel,
              status: outcome.status,
              error: outcome.error ?? null,
            });
            if (outcome.status === 'sent') {
              hasSent = true;
            }
          }
          if (hasSent) {
            markAlertSent({
              alertId,
              reasonCode: 'delivery_success',
              metadata: { channels: decision.channels },
            });
          }
        } else {
          suppressAlert({
            alertId,
            reasonCode: decision.suppressionReason ?? 'unknown',
            metadata: {
              channels: decision.channels,
            },
          });
          logger.info(`Escalation suppressed (${decision.suppressionReason ?? 'unknown'})`, {
            dedupeKey: decision.dedupeKey,
            source: `mentat:${scheduleId}`,
          });
        }
      } else {
        const severity =
          fragilityScore >= Math.max(minOverallScore + 0.1, 0.9) ||
          maxDelta >= Math.max(minDeltaScore + 0.15, 0.3)
            ? 'critical'
            : 'high';
        const enrichedMessage = await enrichAlert(message, severity);
        await sendMentatMessage(channels, enrichedMessage);
      }

      lastMentatRunAtBySchedule.set(scheduleId, new Date().toISOString());
    };

    for (const schedule of schedules) {
      if (schedule.intervalMinutes && schedule.intervalMinutes > 0) {
        setInterval(() => {
          runMentatMonitor(schedule).catch((error) => logger.error('Mentat monitor failed', error));
        }, schedule.intervalMinutes * 60 * 1000);
        continue;
      }

      setInterval(() => {
        const now = new Date();
        const time = schedule.time ?? mentatConfig.time;
        if (!time) return;
        const [hours, minutes] = time.split(':').map((part) => Number(part));
        if (Number.isNaN(hours) || Number.isNaN(minutes)) {
          return;
        }
        const today = now.toISOString().split('T')[0]!;
        const scheduleId =
          schedule.name ??
          `${schedule.system ?? mentatConfig.system ?? 'system'}-${schedule.marketQuery ?? 'all'}`;
        const lastDate = lastMentatDateBySchedule.get(scheduleId);
        if (lastDate === today) {
          return;
        }
        if (now.getHours() !== hours || now.getMinutes() !== minutes) {
          return;
        }
        runMentatMonitor(schedule).catch((error) => logger.error('Mentat monitor failed', error));
        lastMentatDateBySchedule.set(scheduleId, today);
      }, 60_000);
    }
  }
}

const dailyReportConfig = config.notifications?.dailyReport;
if (dailyReportConfig?.enabled) {
  primaryAgent.getAutonomous().on('daily-report', async (report) => {
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
      const qmdCommand = await resolveQmdCommand();
      if (!qmdCommand) {
        return;
      }
      // Run embedding update for all collections
      const { stderr } = await execAsync(`${JSON.stringify(qmdCommand)} embed`, { timeout: 300_000 });
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
    try {
      await onIncoming(msg);
    } catch (error) {
      logger.error(`Telegram message handling failed for ${msg.senderId}`, error);
    }
  });
}

// Telegram channel monitor — reads public channels via MTProto user session.
// Only starts when channels.telegram.monitor.enabled = true and sessionString is set.
if (config.channels?.telegram?.monitor?.enabled) {
  const channelMonitor = new TelegramChannelMonitor(
    config,
    async (itemCount, text, source) => {
      if (config.channels.telegram.monitor?.eventDrivenScanEnabled !== false) {
        await maybeRunEventDrivenScan('intel', itemCount);
      }

      // Pre-screen with local trivial LLM — skip if not market-relevant.
      const infoLlm = primaryAgent.getInfoLlm() ?? primaryAgent.getLlm();
      let relevant = false;
      try {
        const screen = await infoLlm.complete([
          {
            role: 'user',
            content:
              `Relevance filter for a trading system. Does this news have a direct, immediate impact on tradeable assets (crypto perps, oil, gold, FX)?\n\nNews: ${text.slice(0, 500)}\n\nReply YES or NO only.`,
          },
        ], { temperature: 0 });
        relevant = screen.content.trim().toUpperCase().startsWith('YES');
      } catch {
        return;
      }

      if (!relevant || !telegram) return;

      const prompt =
        `Breaking news from @${source}:\n\n${text}\n\n` +
        `You are a trader managing your own book. Assess this headline against YOUR open positions using get_positions and intel_recent. ` +
        `For each position you hold, state whether this headline changes your thesis and what you intend to do about it. ` +
        `Do not suggest trades for others — reason from your actual book. ` +
        `If you hold no positions and the headline has no direct implication for your watchlist, reply BREAKING_OK.`;
      try {
        const response = await primaryAgent.handleMessage('__channel_monitor__', prompt);
        if (!response?.trim() || response.trim().toUpperCase().startsWith('BREAKING_OK')) return;
        for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
          await telegram.sendMessage(String(chatId), response).catch(() => {});
        }
      } catch (err) {
        logger.warn('TelegramChannelMonitor: briefing call failed', err);
      }
    },
  );

  channelMonitor.start().catch((err) => {
    logger.error('TelegramChannelMonitor: failed to start', err);
  });
}

// No native market stream configured; rely on cache refresh schedules instead.

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

  const marketClient = createMarketClient(config);
  if (!marketClient.isAvailable()) {
    return;
  }
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

  (req as typeof req & { thufirConfig?: typeof config }).thufirConfig = config;
  if (handleDashboardApiRequest(req, res)) {
    return;
  }

  if (handleDashboardPageRequest(req, res)) {
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
