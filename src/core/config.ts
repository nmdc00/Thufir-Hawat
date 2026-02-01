import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';
import yaml from 'yaml';

const expandHome = (value: string): string => {
  if (value.startsWith('~/')) {
    return join(homedir(), value.slice(2));
  }
  return value;
};

const ConfigSchema = z.object({
  gateway: z
    .object({
      port: z.number().default(18789),
      bind: z.string().default('loopback'),
    })
    .default({}),
  agent: z.object({
    model: z.string(),
    fallbackModel: z.string().optional(),
    openaiModel: z.string().default('gpt-5.2'),
    executorModel: z.string().optional(),
    executorProvider: z.enum(['anthropic', 'openai', 'local']).default('openai'),
    useExecutorModel: z.boolean().default(false),
    useOrchestrator: z.boolean().default(false),
    showToolTrace: z.boolean().default(false),
    showCriticNotes: z.boolean().default(false),
    showPlanTrace: z.boolean().default(false),
    showFragilityTrace: z.boolean().default(false),
    persistPlans: z.boolean().default(true),
    identityPromptMode: z.enum(['full', 'minimal', 'none']).default('full'),
    internalPromptMode: z.enum(['full', 'minimal', 'none']).default('minimal'),
    mentatAutoScan: z.boolean().default(false),
    mentatSystem: z.string().default('Polymarket'),
    mentatMarketQuery: z.string().optional(),
    mentatMarketLimit: z.number().optional(),
    mentatIntelLimit: z.number().optional(),
    enablePreTradeFragility: z.boolean().default(true),
    trivialTaskProvider: z.enum(['local', 'openai', 'anthropic']).default('local'),
    trivialTaskModel: z.string().default('qwen2.5:1.5b-instruct'),
    trivial: z
      .object({
        enabled: z.boolean().default(true),
        maxTokens: z.number().default(256),
        temperature: z.number().default(0.2),
        timeoutMs: z.number().default(30000),
      })
      .default({}),
    llmBudget: z
      .object({
        enabled: z.boolean().default(true),
        maxCallsPerHour: z.number().default(120),
        maxTokensPerHour: z.number().default(120000),
        reserveCalls: z.number().default(10),
        reserveTokens: z.number().default(10000),
        includeLocal: z.boolean().default(false),
        storagePath: z.string().optional(),
      })
      .default({}),
    provider: z.enum(['anthropic', 'openai', 'local']).default('anthropic'),
    apiBaseUrl: z.string().optional(),
    localBaseUrl: z.string().optional(),
    workspace: z.string().optional(),
    useProxy: z.boolean().default(false),
    proxyBaseUrl: z.string().default('http://localhost:8317'),
    modes: z
      .object({
        chat: z
          .object({
            maxIterations: z.number().default(8),
            temperature: z.number().default(0.7),
          })
          .default({}),
        trade: z
          .object({
            maxIterations: z.number().default(15),
            temperature: z.number().default(0.3),
            requireConfirmation: z.boolean().default(true),
            minConfidence: z.number().default(0.6),
          })
          .default({}),
        mentat: z
          .object({
            maxIterations: z.number().default(20),
            temperature: z.number().default(0.5),
          })
          .default({}),
      })
      .default({}),
  }),
  execution: z
    .object({
      mode: z.enum(['paper', 'webhook', 'live']).default('paper'),
      webhookUrl: z.string().optional(),
    })
    .default({}),
  wallet: z
    .object({
      keystorePath: z.string().optional(),
      limits: z
        .object({
          daily: z.number().default(100),
          perTrade: z.number().default(25),
          confirmationThreshold: z.number().default(10),
        })
        .default({}),
      exposure: z
        .object({
          maxPositionPercent: z.number().default(20),
          maxDomainPercent: z.number().default(40),
        })
        .default({}),
    })
    .default({}),
  polymarket: z.object({
    api: z.object({
      gamma: z.string(),
      clob: z.string(),
    }),
    rpcUrl: z.string().optional(),
    stream: z
      .object({
        enabled: z.boolean().default(false),
        wsUrl: z.string().optional(),
        watchlistOnly: z.boolean().default(true),
        maxWatchlist: z.number().default(50),
        reconnectSeconds: z.number().default(10),
        staleAfterSeconds: z.number().default(180),
        refreshIntervalSeconds: z.number().default(300),
      })
      .default({}),
  }),
  intel: z
    .object({
      embeddings: z
        .object({
          enabled: z.boolean().default(false),
          provider: z.enum(['openai', 'google', 'local']).default('openai'),
          model: z.string().default('text-embedding-3-small'),
          apiBaseUrl: z.string().optional(),
        })
        .default({ enabled: false }),
      sources: z
        .object({
          rss: z
            .object({
              enabled: z.boolean().default(false),
              feeds: z.array(
                z.object({
                  url: z.string(),
                  category: z.string().optional(),
                })
              ),
            })
            .default({ enabled: false, feeds: [] }),
          newsapi: z
            .object({
              enabled: z.boolean().default(false),
              apiKey: z.string().optional(),
              baseUrl: z.string().optional(),
              categories: z.array(z.string()).default([]),
              countries: z.array(z.string()).default([]),
              queries: z.array(z.string()).default([]),
              maxArticlesPerFetch: z.number().default(50),
              language: z.string().default('en'),
            })
            .default({ enabled: false }),
          googlenews: z
            .object({
              enabled: z.boolean().default(false),
              serpApiKey: z.string().optional(),
              baseUrl: z.string().optional(),
              queries: z.array(z.string()).default([]),
              country: z.string().default('us'),
              language: z.string().default('en'),
              maxArticlesPerFetch: z.number().default(20),
            })
            .default({ enabled: false }),
          twitter: z
            .object({
              enabled: z.boolean().default(false),
              bearerToken: z.string().optional(),
              baseUrl: z.string().optional(),
              keywords: z.array(z.string()).default([]),
              accounts: z.array(z.string()).default([]),
              maxTweetsPerFetch: z.number().default(25),
            })
            .default({ enabled: false }),
          polymarketComments: z
            .object({
              enabled: z.boolean().default(false),
              trackWatchlist: z.boolean().default(true),
              watchlistLimit: z.number().default(50),
              trackTopMarkets: z.number().default(0),
              maxCommentsPerMarket: z.number().default(20),
              holdersOnly: z.boolean().default(false),
              getPositions: z.boolean().default(false),
              order: z.string().optional(),
              ascending: z.boolean().optional(),
            })
            .default({ enabled: false }),
        })
        .default({}),
      roaming: z
        .object({
          enabled: z.boolean().default(true),
          allowSources: z.array(z.string()).default([]),
          allowTypes: z.array(z.enum(['news', 'social', 'market'])).default([]),
          minTrust: z.enum(['low', 'medium', 'high']).default('medium'),
          socialOptIn: z.boolean().default(false),
        })
        .default({}),
      retentionDays: z.number().default(30),
    })
    .default({}),
  memory: z.object({
    dbPath: z.string().optional(),
    sessionsPath: z.string().optional(),
    maxHistoryMessages: z.number().default(50),
    compactAfterTokens: z.number().default(12000),
    keepRecentMessages: z.number().default(12),
    retentionDays: z.number().default(90),
    embeddings: z
      .object({
        enabled: z.boolean().default(false),
        provider: z.enum(['openai', 'google', 'local']).default('openai'),
        model: z.string().default('text-embedding-3-small'),
        apiBaseUrl: z.string().optional(),
      })
      .default({ enabled: false }),
  }),
  session: z
    .object({
      mainKey: z.string().default('main'),
      dmScope: z.enum(['main', 'per-peer', 'per-channel-peer']).default('per-channel-peer'),
      identityLinks: z.record(z.array(z.string())).default({}),
    })
    .default({}),
  agents: z
    .object({
      defaultAgentId: z.string().default('main'),
      agentIds: z.array(z.string()).default([]),
      routes: z
        .array(
          z.object({
            agentId: z.string(),
            channel: z.enum(['telegram', 'whatsapp', 'cli']).optional(),
            peerIds: z.array(z.string()).optional(),
            peerKinds: z.array(z.enum(['dm', 'group', 'channel'])).optional(),
            threadIds: z.array(z.string()).optional(),
          })
        )
        .default([]),
      overrides: z
        .record(
          z
            .object({
              agent: z
                .object({
                  model: z.string().optional(),
                  fallbackModel: z.string().optional(),
                  openaiModel: z.string().optional(),
                  executorModel: z.string().optional(),
                  executorProvider: z.enum(['anthropic', 'openai', 'local']).optional(),
                  useExecutorModel: z.boolean().optional(),
                  provider: z.enum(['anthropic', 'openai', 'local']).optional(),
                  apiBaseUrl: z.string().optional(),
                  localBaseUrl: z.string().optional(),
                  workspace: z.string().optional(),
                  useProxy: z.boolean().optional(),
                  proxyBaseUrl: z.string().optional(),
                  trivialTaskProvider: z.enum(['local', 'openai', 'anthropic']).optional(),
                  trivialTaskModel: z.string().optional(),
                  trivial: z
                    .object({
                      enabled: z.boolean().optional(),
                      maxTokens: z.number().optional(),
                      temperature: z.number().optional(),
                      timeoutMs: z.number().optional(),
                    })
                    .default({}),
                  llmBudget: z
                    .object({
                      enabled: z.boolean().optional(),
                      maxCallsPerHour: z.number().optional(),
                      maxTokensPerHour: z.number().optional(),
                      reserveCalls: z.number().optional(),
                      reserveTokens: z.number().optional(),
                      includeLocal: z.boolean().optional(),
                      storagePath: z.string().optional(),
                    })
                    .default({}),
                })
                .default({}),
              memory: z
                .object({
                  sessionsPath: z.string().optional(),
                })
                .default({}),
              autonomy: z
                .object({
                  enabled: z.boolean().optional(),
                  scanIntervalSeconds: z.number().optional(),
                  maxMarketsPerScan: z.number().optional(),
                  watchlistOnly: z.boolean().optional(),
                  eventDriven: z.boolean().optional(),
                  eventDrivenMinItems: z.number().optional(),
                  fullAuto: z.boolean().optional(),
                  minEdge: z.number().optional(),
                  requireHighConfidence: z.boolean().optional(),
                  pauseOnLossStreak: z.number().optional(),
                  dailyReportTime: z.string().optional(),
                  maxTradesPerScan: z.number().optional(),
                })
                .default({}),
            })
            .default({})
        )
        .default({}),
    })
    .default({}),
  channels: z
    .object({
      telegram: z
        .object({
          enabled: z.boolean().default(false),
          token: z.string().optional(),
          allowedChatIds: z.array(z.union([z.string(), z.number()])).default([]),
          pollingInterval: z.number().default(5),
        })
        .default({}),
      whatsapp: z
        .object({
          enabled: z.boolean().default(false),
          verifyToken: z.string().optional(),
          accessToken: z.string().optional(),
          phoneNumberId: z.string().optional(),
          allowedNumbers: z.array(z.string()).default([]),
        })
        .default({}),
    })
    .default({}),
  autonomy: z
    .object({
      enabled: z.boolean().default(true),
      scanIntervalSeconds: z.number().default(900),
      maxMarketsPerScan: z.number().default(10),
      watchlistOnly: z.boolean().default(true),
      eventDriven: z.boolean().default(false),
      eventDrivenMinItems: z.number().default(1),
      // Full autonomous mode options
      fullAuto: z.boolean().default(false),
      minEdge: z.number().default(0.05),
      requireHighConfidence: z.boolean().default(false),
      pauseOnLossStreak: z.number().default(3),
      dailyReportTime: z.string().default('20:00'),
      maxTradesPerScan: z.number().default(3),
    })
    .default({}),
  notifications: z
    .object({
      briefing: z
        .object({
          enabled: z.boolean().default(false),
          time: z.string().default('08:00'),
          channels: z.array(z.string()).default([]),
        })
        .default({}),
      dailyReport: z
        .object({
          enabled: z.boolean().default(false),
          channels: z.array(z.string()).default([]),
        })
        .default({}),
      resolver: z
        .object({
          enabled: z.boolean().default(false),
          time: z.string().default('02:00'),
          limit: z.number().default(50),
        })
        .default({}),
      intelFetch: z
        .object({
          enabled: z.boolean().default(false),
          time: z.string().default('06:00'),
        })
        .default({}),
      marketSync: z
        .object({
          enabled: z.boolean().default(false),
          time: z.string().default('07:00'),
          limit: z.number().default(200),
          maxPages: z.number().default(25),
          intervalSeconds: z.number().optional(),
          refreshLimit: z.number().default(500),
        })
        .default({}),
      proactiveSearch: z
        .object({
          enabled: z.boolean().default(false),
          mode: z.enum(['schedule', 'heartbeat', 'direct']).default('schedule'),
          time: z.string().default('07:30'),
          maxQueries: z.number().default(8),
          watchlistLimit: z.number().default(20),
          useLlm: z.boolean().default(true),
          recentIntelLimit: z.number().default(25),
          extraQueries: z.array(z.string()).default([]),
          channels: z.array(z.string()).default([]),
        })
        .default({}),
      heartbeat: z
        .object({
          enabled: z.boolean().default(false),
          intervalMinutes: z.number().default(30),
          channels: z.array(z.string()).default([]),
          target: z.string().default('last'),
        })
        .default({}),
      intelAlerts: z
        .object({
          enabled: z.boolean().default(false),
          channels: z.array(z.string()).default([]),
          watchlistOnly: z.boolean().default(true),
          maxItems: z.number().default(10),
          includeSources: z.array(z.string()).default([]),
          excludeSources: z.array(z.string()).default([]),
          includeKeywords: z.array(z.string()).default([]),
          excludeKeywords: z.array(z.string()).default([]),
          minKeywordOverlap: z.number().default(1),
          minTitleLength: z.number().default(8),
          minSentiment: z.number().optional(),
          maxSentiment: z.number().optional(),
          sentimentPreset: z.enum(['any', 'positive', 'negative', 'neutral']).default('any'),
          includeEntities: z.array(z.string()).default([]),
          excludeEntities: z.array(z.string()).default([]),
          minEntityOverlap: z.number().default(1),
          useContent: z.boolean().default(true),
          minScore: z.number().default(0),
          keywordWeight: z.number().default(1),
          entityWeight: z.number().default(1),
          sentimentWeight: z.number().default(1),
          showScore: z.boolean().default(false),
          showReasons: z.boolean().default(false),
          entityAliases: z.record(z.array(z.string())).default({}),
        })
        .default({}),
      mentat: z
        .object({
          enabled: z.boolean().default(false),
          time: z.string().default('09:00'),
          intervalMinutes: z.number().optional(),
          channels: z.array(z.string()).default([]),
          system: z.string().default('Polymarket'),
          marketQuery: z.string().optional(),
          marketLimit: z.number().default(25),
          intelLimit: z.number().default(40),
          minOverallScore: z.number().default(0.7),
          minDeltaScore: z.number().default(0.15),
          schedules: z
            .array(
              z.object({
                name: z.string().optional(),
                time: z.string().optional(),
                intervalMinutes: z.number().optional(),
                channels: z.array(z.string()).default([]),
                system: z.string().optional(),
                marketQuery: z.string().optional(),
                marketLimit: z.number().optional(),
                intelLimit: z.number().optional(),
                minOverallScore: z.number().optional(),
                minDeltaScore: z.number().optional(),
              })
            )
            .default([]),
        })
        .default({}),
    })
    .default({}),
  qmd: z
    .object({
      enabled: z.boolean().default(true),
      knowledgePath: z.string().default('~/.thufir/knowledge'),
      collections: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
          })
        )
        .default([
          { name: 'thufir-research', description: 'Web search results and articles' },
          { name: 'thufir-intel', description: 'News and social intel' },
          { name: 'thufir-markets', description: 'Market analysis and notes' },
        ]),
      autoIndexWebSearch: z.boolean().default(true),
      autoIndexWebFetch: z.boolean().default(false),
      embedSchedule: z
        .object({
          enabled: z.boolean().default(true),
          intervalMinutes: z.number().default(60),
        })
        .default({}),
    })
    .default({}),
});

