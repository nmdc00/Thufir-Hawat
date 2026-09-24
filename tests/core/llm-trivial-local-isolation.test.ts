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

  it('admits background work without taking a global permit while it waits for local inference', async () => {
    let releaseLocal!: () => void;
    const localGate = new Promise<void>((resolve) => { releaseLocal = resolve; });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/models')) return { ok: true, json: async () => ({ data: [{ id: 'qwen2.5:1.5b-instruct' }] }) };
      await localGate;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'local' } }] }) };
    });

    const { createBackgroundTrivialTaskClient, wrapWithLimiter } = await import('../../src/core/llm.js');
    const config = {
      agent: {
        provider: 'anthropic', model: 'claude-test', workspace: '/tmp',
        localBaseUrl: 'http://localhost:11434',
        trivial: { enabled: true, timeoutMs: 6000, localSoftTimeoutMs: 6000, keepWarmEnabled: false },
      },
    } as any;
    const background = createBackgroundTrivialTaskClient(config)!;
    const backgroundCall = background.complete([{ role: 'user', content: 'news' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    let interactiveStarted = false;
    const interactive = wrapWithLimiter({
      complete: async () => { interactiveStarted = true; return { content: 'interactive', model: 'test' }; },
    });
    await interactive.complete([{ role: 'user', content: 'interactive' }]);
    expect(interactiveStarted).toBe(true);
    releaseLocal();
    await backgroundCall;
  });

  it('starts a normal local request ahead of queued background work and keeps local calls single-flight', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let inFlight = 0;
    let maxInFlight = 0;
    const prompts: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/models')) return { ok: true, json: async () => ({ data: [{ id: 'qwen2.5:1.5b-instruct' }] }) };
      const body = JSON.parse(String(init?.body));
      prompts.push(body.messages.at(-1).content);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (prompts.length === 1) await firstGate;
      inFlight -= 1;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    });

    const { createBackgroundTrivialTaskClient, createTrivialTaskClient, wrapWithLimiter } = await import('../../src/core/llm.js');
    const config = {
      agent: {
        provider: 'anthropic', model: 'claude-test', workspace: '/tmp', trivialTaskProvider: 'local',
        localBaseUrl: 'http://localhost:11434',
        trivial: { enabled: true, timeoutMs: 6000, localSoftTimeoutMs: 6000, keepWarmEnabled: false },
      },
    } as any;
    const normal = createTrivialTaskClient(config)!;
    const background = createBackgroundTrivialTaskClient(config)!;
    const first = normal.complete([{ role: 'user', content: 'first normal' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const news = background.complete([{ role: 'user', content: 'queued news' }]);

    let releaseRemote!: () => void;
    let confirmRemoteStarted!: () => void;
    const remoteGate = new Promise<void>((resolve) => { releaseRemote = resolve; });
    const remoteStarted = new Promise<void>((resolve) => { confirmRemoteStarted = resolve; });
    const globalBlocker = wrapWithLimiter({
      complete: async () => {
        confirmRemoteStarted();
        await remoteGate;
        return { content: 'remote', model: 'test' };
      },
    });
    const remoteCall = globalBlocker.complete([{ role: 'user', content: 'hold global permit' }]);
    await remoteStarted;

    const nextNormal = normal.complete([{ role: 'user', content: 'next normal' }]);
    releaseFirst();
    const [firstResult, newsResult, nextNormalResult] = await Promise.all([first, news, nextNormal]);
    releaseRemote();
    await remoteCall;

    expect(prompts).toEqual(['first normal', 'next normal', 'queued news']);
    expect(maxInFlight).toBe(1);
    expect(newsResult.queueWaitMs).toEqual(expect.any(Number));
    expect(newsResult.queueWaitMs).toBeGreaterThan(0);
    expect(firstResult.content).toBe('ok');
    expect(nextNormalResult.content).toBe('ok');
  });

  it('removes an aborted background request while it is waiting for local admission', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/models')) return { ok: true, json: async () => ({ data: [{ id: 'qwen2.5:1.5b-instruct' }] }) };
      await firstGate;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    });

    const { createBackgroundTrivialTaskClient, createTrivialTaskClient } = await import('../../src/core/llm.js');
    const config = {
      agent: {
        provider: 'anthropic', model: 'claude-test', workspace: '/tmp', trivialTaskProvider: 'local',
        localBaseUrl: 'http://localhost:11434',
        trivial: { enabled: true, timeoutMs: 6000, localSoftTimeoutMs: 6000, keepWarmEnabled: false },
      },
    } as any;
    const normal = createTrivialTaskClient(config)!;
    const background = createBackgroundTrivialTaskClient(config)!;
    const first = normal.complete([{ role: 'user', content: 'active normal' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const controller = new AbortController();
    const aborted = background.complete([{ role: 'user', content: 'cancelled news' }], { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    releaseFirst();
    await first;

    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/chat/completions'))).toHaveLength(1);
  });

  it('never falls back to a remote provider when background local inference fails', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const { createBackgroundTrivialTaskClient } = await import('../../src/core/llm.js');
    const client = createBackgroundTrivialTaskClient({
      agent: {
        provider: 'anthropic', model: 'claude-test', workspace: '/tmp',
        localBaseUrl: 'http://localhost:11434',
        trivial: { enabled: true, timeoutMs: 6000, localSoftTimeoutMs: 6000, keepWarmEnabled: false },
      },
    } as any)!;

    await expect(client.complete([{ role: 'user', content: 'news' }])).rejects.toThrow(/Local LLM unavailable/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('localhost:11434/v1/models');
  });
});
