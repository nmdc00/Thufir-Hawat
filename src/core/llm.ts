import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';

import type { ThufirConfig } from './config.js';
import { THUFIR_TOOLS } from './tool-schemas.js';
import { executeToolCall, type ToolExecutorContext } from './tool-executor.js';
import { Logger } from './logger.js';
import {
  loadIdentityPrelude,
  injectIdentity,
  clearIdentityCache as clearIdentityPreludeCache,
  buildHardIdentityPrompt,
  buildSoftIdentityPrompt,
} from '../agent/identity/identity.js';
import { IDENTITY_MARKER } from '../agent/identity/types.js';
import { sanitizeUntrustedText } from './sanitize_untrusted_text.js';
import {
  getExecutionContext,
  estimateTokensFromMessages,
  estimateTokensFromText,
  getLlmBudgetManager,
  isCooling,
  recordCooldown,
} from './llm_infra.js';

export const clearIdentityCache = clearIdentityPreludeCache;
import type {
  ContentBlock,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  content: string;
  model: string;
}

export type LlmClientOptions = {
  temperature?: number;
  timeoutMs?: number;
  maxTokens?: number;
};

export type LlmClientMeta = {
  provider: 'anthropic' | 'openai' | 'local';
  model: string;
  kind?: 'primary' | 'executor' | 'agentic' | 'trivial';
};

export interface LlmClient {
  complete(messages: ChatMessage[], options?: LlmClientOptions): Promise<LlmResponse>;
  meta?: LlmClientMeta;
}

function resolveIdentityPromptMode(
  config: ThufirConfig,
  kind?: LlmClientMeta['kind']
): 'full' | 'minimal' | 'none' {
  if (kind === 'trivial') {
    return config.agent?.internalPromptMode ?? 'minimal';
  }
  return config.agent?.identityPromptMode ?? 'full';
}

function isDebugEnabled(): boolean {
  return (process.env.THUFIR_LOG_LEVEL ?? '').toLowerCase() === 'debug';
}

function finalizeMessages(
  messages: ChatMessage[],
  config: ThufirConfig,
  meta?: LlmClientMeta
): ChatMessage[] {
  const promptMode = resolveIdentityPromptMode(config, meta?.kind);
  const identityConfig = {
    workspacePath: config.agent?.workspace,
    bootstrapMaxChars: config.agent?.identityBootstrapMaxChars,
    includeMissing: config.agent?.identityBootstrapIncludeMissing,
  };

  const { identity } = loadIdentityPrelude({
    ...identityConfig,
    promptMode: 'minimal',
  });

  const hardIdentity = buildHardIdentityPrompt(identity);
  const softIdentity = promptMode === 'full' ? buildSoftIdentityPrompt(identity) : '';
  const identityBlock = softIdentity
    ? `${hardIdentity}\n\n---\n\n${softIdentity}`
    : hardIdentity;

  const systemIndex = messages.findIndex((msg) => msg.role === 'system');
  const existingSystem =
    systemIndex >= 0 ? messages[systemIndex]?.content ?? '' : '';
  const systemHasMarker = existingSystem.includes(IDENTITY_MARKER);
  const systemContent = systemHasMarker
    ? existingSystem
    : existingSystem
      ? `${identityBlock}\n\n---\n\n${existingSystem}`
      : identityBlock;

  const sanitized = messages.map((msg, idx) => {
    if (idx === systemIndex) {
      return { ...msg, content: systemContent };
    }
    if (
      msg.role === 'user' &&
      typeof msg.content === 'string' &&
      looksLikeToolOutput(msg.content)
    ) {
      return {
        ...msg,
        content: sanitizeUntrustedText(
          msg.content,
          config.agent?.maxToolResultChars ?? 8000
        ),
      };
    }
    return msg;
  });

  const withSystem =
    systemIndex >= 0
      ? sanitized
      : ([{ role: 'system', content: systemContent } as ChatMessage, ...sanitized] as ChatMessage[]);

  const trimmed = trimMessagesByCharBudget(
    withSystem,
    config.agent?.maxPromptChars ?? 120000,
    config.agent?.maxToolResultChars ?? 8000
  );

  if (isDebugEnabled()) {
    const sys = trimmed.find((msg) => msg.role === 'system')?.content ?? '';
    if (!sys.includes(IDENTITY_MARKER)) {
      throw new Error('Identity marker missing from system prompt');
    }
  }

  return trimmed;
}

function looksLikeToolOutput(content: string): boolean {
  return (
    content.includes('## Tool Results') ||
    content.includes('Execution results:') ||
    content.includes('tool_result') ||
    content.includes('tool_use')
  );
}

function trimMessagesByCharBudget(
  messages: ChatMessage[],
  maxChars: number,
  maxToolChars: number
): ChatMessage[] {
  const system = messages.find((msg) => msg.role === 'system');
  const rest = messages.filter((msg) => msg.role !== 'system');

  const calcChars = (items: ChatMessage[]) =>
    items.reduce((sum, msg) => sum + (typeof msg.content === 'string' ? msg.content.length : 0), 0);

  let totalChars = calcChars(messages);
  if (totalChars <= maxChars) {
    return messages;
  }

  const trimmedRest = [...rest];
  while (trimmedRest.length > 0 && totalChars > maxChars) {
    trimmedRest.shift();
    totalChars = calcChars(system ? [system, ...trimmedRest] : trimmedRest);
  }

  if (totalChars > maxChars) {
    for (const msg of trimmedRest) {
      if (totalChars <= maxChars) break;
      if (typeof msg.content === 'string' && msg.content.length > maxToolChars) {
        const truncated = `${msg.content.slice(0, maxToolChars)}\n\n[TRUNCATED]`;
        totalChars -= msg.content.length - truncated.length;
        msg.content = truncated;
      }
    }
  }

  return system ? [system, ...trimmedRest] : trimmedRest;
}

class LlmQueue {
  private queue: Array<() => void> = [];
  private inFlight = 0;

  constructor(
    private concurrency: number,
    private minDelayMs: number
  ) {}

  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        this.inFlight += 1;
        try {
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          if (this.minDelayMs > 0) {
            await sleep(this.minDelayMs);
          }
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.dequeue();
        }
      };

      this.queue.push(run);
      this.dequeue();
    });
  }

  private dequeue(): void {
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }
}

class LimitedLlmClient implements LlmClient {
  meta?: LlmClientMeta;

  constructor(private inner: LlmClient, private limiter: LlmQueue) {
    // Preserve meta for observability/debugging and infra routing decisions.
    this.meta = inner.meta;
  }

  complete(messages: ChatMessage[], options?: LlmClientOptions): Promise<LlmResponse> {
    return this.limiter.enqueue(() => this.inner.complete(messages, options));
  }
}

const globalLimiter = new LlmQueue(
  Math.max(1, Number(process.env.THUFIR_LLM_CONCURRENCY ?? 1)),
  Math.max(0, Number(process.env.THUFIR_LLM_MIN_DELAY_MS ?? 0))
);

export function wrapWithLimiter(client: LlmClient): LlmClient {
  return new LimitedLlmClient(client, globalLimiter);
}

class InfraLlmClient implements LlmClient {
  meta?: LlmClientMeta;
  private logger: Logger;
  private config: ThufirConfig;
  private inner: LlmClient;

  constructor(inner: LlmClient, config: ThufirConfig, logger?: Logger) {
    this.inner = inner;
    this.config = config;
    this.logger = logger ?? new Logger('info');
    this.meta = inner.meta;
  }

