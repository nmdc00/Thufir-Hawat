import type Database from 'better-sqlite3';
import { openDatabase } from '../memory/db.js';
import type { ChatMessage, LlmClient } from '../core/llm.js';
import { withExecutionContext } from '../core/llm_infra.js';
import type { NewsActivation } from './news_activation.js';
import { storeIntel, type StoredIntel } from './store.js';

export type NewsScreen =
  | { relevance: 'irrelevant'; urgency: 'none' }
  | { relevance: 'relevant'; urgency: 'routine' | 'urgent' };

export interface NewsScreenTerminalResult {
  intelId: string;
  source: string;
  activation?: NewsActivation;
  screen: NewsScreen;
  attempts: number;
  verdict: 'YES' | 'NO';
}

type JobRow = {
  intel_id: string;
  status: string;
  attempts: number;
  activation: string | null;
  title: string;
  content: string | null;
  source: string;
  created_at?: string;
  verdict?: 'YES' | 'NO' | null;
  urgency?: 'routine' | 'urgent' | null;
};

type PersistedNewsActivation = Omit<NewsActivation, 'text'>;

function serializeActivation(activation: NewsActivation): string {
  const provenance: PersistedNewsActivation = {
    id: activation.id,
    intelId: activation.intelId,
    source: activation.source,
    receivedAtMs: activation.receivedAtMs,
    ...(activation.publishedAtMs === undefined ? {} : { publishedAtMs: activation.publishedAtMs }),
    matchedKeyword: activation.matchedKeyword,
  };
  return JSON.stringify(provenance);
}

export function enqueueNewsScreenJob(intelId: string, activation?: NewsActivation): boolean {
  const db = openDatabase();
  const intel = db.prepare('SELECT id FROM intel_items WHERE id = ?').get(intelId);
  if (!intel) return false;
  db.prepare(`INSERT INTO news_screen_jobs (intel_id, activation) VALUES (?, ?)
    ON CONFLICT(intel_id) DO NOTHING`).run(intelId, activation ? serializeActivation(activation) : null);
  return true;
}

/** Stores and admits a live post in one SQLite transaction, closing the crash gap between the two writes. */
export function storeIntelAndEnqueueNewsScreenJob(item: StoredIntel, activation?: NewsActivation): boolean {
  const db = openDatabase();
  return db.transaction(() => {
    const inserted = storeIntel(item);
    if (inserted) {
      db.prepare(`INSERT INTO news_screen_jobs (intel_id, activation) VALUES (?, ?)
        ON CONFLICT(intel_id) DO NOTHING`).run(item.id, activation ? serializeActivation(activation) : null);
    }
    return inserted;
  })();
}

export function storeIntelAndMarkNewsScreenUnsampled(item: StoredIntel): boolean {
  const db = openDatabase();
  return db.transaction(() => {
    const inserted = storeIntel(item);
    if (inserted) db.prepare(`INSERT INTO news_screen_jobs (intel_id, status, completed_at)
      VALUES (?, 'unsampled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(intel_id) DO NOTHING`).run(item.id);
    return inserted;
  })();
}

const relevancePrompt = (title: string, content: string | null): ChatMessage[] => [
  { role: 'system', content: 'Classify market relevance. Reply with exactly YES or NO.' },
  { role: 'user', content: `Could this post materially affect a tradable market or held position over the current or next trading session? Consider realized price moves and credible developing events; an asset name is not required. Reply exactly YES or NO.\n\n${title}\n${content ?? ''}` },
];

const urgencyPrompt = (title: string, content: string | null): ChatMessage[] => [
  { role: 'system', content: 'Classify news urgency. Reply with exactly URGENT or ROUTINE.' },
  { role: 'user', content: `Does this relevant market news describe a fresh event that needs immediate review, or routine relevant news? Reply exactly URGENT or ROUTINE.\n\n${title}\n${content ?? ''}` },
];

function parseExact(response: string, allowed: readonly string[]): string {
  const value = response.trim().toUpperCase();
  if (!allowed.includes(value)) throw new Error('malformed_model_response');
  return value;
}

