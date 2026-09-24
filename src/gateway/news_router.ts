import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import type { MarketClient } from '../execution/market-client.js';
import type { NewsActivation } from '../intel/news_activation.js';
import {
  claimNewsDispatch,
  countNewsDispatchesSince,
  ensureNewsRoutingSchema,
  finishNewsDispatch,
  hasRecentSimilarNewsScan,
  listPendingUrgentNews,
  mapNewsToTradableMarket,
  recordNewsRoute,
  type RoutineNewsDigest,
  setNewsRouteOutcome,
} from '../intel/news_routing.js';
import type { NewsScreen } from '../intel/news_screening.js';

export interface NewsScreenTerminal {
  intelId: string;
  source: string;
  activation?: NewsActivation;
  screen: NewsScreen;
  attempts: number;
}

export interface GatewayNewsRouterOptions {
  db?: Database.Database;
  rolloutMode: 'sampled_shadow' | 'full_shadow' | 'active';
  scansPerHour: number;
  marketClient: MarketClient;
  requestEventScan: (activation: NewsActivation) => Promise<boolean>;
}

export class GatewayNewsRouter {
  private draining = false;

  constructor(private readonly options: GatewayNewsRouterOptions) {
    ensureNewsRoutingSchema(options.db);
  }

  /** Keep this synchronous: the screening worker must be free to claim its next job. */
  onTerminal = (terminal: NewsScreenTerminal): void => {
    const relevance = terminal.screen.relevance;
    const urgency = terminal.screen.urgency;
    const legacyKeywordHit = Boolean(terminal.activation?.matchedKeyword);
    const mayRoute = this.options.rolloutMode === 'active' || legacyKeywordHit;
    const routeOutcome = relevance === 'irrelevant'
      ? 'irrelevant'
      : !mayRoute
        ? 'shadow_only'
        : urgency === 'routine'
          ? 'routine_pending'
          : 'pending';
    recordNewsRoute({
      intelId: terminal.intelId,
      relevance,
      urgency,
      rolloutMode: this.options.rolloutMode,
      legacyKeywordHit,
      routeOutcome,
    }, this.options.db);
  };

  async drainUrgent(limit = 5): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let dispatched = 0;
    try {
      const pending = listPendingUrgentNews(limit, this.options.db);
      if (pending.length === 0) return 0;
      let markets;
      let marketLoadError: unknown;
      try {
        if (!this.options.marketClient.isAvailable()) throw new Error('market client unavailable');
        markets = await this.options.marketClient.listMarkets(10_000);
      } catch (error) {
        marketLoadError = error;
      }
      for (const item of pending) {
        const source = item.source.startsWith('@') ? item.source : `@${item.source}`;
        const activation: NewsActivation = {
          id: item.intelId,
          intelId: item.intelId,
          source,
          text: item.content || item.title,
          receivedAtMs: Date.parse(item.receivedAt) || Date.now(),
        };
        if (marketLoadError || !markets) {
          setNewsRouteOutcome(item.intelId, 'market_mapping_failed', undefined, this.options.db);
          continue;
        }
        const market = mapNewsToTradableMarket(activation.text, markets);
        if (!market) {
          setNewsRouteOutcome(item.intelId, 'suppressed_unmapped_market', undefined, this.options.db);
          continue;
        }
        activation.text = `${activation.text.slice(0, 1000)}\nMapped tradable market: ${market.symbol ?? market.id}`;

        if (hasRecentSimilarNewsScan(item.title, 30 * 60_000, this.options.db)) {
          setNewsRouteOutcome(item.intelId, 'suppressed_duplicate_event', market.symbol ?? market.id, this.options.db);
          continue;
        }

        const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
        if (countNewsDispatchesSince('event_scan', hourAgo, this.options.db) >= Math.max(0, this.options.scansPerHour)) {
          setNewsRouteOutcome(item.intelId, 'suppressed_hourly_budget', market.symbol ?? market.id, this.options.db);
          continue;
        }
        const dispatchKey = claimNewsDispatch(item.intelId, 'event_scan', this.options.db);
        if (!dispatchKey) {
          setNewsRouteOutcome(item.intelId, 'dispatch_already_initiated', market.symbol ?? market.id, this.options.db);
          continue;
        }
        try {
          const started = await this.options.requestEventScan(activation);
          if (!started) {
            finishNewsDispatch(dispatchKey, 'suppressed', 'existing_event_cooldown', this.options.db);
            setNewsRouteOutcome(item.intelId, 'suppressed_event_cooldown', market.symbol ?? market.id, this.options.db);
            continue;
          }
          finishNewsDispatch(dispatchKey, 'completed', 'scan_requested', this.options.db);
          setNewsRouteOutcome(item.intelId, 'scan_requested', market.symbol ?? market.id, this.options.db);
          dispatched += 1;
        } catch (error) {
          // A throw can occur after a downstream scan started. Preserve the key
          // and surface uncertainty instead of retrying an external side effect.
          finishNewsDispatch(dispatchKey, 'uncertain', error instanceof Error ? error.message : String(error), this.options.db);
          setNewsRouteOutcome(item.intelId, 'scan_outcome_uncertain', market.symbol ?? market.id, this.options.db);
        }
      }
    } finally {
      this.draining = false;
    }
    return dispatched;
  }

  async runRoutineBriefing(input: {
    digest: RoutineNewsDigest;
    scanResult: string;
    recipients: string[];
    assess: (digest: RoutineNewsDigest, scanResult: string) => Promise<string>;
    send: (recipient: string, message: string) => Promise<void>;
  }): Promise<'no_impact' | 'sent' | 'uncertain' | 'no_recipients'> {
    if (input.digest.references.length === 0) return 'no_impact';
    const cycleId = createHash('sha256')
      .update(input.digest.references.map((item) => item.intelId).join('|'))
      .digest('hex');
    const assessment = (await input.assess(input.digest, input.scanResult)).trim();
    if (assessment.toUpperCase() === 'BREAKING_OK') {
      for (const item of input.digest.references) setNewsRouteOutcome(item.intelId, 'routine_no_position_impact', undefined, this.options.db);
      return 'no_impact';
    }
    if (!/^NEWS_IMPACT:\s*\S/i.test(assessment)) throw new Error('malformed_routine_news_assessment');
    if (input.recipients.length === 0) {
      for (const item of input.digest.references) setNewsRouteOutcome(item.intelId, 'briefing_no_recipients', undefined, this.options.db);
      return 'no_recipients';
    }
    const dispatchKey = claimNewsDispatch(cycleId, 'briefing', this.options.db);
    if (!dispatchKey) return 'sent';
    const message = assessment.replace(/^NEWS_IMPACT:\s*/i, '').slice(0, 1800);
    try {
      for (const recipient of input.recipients) await input.send(recipient, message);
      finishNewsDispatch(dispatchKey, 'completed', `sent:${input.recipients.length}`, this.options.db);
      for (const item of input.digest.references) setNewsRouteOutcome(item.intelId, 'briefing_sent', undefined, this.options.db);
      return 'sent';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      finishNewsDispatch(dispatchKey, 'uncertain', reason, this.options.db);
      for (const item of input.digest.references) setNewsRouteOutcome(item.intelId, 'briefing_delivery_uncertain', undefined, this.options.db);
      return 'uncertain';
    }
  }
}
