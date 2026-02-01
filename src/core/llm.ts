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
} from '../agent/identity/identity.js';

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

export interface LlmClient {
  complete(messages: ChatMessage[], options?: { temperature?: number }): Promise<LlmResponse>;
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

  complete(messages: ChatMessage[], options?: { temperature?: number }): Promise<LlmResponse> {
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

export function createLlmClient(config: ThufirConfig): LlmClient {
  switch (config.agent.provider) {
    case 'anthropic':
      return wrapWithLimiter(createAnthropicClientWithFallback(config));
    case 'openai':
      return wrapWithLimiter(new OpenAiClient(config));
    case 'local':
      return wrapWithLimiter(new LocalClient(config));
    default:
      return wrapWithLimiter(createAnthropicClientWithFallback(config));
  }
}

export function createOpenAiClient(
  config: ThufirConfig,
  modelOverride?: string
): LlmClient {
  return wrapWithLimiter(new OpenAiClient(config, modelOverride));
}

export function createExecutorClient(
  config: ThufirConfig,
  modelOverride?: string,
  providerOverride?: 'anthropic' | 'openai' | 'local'
): LlmClient {
  const provider = providerOverride ?? config.agent.executorProvider ?? 'openai';
  const model =
    modelOverride ??
    config.agent.executorModel ??
    config.agent.openaiModel ??
    config.agent.model;
  switch (provider) {
    case 'anthropic':
      return wrapWithLimiter(new AnthropicClient(config, model));
    case 'local':
      return wrapWithLimiter(new LocalClient(config, model));
    case 'openai':
    default:
      return wrapWithLimiter(new OpenAiClient(config, model));
  }
}

export function createAgenticExecutorClient(
  config: ThufirConfig,
  toolContext: ToolExecutorContext,
  modelOverride?: string
): LlmClient {
  const provider = config.agent.executorProvider ?? 'openai';
  const model =
    modelOverride ??
    config.agent.executorModel ??
    config.agent.openaiModel ??
    config.agent.model;
  if (provider === 'anthropic') {
    const primary = new AgenticAnthropicClient(config, toolContext, model);
    const fallbackModel = config.agent.openaiModel ?? config.agent.fallbackModel ?? 'gpt-5.2';
    const fallback = new AgenticOpenAiClient(config, toolContext, fallbackModel);
    return wrapWithLimiter(new FallbackLlmClient(primary, fallback, isRateLimitError));
  }
  return wrapWithLimiter(new AgenticOpenAiClient(config, toolContext, model));
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

function resolveAnthropicBaseUrl(config: ThufirConfig): string | undefined {
  if (config.agent.useProxy) {
    return config.agent.proxyBaseUrl;
  }
  return undefined;
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

  async complete(messages: ChatMessage[], options?: { temperature?: number }): Promise<LlmResponse> {
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

export interface AgenticLlmOptions {
  maxToolCalls?: number;
  temperature?: number;
}

export class AgenticAnthropicClient implements LlmClient {
  private client: Anthropic;
  private model: string;
  private toolContext: ToolExecutorContext;

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
  }

  async complete(messages: ChatMessage[], options?: AgenticLlmOptions): Promise<LlmResponse> {
    const maxIterations = options?.maxToolCalls ?? 6;
    const temperature = options?.temperature ?? 0.2;

    const system = messages.find((msg) => msg.role === 'system')?.content ?? '';
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
        system,
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

const MAX_RETRY_DELAY_MS = 30_000; // Cap retry delay at 30 seconds

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

async function fetchWithRetry(
  factory: () => Promise<FetchResponse>,
  maxRetries = 3
): Promise<FetchResponse> {
  let attempt = 0;
  while (true) {
    const response = await factory();
    if (response.ok || response.status !== 429 || attempt >= maxRetries) {
      return response;
    }

    const retryAfter = Number(response.headers.get('retry-after') ?? '');
    // If retry-after is longer than our max, don't wait - just return the 429
    if (Number.isFinite(retryAfter) && retryAfter * 1000 > MAX_RETRY_DELAY_MS) {
      return response;
    }
    const baseDelay = Number.isFinite(retryAfter)
      ? Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS)
      : Math.min(500 * 2 ** attempt, MAX_RETRY_DELAY_MS);
    const jitter = Math.floor(Math.random() * 250);
    await sleep(baseDelay + jitter);
    attempt += 1;
  }
}

export class AgenticOpenAiClient implements LlmClient {
  private model: string;
  private baseUrl: string;
  private toolContext: ToolExecutorContext;
  private includeTemperature: boolean;
  private useResponsesApi: boolean;

  constructor(
    config: ThufirConfig,
    toolContext: ToolExecutorContext,
    modelOverride?: string
  ) {
    this.model = modelOverride ?? config.agent.openaiModel ?? config.agent.model;
    this.baseUrl = resolveOpenAiBaseUrl(config);
    this.toolContext = toolContext;
    this.includeTemperature = !config.agent.useProxy;
    this.useResponsesApi = config.agent.useProxy;
  }

  async complete(messages: ChatMessage[], options?: AgenticLlmOptions): Promise<LlmResponse> {
    const maxIterations = options?.maxToolCalls ?? 6;
    const temperature = options?.temperature ?? 0.2;

    let openaiMessages: OpenAiMessage[] = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
    if (this.useResponsesApi) {
      const prelude = loadIdentityPrelude({
        workspacePath: this.toolContext.config.agent?.workspace,
        promptMode: this.toolContext.config.agent?.identityPromptMode ?? 'full',
      }).prelude;
      // Inject workspace identity at the start (Moltbot pattern)
      openaiMessages = injectIdentity(openaiMessages, prelude);
    }

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
                  input: openaiMessages.map((msg) => ({
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
  private client: Anthropic;
  private model: string;

  constructor(config: ThufirConfig, modelOverride?: string) {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      baseURL: resolveAnthropicBaseUrl(config),
    });
    this.model = modelOverride ?? config.agent.model;
  }

  async complete(messages: ChatMessage[], options?: { temperature?: number }): Promise<LlmResponse> {
    const system = messages.find((msg) => msg.role === 'system')?.content ?? '';
    const converted = messages
      .filter((msg) => msg.role !== 'system')
      .map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      temperature: options?.temperature ?? 0.2,
      system,
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

  constructor(config: ThufirConfig, modelOverride?: string) {
    this.config = config;
    this.model = modelOverride ?? config.agent.model;
    this.baseUrl = resolveOpenAiBaseUrl(config);
    this.includeTemperature = !config.agent.useProxy;
    this.useResponsesApi = config.agent.useProxy;
  }

  async complete(messages: ChatMessage[], options?: { temperature?: number }): Promise<LlmResponse> {
    let openaiMessages = messages;
    if (this.useResponsesApi) {
      const prelude = loadIdentityPrelude({
        workspacePath: this.config.agent?.workspace,
        promptMode: this.config.agent?.identityPromptMode ?? 'full',
      }).prelude;
      // Inject workspace identity at the start (Moltbot pattern)
      openaiMessages = injectIdentity(openaiMessages, prelude);
    }
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
                input: openaiMessages.map((msg) => ({
                  role: msg.role,
                  content: [{ type: 'text', text: msg.content }],
                })),
              }
            : {
                model: this.model,
                ...(this.includeTemperature ? { temperature: options?.temperature ?? 0.2 } : {}),
                messages,
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

  constructor(config: ThufirConfig, modelOverride?: string) {
    this.model = modelOverride ?? config.agent.model;
    this.baseUrl = config.agent.apiBaseUrl ?? 'http://localhost:11434';
  }

  async complete(messages: ChatMessage[], options?: { temperature?: number }): Promise<LlmResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        temperature: options?.temperature ?? 0.2,
        messages,
      }),
    });

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
  constructor(
    private primary: LlmClient,
    private fallback: LlmClient,
    private shouldFallback: (error: unknown) => boolean
  ) {}

  async complete(messages: ChatMessage[], options?: { temperature?: number }): Promise<LlmResponse> {
    try {
      return await this.primary.complete(messages, options);
    } catch (error) {
      if (!this.shouldFallback(error)) {
        throw error;
      }
      return this.fallback.complete(messages, options);
    }
  }
}

export function isRateLimitError(error: unknown): boolean {
  const err = error as { status?: number; message?: string };
  if (err?.status && err.status >= 500 && err.status <= 599) return true;
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
  return new FallbackLlmClient(primary, fallback, isRateLimitError);
}
