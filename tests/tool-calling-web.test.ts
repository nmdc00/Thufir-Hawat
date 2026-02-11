import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { executeToolCall } from '../src/core/tool-executor.js';

describe('web tools', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('uses SerpAPI for web_search when available', async () => {
    process.env.SERPAPI_KEY = 'serp-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        organic_results: [
          { title: 'Result', link: 'https://example.com', snippet: 'Snippet' },
        ],
      }),
    });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;

    const result = await executeToolCall(
      'web_search',
      { query: 'test query', limit: 1 },
      { config: {} as any, marketClient: {} as any }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { provider: string; results: Array<{ url: string }> };
      expect(data.provider).toBe('serpapi');
      expect(data.results[0].url).toBe('https://example.com');
    }
  });

  it('falls back to Brave when SerpAPI fails', async () => {
    process.env.SERPAPI_KEY = 'serp-key';
    process.env.BRAVE_API_KEY = 'brave-key';

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (url.includes('serpapi.com')) {
        return Promise.resolve({ ok: false, status: 429 });
      }
      if (url.includes('api.search.brave.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            web: {
              results: [{ title: 'Brave', url: 'https://brave.com', description: 'Desc' }],
            },
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;

    const result = await executeToolCall(
      'web_search',
      { query: 'test query', limit: 1 },
      { config: {} as any, marketClient: {} as any }
    );

    expect(result.success).toBe(true);
    expect(callCount).toBe(2);
    if (result.success) {
      const data = result.data as { provider: string; results: Array<{ url: string }> };
      expect(data.provider).toBe('brave');
      expect(data.results[0].url).toBe('https://brave.com');
    }
  });

  it('falls back to DuckDuckGo when SerpAPI and Brave are unavailable', async () => {
    delete process.env.SERPAPI_KEY;
    delete process.env.BRAVE_API_KEY;

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('api.duckduckgo.com')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            RelatedTopics: [
              { Text: 'Duck Topic - summary', FirstURL: 'https://duck.example/topic' },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;

    const result = await executeToolCall(
      'web_search',
      { query: 'duck query', limit: 1 },
      { config: {} as any, marketClient: {} as any }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { provider: string; results: Array<{ url: string }> };
      expect(data.provider).toBe('duckduckgo');
      expect(data.results[0].url).toBe('https://duck.example/topic');
    }
  });

  it('blocks unsafe URLs for web_fetch', async () => {
    const result = await executeToolCall(
      'web_fetch',
      { url: 'http://localhost/admin' },
      { config: {} as any, marketClient: {} as any }
    );
    expect(result.success).toBe(false);
  });

  it('rejects malformed URLs for web_fetch', async () => {
    const result = await executeToolCall(
      'web_fetch',
      { url: 'not-a-url' },
      { config: {} as any, marketClient: {} as any }
    );
    expect(result.success).toBe(false);
  });

  it('extracts content for web_fetch HTML responses', async () => {
    const html = '<html><head><title>Test</title></head><body><article>Hello world</article></body></html>';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (key: string) => (key === 'content-type' ? 'text/html' : null),
      },
      arrayBuffer: async () => new TextEncoder().encode(html).buffer,
    });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;

    const result = await executeToolCall(
      'web_fetch',
      { url: 'https://example.com', max_chars: 200 },
      { config: {} as any, marketClient: {} as any }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { content: string; title: string | null };
      expect(data.title).toBeTruthy();
      expect(data.content).toContain('Hello world');
    }
  });

  it('returns raw text for non-HTML responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (key: string) => (key === 'content-type' ? 'text/plain' : null),
      },
      arrayBuffer: async () => new TextEncoder().encode('plain text').buffer,
    });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;

    const result = await executeToolCall(
      'web_fetch',
      { url: 'https://example.com/data.txt', max_chars: 100 },
      { config: {} as any, marketClient: {} as any }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { content: string; title: string | null };
      expect(data.title).toBeNull();
      expect(data.content).toContain('plain text');
    }
  });

  it('rejects responses over the max size by content-length', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (key: string) => (key === 'content-length' ? '3000001' : 'text/html'),
      },
      arrayBuffer: async () => new ArrayBuffer(1),
    });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;

    const result = await executeToolCall(
      'web_fetch',
      { url: 'https://example.com/large' },
      { config: {} as any, marketClient: {} as any }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Response too large');
    }
  });

  it('rejects responses over the max size by buffer length', async () => {
    const big = new Uint8Array(2_000_001).buffer;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (key: string) => (key === 'content-type' ? 'text/html' : null),
      },
      arrayBuffer: async () => big,
    });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;

    const result = await executeToolCall(
      'web_fetch',
      { url: 'https://example.com/large-buffer' },
      { config: {} as any, marketClient: {} as any }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Response too large');
    }
  });

  it('times out long-running fetches', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('AbortError'));
        });
      });
    });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;

    const promise = executeToolCall(
      'web_fetch',
      { url: 'https://example.com/slow' },
      { config: {} as any, marketClient: {} as any }
    );

    vi.advanceTimersByTime(10000);
    const result = await promise;
    expect(result.success).toBe(false);
    vi.useRealTimers();
  });
});
