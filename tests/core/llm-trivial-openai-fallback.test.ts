import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('node-fetch', () => {
  return {
    default: vi.fn(),
  };
});

import fetch from 'node-fetch';

describe('createTrivialTaskClient OpenAI fallback shaping', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key';
  });

  it('passes max token fields through for OpenAI-backed trivial calls', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"ok":true}',
            },
          },
        ],
      }),
    });

    const { createTrivialTaskClient } = await import('../../src/core/llm.js');

    const client = createTrivialTaskClient({
      agent: {
        provider: 'openai',
        model: 'gpt-5.1',
        openaiModel: 'gpt-5.1',
        useProxy: true,
        proxyBaseUrl: 'http://localhost:8317',
        useResponsesApi: true,
        workspace: '/tmp',
        trivialTaskProvider: 'openai',
        trivialTaskModel: 'gpt-5.1',
        trivial: {
          enabled: true,
          maxTokens: 96,
          temperature: 0.2,
          timeoutMs: 5000,
        },
      },
    } as any);

    expect(client).not.toBeNull();
    await client!.complete([{ role: 'user', content: 'Return JSON only' }]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
    const body = JSON.parse(init.body ?? '{}');
    expect(body.max_output_tokens).toBe(96);
    expect(body.max_tokens).toBeUndefined();
  });
});
