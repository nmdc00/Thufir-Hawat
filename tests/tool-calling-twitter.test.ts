import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { executeToolCall } from '../src/core/tool-executor.js';

describe('twitter_search tool', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('returns items when Twitter API succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 't1',
            text: 'Test tweet',
            created_at: '2026-01-27T00:00:00Z',
            author_id: 'a1',
          },
        ],
        includes: {
          users: [{ id: 'a1', username: 'testuser', name: 'Test User' }],
        },
      }),
    });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;

    const result = await executeToolCall(
      'twitter_search',
      { query: 'polymarket', limit: 1 },
      {
        config: { intel: { sources: { twitter: { bearerToken: 'token' } } } },
        marketClient: {} as any,
      } as any
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const items = result.data as Array<{ id: string; author: string }>;
      expect(items[0].id).toBe('t1');
      expect(items[0].author).toBe('testuser');
    }
  });

  it('falls back to SerpAPI when Twitter API fails', async () => {
    process.env.SERPAPI_KEY = 'test-serp-key';

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (url.includes('api.twitter.com')) {
        // Twitter API fails
        return Promise.resolve({ ok: false, status: 429 });
      }
      if (url.includes('serpapi.com')) {
        // SerpAPI succeeds
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tweets: [
              {
                text: 'SerpAPI tweet',
                user: { screen_name: 'serpuser' },
                likes: 10,
                retweets: 5,
                link: 'https://twitter.com/status/123',
              },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;

    const result = await executeToolCall(
      'twitter_search',
      { query: 'polymarket', limit: 1 },
      {
        config: { intel: { sources: { twitter: { bearerToken: 'token' } } } },
        marketClient: {} as any,
      } as any
    );

    expect(result.success).toBe(true);
    expect(callCount).toBe(2); // Twitter first, then SerpAPI
    if (result.success) {
      const items = result.data as Array<{ text: string; author: string }>;
      expect(items[0].text).toBe('SerpAPI tweet');
      expect(items[0].author).toBe('serpuser');
    }
  });

  it('returns error when both Twitter and SerpAPI fail', async () => {
    process.env.SERPAPI_KEY = 'test-serp-key';

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;

    const result = await executeToolCall(
      'twitter_search',
      { query: 'polymarket', limit: 1 },
      {
        config: { intel: { sources: { twitter: { bearerToken: 'token' } } } },
        marketClient: {} as any,
      } as any
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Twitter');
      expect(result.error).toContain('SerpAPI');
    }
  });
});
