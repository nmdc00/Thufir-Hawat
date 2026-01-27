import { describe, it, expect, vi, beforeEach } from 'vitest';

const pipelineMock = vi.hoisted(() => vi.fn());

vi.mock('../src/intel/pipeline.js', () => ({
  runIntelPipelineDetailedWithOverrides: pipelineMock,
}));

vi.mock('../src/memory/watchlist.js', () => ({
  listWatchlist: () => [{ marketId: 'm1' }],
}));

vi.mock('../src/execution/polymarket/markets.js', () => ({
  PolymarketMarketClient: class {
    async getMarket() {
      return {
        id: 'm1',
        question: 'Will X happen this year?',
        outcomes: ['YES', 'NO'],
        prices: { YES: 0.4, NO: 0.6 },
      };
    }
  },
}));

import { runProactiveSearch } from '../src/core/proactive_search.js';

describe('proactive search', () => {
  beforeEach(() => {
    pipelineMock.mockReset().mockResolvedValue({ storedCount: 0, storedItems: [] });
  });

  it('generates queries from watchlist and runs pipeline with overrides', async () => {
    const config = {
      gateway: { port: 18789, bind: 'loopback' },
      agent: { model: 'test', provider: 'local', fallbackModel: 'test' },
      execution: { mode: 'paper' },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      polymarket: { api: { gamma: 'https://example.com', clob: 'https://example.com' } },
      intel: {
        roaming: { enabled: true, socialOptIn: true, minTrust: 'low' },
        sources: {
          newsapi: { enabled: true, queries: [] },
          googlenews: { enabled: true, queries: [] },
          twitter: { enabled: true, keywords: [] },
        },
      },
      memory: { dbPath: ':memory:' },
      channels: { telegram: { enabled: false }, whatsapp: { enabled: false } },
      autonomy: { enabled: false },
      notifications: {},
    };

    const result = await runProactiveSearch(config as any, { useLlm: false, recentIntelLimit: 0 });
    expect(result.queries[0]).toContain('Will X happen');
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    const overrides = pipelineMock.mock.calls[0]?.[1];
    expect(overrides.newsapiQueries?.[0]).toContain('Will X happen');
    expect(overrides.googlenewsQueries?.[0]).toContain('Will X happen');
    expect(overrides.twitterKeywords?.[0]).toContain('Will X happen');
  });
});
