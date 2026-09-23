import { randomUUID } from 'node:crypto';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';

import { Logger } from '../core/logger.js';
import type { ThufirConfig } from '../core/config.js';
import { storeIntel } from './store.js';
import type { NewsActivation } from './news_activation.js';

// ---------------------------------------------------------------------------
// Breaking-news keyword set (hardcoded baseline + configurable extras)
// ---------------------------------------------------------------------------

const BREAKING_KEYWORDS = new Set([
  // Geopolitical / military
  'blockad', 'sanction', 'invad', 'invasion', 'war', 'ceasefire',
  'nuclear', 'explos', 'attack', 'missile', 'coup', 'assassin',
  'emergency', 'breaking', 'halt', 'ban', 'freeze',
  'collapse', 'arrested', 'indicted', 'tariff', 'escalat',
  'sabotage',

  // Macro / monetary policy
  'fomc', 'rate hike', 'rate cut', 'rate decision', 'federal reserve',
  'inflation', 'cpi', 'pce', 'nfp', 'non-farm', 'unemployment',
  'recession', 'stagflation', 'gdp', 'debt ceiling', 'default',
  'quantitative', 'balance sheet', 'pivot', 'powell', 'lagarde',
  'devaluat', 'imf rescue', 'capital control',

  // Market structure shocks
  'circuit breaker', 'trading halt', 'margin call', 'liquidat',
  'flash crash', 'contagion', 'bank run', 'bail', 'insolvenc',
  'bankruptcy', 'chapter 11', 'seized', 'nationali',
  'squeeze',

  // Energy / commodities
  'opec', 'oil embargo', 'supply cut', 'pipeline',
  'production cut', 'output cut',

  // Shipping / chokepoints
  'strait', 'hormuz', 'suez', 'red sea', 'houthi', 'tanker',
  'outage',

  // Weather shocks
  'drought', 'flood', 'frost', 'heatwave', 'hurricane', 'el niño',

  // Animal disease / agri supply
  'outbreak', 'avian flu', 'bird flu', 'swine fever',

  // Export controls
  'export ban', 'export control', 'export restriction',

  // Labor disruptions
  'strike',
]);

const POLL_INTERVAL_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// TelegramChannelMonitor
// ---------------------------------------------------------------------------

/**
 * Monitors one or more Telegram channels via MTProto user API (gramjs).
 *
 * On every new message:
 *   1. Stores the post as a `social` intel item (deduped by title+URL hash).
 *   2. If the text contains a breaking-news keyword, invokes `onBreakingNews`
 *      so the caller (gateway) can fire an immediate event-driven scan.
 *
 * Delivery strategy (two complementary paths):
 *   - Event handler (bonus): gramjs NewMessage fires for channels where the
 *     MTProto server happens to push updates.  Unreliable for infrequently-
 *     active channels or cold sessions.
 *   - Polling (primary): every 60 s, getMessages(entity, { limit: 20 }) is
 *     called for each monitored channel.  Catches everything the event path
 *     misses; storeIntel dedup prevents double-counting.
 *
 * Auth: requires a Telegram API ID, API hash, and a pre-generated session
 * string.  Run `scripts/telegram_monitor_auth.ts` once to obtain the string.
 */