function parseDbTimestamp(value: string): number {
  return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

export interface NewsScreenWorkerOptions {
  client: LlmClient;
  db?: Database.Database;
  onTerminal?: (result: NewsScreenTerminalResult) => void | Promise<void>;
  pollIntervalMs?: number;
  leaseMs?: number;
  maxCallsPerMinute?: number;
  maxCallsPerHour?: number;
  isHealthy?: () => boolean | Promise<boolean>;
}

/** A single-flight durable worker. At most three claims are made per job (initial attempt + 2 retries). */
export class NewsScreenWorker {
  private readonly db: Database.Database;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly maxCallsPerMinute: number;
  private readonly maxCallsPerHour: number;
  private stopped = true;
  private loopPromise?: Promise<void>;

  constructor(private readonly options: NewsScreenWorkerOptions) {
    this.db = options.db ?? openDatabase();
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxCallsPerMinute = options.maxCallsPerMinute ?? 30;
    this.maxCallsPerHour = options.maxCallsPerHour ?? 320;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loopPromise;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      let found = false;
      try {
        found = await this.processNext();
      } catch (error) {
        console.error('[NewsScreenWorker] worker loop error', error instanceof Error ? error.message : String(error));
        await new Promise((resolve) => setTimeout(resolve, Math.max(this.pollIntervalMs, 1_000)));
      }
      if (!found && !this.stopped) await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  /** Claims and processes at most one job; useful for controlled lifecycle orchestration and tests. */
  async processNext(): Promise<boolean> {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseIso = new Date(now.getTime() + this.leaseMs).toISOString();
    const routeJob = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT j.intel_id, j.status, j.attempts, j.activation, j.verdict, j.urgency,
          i.title, i.content, i.source
        FROM news_screen_jobs j JOIN intel_items i ON i.id = j.intel_id
        WHERE j.status = 'routing' AND (j.lease_until IS NULL OR j.lease_until <= ?)
        ORDER BY j.created_at, j.intel_id LIMIT 1`).get(nowIso) as JobRow | undefined;
      if (!row) return undefined;
      this.db.prepare("UPDATE news_screen_jobs SET lease_until = ? WHERE intel_id = ? AND status = 'routing'")
        .run(leaseIso, row.intel_id);
      return row;
    })();
    if (routeJob) {
      if (!this.options.onTerminal) {
        this.db.prepare("UPDATE news_screen_jobs SET status = 'screened', lease_until = NULL WHERE intel_id = ? AND status = 'routing'").run(routeJob.intel_id);
      } else {
        try {
          await this.options.onTerminal(this.toTerminalResult(routeJob));
          this.db.prepare("UPDATE news_screen_jobs SET status = 'screened', lease_until = NULL, error = NULL WHERE intel_id = ? AND status = 'routing'").run(routeJob.intel_id);
        } catch (error) {
          this.db.prepare("UPDATE news_screen_jobs SET lease_until = ?, error = ? WHERE intel_id = ? AND status = 'routing'")
            .run(new Date(Date.now() + Math.max(1_000, this.pollIntervalMs)).toISOString(), `routing_callback_failed: ${error instanceof Error ? error.message : String(error)}`, routeJob.intel_id);
        }
      }
      return true;
    }
    const pause = this.db.prepare("SELECT value FROM news_screen_state WHERE key = 'pause_until'").get() as { value: string } | undefined;
    if (pause && Date.parse(pause.value) > Date.now()) return false;
    if (this.options.isHealthy) {
      try {
        if (!(await this.options.isHealthy())) return false;
      } catch {
        this.db.prepare("INSERT INTO news_screen_state (key, value) VALUES ('pause_until', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(new Date(Date.now() + 30_000).toISOString());
        return false;
      }
    }
    if (!this.hasCallCapacity()) return false;
    const claimed = this.db.transaction(() => {
      this.db.prepare(`UPDATE news_screen_jobs SET status = 'failed', lease_until = NULL,
        error = 'worker_lease_expired_after_retry_limit', completed_at = ?
        WHERE status = 'processing' AND attempts >= 3 AND lease_until <= ?`).run(nowIso, nowIso);
      const row = this.db.prepare(`SELECT j.intel_id, j.status, j.attempts, j.activation,
          i.title, i.content, i.source, j.created_at
        FROM news_screen_jobs j JOIN intel_items i ON i.id = j.intel_id
        WHERE ((j.status = 'pending' AND j.next_attempt_at <= ?)
          OR (j.status = 'processing' AND j.lease_until <= ?))
          AND j.attempts < 3
        ORDER BY j.created_at, j.intel_id LIMIT 1`).get(nowIso, nowIso) as JobRow | undefined;
      if (!row) return undefined;
      const result = this.db.prepare(`UPDATE news_screen_jobs SET status = 'processing', attempts = attempts + 1,
        lease_until = ?, error = NULL WHERE intel_id = ? AND attempts = ?`).run(leaseIso, row.intel_id, row.attempts);
      return result.changes === 1 ? { ...row, attempts: row.attempts + 1 } : undefined;
    })();
    if (!claimed) return false;

    const started = Date.now();
    let queueWaitMs = 0;
    try {
      const relevanceResponse = await this.complete(relevancePrompt(claimed.title, claimed.content), 3);
      queueWaitMs += (relevanceResponse as typeof relevanceResponse & { queueWaitMs?: number }).queueWaitMs ?? 0;
      const relevance = parseExact(relevanceResponse.content, ['YES', 'NO']) as 'YES' | 'NO';
      let urgency: 'routine' | 'urgent' | undefined;
      if (relevance === 'YES') {
        const urgencyResponse = await this.complete(urgencyPrompt(claimed.title, claimed.content), 4);
        queueWaitMs += (urgencyResponse as typeof urgencyResponse & { queueWaitMs?: number }).queueWaitMs ?? 0;
        urgency = (parseExact(urgencyResponse.content, ['ROUTINE', 'URGENT']) === 'URGENT') ? 'urgent' : 'routine';
      }
      const screen: NewsScreen = relevance === 'NO'
        ? { relevance: 'irrelevant', urgency: 'none' }
        : { relevance: 'relevant', urgency: urgency! };
      const duration = Date.now() - started;
      const queueAge = Math.max(0, Date.now() - parseDbTimestamp(claimed.created_at ?? new Date().toISOString()));
      this.db.prepare(`UPDATE news_screen_jobs SET status = 'routing', verdict = ?, urgency = ?,
        reason = NULL, model = ?, latency_ms = ?, queue_wait_ms = ?, queue_age_ms = ?, lease_until = ?, error = NULL, completed_at = ?
        WHERE intel_id = ? AND status = 'processing'`).run(relevance, urgency ?? null, this.options.client.meta?.model ?? 'unknown', Math.max(0, duration - queueWaitMs), queueWaitMs, queueAge, leaseIso, new Date().toISOString(), claimed.intel_id);
      const routingRow = { ...claimed, verdict: relevance, urgency: urgency ?? null };
      if (!this.options.onTerminal) {
        this.db.prepare("UPDATE news_screen_jobs SET status = 'screened', lease_until = NULL WHERE intel_id = ? AND status = 'routing'").run(claimed.intel_id);
      } else {
        try {
          await this.options.onTerminal({ ...this.toTerminalResult(routingRow), screen });
          this.db.prepare("UPDATE news_screen_jobs SET status = 'screened', lease_until = NULL WHERE intel_id = ? AND status = 'routing'").run(claimed.intel_id);
        } catch (error) {
          this.db.prepare("UPDATE news_screen_jobs SET lease_until = ?, error = ? WHERE intel_id = ? AND status = 'routing'")
            .run(new Date(Date.now() + Math.max(1_000, this.pollIntervalMs)).toISOString(), `routing_callback_failed: ${error instanceof Error ? error.message : String(error)}`, claimed.intel_id);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'news_call_budget_exhausted') {
        this.db.prepare(`UPDATE news_screen_jobs SET status = 'pending', attempts = MAX(0, attempts - 1),
          next_attempt_at = ?, lease_until = NULL, error = 'budget_suppressed'
          WHERE intel_id = ? AND status = 'processing'`).run(new Date(Date.now() + 60_000).toISOString(), claimed.intel_id);
        return true;
      }
      if (message !== 'malformed_model_response') {
        this.db.prepare("INSERT INTO news_screen_state (key, value) VALUES ('pause_until', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(new Date(Date.now() + 30_000).toISOString());
      }
      const exhausted = claimed.attempts >= 3;
      const delayMs = claimed.attempts === 1 ? 1_000 : 5_000;
      const queueAgeMs = Math.max(0, Date.now() - parseDbTimestamp(claimed.created_at ?? new Date().toISOString()));
      this.db.prepare(`UPDATE news_screen_jobs SET status = ?, next_attempt_at = ?, lease_until = NULL,
        error = ?, model = ?, latency_ms = ?, queue_wait_ms = ?, queue_age_ms = ?, completed_at = ? WHERE intel_id = ? AND status = 'processing'`).run(
        exhausted ? 'failed' : 'pending', new Date(Date.now() + delayMs).toISOString(), message,
        this.options.client.meta?.model ?? 'unknown', Date.now() - started, queueWaitMs,
        queueAgeMs,
        exhausted ? new Date().toISOString() : null, claimed.intel_id);
    }
    return true;
  }

  private hasCallCapacity(): boolean {
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN admitted_at >= ? THEN 1 ELSE 0 END) AS minute_count,
      SUM(CASE WHEN admitted_at >= ? THEN 1 ELSE 0 END) AS hour_count
      FROM news_screen_call_log`).get(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 3_600_000).toISOString()) as { minute_count: number | null; hour_count: number | null };
    return (row.minute_count ?? 0) < this.maxCallsPerMinute && (row.hour_count ?? 0) < this.maxCallsPerHour;
  }

  private async complete(messages: ChatMessage[], maxTokens: number): ReturnType<LlmClient['complete']> {
    const admittedAt = new Date().toISOString();
    const admission = this.db.transaction(() => {
      if (!this.hasCallCapacity()) return false;
      this.db.prepare("DELETE FROM news_screen_call_log WHERE admitted_at < ?").run(new Date(Date.now() - 2 * 3_600_000).toISOString());
      this.db.prepare('INSERT INTO news_screen_call_log (admitted_at) VALUES (?)').run(admittedAt);
      return true;
    })();
    if (!admission) throw new Error('news_call_budget_exhausted');
    return withExecutionContext(
      { mode: 'LIGHT_REASONING', critical: false, reason: 'news_screening', source: 'news' },
      () => this.options.client.complete(messages, { temperature: 0, maxTokens })
    );
  }

  private toTerminalResult(row: JobRow): NewsScreenTerminalResult {
    if (row.verdict !== 'YES' && row.verdict !== 'NO') {
      throw new Error(`invalid_persisted_terminal_verdict:${row.intel_id}`);
    }
    if (row.verdict === 'YES' && row.urgency !== 'routine' && row.urgency !== 'urgent') {
      throw new Error(`invalid_persisted_terminal_urgency:${row.intel_id}`);
    }
    let activation: NewsActivation | undefined;
    if (row.activation) {
      try {
        const provenance = JSON.parse(row.activation) as PersistedNewsActivation & { text?: string };
        activation = { ...provenance, text: row.content ?? row.title };
        this.db.prepare('UPDATE news_screen_jobs SET activation = ? WHERE intel_id = ?')
          .run(serializeActivation(activation), row.intel_id);
      } catch { /* invalid optional legacy provenance */ }
    }
    const screen: NewsScreen = row.verdict === 'NO'
      ? { relevance: 'irrelevant', urgency: 'none' }
      : { relevance: 'relevant', urgency: row.urgency === 'urgent' ? 'urgent' : 'routine' };
    return { intelId: row.intel_id, source: row.source, activation, screen, attempts: row.attempts, verdict: row.verdict };
  }
}