  async complete(
    messages: ChatMessage[],
    options?: LlmClientOptions
  ): Promise<LlmResponse> {
    const meta = this.meta ?? { provider: 'openai', model: 'unknown' };
    const finalized = finalizeMessages(messages, this.config, this.meta);
    const ctx = getExecutionContext();
    const context = ctx ?? {
      mode: 'FULL_AGENT' as const,
      critical: false,
      reason: 'default',
    };
    if (!ctx) {
      this.logger.warn('LLM execution context missing; defaulting to FULL_AGENT');
    }

    if (context.mode === 'MONITOR_ONLY') {
      return { content: '', model: meta.model };
    }

    const budget = getLlmBudgetManager(this.config);
    const estimatedTokens = estimateTokensFromMessages(finalized);
    if (!budget.canConsume(estimatedTokens, !!context.critical, meta.provider)) {
      this.logger.warn('LLM budget exceeded; degrading to MONITOR_ONLY', {
        provider: meta.provider,
        model: meta.model,
        reason: context.reason,
      });
      return { content: '', model: meta.model };
    }

    const cooldown = isCooling(meta.provider, meta.model);
    if (cooldown) {
      if (context.critical) {
        const error = new Error(
          `LLM provider in cooldown until ${new Date(cooldown.until).toISOString()}`
        );
        (error as { code?: string }).code = 'model_cooldown';
        throw error;
      }
      this.logger.warn('LLM provider cooling down; skipping call', {
        provider: meta.provider,
        model: meta.model,
        until: new Date(cooldown.until).toISOString(),
      });
      return { content: '', model: meta.model };
    }

    try {
      const explicitTimeoutMs = options?.timeoutMs;
      const timeoutMs = explicitTimeoutMs ?? resolveDefaultLlmTimeoutMs();
      // Preserve inner-client default timeouts (notably TrivialTaskClient soft timeouts) by
      // only forwarding timeoutMs when the caller explicitly provided one.
      const forwardedOptions =
        explicitTimeoutMs !== undefined ? { ...options, timeoutMs: explicitTimeoutMs } : options;
      const response = await runWithTimeout(
        () => this.inner.complete(finalized, forwardedOptions),
        timeoutMs,
        `LLM request (${meta.provider}/${meta.model})`
      );
      const totalTokens = estimatedTokens + estimateTokensFromText(response.content);
      budget.record(totalTokens, meta.provider);
      return response;
    } catch (error) {
      if (isRateLimitError(error)) {
        const state = recordCooldown(meta.provider, meta.model, {
          resetSeconds: extractResetSeconds(error),
        });
        this.logger.warn('LLM rate limit detected; entering cooldown', {
          provider: meta.provider,
          model: meta.model,
          until: new Date(state.until).toISOString(),
        });
      }
      throw error;
    }
  }
}

export function wrapWithInfra(client: LlmClient, config: ThufirConfig, logger?: Logger): LlmClient {
  return new InfraLlmClient(client, config, logger);
}

