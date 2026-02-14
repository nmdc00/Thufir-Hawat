import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ThufirConfig } from './config.js';
import type { ChatMessage } from './llm.js';

export type ExecutionMode = 'MONITOR_ONLY' | 'LIGHT_REASONING' | 'FULL_AGENT';

export type ExecutionContext = {
  mode: ExecutionMode;
  critical?: boolean;
  reason?: string;
  source?: string;
};

type BudgetEntry = {
  ts: number;
  calls: number;
  tokens: number;
};

type BudgetState = {
  entries: BudgetEntry[];
};

type CooldownState = {
  until: number;
  backoffMs: number;
};

const executionStorage = new AsyncLocalStorage<ExecutionContext>();
const budgetCache = new Map<string, LlmBudgetManager>();
const cooldowns = new Map<string, CooldownState>();

const WINDOW_MS = 60 * 60 * 1000;
const COOLDOWN_MIN_MS = 30_000;
const COOLDOWN_MAX_MS = 15 * 60 * 1000;

export function withExecutionContext<T>(
  ctx: ExecutionContext,
  fn: () => Promise<T>
): Promise<T> {
  return executionStorage.run(ctx, fn);
}

export function withExecutionContextIfMissing<T>(
  ctx: ExecutionContext,
  fn: () => Promise<T>
): Promise<T> {
  if (executionStorage.getStore()) {
    return fn();
  }
  return executionStorage.run(ctx, fn);
}

export function getExecutionContext(): ExecutionContext | null {
  return executionStorage.getStore() ?? null;
}

export function estimateTokensFromMessages(messages: ChatMessage[]): number {
  const totalChars = messages.reduce((sum, msg) => sum + (msg.content?.length ?? 0), 0);
  return Math.max(1, Math.ceil(totalChars / 4));
}

export function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function resolveBudgetPath(config: ThufirConfig): string {
  const explicit = config.agent?.llmBudget?.storagePath;
  if (explicit) return explicit;
  const workspace = config.agent?.workspace ?? join(process.env.HOME ?? '', '.thufir');
  return join(workspace, 'llm_budget.json');
}

function loadBudgetState(path: string): BudgetState {
  if (!existsSync(path)) {
    return { entries: [] };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as BudgetState;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function saveBudgetState(path: string, state: BudgetState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export class LlmBudgetManager {
  private path: string;
  private state: BudgetState;
  private enabled: boolean;
  private maxCalls: number;
  private maxTokens: number;
  private reserveCalls: number;
  private reserveTokens: number;
  private includeLocal: boolean;

  constructor(config: ThufirConfig) {
    const budget = config.agent?.llmBudget;
    this.enabled = budget?.enabled ?? true;
    this.maxCalls = budget?.maxCallsPerHour ?? 120;
    this.maxTokens = budget?.maxTokensPerHour ?? 120000;
    this.reserveCalls = budget?.reserveCalls ?? 10;
    this.reserveTokens = budget?.reserveTokens ?? 10000;
    this.includeLocal = budget?.includeLocal ?? false;
    this.path = resolveBudgetPath(config);
    this.state = loadBudgetState(this.path);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  shouldCountProvider(provider: 'anthropic' | 'openai' | 'local'): boolean {
    if (provider === 'local') {
      return this.includeLocal;
    }
    return true;
  }

  canConsume(tokens: number, critical: boolean, provider: 'anthropic' | 'openai' | 'local'): boolean {
    if (!this.enabled) return true;
    if (!this.shouldCountProvider(provider)) return true;

    this.prune();
    const { calls, tokens: used } = this.totals();
    const maxCalls = critical ? this.maxCalls + this.reserveCalls : this.maxCalls;
    const maxTokens = critical ? this.maxTokens + this.reserveTokens : this.maxTokens;
    return calls + 1 <= maxCalls && used + tokens <= maxTokens;
  }

  record(tokens: number, provider: 'anthropic' | 'openai' | 'local'): void {
    if (!this.enabled) return;
    if (!this.shouldCountProvider(provider)) return;

    this.prune();
    this.state.entries.push({ ts: Date.now(), calls: 1, tokens });
    saveBudgetState(this.path, this.state);
  }

  private prune(): void {
    const cutoff = Date.now() - WINDOW_MS;
    this.state.entries = this.state.entries.filter((entry) => entry.ts >= cutoff);
  }

  private totals(): { calls: number; tokens: number } {
    return this.state.entries.reduce(
      (acc, entry) => {
        acc.calls += entry.calls;
        acc.tokens += entry.tokens;
        return acc;
      },
      { calls: 0, tokens: 0 }
    );
  }
}

export function getLlmBudgetManager(config: ThufirConfig): LlmBudgetManager {
  const path = resolveBudgetPath(config);
  const existing = budgetCache.get(path);
  if (existing) return existing;
  const manager = new LlmBudgetManager(config);
  budgetCache.set(path, manager);
  return manager;
}

export function isCooling(provider: string, model: string): CooldownState | null {
  const key = `${provider}:${model}`;
  const state = cooldowns.get(key);
  if (!state) return null;
  if (Date.now() >= state.until) {
    cooldowns.delete(key);
    return null;
  }
  return state;
}

export function recordCooldown(
  provider: string,
  model: string,
  opts?: { resetSeconds?: number | null }
): CooldownState {
  const key = `${provider}:${model}`;
  const existing = cooldowns.get(key);
  const nextBackoff = Math.min(
    existing ? existing.backoffMs * 2 : COOLDOWN_MIN_MS,
    COOLDOWN_MAX_MS
  );
  const resetMs =
    typeof opts?.resetSeconds === 'number' && Number.isFinite(opts.resetSeconds) && opts.resetSeconds > 0
      ? Math.floor(opts.resetSeconds * 1000)
      : 0;
  const durationMs = Math.min(
    COOLDOWN_MAX_MS,
    Math.max(COOLDOWN_MIN_MS, nextBackoff, resetMs)
  );
  const state = { until: Date.now() + durationMs, backoffMs: durationMs };
  cooldowns.set(key, state);
  return state;
}
