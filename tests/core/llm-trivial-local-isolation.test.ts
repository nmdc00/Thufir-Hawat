import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('node-fetch', () => {
  return {
    default: vi.fn(),
  };
});

import fetch from 'node-fetch';
import { FallbackLlmClient, isLocalFailure, type ChatMessage, type LlmClient } from '../../src/core/llm.js';

describe('isLocalFailure', () => {
  it('classifies local health/timeout/unreachable errors as local failures', () => {
    expect(isLocalFailure(new Error('Local LLM unavailable: connection refused'))).toBe(true);
    expect(isLocalFailure(new Error('LLM request (local/qwen2.5:1.5b-instruct) timed out after 6000ms'))).toBe(
      true
    );
    expect(isLocalFailure(new Error('Local model request failed: 500'))).toBe(true);
  });

  it('does not classify remote/provider errors as local failures', () => {
    expect(isLocalFailure(new Error('rate limit exceeded'))).toBe(false);
    expect(isLocalFailure(new Error('LLM request (openai/gpt-5.4) timed out after 8000ms'))).toBe(false);
    expect(isLocalFailure(new Error('insufficient credit balance'))).toBe(false);
  });
});

describe('FallbackLlmClient local-failure isolation', () => {
  const message: ChatMessage[] = [{ role: 'user', content: 'ping' }];

  it('does not fall back to a remote provider when the primary fails locally', async () => {
    const primary: LlmClient = {
      meta: { provider: 'local', model: 'qwen2.5:1.5b-instruct', kind: 'trivial' },
      complete: async () => {
        throw new Error('LLM request (local/qwen2.5:1.5b-instruct) timed out after 6000ms');
      },
    };
    const fallback: LlmClient = {
      meta: { provider: 'openai', model: 'gpt-5.4', kind: 'trivial' },
      complete: vi.fn(async () => ({ content: 'remote', model: 'gpt-5.4' })),
    };

    const client = new FallbackLlmClient(primary, fallback, (error) => !isLocalFailure(error));

    await expect(client.complete(message)).rejects.toThrow(/timed out/);
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  it('still falls back to remote for non-local primary failures', async () => {
    const primary: LlmClient = {
      meta: { provider: 'local', model: 'qwen2.5:1.5b-instruct', kind: 'trivial' },
      complete: async () => {
        throw new Error('unexpected token in JSON response');
      },
    };
    const fallback: LlmClient = {
      meta: { provider: 'openai', model: 'gpt-5.4', kind: 'trivial' },
      complete: vi.fn(async () => ({ content: 'remote', model: 'gpt-5.4' })),
    };

    const client = new FallbackLlmClient(primary, fallback, (error) => !isLocalFailure(error));

    const result = await client.complete(message);
    expect(result.content).toBe('remote');
    expect(fallback.complete).toHaveBeenCalledOnce();
  });
});

describe('createTrivialTaskClient local single-flight queue', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('never runs two concurrent completion calls against the local model', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'qwen2.5:1.5b-instruct' }] }) };
      }
      if (url.endsWith('/api/generate')) {
        return { ok: true, json: async () => ({}) };
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    });

    const { createTrivialTaskClient } = await import('../../src/core/llm.js');

    const client = createTrivialTaskClient({
      agent: {
        provider: 'anthropic',
        model: 'claude-test',
        workspace: '/tmp',
        trivialTaskProvider: 'local',
        trivialTaskModel: 'qwen2.5:1.5b-instruct',
        localBaseUrl: 'http://localhost:11434',
        trivial: {
          enabled: true,
          maxTokens: 96,
          temperature: 0.2,
          timeoutMs: 6000,
          localSoftTimeoutMs: 6000,
          fallbackTimeoutMs: 6000,
          keepWarmEnabled: false,
        },
      },
    } as any);

    expect(client).not.toBeNull();

    await Promise.all([
      client!.complete([{ role: 'user', content: 'a' }]),
      client!.complete([{ role: 'user', content: 'b' }]),
      client!.complete([{ role: 'user', content: 'c' }]),
    ]);

    expect(maxInFlight).toBe(1);
  });
});