function extractResetSeconds(error: unknown): number | null {
  const message = extractErrorMessage(error);
  if (!message) return null;
  // llm-mux often nests JSON into a string; a regex is the most robust approach here.
  const m = message.match(/reset_seconds\"?\s*:\s*(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isFailoverEligibleError(error: unknown): boolean {
  if (isRateLimitError(error)) return true;
  const message = extractErrorMessage(error).toLowerCase();
  // Proxies can fail in non-429 ways (bad routing, missing auth, schema mismatch) where a
  // configured fallback route is still desirable.
  return (
    message.includes('auth_not_found') ||
    message.includes('unknown provider for model') ||
    message.includes('unsupported parameter') ||
    message.includes('missing management key') ||
    message.includes('invalid_request_error') ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('connect') && message.includes('refused')
  );
}

export class RateLimitFailoverClient implements LlmClient {
  meta?: LlmClientMeta;
  private logger: Logger;
  private config: ThufirConfig;
  private candidates: LlmClient[];

  constructor(candidates: LlmClient[], config: ThufirConfig, logger?: Logger) {
    this.candidates = candidates;
    this.config = config;
    this.logger = logger ?? new Logger('info');
    this.meta = candidates[0]?.meta;
  }

  async complete(messages: ChatMessage[], options?: LlmClientOptions): Promise<LlmResponse> {
    const ctx = getExecutionContext();
    const allowNonCritical = this.config?.agent?.allowFallbackNonCritical ?? true;

    let lastError: unknown = null;
    for (let i = 0; i < this.candidates.length; i += 1) {
      const candidate = this.candidates[i];
      if (!candidate) continue;
      const meta = candidate.meta ?? { provider: 'unknown', model: 'unknown' };
      const cooldown = meta.provider !== 'unknown' && meta.model !== 'unknown'
        ? isCooling(meta.provider, meta.model)
        : null;
      if (cooldown) {
        // Skip cooled routes and keep trying alternatives.
        this.logger.warn('LLM route cooling; skipping', {
          provider: meta.provider,
          model: meta.model,
          until: new Date(cooldown.until).toISOString(),
        });
        continue;
      }

      try {
        const response = await candidate.complete(messages, options);
        const empty = response.content.trim().length === 0;
        if (empty) {
          // Treat empty output as a soft failure. This can happen when a proxy returns an
          // "ok" response with no assistant text, or when infra suppresses calls.
          this.logger.warn('LLM returned empty response; trying next route', {
            from: meta,
            to: (this.candidates[i + 1]?.meta ?? { provider: 'unknown', model: 'unknown' }),
          });
          if (this.candidates[i + 1]) {
            continue;
          }
        }
        return response;
      } catch (error) {
        lastError = error;
        const isCooldownError = (error as { code?: string } | null)?.code === 'model_cooldown';
        if (!isCooldownError && !isFailoverEligibleError(error)) {
          throw error;
        }
        if (!ctx?.critical && !allowNonCritical) {
          throw error;
        }

        const reason = extractErrorMessage(error);
        const next = this.candidates[i + 1];
        const nextMeta = next?.meta ?? { provider: 'unknown', model: 'unknown' };
        if (!next) {
          throw error;
        }
        this.logger.warn('LLM failover triggered', {
          from: meta,
          to: nextMeta,
          reason,
        });
        continue;
      }
    }

    if (lastError) throw lastError;
    return { content: '', model: this.meta?.model ?? 'unknown' };
  }
}

function resolveRateLimitFailover(config: ThufirConfig): { provider: 'anthropic' | 'openai'; model: string } {
  const provider = (config.agent.rateLimitFallbackProvider ?? 'openai') as 'anthropic' | 'openai' | 'local';
  if (provider === 'local') {
    // Don't allow "local" as an automatic failover route for full agentic calls.
    return { provider: 'openai', model: config.agent.rateLimitFallbackModel ?? config.agent.executorModel ?? 'gpt-5' };
  }
  const model =
    config.agent.rateLimitFallbackModel ??
    config.agent.executorModel ??
    // Prefer gpt-5 because llm-mux previously rejected gpt-5.2 as unknown.
    'gpt-5';
  return { provider, model };
}

function wrapWithRateLimitFailoverIfNeeded(primary: LlmClient, config: ThufirConfig): LlmClient {
  const primaryModel = primary.meta?.model ?? '';
  const looksClaude = primaryModel.toLowerCase().includes('claude');
  const explicit =
    !!config.agent.rateLimitFallbackModel || !!config.agent.rateLimitFallbackProvider;
  if (!looksClaude && !explicit) {
    return primary;
  }

  const fallback = resolveRateLimitFailover(config);
  // If the fallback is identical to primary, don't wrap.
  if (primary.meta?.provider === fallback.provider && primary.meta?.model === fallback.model) {
    return primary;
  }

  const fallbackRaw =
    fallback.provider === 'anthropic'
      ? (new AnthropicClient(config, fallback.model) as LlmClient)
      : (new OpenAiClient(config, fallback.model) as LlmClient);
  const fallbackClient = wrapWithInfra(fallbackRaw, config);
  return new RateLimitFailoverClient([primary, fallbackClient], config);
}

function assertLocalProviderNotAllowed(
  provider: 'anthropic' | 'openai' | 'local',
  context: string
): void {
  if (provider === 'local') {
    throw new Error(
      `Local provider is reserved for trivial tasks. Set agent.trivialTaskProvider/localBaseUrl for ${context}.`
    );
  }
}

export function createLlmClient(config: ThufirConfig): LlmClient {
  assertLocalProviderNotAllowed(config.agent.provider, 'primary LLM usage');
  const primaryRaw =
    config.agent.provider === 'anthropic'
      ? (new AnthropicClient(config) as LlmClient)
      : config.agent.provider === 'openai'
        ? (new OpenAiClient(config) as LlmClient)
        : (new LocalClient(config) as LlmClient);

  const primary = wrapWithInfra(primaryRaw, config);
  const withFailover = wrapWithRateLimitFailoverIfNeeded(primary, config);
  return wrapWithLimiter(withFailover);
}

export function createOpenAiClient(
  config: ThufirConfig,
  modelOverride?: string
): LlmClient {
  return wrapWithLimiter(wrapWithInfra(new OpenAiClient(config, modelOverride), config));
}

export function createExecutorClient(
  config: ThufirConfig,
  modelOverride?: string,
  providerOverride?: 'anthropic' | 'openai' | 'local'
): LlmClient {
  const provider = providerOverride ?? config.agent.executorProvider ?? 'openai';
  assertLocalProviderNotAllowed(provider, 'executor usage');
  const model =
    modelOverride ??
    config.agent.executorModel ??
    config.agent.openaiModel ??
    config.agent.model;
  switch (provider) {
    case 'anthropic':
      return wrapWithLimiter(wrapWithInfra(new AnthropicClient(config, model), config));
    case 'local':
      return wrapWithLimiter(wrapWithInfra(new LocalClient(config, model), config));
    case 'openai':
    default:
      return wrapWithLimiter(wrapWithInfra(new OpenAiClient(config, model), config));
  }
}

export function createAgenticExecutorClient(
  config: ThufirConfig,
  toolContext: ToolExecutorContext,
  modelOverride?: string
): LlmClient {
  const provider = config.agent.executorProvider ?? 'openai';
  assertLocalProviderNotAllowed(provider, 'agentic executor usage');
  const model =
    modelOverride ??
    config.agent.executorModel ??
    config.agent.openaiModel ??
    config.agent.model;
  if (provider === 'anthropic') {
    const primary = new AgenticAnthropicClient(config, toolContext, model);
    const fallbackModel = config.agent.fallbackModel ?? 'claude-3-5-haiku-20241022';
    const fallback = new AgenticAnthropicClient(config, toolContext, fallbackModel);
    const withinProvider = wrapWithInfra(
      new FallbackLlmClient(primary, fallback, isRateLimitError, config),
      config
    );
    const withFailover = wrapWithRateLimitFailoverIfNeeded(withinProvider, config);
    return wrapWithLimiter(withFailover);
  }
  const primary = wrapWithInfra(new AgenticOpenAiClient(config, toolContext, model), config);
  const withFailover = wrapWithRateLimitFailoverIfNeeded(primary, config);
  return wrapWithLimiter(withFailover);
}

export function createTrivialTaskClient(config: ThufirConfig): LlmClient | null {
  const trivialConfig = config.agent?.trivial;
  if (!trivialConfig?.enabled) return null;
  const provider = config.agent?.trivialTaskProvider ?? 'local';
  const modelRaw = config.agent?.trivialTaskModel ?? 'qwen2.5:1.5b-instruct';
  const model = (() => {
    // Guard against common misconfig: selecting a remote provider but leaving the local-model default.
    // This can happen when users switch trivialTaskProvider to anthropic/openai but forget to change
    // trivialTaskModel, which defaults to an Ollama-style model id.
    const looksLocal = modelRaw.includes(':') || modelRaw.includes('/');
    if (provider === 'anthropic') {
      const looksAnthropic = modelRaw.toLowerCase().includes('claude');
      if (!looksAnthropic && looksLocal) {
        return config.agent.fallbackModel ?? config.agent.model;
      }
      return modelRaw;
    }
    if (provider === 'openai') {
      // OpenAI models will not look like "qwen2.5:..." or "llama3:..." (Ollama-style).
      if (looksLocal) {
        return config.agent.openaiModel ?? config.agent.model;
      }
      return modelRaw;
    }
    return modelRaw;
  })();
  const defaults: LlmClientOptions = {
    temperature: trivialConfig.temperature ?? 0.2,
    timeoutMs: trivialConfig.timeoutMs,
    maxTokens: trivialConfig.maxTokens,
  };
  if (provider === 'local') {
    const baseUrl = resolveLocalBaseUrl(config);
    startLocalKeepWarm({ baseUrl, model });
    const inner = new LocalClient(config, model, 'trivial');
    const guarded = new LocalHealthGuard(inner, {
      baseUrl,
      model,
      timeoutMs: trivialConfig.timeoutMs,
    });

    // Prefer local for trivial tasks, but do not block interactive paths on slow local inference.
    // If local cannot answer quickly, fall back to a remote provider for the same trivial task.
    const localSoftTimeoutMs = 5_000;
    const localDefaults: LlmClientOptions = {
      temperature: defaults.temperature,
      timeoutMs:
        typeof defaults.timeoutMs === 'number'
          ? Math.min(defaults.timeoutMs, localSoftTimeoutMs)
          : localSoftTimeoutMs,
      maxTokens:
        typeof defaults.maxTokens === 'number'
          ? Math.min(defaults.maxTokens, 96)
          : 96,
    };

    const primary = new TrivialTaskClient(guarded, localDefaults);
    // Prefer OpenAI as the default remote fallback. We route through the same proxy (if enabled) and
    // llm-mux supports OpenAI-style chat endpoints for gpt-* models; falling back to Anthropic here
    // makes trivial tasks depend on Claude OAuth health unnecessarily.
    const fallbackRemote =
      config.agent.provider === 'anthropic'
        ? new AnthropicClient(
            config,
            config.agent.fallbackModel ?? 'claude-3-5-haiku-20241022',
            'trivial'
          )
        : new OpenAiClient(config, config.agent.openaiModel ?? config.agent.model, 'trivial');
    const fallback = new TrivialTaskClient(fallbackRemote, defaults);

    return wrapWithLimiter(
      wrapWithInfra(
        new FallbackLlmClient(primary, fallback, () => true, config),
        config
      )
    );
  }
  if (provider === 'anthropic') {
    return wrapWithLimiter(
      wrapWithInfra(new TrivialTaskClient(new AnthropicClient(config, model, 'trivial'), defaults), config)
    );
  }
  return wrapWithLimiter(
    wrapWithInfra(new TrivialTaskClient(new OpenAiClient(config, model, 'trivial'), defaults), config)
  );
}

const localKeepWarmStarted = new Set<string>();

function startLocalKeepWarm(params: { baseUrl: string; model: string }): void {
  // Avoid keeping the process alive for short-lived CLI invocations.
  const key = `${params.baseUrl}::${params.model}`;
  if (localKeepWarmStarted.has(key)) return;
  localKeepWarmStarted.add(key);

  const intervalMs = 3 * 60 * 1000;
  const keepAlive = '10m';

  const tick = async () => {
    try {
      // Best-effort: Ollama-specific keep-alive. If unavailable, ignore.
      await fetch(`${params.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: params.model,
          prompt: 'ping',
          stream: false,
          keep_alive: keepAlive,
          options: { num_predict: 1 },
        }),
      });
    } catch {
      // ignore
    }
  };

  // Fire once soon after startup, then periodically.
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
}

export function shouldUseExecutorModel(config: ThufirConfig): boolean {
  if (!config.agent || !config.agent.useExecutorModel) {
    return false;
  }

  const baseProvider = config.agent.provider ?? 'anthropic';
  const baseModel = config.agent.model ?? '';
  const executorProvider = config.agent.executorProvider ?? 'openai';
  const executorModel =
    config.agent.executorModel ??
    config.agent.openaiModel ??
    config.agent.model ??
    '';

  return baseProvider !== executorProvider || baseModel !== executorModel;
}

function resolveOpenAiBaseUrl(config: ThufirConfig): string {
  if (config.agent.useProxy) {
    return config.agent.proxyBaseUrl;
  }
  return config.agent.apiBaseUrl ?? 'https://api.openai.com';
}

function resolveOpenAiModel(config: ThufirConfig, modelOverride?: string): string {
  let model = modelOverride ?? config.agent.openaiModel ?? config.agent.model;
  if (config.agent.useProxy) {
    const isAnthropicPrimary = config.agent.provider === 'anthropic';
    const looksAnthropic = model.toLowerCase().includes('claude');
    if ((isAnthropicPrimary && model === config.agent.model) || looksAnthropic) {
      model = config.agent.openaiModel ?? model;
    }
  }
  return model;
}

function resolveAnthropicBaseUrl(config: ThufirConfig): string | undefined {
  if (config.agent.useProxy) {
    return config.agent.proxyBaseUrl;
  }
  return undefined;
}

function resolveLocalBaseUrl(config: ThufirConfig): string {
  return config.agent.localBaseUrl ?? 'http://localhost:11434';
}

const LOCAL_HEALTH_TTL_MS = 2 * 60 * 1000;
const LOCAL_HEALTH_COOLDOWN_MS = 5 * 60 * 1000;
const LOCAL_HEALTH_TIMEOUT_MS = 3000;

type LocalHealthState = {
  lastChecked: number;
  cooldownUntil: number;
  ok: boolean;
  reason?: string;
};

const localHealthState = new Map<string, LocalHealthState>();

function getLocalHealthState(baseUrl: string): LocalHealthState {
  const existing = localHealthState.get(baseUrl);
  if (existing) return existing;
  const state = { lastChecked: 0, cooldownUntil: 0, ok: true };
  localHealthState.set(baseUrl, state);
  return state;
}

async function checkLocalHealth(
  baseUrl: string,
  model?: string,
  timeoutMs: number = LOCAL_HEALTH_TIMEOUT_MS
): Promise<{ ok: boolean; reason?: string }> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timeout: NodeJS.Timeout | null = null;
  if (controller && timeoutMs > 0) {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      signal: controller?.signal,
    });
    if (!response.ok) {
      return { ok: false, reason: `status ${response.status}` };
    }
    try {
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      if (model && Array.isArray(data?.data)) {
        const found = data.data.some((item) => item?.id === model);
        if (!found) {
          return { ok: false, reason: `model ${model} not found` };
        }
      }
    } catch {
      // If model list isn't parseable, treat endpoint as alive.
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unreachable';
    return { ok: false, reason: message };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

class LocalHealthGuard implements LlmClient {
  meta?: LlmClientMeta;
  private logger: Logger;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(
    private inner: LlmClient,
    params: { baseUrl: string; model: string; timeoutMs?: number; logger?: Logger }
  ) {
    this.baseUrl = params.baseUrl;
    this.model = params.model;
    this.timeoutMs = params.timeoutMs ?? LOCAL_HEALTH_TIMEOUT_MS;
    this.logger = params.logger ?? new Logger('info');
    this.meta = inner.meta;
  }

  async complete(messages: ChatMessage[], options?: LlmClientOptions): Promise<LlmResponse> {
    const now = Date.now();
    const state = getLocalHealthState(this.baseUrl);
    if (state.cooldownUntil > now) {
      throw new Error('Local LLM unavailable; skipping trivial task');
    }
    if (now - state.lastChecked > LOCAL_HEALTH_TTL_MS) {
      const result = await checkLocalHealth(this.baseUrl, this.model, this.timeoutMs);
      state.lastChecked = now;
      state.ok = result.ok;
      state.reason = result.reason;
      state.cooldownUntil = result.ok ? 0 : now + LOCAL_HEALTH_COOLDOWN_MS;
      if (!result.ok) {
        this.logger.warn('Local LLM health check failed; skipping trivial task', {
          baseUrl: this.baseUrl,
          model: this.model,
          reason: result.reason,
        });
        throw new Error(`Local LLM unavailable: ${result.reason ?? 'unreachable'}`);
      }
    }
    return this.inner.complete(messages, options);
  }
}

class TrivialTaskClient implements LlmClient {
  meta?: LlmClientMeta;
  private defaults: LlmClientOptions;

  constructor(inner: LlmClient, defaults: LlmClientOptions) {
    this.inner = inner;
    this.defaults = defaults;
    this.meta = inner.meta;
  }

  private inner: LlmClient;

  complete(messages: ChatMessage[], options?: LlmClientOptions): Promise<LlmResponse> {
    return this.inner.complete(messages, {
      temperature: options?.temperature ?? this.defaults.temperature,
      timeoutMs: options?.timeoutMs ?? this.defaults.timeoutMs,
      maxTokens: options?.maxTokens ?? this.defaults.maxTokens,
    });
  }
}

type ExecutionPlan = {
  intent?: string;
  toolCalls?: Array<{
    tool: string;
    params: Record<string, unknown>;
    dependsOn?: string[];
  }>;
  context?: Record<string, unknown>;
};

const TOOL_LIST = THUFIR_TOOLS.map((tool) => `- ${tool.name}: ${tool.description}`).join(
  '\n'
);

const ORCHESTRATOR_PROMPT = `
You are a planning agent. Analyze the user's request and create an execution plan.

Output ONLY a JSON object with:
- intent: what the user wants
- toolCalls: array of tool calls needed (in order)
- context: optional extra context for execution

Available tools:
${TOOL_LIST}

Do NOT execute tools yourself. Only plan which tools are needed and in what order.
`.trim();

// THUFIR_IDENTITY_OVERRIDE removed - now using identity prelude for all code paths

const EXECUTOR_PROMPT = `
You are an execution agent. Execute the provided plan using tool calls as needed.

Rules:
- Follow the plan order.
- Use tool calls to gather data.
- Retry or adjust parameters if a tool fails.
- Return ONLY a JSON object with "results" (array of tool outputs) and optional "notes".

Available tools:
${TOOL_LIST}
`.trim();

const SYNTHESIZER_PROMPT = `
You are a synthesis agent. The executor has gathered data for the user's request.
Analyze the results, apply reasoning, and respond to the user.
Do not dump raw JSON; provide a concise, thoughtful answer.
`.trim();

export type OrchestratorMetrics = {
  calls: number;
  planFailures: number;
  executorFailures: number;
  synthFailures: number;
  fallbacks: number;
  toolCallsPlanned: number;
};

const orchestratorMetrics: OrchestratorMetrics = {
  calls: 0,
  planFailures: 0,
  executorFailures: 0,
  synthFailures: 0,
  fallbacks: 0,
  toolCallsPlanned: 0,
};

export function getOrchestratorMetrics(): OrchestratorMetrics {
  return { ...orchestratorMetrics };
}

function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export class OrchestratorClient implements LlmClient {
  constructor(
    private orchestrator: LlmClient,
    private executor: LlmClient,
    private fallbackExecutor?: LlmClient,
    private logger?: Logger
  ) {}

  async complete(messages: ChatMessage[], options?: LlmClientOptions): Promise<LlmResponse> {
    orchestratorMetrics.calls += 1;
    const systemMessage = messages.find((msg) => msg.role === 'system')?.content ?? '';
    const rest = messages.filter((msg) => msg.role !== 'system');

    const plannerMessages: ChatMessage[] = [
      {
        role: 'system',
        content: `${ORCHESTRATOR_PROMPT}\n\n## Base Instructions\n${systemMessage}`,
      },
      ...rest,
    ];

    let planResponse: LlmResponse;
    try {
      planResponse = await this.orchestrator.complete(plannerMessages, options);
    } catch (error) {
      orchestratorMetrics.planFailures += 1;
      if (this.fallbackExecutor) {
        orchestratorMetrics.fallbacks += 1;
        this.logger?.warn('Orchestrator: plan failed, using fallback', error);
        return this.fallbackExecutor.complete(messages, options);
      }
      throw error;
    }

    const plan = extractJson<ExecutionPlan>(planResponse.content);
    if (!plan?.toolCalls || plan.toolCalls.length === 0) {
      this.logger?.debug('Orchestrator: no tool calls planned');
      return this.fallbackExecutor
        ? (orchestratorMetrics.fallbacks += 1,
          this.logger?.debug('Orchestrator: using fallback for direct response'),
          this.fallbackExecutor.complete(messages, options))
        : this.orchestrator.complete(messages, options);
    }

    orchestratorMetrics.toolCallsPlanned += plan.toolCalls.length;
    this.logger?.info('Orchestrator: tool plan created', {
      intent: plan.intent,
      toolCalls: plan.toolCalls.length,
    });

    const executorMessages: ChatMessage[] = [
      {
        role: 'system',
        content: EXECUTOR_PROMPT,
      },
      {
        role: 'user',
        content: `Execution plan:\n${JSON.stringify(plan)}`,
      },
    ];

    let executorResponse: LlmResponse;
    try {
      executorResponse = await this.executor.complete(executorMessages, { temperature: 0.2 });
    } catch (error) {
      orchestratorMetrics.executorFailures += 1;
      if (this.fallbackExecutor) {
        orchestratorMetrics.fallbacks += 1;
        this.logger?.warn('Orchestrator: executor failed, using fallback', error);
        return this.fallbackExecutor.complete(messages, options);
      }
      throw error;
    }

    const execResults = extractJson<Record<string, unknown>>(executorResponse.content) ?? {
      raw: executorResponse.content,
    };

    const synthMessages: ChatMessage[] = [
      {
        role: 'system',
        content: `${SYNTHESIZER_PROMPT}\n\n## Base Instructions\n${systemMessage}`,
      },
      ...rest,
      {
        role: 'assistant',
        content: `Execution results:\n${JSON.stringify(execResults)}`,
      },
    ];

    try {
      return await this.orchestrator.complete(synthMessages, options);
    } catch (error) {
      orchestratorMetrics.synthFailures += 1;
      if (this.fallbackExecutor) {
        orchestratorMetrics.fallbacks += 1;
        this.logger?.warn('Orchestrator: synth failed, using fallback', error);
        return this.fallbackExecutor.complete(messages, options);
      }
      throw error;
    }
  }
}

export interface AgenticLlmOptions extends LlmClientOptions {
  maxToolCalls?: number;
}

export class AgenticAnthropicClient implements LlmClient {
  private client: Anthropic;
  private model: string;
  private toolContext: ToolExecutorContext;
  meta?: LlmClientMeta;

  constructor(
    config: ThufirConfig,
    toolContext: ToolExecutorContext,
    modelOverride?: string
  ) {
    const baseURL = resolveAnthropicBaseUrl(config);
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || 'unused',
      baseURL,
    });
    this.model = modelOverride ?? config.agent.model;
    this.toolContext = toolContext;
    this.meta = { provider: 'anthropic', model: this.model, kind: 'agentic' };
  }

  async complete(messages: ChatMessage[], options?: AgenticLlmOptions): Promise<LlmResponse> {
    // Some interactive requests can require many tool iterations (portfolio + web + follow-ups).
    // Keep a conservative ceiling, but avoid premature failure.
    const maxIterations = options?.maxToolCalls ?? 40;
    const temperature = options?.temperature ?? 0.2;

    const system = messages.find((msg) => msg.role === 'system')?.content ?? '';
    const prelude = loadIdentityPrelude({
      workspacePath: this.toolContext.config.agent?.workspace,
      promptMode: resolveIdentityPromptMode(this.toolContext.config, this.meta?.kind),
      bootstrapMaxChars: this.toolContext.config.agent?.identityBootstrapMaxChars,
      includeMissing: this.toolContext.config.agent?.identityBootstrapIncludeMissing,
    }).prelude;
    const systemPrompt =
      prelude && !system.includes(IDENTITY_MARKER)
        ? `${prelude}${system ? '\n\n---\n\n' + system : ''}`
        : system;
    let anthropicMessages: MessageParam[] = messages
      .filter((msg) => msg.role !== 'system')
      .map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));

    let iteration = 0;
    while (iteration < maxIterations) {
      iteration += 1;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        temperature,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: THUFIR_TOOLS,
      });

      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use'
      );

      if (toolUseBlocks.length === 0) {
        const text = response.content
          .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
          .map((block) => block.text)
          .join('')
          .trim();
        return { content: text, model: this.model };
      }

      const toolResults: ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const result = await executeToolCall(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
          this.toolContext
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result.success ? result.data : { error: result.error }),
          is_error: !result.success,
        });
      }

      anthropicMessages.push({
        role: 'assistant',
        content: response.content,
      });

      anthropicMessages.push({
        role: 'user',
        content: toolResults,
      });
    }

    return {
      content: 'I was unable to complete the request within the allowed number of steps.',
      model: this.model,
    };
  }
}

type OpenAiTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

type OpenAiToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type OpenAiMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: OpenAiToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDefaultLlmTimeoutMs(): number {
  const raw = Number(process.env.THUFIR_LLM_TIMEOUT_MS ?? 45_000);
  if (!Number.isFinite(raw)) return 45_000;
  return Math.max(1_000, raw);
}

async function runWithTimeout<T>(
  task: () => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  if (timeoutMs <= 0) {
    return task();
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    task()
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function parseProxyError(detail: string): string {
  try {
    const outer = JSON.parse(detail);
    const inner = outer?.error?.message ? JSON.parse(outer.error.message) : null;
    if (inner?.error?.code === 'model_cooldown') {
      return `LLM rate limited. All providers cooling down. Reset in ${inner.error.reset_time ?? 'a few minutes'}.`;
    }
    return inner?.error?.message ?? outer?.error?.message ?? detail;
  } catch {
    return detail;
  }
}

async function fetchWithRetry(factory: () => Promise<FetchResponse>): Promise<FetchResponse> {
  return factory();
}

// ---------------------------------------------------------------------------
// Text-based tool calling helpers
// ---------------------------------------------------------------------------
// When going through a proxy that strips the `tools` API parameter, we inject
// tool definitions into the system prompt as text and parse structured
// <tool_call> blocks from the model's response.

interface TextToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function buildTextToolPrompt(): string {
  const toolDefs = THUFIR_TOOLS.map((tool) => {
    const schema = tool.input_schema as {
      properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
      required?: string[];
    };
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const paramLines = Object.entries(props).map(([name, prop]) => {
      const req = required.has(name) ? '' : '?';
      const enumPart = prop.enum ? ` [${prop.enum.join(', ')}]` : '';
      return `    ${name}${req} (${prop.type ?? 'any'}${enumPart}): ${prop.description ?? ''}`;
    });
    const paramsBlock = paramLines.length > 0 ? '\n' + paramLines.join('\n') : '';
    return `- **${tool.name}**: ${tool.description}${paramsBlock}`;
  }).join('\n');

  return `## Available Tools

To call a tool, output a <tool_call> block:

<tool_call>
{"name": "tool_name", "arguments": {"key": "value"}}
</tool_call>

You may use multiple <tool_call> blocks per response. Wait for results; never fabricate outputs.

${toolDefs}`;
}

function parseTextToolCalls(text: string): TextToolCall[] {
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const calls: TextToolCall[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    try {
      const raw = match[1]!;
      // Handle potential markdown code fences inside the block
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const parsed = JSON.parse(cleaned);
      if (typeof parsed.name === 'string') {
        calls.push({
          name: parsed.name,
          arguments:
            typeof parsed.arguments === 'object' && parsed.arguments !== null
              ? parsed.arguments
              : {},
        });
      }
    } catch {
      // Skip malformed tool calls
    }
  }
  return calls;
}

function formatTextToolResults(
  results: Array<{ name: string; data: unknown; success: boolean }>
): string {
  return results
    .map((r) => {
      const content = JSON.stringify(r.success ? r.data : { error: r.data });
      return `<tool_result name="${r.name}">\n${content}\n</tool_result>`;
    })
    .join('\n\n');
}

export class AgenticOpenAiClient implements LlmClient {
  private model: string;
  private baseUrl: string;
  private toolContext: ToolExecutorContext;
  private includeTemperature: boolean;
  private useResponsesApi: boolean;
  private useTextToolCalling: boolean;
  meta?: LlmClientMeta;

  constructor(
    config: ThufirConfig,
    toolContext: ToolExecutorContext,
    modelOverride?: string
  ) {
    this.model = resolveOpenAiModel(config, modelOverride);
    this.baseUrl = resolveOpenAiBaseUrl(config);
    this.toolContext = toolContext;
    this.includeTemperature = !config.agent.useProxy;
    this.useResponsesApi = config.agent.useResponsesApi ?? config.agent.useProxy;
    this.useTextToolCalling = config.agent.useProxy ?? false;
    this.meta = { provider: 'openai', model: this.model, kind: 'agentic' };
  }

  async complete(messages: ChatMessage[], options?: AgenticLlmOptions): Promise<LlmResponse> {
    // Some interactive requests can require many tool iterations (portfolio + web + follow-ups).
    // Keep a conservative ceiling, but avoid premature failure.
    const maxIterations = options?.maxToolCalls ?? 40;
    const temperature = options?.temperature ?? 0.2;

    const prelude = loadIdentityPrelude({
      workspacePath: this.toolContext.config.agent?.workspace,
      promptMode: resolveIdentityPromptMode(this.toolContext.config, this.meta?.kind),
      bootstrapMaxChars: this.toolContext.config.agent?.identityBootstrapMaxChars,
      includeMissing: this.toolContext.config.agent?.identityBootstrapIncludeMissing,
    }).prelude;

    if (this.useTextToolCalling) {
      return this.completeWithTextTools(messages, maxIterations, temperature, prelude);
    }

    let openaiMessages: OpenAiMessage[] = injectIdentity(
      messages,
      prelude
    ).map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // llm-mux's /v1/responses follows the Responses API shape where tool calls are returned as
    // top-level output items of type "function_call" (not nested inside message.content[]).
    // Keep a separate input-item transcript for that path.
    const responsesInstructions = this.useResponsesApi
      ? openaiMessages
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n\n---\n\n') || undefined
      : undefined;
    let responsesInput: Array<Record<string, unknown>> | null = this.useResponsesApi
      ? openaiMessages
          .filter((msg) => msg.role !== 'system')
          .map((msg) => ({
            role: msg.role,
            content:
              msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls
                ? msg.tool_calls.map((call) => ({
                    type: 'function_call',
                    name: call.function.name,
                    arguments: call.function.arguments,
                    call_id: call.id,
                  }))
                : [{ type: 'text', text: msg.content ?? '' }],
          }))
      : null;

    const tools: OpenAiTool[] = THUFIR_TOOLS.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema as Record<string, unknown>,
      },
    }));

    const responseTools = THUFIR_TOOLS.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema as Record<string, unknown>,
      },
    }));

    let iteration = 0;
    while (iteration < maxIterations) {
      iteration += 1;
      const response = await fetchWithRetry(() =>
        fetch(`${this.baseUrl}${this.useResponsesApi ? '/v1/responses' : '/v1/chat/completions'}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            this.useResponsesApi
              ? {
                  model: this.model,
                  // Merge ALL system messages into instructions (identity + task prompts)
                  instructions: responsesInstructions,
                  input: responsesInput ?? [],
                  // Responses API expects OpenAI's canonical tool schema.
                  tools: responseTools,
                }
              : {
                  model: this.model,
                  ...(this.includeTemperature ? { temperature } : {}),
                  messages: openaiMessages,
                  tools,
                }
          ),
        })
      );

      if (!response.ok) {
        let detail = '';
        try {
          detail = await response.text();
        } catch {
          detail = '';
        }
        const errorMsg = detail ? parseProxyError(detail) : `status ${response.status}`;
        throw new Error(`LLM request failed: ${errorMsg}`);
      }

      const data = (await response.json()) as {
        response?: Record<string, unknown>;
        choices?: Array<{
          message: {
            content: string | null;
            tool_calls?: OpenAiToolCall[];
          };
        }>;
        output?: unknown;
      };

      if (this.useResponsesApi) {
        const root = (data.response ?? data) as any;
        if (root?.error) {
          const msg =
            typeof root.error === 'string'
              ? root.error
              : typeof root.error?.message === 'string'
                ? root.error.message
                : JSON.stringify(root.error);
          throw new Error(`LLM request failed: ${msg}`);
        }

        const outputItems: any[] = Array.isArray(root?.output) ? root.output : [];

        // llm-mux returns tool calls as top-level output items with shape:
        // { type: "function_call", name, arguments, call_id, ... } (no content array)
        const toolCallsFromItems = outputItems
          .filter((item) => item && item.type === 'function_call' && typeof item.name === 'string')
          .map((item) => ({
            id: typeof item.call_id === 'string' && item.call_id ? item.call_id : `call_${Date.now()}`,
            type: 'function' as const,
            function: {
              name: String(item.name),
              arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
            },
          }));

        // Also support canonical Responses format where function_call appears inside message.content[].
        const contentParts: any[] = outputItems.flatMap((item) =>
          Array.isArray(item?.content) ? item.content : []
        );
        const toolCallsFromContent = contentParts
          .filter((part) => part && part.type === 'function_call' && typeof part.name === 'string')
          .map((part) => ({
            id: typeof part.call_id === 'string' && part.call_id ? part.call_id : `call_${Date.now()}`,
            type: 'function' as const,
            function: {
              name: String(part.name),
              arguments: typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments ?? {}),
            },
          }));

        const toolCalls = [...toolCallsFromItems, ...toolCallsFromContent];

        if (toolCalls.length === 0) {
          const text = contentParts
            .filter((part) => part && (part.type === 'output_text' || part.type === 'text'))
            .map((part) => String(part.text ?? ''))
            .join('')
            .trim();
          return { content: text, model: this.model };
        }

        if (!responsesInput) {
          responsesInput = [];
        }
        for (const toolCall of toolCalls) {
          // Append the function call event.
          responsesInput.push({
            type: 'function_call',
            call_id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          });

          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(toolCall.function.arguments ?? '{}');
          } catch {
            parsed = {};
          }
          const result = await executeToolCall(toolCall.function.name, parsed, this.toolContext);
          // Append the function call output event.
          responsesInput.push({
            type: 'function_call_output',
            call_id: toolCall.id,
            output: JSON.stringify(result.success ? result.data : { error: result.error }),
          });
        }
        continue;
      }

      const message = data.choices?.[0]?.message;
      if (!message) {
        return { content: '', model: this.model };
      }

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return { content: (message.content ?? '').trim(), model: this.model };
      }

      openaiMessages.push({
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(toolCall.function.arguments ?? '{}');
        } catch {
          parsed = {};
        }
        const result = await executeToolCall(toolCall.function.name, parsed, this.toolContext);
        openaiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result.success ? result.data : { error: result.error }),
        });
      }
    }

    return {
      content: 'I was unable to complete the request within the allowed number of steps.',
      model: this.model,
    };
  }

  /**
   * Text-based tool calling: injects tool definitions into the system prompt
   * and parses <tool_call> blocks from the model's text response.
   * Used when a proxy strips the native `tools` API parameter.
   */
  private async completeWithTextTools(
    messages: ChatMessage[],
    maxIterations: number,
    temperature: number,
    prelude: string
  ): Promise<LlmResponse> {
    const toolPrompt = buildTextToolPrompt();

    // Build conversation with identity prelude injected
    const conversation: Array<{ role: string; content: string }> = injectIdentity(
      messages,
      prelude
    ).map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Inject tool definitions into the system message
    const sysIdx = conversation.findIndex((m) => m.role === 'system');
    if (sysIdx >= 0) {
      conversation[sysIdx] = {
        role: 'system',
        content: `${conversation[sysIdx]!.content}\n\n${toolPrompt}`,
      };
    } else {
      conversation.unshift({ role: 'system', content: toolPrompt });
    }

    let iteration = 0;
    while (iteration < maxIterations) {
      iteration += 1;

      const endpoint = this.useResponsesApi ? '/v1/responses' : '/v1/chat/completions';
      let body: Record<string, unknown>;

      if (this.useResponsesApi) {
        const instructions =
          conversation
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n\n---\n\n') || undefined;
        const input = conversation
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role,
            content: [{ type: 'text', text: m.content }],
          }));
        body = { model: this.model, instructions, input };
      } else {
        body = {
          model: this.model,
          ...(this.includeTemperature ? { temperature } : {}),
          messages: conversation,
        };
      }

      const response = await fetchWithRetry(() =>
        fetch(`${this.baseUrl}${endpoint}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        })
      );

      if (!response.ok) {
        let detail = '';
        try {
          detail = await response.text();
        } catch {
          detail = '';
        }
        const errorMsg = detail ? parseProxyError(detail) : `status ${response.status}`;
        throw new Error(`LLM request failed: ${errorMsg}`);
      }

      const data = (await response.json()) as any;

      // Extract text from the response
      let text: string;
      if (this.useResponsesApi) {
        const root = data.response ?? data;
        if (root?.error) {
          const msg =
            typeof root.error === 'string'
              ? root.error
              : typeof root.error?.message === 'string'
                ? root.error.message
                : JSON.stringify(root.error);
          throw new Error(`LLM request failed: ${msg}`);
        }
        const outputItems: any[] = Array.isArray(root?.output) ? root.output : [];
        text = outputItems
          .flatMap((item: any) => (Array.isArray(item?.content) ? item.content : []))
          .filter((part: any) => part && (part.type === 'output_text' || part.type === 'text'))
          .map((part: any) => String(part.text ?? ''))
          .join('');
      } else {
        const message = data.choices?.[0]?.message;
        text = message?.content ?? '';
      }

      // Parse text for <tool_call> blocks
      const toolCalls = parseTextToolCalls(text);

      if (toolCalls.length === 0) {
        // No tool calls — return the model's text as the final response.
        // Strip any leftover <tool_call> artifacts just in case.
        return { content: text.trim(), model: this.model };
      }

      // Append the assistant's full response (including tool_call blocks) to conversation
      conversation.push({ role: 'assistant', content: text });

      // Execute each tool call
      const results: Array<{ name: string; data: unknown; success: boolean }> = [];
      for (const tc of toolCalls) {
        const result = await executeToolCall(tc.name, tc.arguments, this.toolContext);
        results.push({
          name: tc.name,
          data: result.success ? result.data : result.error,
          success: result.success,
        });
      }

      // Feed tool results back as a user message
      conversation.push({
        role: 'user',
        content: formatTextToolResults(results),
      });
    }

    return {
      content: 'I was unable to complete the request within the allowed number of steps.',
      model: this.model,
    };
  }
}

