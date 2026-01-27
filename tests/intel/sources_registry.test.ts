import { describe, it, expect } from 'vitest';

import {
  listIntelSources,
  listQueryCapableRoamingSources,
  isSourceAllowedForRoaming,
} from '../../src/intel/sources_registry.js';

describe('intel sources registry', () => {
  const baseConfig: any = {
    intel: {
      roaming: { enabled: true, minTrust: 'medium', socialOptIn: false },
      sources: {
        rss: { enabled: true, feeds: [{ url: 'https://example.com/rss' }] },
        newsapi: { enabled: true, apiKey: 'k', queries: [] },
        googlenews: { enabled: true, serpApiKey: 'k', queries: [] },
        twitter: { enabled: true, bearerToken: 'k', keywords: [] },
        polymarketComments: { enabled: true },
      },
    },
  };

  it('excludes social sources unless opted in', () => {
    const entries = listIntelSources(baseConfig);
    const twitter = entries.find((entry) => entry.name === 'twitter');
    expect(twitter).toBeTruthy();
    expect(isSourceAllowedForRoaming(baseConfig, twitter!)).toBe(false);
  });

  it('respects min trust threshold', () => {
    const config = {
      ...baseConfig,
      intel: {
        ...baseConfig.intel,
        roaming: { enabled: true, minTrust: 'high', socialOptIn: true },
      },
    };
    const allowed = listQueryCapableRoamingSources(config).map((entry) => entry.name);
    expect(allowed).toEqual([]);
  });

  it('allows query-capable sources when roaming permits', () => {
    const config = {
      ...baseConfig,
      intel: {
        ...baseConfig.intel,
        roaming: { enabled: true, minTrust: 'low', socialOptIn: true },
      },
    };
    const allowed = listQueryCapableRoamingSources(config).map((entry) => entry.name);
    expect(allowed).toContain('newsapi');
    expect(allowed).toContain('googlenews');
    expect(allowed).toContain('twitter');
  });
});