export class TelegramChannelMonitor {
  private client: TelegramClient | null = null;
  private logger = new Logger('info');
  private stopped = false;
  /** channelId (bigint) → display username, populated at start() */
  private channelMap: Map<bigint, string> = new Map();
  /** username → resolved entity object, used for polling */
  private entityObjects: Map<string, any> = new Map();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private config: ThufirConfig,
    /** Called when a breaking-news message is stored; receives the raw text and source. */
    private onBreakingNews: (itemCount: number, text: string, source: string, activation: NewsActivation) => Promise<void>,
  ) {}

  isConfigured(): boolean {
    const m = this.config.channels?.telegram?.monitor;
    return !!(
      m?.enabled &&
      m.apiId &&
      m.apiHash &&
      m.sessionString &&
      (m.channels?.length ?? 0) > 0
    );
  }

  async start(): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.info('TelegramChannelMonitor: not configured, skipping');
      return;
    }

    const m = this.config.channels.telegram.monitor!;
    const channels = (m.channels ?? []).map((c) => c.replace(/^@/, ''));
    const extraKeywords = (m.breakingNewsKeywords ?? []).map((k) => k.toLowerCase());
    const allKeywords: Set<string> = new Set([...BREAKING_KEYWORDS, ...extraKeywords]);

    const session = new StringSession(m.sessionString);
    this.client = new TelegramClient(session, m.apiId!, m.apiHash!, {
      connectionRetries: 5,
      retryDelay: 1000,
      autoReconnect: true,
    });

    await this.client.connect();

    // Resolve each channel username → entity ID now, while we have the username
    // to look up by.  Incoming updates only carry a numeric channelId in peerId;
    // resolving by ID alone fails on a cold session because the access hash is
    // missing.  Resolving by username always works and caches the entity.
    this.channelMap = new Map();
    this.entityObjects = new Map();
    for (const ch of channels) {
      try {
        const entity = await this.client.getEntity(ch) as any;
        const id: bigint | number | undefined = entity?.id;
        if (id != null) {
          this.channelMap.set(BigInt(id), ch);
          this.entityObjects.set(ch, entity);
          this.logger.info(`TelegramChannelMonitor: resolved @${ch} → id=${id}`);
        } else {
          this.logger.warn(`TelegramChannelMonitor: entity for @${ch} has no id — messages may be missed`);
        }
      } catch (err) {
        this.logger.warn(`TelegramChannelMonitor: could not resolve @${ch}`, err);
      }
    }

    this.logger.info(`TelegramChannelMonitor: connected, monitoring [${channels.map((c) => '@' + c).join(', ')}]`);

    // Seed: fetch recent messages for each channel immediately so we start
    // from current state and avoid re-storing old posts on restart.
    await this.pollAll(allKeywords, /* seed */ true);

    // Poll every 60 s — primary delivery path for channels where MTProto push
    // is unreliable (e.g. infrequently active, cold session).
    const schedulePoll = () => {
      this.pollTimer = setTimeout(async () => {
        if (this.stopped) return;
        await this.pollAll(allKeywords, false).catch((err) =>
          this.logger.warn('TelegramChannelMonitor: poll error', err),
        );
        if (!this.stopped) schedulePoll();
      }, POLL_INTERVAL_MS);
    };
    schedulePoll();

    // Event handler: bonus path — fires immediately when MTProto pushes the
    // update.  No chats filter: gramJS resolves the filter at registration time
    // using only the entity cache; on a cold restart it silently drops the
    // filter and the handler never fires.  We match by channelId instead.
    this.client.addEventHandler(
      async (event: NewMessageEvent) => {
        if (this.stopped) return;
        try {
          await this.handleMessage(event, allKeywords);
        } catch (err) {
          this.logger.warn('TelegramChannelMonitor: message handler error', err);
        }
      },
      new NewMessage({}),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.client) {
      try { await this.client.disconnect(); } catch { /* best-effort */ }
      this.client = null;
    }
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private async pollAll(keywords: Set<string>, seed: boolean): Promise<void> {
    if (!this.client) return;
    for (const [username, entity] of this.entityObjects) {
      try {
        const msgs = await this.client.getMessages(entity, { limit: 20 }) as any[];
        let stored = 0;
        for (const msg of msgs) {
          const text: string = msg.message ?? msg.text ?? '';
          if (!text.trim()) continue;
          const isNew = await this.processMessage(text, username, keywords, seed);
          if (isNew) stored++;
        }
        if (!seed && stored > 0) {
          this.logger.info(`TelegramChannelMonitor: poll stored ${stored} new item(s) from @${username}`);
        }
      } catch (err) {
        this.logger.warn(`TelegramChannelMonitor: poll failed for @${username}`, err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event handler (bonus delivery path)
  // -------------------------------------------------------------------------

  private async handleMessage(
    event: NewMessageEvent,
    keywords: Set<string>,
  ): Promise<void> {
    const text: string = (event.message as any).message ?? (event.message as any).text ?? '';
    if (!text.trim()) return;

    // Match by channel ID — fast, no async, no entity-cache dependency.
    // peerId.channelId is present for channel messages; absent for DMs/groups.
    const rawChannelId = (event.message as any).peerId?.channelId;
    if (rawChannelId == null) return;
    const source = this.channelMap.get(BigInt(rawChannelId));
    if (!source) return; // not a monitored channel

    await this.processMessage(text, source, keywords, false);
  }

  // -------------------------------------------------------------------------
  // Core message processing (shared by poll + event paths)
  // -------------------------------------------------------------------------

  private async processMessage(
    text: string,
    source: string,
    keywords: Set<string>,
    seed: boolean,
  ): Promise<boolean> {
    const intelId = randomUUID();
    const receivedAtMs = Date.now();
    const isNew = storeIntel({
      id: intelId,
      title: text.slice(0, 120),
      content: text,
      source: `@${source}`,
      sourceType: 'social',
      category: 'market_news',
      timestamp: new Date(receivedAtMs).toISOString(),
    });

    if (!isNew) return false; // duplicate
    if (seed) return true; // seeding — store but don't trigger callbacks

    this.logger.info(`TelegramChannelMonitor: stored intel from @${source} (${text.length} chars)`);

    // Check for breaking-news keywords
    const lowerText = text.toLowerCase();
    const matched = [...keywords].find((k) => lowerText.includes(k));
    if (!matched) return true;

    this.logger.info(`TelegramChannelMonitor: breaking keyword "${matched}" → triggering event scan`);

    await this.onBreakingNews(1, text, source, {
      id: intelId,
      intelId,
      source: `@${source}`,
      text,
      receivedAtMs,
      matchedKeyword: matched,
    }).catch((err) =>
      this.logger.warn('TelegramChannelMonitor: event scan callback failed', err),
    );

    return true;
  }
}