class AnthropicClient implements LlmClient {
  private config: ThufirConfig;
  private client: Anthropic;
  private model: string;
  meta?: LlmClientMeta;

  constructor(config: ThufirConfig, modelOverride?: string, kind?: LlmClientMeta['kind']) {
    this.config = config;
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      baseURL: resolveAnthropicBaseUrl(config),
    });
    this.model = modelOverride ?? config.agent.model;
    this.meta = { provider: 'anthropic', model: this.model, kind };
  }

  async complete(messages: ChatMessage[], options?: LlmClientOptions): Promise<LlmResponse> {
    const system = messages.find((msg) => msg.role === 'system')?.content ?? '';
    const prelude = loadIdentityPrelude({
      workspacePath: this.config.agent?.workspace,
      promptMode: resolveIdentityPromptMode(this.config, this.meta?.kind),
      bootstrapMaxChars: this.config.agent?.identityBootstrapMaxChars,
      includeMissing: this.config.agent?.identityBootstrapIncludeMissing,
    }).prelude;
    const systemPrompt =
      prelude && !system.includes(IDENTITY_MARKER)
        ? `${prelude}${system ? '\n\n---\n\n' + system : ''}`
        : system;
    const converted = messages
      .filter((msg) => msg.role !== 'system')
      .map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.2,
      system: systemPrompt,
      messages: converted,
    });

    const text = response.content
      .map((block) => ('text' in block ? block.text : ''))
      .join('')
      .trim();

    return { content: text, model: this.model };
  }
}

