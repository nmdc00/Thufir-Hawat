import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('collects launchdock streaming decision text when non-streaming content is omitted', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () =>
        'data: {"choices":[{"delta":{"content":"{\\"action\\":\\"hold\\","}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"\\"reasoning\\":\\"ok\\"}"}}]}\n\n' +
        'data: [DONE]\n\n',
    });
    const { createDecisionClient } = await import('../../src/core/llm.js');
    const client = createDecisionClient(baseConfig({ useResponsesApi: false }));

    const result = await client.complete([{ role: 'user', content: 'Decide.' }]);

    expect(result.content).toBe('{"action":"hold","reasoning":"ok"}');
    const [url, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
    expect(url.endsWith('/v1/chat/completions')).toBe(true);
    expect(JSON.parse(init.body ?? '{}').stream).toBe(true);
  });

  it('accepts compact SSE data lines and rejects an incomplete stream', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const { createDecisionClient } = await import('../../src/core/llm.js');
    const client = createDecisionClient(baseConfig({ useResponsesApi: false }));
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () =>
      ': keepalive\n\ndata:{"choices":[{"delta":{"content":"{\\"verdict\\":\\"reject\\"}"}}]}\n\ndata: [DONE]\n' });
    await expect(client.complete([{ role: 'user', content: 'Decide.' }])).resolves.toMatchObject({ content: '{"verdict":"reject"}' });
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () =>
      'data:{"choices":[{"delta":{"content":"{\\"verdict\\":"}}]}\n' });
    await expect(client.complete([{ role: 'user', content: 'Decide.' }])).rejects.toMatchObject({ code: 'truncated_stream' });
  });

  it('reports a critical budget refusal without invoking the provider', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'thufir-budget-test-'));
    try {
      const { createDecisionClient } = await import('../../src/core/llm.js');
      const { withExecutionContext } = await import('../../src/core/llm_infra.js');
      const client = createDecisionClient(baseConfig({
        useResponsesApi: false,
        workspace: directory,
        llmBudget: { enabled: true, maxCallsPerHour: 0, reserveCalls: 0, maxTokensPerHour: 0, reserveTokens: 0 },
      }));
      await expect(withExecutionContext({ mode: 'FULL_AGENT', critical: true, reason: 'entry_gate' },
        () => client.complete([{ role: 'user', content: 'Decide.' }]))).rejects.toMatchObject({ code: 'llm_budget_exhausted' });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
