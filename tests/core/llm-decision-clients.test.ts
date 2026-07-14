import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetch from 'node-fetch';

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    agent: {
      provider: 'openai',
      model: 'gpt-5.4',
      openaiModel: 'gpt-5.4',
      useProxy: true,
      proxyBaseUrl: 'http://localhost:8317',
      useResponsesApi: true,
      workspace: '/tmp/thufir-decision-test',
      internalPromptMode: 'minimal',
      promptBudget: { trivial: 10_000 },
      llmBudget: { enabled: false },
      trivialTaskModel: 'qwen-decision-test',
      localBaseUrl: 'http://localhost:11434',
      trivial: {
        enabled: true,
        maxTokens: 128,
        temperature: 0.2,
        timeoutMs: 25_000,
        localSoftTimeoutMs: 25_000,
        keepWarmEnabled: false,
      },
      ...overrides,
    },
  } as any;
}

describe('bounded decision clients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends primary decisions without the agentic tool catalog', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"verdict":"reject"}' }] }],
      }),
    });
    const { createDecisionClient } = await import('../../src/core/llm.js');
    const client = createDecisionClient(baseConfig());

    const result = await client.complete([
      { role: 'system', content: 'Return JSON only.' },
      { role: 'user', content: 'Decide.' },
    ], { timeoutMs: 1000 });

    expect(result.content).toBe('{"verdict":"reject"}');
    expect(client.meta).toMatchObject({ provider: 'openai', model: 'gpt-5.4', kind: 'decision' });
    const [url, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
    const body = JSON.parse(init.body ?? '{}');
    expect(url.endsWith('/v1/responses')).toBe(true);
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('perp_place_order');
  });

  it('keeps Ollama as a compact local fallback with enough JSON output budget', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'qwen-decision-test' }] }) };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"action":"hold"}' } }] }),
      };
    });
    const { createDecisionFallbackClient } = await import('../../src/core/llm.js');
    const client = createDecisionFallbackClient(baseConfig());

    const result = await client.complete([{ role: 'user', content: 'Decide locally.' }], {
      timeoutMs: 25_000,
    });

    expect(result.content).toBe('{"action":"hold"}');
    expect(client.meta).toMatchObject({ provider: 'local', model: 'qwen-decision-test', kind: 'decision' });
    const completionCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/chat/completions'));
    expect(completionCall).toBeDefined();
    const body = JSON.parse((completionCall?.[1] as { body?: string }).body ?? '{}');
    expect(body.max_tokens).toBe(256);
    expect(JSON.stringify(body)).not.toContain('perp_place_order');
  });
});