class OpenAiClient implements LlmClient {
  private config: ThufirConfig;
  private model: string;
  private baseUrl: string;
  private includeTemperature: boolean;
  private useResponsesApi: boolean;
  meta?: LlmClientMeta;

  constructor(config: ThufirConfig, modelOverride?: string, kind?: LlmClientMeta['kind']) {
    this.config = config;
    this.model = resolveOpenAiModel(config, modelOverride);
    this.baseUrl = resolveOpenAiBaseUrl(config);
    this.includeTemperature = !config.agent.useProxy;
    // Some OpenAI-compatible proxies (e.g. llm-mux) don't support the Responses API
    // parameters (e.g. max_output_tokens). Only enable when explicitly requested.
    this.useResponsesApi = config.agent.useResponsesApi ?? false;
    this.meta = { provider: 'openai', model: this.model, kind };
  }

  async complete(messages: ChatMessage[], options?: LlmClientOptions): Promise<LlmResponse> {
    const prelude = loadIdentityPrelude({
      workspacePath: this.config.agent?.workspace,
      promptMode: resolveIdentityPromptMode(this.config, this.meta?.kind),
      bootstrapMaxChars: this.config.agent?.identityBootstrapMaxChars,
      includeMissing: this.config.agent?.identityBootstrapIncludeMissing,
    }).prelude;
    // Inject workspace identity at the start (Moltbot pattern)
    const openaiMessages = injectIdentity(messages, prelude);
    const maxTokens = options?.maxTokens;
    // llm-mux's /v1/responses currently rejects token limit parameters entirely.
    // When talking to OpenAI directly, `max_output_tokens` is fine.
    const shouldSendResponsesTokenLimit = !this.config.agent.useProxy;
    const response = await fetchWithRetry(() =>
      fetch(`${this.baseUrl}${this.useResponsesApi ? '/v1/responses' : '/v1/chat/completions'}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          this.useResponsesApi
            ? {
                model: this.model,
                ...(shouldSendResponsesTokenLimit && typeof maxTokens === 'number'
                  ? { max_output_tokens: maxTokens }
                  : {}),
                // Merge ALL system messages into instructions (identity + task prompts)
                instructions: openaiMessages
                  .filter((m) => m.role === 'system')
                  .map((m) => m.content)
                  .join('\n\n---\n\n') || undefined,
                input: openaiMessages
                  .filter((msg) => msg.role !== 'system')
                  .map((msg) => ({
                    role: msg.role,
                    content: [{ type: 'text', text: msg.content }],
                  })),
              }
            : {
                model: this.model,
                ...(this.includeTemperature ? { temperature: options?.temperature ?? 0.2 } : {}),
                // Prefer max_tokens for broad OpenAI-compatible proxy support.
                ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
                messages: openaiMessages,
              }
        ),
      })
    );

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        detail = '';
      }
      const errorMsg = detail ? parseProxyError(detail) : `status ${response.status}`;
      throw new Error(`LLM request failed: ${errorMsg}`);
    }

    const data = (await response.json()) as {
      response?: {
        output?: Array<{ type?: string; content?: Array<{ type: string; text?: string }> }>;
      };
      choices?: Array<{ message: { content: string } }>;
      output?: Array<{ type?: string; content?: Array<{ type: string; text?: string }> }>;
    };

    const text = this.useResponsesApi
      ? ((data.response?.output ?? data.output)
          ?.flatMap((item) => (Array.isArray(item.content) ? item.content : []))
          .filter((part) => part.type === 'output_text')
          .map((part) => part.text ?? '')
          .join('')
          .trim() ?? '')
      : data.choices?.[0]?.message?.content?.trim() ?? '';
    return { content: text, model: this.model };
  }
}

class LocalClient implements LlmClient {
  private model: string;
  private baseUrl: string;
  private config: ThufirConfig;
  meta?: LlmClientMeta;

  constructor(config: ThufirConfig, modelOverride?: string, kind?: LlmClientMeta['kind']) {
    this.config = config;
    this.model = modelOverride ?? config.agent.model;
    this.baseUrl = resolveLocalBaseUrl(config);
    this.meta = { provider: 'local', model: this.model, kind };
  }

  async complete(
    messages: ChatMessage[],
    options?: LlmClientOptions
  ): Promise<LlmResponse> {
    const prelude = loadIdentityPrelude({
      workspacePath: this.config.agent?.workspace,
      promptMode: resolveIdentityPromptMode(this.config, this.meta?.kind),
      bootstrapMaxChars: this.config.agent?.identityBootstrapMaxChars,
      includeMissing: this.config.agent?.identityBootstrapIncludeMissing,
    }).prelude;
    const localMessages = injectIdentity(messages, prelude);
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutMs = options?.timeoutMs;
    let timeout: NodeJS.Timeout | null = null;
    if (controller && timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => controller.abort(), timeoutMs);
    }

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller?.signal,
        body: JSON.stringify({
          model: this.model,
          temperature: options?.temperature ?? 0.2,
          ...(typeof options?.maxTokens === 'number' ? { max_tokens: options.maxTokens } : {}),
          messages: localMessages,
        }),
      });
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }

    if (!response.ok) {
      throw new Error(`Local model request failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    return { content: text, model: this.model };
  }
}

export class FallbackLlmClient implements LlmClient {
  meta?: LlmClientMeta;
  private logger: Logger;
  constructor(
    private primary: LlmClient,
    private fallback: LlmClient,
    private shouldFallback: (error: unknown) => boolean,
    private config?: ThufirConfig,
    logger?: Logger
  ) {
    this.logger = logger ?? new Logger('info');
    this.meta = primary.meta;
  }

  async complete(
    messages: ChatMessage[],
    options?: LlmClientOptions
  ): Promise<LlmResponse> {
    const primaryMeta = this.primary.meta ?? { provider: 'unknown', model: 'unknown' };
    const fallbackMeta = this.fallback.meta ?? { provider: 'unknown', model: 'unknown' };
    if (primaryMeta.provider !== 'unknown' && primaryMeta.model !== 'unknown') {
      const cooldown = isCooling(primaryMeta.provider, primaryMeta.model);
      if (cooldown) {
        const reason = `primary cooling until ${new Date(cooldown.until).toISOString()}`;
        this.logger.warn('LLM fallback triggered (primary cooling)', {
          from: primaryMeta,
          to: fallbackMeta,
          reason,
        });
        return this.fallback.complete(messages, options);
      }
    }

    try {
      return await this.primary.complete(messages, options);
    } catch (error) {
      if (!this.shouldFallback(error)) {
        throw error;
      }
      const reason = extractErrorMessage(error);
      const ctx = getExecutionContext();
      const allowNonCritical = this.config?.agent?.allowFallbackNonCritical ?? true;
      if (!ctx?.critical && !allowNonCritical) {
        this.logger?.warn('LLM fallback suppressed (non-critical context)', {
          from: primaryMeta,
          to: fallbackMeta,
          reason,
        });
        throw error;
      }
      this.logger?.warn('LLM fallback triggered', {
        from: primaryMeta,
        to: fallbackMeta,
        reason,
      });
      if (this.config) {
        const budget = getLlmBudgetManager(this.config);
        const meta = this.fallback.meta ?? { provider: 'openai', model: 'unknown' };
        const tokens = estimateTokensFromMessages(messages);
        if (!budget.canConsume(tokens, true, meta.provider)) {
          throw error;
        }
      }
      return this.fallback.complete(messages, options);
    }
  }
}

function extractErrorMessage(error: unknown): string {
  if (!error) return '';
  const err = error as {
    message?: string;
    error?: { message?: string; error?: { message?: string } };
    response?: { data?: { error?: { message?: string } } };
  };
  return [
    err.message,
    err.error?.message,
    err.error?.error?.message,
    err.response?.data?.error?.message,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
}

export function isRateLimitError(error: unknown): boolean {
  const err = error as { status?: number; message?: string };
  if (err?.status && err.status >= 500 && err.status <= 599) return true;
  if (err?.status === 429) return true;
  if (err?.status === 402) return true;
  const message = extractErrorMessage(error).toLowerCase();
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
    message.includes('balance is too low') ||
    message.includes('circuit_open') ||
    message.includes('circuit open') ||
    message.includes('circuit breaker')
  );
}
