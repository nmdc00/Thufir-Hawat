import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createAgentRegistry } from '../src/gateway/agent_router.js';

vi.mock('../src/core/agent.js', () => ({
  ThufirAgent: class {
    config: unknown;
    constructor(config: unknown) {
      this.config = config;
    }
  },
}));

const baseConfig = {
  gateway: { port: 18789, bind: 'loopback' },
  agent: { model: 'test-model', provider: 'local', openaiModel: 'gpt-5.2' },
  execution: { mode: 'paper' },
  wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 }, exposure: { maxPositionPercent: 20, maxDomainPercent: 40 } },
  polymarket: { api: { gamma: 'https://example.com', clob: 'https://example.com' } },
  intel: { embeddings: { enabled: false, provider: 'openai', model: 'text-embedding-3-small' }, sources: {}, roaming: { enabled: true, allowSources: [], allowTypes: [], minTrust: 'medium', socialOptIn: false }, retentionDays: 30 },
  memory: { dbPath: '/tmp/thufir.sqlite', sessionsPath: '/tmp/thufir/sessions', maxHistoryMessages: 50, compactAfterTokens: 12000, keepRecentMessages: 12, retentionDays: 90, embeddings: { enabled: false, provider: 'openai', model: 'text-embedding-3-small' } },
  session: { mainKey: 'main', dmScope: 'per-channel-peer', identityLinks: {} },
  channels: { telegram: { enabled: false, token: '', allowedChatIds: [], pollingInterval: 5 }, whatsapp: { enabled: false, verifyToken: '', accessToken: '', phoneNumberId: '', allowedNumbers: [] } },
  autonomy: { enabled: false, scanIntervalSeconds: 900, maxMarketsPerScan: 10, watchlistOnly: true, eventDriven: false, eventDrivenMinItems: 1, fullAuto: false, minEdge: 0.05, requireHighConfidence: false, pauseOnLossStreak: 3, dailyReportTime: '20:00', maxTradesPerScan: 3 },
  notifications: { briefing: { enabled: false, time: '08:00', channels: [] }, dailyReport: { enabled: false, channels: [] }, resolver: { enabled: false, time: '02:00', limit: 50 }, intelFetch: { enabled: false, time: '06:00' }, marketSync: { enabled: false, time: '07:00', limit: 200 }, proactiveSearch: { enabled: false, time: '07:30', maxQueries: 8, watchlistLimit: 20, useLlm: true, recentIntelLimit: 25, extraQueries: [] }, intelAlerts: { enabled: false, channels: [], watchlistOnly: true, maxItems: 10, includeSources: [], excludeSources: [], includeKeywords: [], excludeKeywords: [], minKeywordOverlap: 1, minTitleLength: 8, sentimentPreset: 'any', includeEntities: [], excludeEntities: [], minEntityOverlap: 1, useContent: true, minScore: 0, keywordWeight: 1, entityWeight: 1, sentimentWeight: 1, showScore: false, showReasons: false, entityAliases: {} } },
};

describe('agent routing session isolation', () => {
  it('isolates sessions per agent when multiple agents are configured', () => {
    const config = {
      ...baseConfig,
      agents: {
        defaultAgentId: 'main',
        agentIds: ['research'],
        routes: [],
        overrides: {},
      },
    };

    const registry = createAgentRegistry(config as any, {} as any);
    const mainAgent = registry.agents.get('main') as any;
    const researchAgent = registry.agents.get('research') as any;

    expect(mainAgent.config.memory.sessionsPath).toBe(
      join('/tmp/thufir/sessions', 'agents', 'main')
    );
    expect(researchAgent.config.memory.sessionsPath).toBe(
      join('/tmp/thufir/sessions', 'agents', 'research')
    );
  });

  it('keeps shared sessions path when only one agent exists', () => {
    const config = {
      ...baseConfig,
      agents: {
        defaultAgentId: 'main',
        agentIds: [],
        routes: [],
        overrides: {},
      },
    };

    const registry = createAgentRegistry(config as any, {} as any);
    const mainAgent = registry.agents.get('main') as any;

    expect(mainAgent.config.memory.sessionsPath).toBe('/tmp/thufir/sessions');
  });
});
