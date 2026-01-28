import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';

import type { BijazConfig } from './config.js';
import { BIJAZ_TOOLS } from './tool-schemas.js';
import { executeToolCall, type ToolExecutorContext } from './tool-executor.js';
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

export function createLlmClient(config: BijazConfig): LlmClient {
  switch (config.agent.provider) {
    case 'anthropic':
      return createAnthropicClientWithFallback(config);
    case 'openai':
      return new OpenAiClient(config);
    case 'local':
      return new LocalClient(config);
    default:
      return createAnthropicClientWithFallback(config);
  }
}

export function createOpenAiClient(
  config: BijazConfig,
  modelOverride?: string
): LlmClient {
  return new OpenAiClient(config, modelOverride);
}

export interface AgenticLlmOptions {
  maxToolCalls?: number;
  temperature?: number;
}

export class AgenticAnthropicClient implements LlmClient {
  private client: Anthropic;
  private model: string;
  private toolContext: ToolExecutorContext;

  constructor(config: BijazConfig, toolContext: ToolExecutorContext) {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
    this.model = config.agent.model;
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
        tools: BIJAZ_TOOLS,
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
    const baseDelay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt;
    const jitter = Math.floor(Math.random() * 250);
    await sleep(baseDelay + jitter);
    attempt += 1;
  }
}

export class AgenticOpenAiClient implements LlmClient {
  private model: string;
  private baseUrl: string;
  private toolContext: ToolExecutorContext;

  constructor(config: BijazConfig, toolContext: ToolExecutorContext) {
    this.model = config.agent.openaiModel ?? config.agent.model;
    this.baseUrl = config.agent.apiBaseUrl ?? 'https://api.openai.com';
    this.toolContext = toolContext;
  }

  async complete(messages: ChatMessage[], options?: AgenticLlmOptions): Promise<LlmResponse> {
    const maxIterations = options?.maxToolCalls ?? 6;
    const temperature = options?.temperature ?? 0.2;

    const openaiMessages: OpenAiMessage[] = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const tools: OpenAiTool[] = BIJAZ_TOOLS.map((tool) => ({
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
        fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            temperature,
            messages: openaiMessages,
            tools,
          }),
        })
      );

      if (!response.ok) {
        throw new Error(`OpenAI request failed: ${response.status}`);
      }

      const data = (await response.json()) as {
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: OpenAiToolCall[];
          };
        }>;
      };

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

  constructor(config: BijazConfig) {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
    this.model = config.agent.model;
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
  private model: string;
  private baseUrl: string;

  constructor(config: BijazConfig, modelOverride?: string) {
    this.model = modelOverride ?? config.agent.model;
    this.baseUrl = config.agent.apiBaseUrl ?? 'https://api.openai.com';
  }

  async complete(messages: ChatMessage[], options?: { temperature?: number }): Promise<LlmResponse> {
    const response = await fetchWithRetry(() =>
      fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          temperature: options?.temperature ?? 0.2,
          messages,
        }),
      })
    );

    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    return { content: text, model: this.model };
  }
}

class LocalClient implements LlmClient {
  private model: string;
  private baseUrl: string;

  constructor(config: BijazConfig) {
    this.model = config.agent.model;
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

class FallbackLlmClient implements LlmClient {
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

function isRateLimitError(error: unknown): boolean {
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

function createAnthropicClientWithFallback(config: BijazConfig): LlmClient {
  const primary = new AnthropicClient(config);
  const fallbackModel = config.agent.openaiModel ?? config.agent.fallbackModel ?? 'gpt-5.2';
  const fallback = new OpenAiClient(config, fallbackModel);
  return new FallbackLlmClient(primary, fallback, isRateLimitError);
}
