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
  constructor(private inner: LlmClient, private limiter: LlmQueue) {}

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
      const response = await this.inner.complete(finalized, options);
      const totalTokens = estimatedTokens + estimateTokensFromText(response.content);
      budget.record(totalTokens, meta.provider);
      return response;
    } catch (error) {
      if (isRateLimitError(error)) {
        const state = recordCooldown(meta.provider, meta.model);
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
  switch (config.agent.provider) {
    case 'anthropic':
      return wrapWithLimiter(wrapWithInfra(createAnthropicClientWithFallback(config), config));
    case 'openai':
      return wrapWithLimiter(wrapWithInfra(new OpenAiClient(config), config));
    case 'local':
      return wrapWithLimiter(wrapWithInfra(new LocalClient(config), config));
    default:
      return wrapWithLimiter(wrapWithInfra(createAnthropicClientWithFallback(config), config));
  }
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
    const fallbackModel = config.agent.openaiModel ?? config.agent.fallbackModel ?? 'gpt-5.2';
    const fallback = new AgenticOpenAiClient(config, toolContext, fallbackModel);
    return wrapWithLimiter(
      wrapWithInfra(new FallbackLlmClient(primary, fallback, isRateLimitError, config), config)
    );
  }
  return wrapWithLimiter(wrapWithInfra(new AgenticOpenAiClient(config, toolContext, model), config));
}

export function createTrivialTaskClient(config: ThufirConfig): LlmClient | null {
  const trivialConfig = config.agent?.trivial;
  if (!trivialConfig?.enabled) return null;
  const provider = config.agent?.trivialTaskProvider ?? 'local';
  const model = config.agent?.trivialTaskModel ?? 'qwen2.5:1.5b-instruct';
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
    // If local cannot answer quickly, fall back to OpenAI for the same trivial task.
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
    const fallback = new TrivialTaskClient(
      new OpenAiClient(config, config.agent.openaiModel ?? config.agent.model, 'trivial'),
      defaults
    );

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
const LOCAL_HEALTH_TIMEOUT_MS = 1500;

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
    const maxIterations = options?.maxToolCalls ?? 20;
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

export class AgenticOpenAiClient implements LlmClient {
  private model: string;
  private baseUrl: string;
  private toolContext: ToolExecutorContext;
  private includeTemperature: boolean;
  private useResponsesApi: boolean;
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
    this.meta = { provider: 'openai', model: this.model, kind: 'agentic' };
  }

  async complete(messages: ChatMessage[], options?: AgenticLlmOptions): Promise<LlmResponse> {
    const maxIterations = options?.maxToolCalls ?? 20;
    const temperature = options?.temperature ?? 0.2;

    const prelude = loadIdentityPrelude({
      workspacePath: this.toolContext.config.agent?.workspace,
      promptMode: resolveIdentityPromptMode(this.toolContext.config, this.meta?.kind),
      bootstrapMaxChars: this.toolContext.config.agent?.identityBootstrapMaxChars,
      includeMissing: this.toolContext.config.agent?.identityBootstrapIncludeMissing,
    }).prelude;
    let openaiMessages: OpenAiMessage[] = injectIdentity(
      messages,
      prelude
    ).map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const tools: OpenAiTool[] = THUFIR_TOOLS.map((tool) => ({
      type: 'function',
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
                  instructions: openaiMessages
                    .filter((m) => m.role === 'system')
                    .map((m) => m.content)
                    .join('\n\n---\n\n') || undefined,
                  input: openaiMessages
                    .filter((msg) => msg.role !== 'system')
                    .map((msg) => ({
                      role: msg.role,
                      content:
                        msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls
                          ? msg.tool_calls.map((call) => ({
                              type: 'function_call',
                              name: call.function.name,
                              arguments: call.function.arguments,
                            }))
                          : [{ type: 'text', text: msg.content ?? '' }],
                    })),
                  tools: THUFIR_TOOLS.map((tool) => ({
                    type: 'function',
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.input_schema as Record<string, unknown>,
                  })),
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
        response?: {
          output?: Array<{
            type?: string;
            content?: Array<
              | { type: 'output_text'; text?: string }
              | { type: 'function_call'; name: string; arguments: string; call_id?: string }
            >;
          }>;
        };
        choices?: Array<{
          message: {
            content: string | null;
            tool_calls?: OpenAiToolCall[];
          };
        }>;
        output?: Array<{
          type?: string;
          content?: Array<
            | { type: 'output_text'; text?: string }
            | { type: 'function_call'; name: string; arguments: string; call_id?: string }
          >;
        }>;
      };

      if (this.useResponsesApi) {
        const root = data.response ?? data;
        const contentParts =
          root.output?.flatMap((item) => (Array.isArray(item.content) ? item.content : [])) ?? [];
        const toolCalls = contentParts
          .filter((part) => part.type === 'function_call')
          .map((part) => ({
            id: 'call_id' in part && part.call_id ? part.call_id : `call_${Date.now()}`,
            type: 'function' as const,
            function: {
              name: (part as { name: string }).name,
              arguments: (part as { arguments: string }).arguments,
            },
          }));

        if (toolCalls.length === 0) {
          const text = contentParts
            .filter((part) => part.type === 'output_text')
            .map((part) => (part as { text?: string }).text ?? '')
            .join('')
            .trim();
          return { content: text, model: this.model };
        }

        openaiMessages.push({
          role: 'assistant',
          content: null,
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
                ...(typeof maxTokens === 'number' ? { max_output_tokens: maxTokens } : {}),
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

function createAnthropicClientWithFallback(config: ThufirConfig): LlmClient {
  const primary = new AnthropicClient(config);
  const fallbackModel = config.agent.openaiModel ?? config.agent.fallbackModel ?? 'gpt-5.2';
  const fallback = new OpenAiClient(config, fallbackModel);
  return new FallbackLlmClient(primary, fallback, isRateLimitError, config);
}