export type ThufirConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(configPath?: string): ThufirConfig {
  const path =
    configPath ??
    process.env.THUFIR_CONFIG_PATH ??
    join(homedir(), '.thufir', 'config.yaml');

  const raw = readFileSync(path, 'utf-8');
  const parsed = yaml.parse(raw) ?? {};

  const cfg = ConfigSchema.parse(parsed);

  const envPort = process.env.THUFIR_GATEWAY_PORT;
  if (envPort) {
    const port = Number(envPort);
    if (!Number.isNaN(port)) {
      cfg.gateway.port = port;
    }
  }

  if (cfg.agent.workspace) {
    cfg.agent.workspace = expandHome(cfg.agent.workspace);
  }
  if (cfg.agent?.llmBudget?.storagePath) {
    cfg.agent.llmBudget.storagePath = expandHome(cfg.agent.llmBudget.storagePath);
  }
  if (cfg.memory.dbPath) {
    cfg.memory.dbPath = expandHome(cfg.memory.dbPath);
  }
  if (cfg.wallet?.keystorePath) {
    cfg.wallet.keystorePath = expandHome(cfg.wallet.keystorePath);
  }
  if (cfg.memory?.sessionsPath) {
    cfg.memory.sessionsPath = expandHome(cfg.memory.sessionsPath);
  }
  if (cfg.agents?.overrides) {
    for (const override of Object.values(cfg.agents.overrides)) {
      if (override.agent?.workspace) {
        override.agent.workspace = expandHome(override.agent.workspace);
      }
      if (override.agent?.llmBudget?.storagePath) {
        override.agent.llmBudget.storagePath = expandHome(override.agent.llmBudget.storagePath);
      }
      if (override.memory?.sessionsPath) {
        override.memory.sessionsPath = expandHome(override.memory.sessionsPath);
      }
    }
  }
  if (cfg.qmd?.knowledgePath) {
    cfg.qmd.knowledgePath = expandHome(cfg.qmd.knowledgePath);
  }

  return cfg;
}
