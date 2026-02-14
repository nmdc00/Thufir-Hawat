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
    allowFallbackNonCritical: z.boolean().default(true),
    alwaysIncludeTime: z.boolean().default(false),
    identityPromptMode: z.enum(['full', 'minimal', 'none']).default('full'),
    internalPromptMode: z.enum(['full', 'minimal', 'none']).default('minimal'),
    identityBootstrapMaxChars: z.number().default(20000),
    identityBootstrapIncludeMissing: z.boolean().default(true),
    maxPromptChars: z.number().default(120000),
    maxToolResultChars: z.number().default(8000),
    mentatAutoScan: z.boolean().default(false),
    mentatSystem: z.string().default('Markets'),
    mentatMarketQuery: z.string().optional(),
    mentatMarketLimit: z.number().optional(),
    mentatIntelLimit: z.number().optional(),
    enablePreTradeFragility: z.boolean().default(true),
    trivialTaskProvider: z.enum(['local', 'openai', 'anthropic']).default('local'),
    trivialTaskModel: z.string().default('qwen2.5:1.5b-instruct'),
    systemTools: z
      .object({
        enabled: z.boolean().default(false),
        allowedCommands: z.array(z.string()).default(['node', 'npm', 'pnpm', 'bun', 'qmd']),
        allowedManagers: z.array(z.enum(['npm', 'pnpm', 'bun'])).default(['pnpm', 'npm', 'bun']),
        allowGlobalInstall: z.boolean().default(false),
        timeoutMs: z.number().default(120000),
        maxOutputChars: z.number().default(12000),
      })
      .default({}),
    trivial: z
      .object({
        enabled: z.boolean().default(true),
        // Default lowered to reduce CPU time on small boxes when using local trivial LLMs.
        maxTokens: z.number().default(128),
        temperature: z.number().default(0.2),
        // Default raised because local LLM cold-starts can exceed 30s.
        timeoutMs: z.number().default(120000),
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
    useResponsesApi: z.boolean().optional(),
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
      provider: z.enum(['hyperliquid']).default('hyperliquid'),
      webhookUrl: z.string().optional(),
    })
    .default({}),
  wallet: z
    .object({
      keystorePath: z.string().optional(),
      rpcUrl: z.string().optional(),
      rpcUrls: z
        .object({
          polygon: z.string().optional(),
          arbitrum: z.string().optional(),
        })
        .default({}),
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
      perps: z
        .object({
          maxLeverage: z.number().optional(),
          maxOrderNotionalUsd: z.number().optional(),
          maxTotalNotionalUsd: z.number().optional(),
          minLiquidationDistanceBps: z.number().optional(),
          correlationCaps: z
            .array(
              z.object({
                name: z.string(),
                symbols: z.array(z.string()),
                maxNotionalUsd: z.number(),
              })
            )
            .default([]),
        })
        .default({}),
    })
    .default({}),
  evm: z
    .object({
      rpcUrls: z
        .object({
          polygon: z.string().optional(),
          arbitrum: z.string().optional(),
        })
        .default({}),
      usdc: z
        .object({
          polygon: z
            .object({
              address: z.string().default('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
              decimals: z.number().default(6),
            })
            .default({}),
          arbitrum: z
            .object({
              address: z.string().default('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
              decimals: z.number().default(6),
            })
            .default({}),
        })
        .default({}),
    })
    .default({}),
  cctp: z
    .object({
      enabled: z.boolean().default(true),
      irisBaseUrl: z.string().default('https://iris-api.circle.com'),
      domains: z
        .object({
          polygon: z.number().default(7),
          arbitrum: z.number().default(3),
        })
        .default({}),
      contracts: z
        .object({
          polygon: z
            .object({
              tokenMessenger: z
                .string()
                .default('0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE'),
              messageTransmitter: z
                .string()
                .default('0xF3be9355363857F3e001be68856A2f96b4C39Ba9'),
            })
            .default({}),
          arbitrum: z
            .object({
              tokenMessenger: z
                .string()
                .default('0x19330d10D9Cc8751218eaf51E8885D058642E08A'),
              messageTransmitter: z
                .string()
                .default('0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca'),
            })
            .default({}),
        })
        .default({}),
    })
    .default({}),
  hyperliquid: z
    .object({
      enabled: z.boolean().default(true),
      baseUrl: z.string().default('https://api.hyperliquid.xyz'),
      wsUrl: z.string().default('wss://api.hyperliquid.xyz/ws'),
      accountAddress: z.string().optional(),
      privateKey: z.string().optional(),
      maxLeverage: z.number().default(5),
      defaultSlippageBps: z.number().default(10),
      symbols: z.array(z.string()).default(['BTC', 'ETH']),
      bridge: z
        .object({
          enabled: z.boolean().default(true),
          chain: z.enum(['arbitrum']).default('arbitrum'),
          depositAddress: z
            .string()
            .default('0x2df1c51e09aecf9cacb7bc98cb1742757f163df7'),
          minDepositUsdc: z.number().default(5),
        })
        .default({}),
    })
    .default({}),
  technical: z
    .object({
      enabled: z.boolean().default(false),
      priceSource: z.enum(['binance', 'coinbase', 'coingecko']).default('binance'),
      symbols: z.array(z.string()).default(['BTC/USDT', 'ETH/USDT']),
      timeframes: z.array(z.enum(['1m', '5m', '15m', '1h', '4h', '1d'])).default(['1h', '4h', '1d']),
      indicators: z
        .object({
          rsi: z
            .object({
              period: z.number().default(14),
              overbought: z.number().default(70),
              oversold: z.number().default(30),
            })
            .default({}),
          macd: z
            .object({
              fast: z.number().default(12),
              slow: z.number().default(26),
              signal: z.number().default(9),
            })
            .default({}),
          bollingerBands: z
            .object({
              period: z.number().default(20),
              stdDev: z.number().default(2),
            })
            .default({}),
        })
        .default({}),
      signals: z
        .object({
          minConfidence: z.number().default(0.5),
          weights: z
            .object({
              technical: z.number().default(0.5),
              news: z.number().default(0.3),
              onChain: z.number().default(0.2),
            })
            .default({}),
        })
        .default({}),
      onChain: z
        .object({
          enabled: z.boolean().default(false),
          coinglassApiKey: z.string().optional(),
        })
        .default({}),
    })
    .default({ enabled: false }),
  reflexivity: z
    .object({
      enabled: z.boolean().default(false),
      horizonSeconds: z.number().default(24 * 60 * 60),
      catalystsFile: z.string().default('config/catalysts.yaml'),
      edgeScale: z.number().default(0.2),
      weights: z
        .object({
          crowding: z.number().default(0.4),
          fragility: z.number().default(0.4),
          catalyst: z.number().default(0.2),
        })
        .default({}),
      thresholds: z
        .object({
          setupScoreMin: z.number().default(0.7),
        })
        .default({}),
      narrative: z
        .object({
          maxIntelItems: z.number().default(50),
          cacheTtlSeconds: z.number().default(1800),
          llm: z
            .object({
              enabled: z.boolean().default(false),
              useTrivial: z.boolean().default(true),
            })
            .default({}),
        })
        .default({}),
    })
    .default({ enabled: false }),
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
                  systemTools: z
                    .object({
                      enabled: z.boolean().optional(),
                      allowedCommands: z.array(z.string()).optional(),
                      allowedManagers: z.array(z.enum(['npm', 'pnpm', 'bun'])).optional(),
                      allowGlobalInstall: z.boolean().optional(),
                      timeoutMs: z.number().optional(),
                      maxOutputChars: z.number().optional(),
                    })
                    .default({}),
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
      strategy: z.enum(['opportunity', 'discovery']).default('discovery'),
      probeRiskFraction: z.number().default(0.005),
      // Full autonomous mode options
      fullAuto: z.boolean().default(false),
      allowFundingActions: z.boolean().default(false),
      minEdge: z.number().default(0.05),
      requireHighConfidence: z.boolean().default(false),
      pauseOnLossStreak: z.number().default(3),
      dailyReportTime: z.string().default('20:00'),
      maxTradesPerScan: z.number().default(3),
    })
    .default({}),
  tradeManagement: z
    .object({
      enabled: z.boolean().default(true),

      defaults: z
        .object({
          stopLossPct: z.number().default(3.0),
          takeProfitPct: z.number().default(5.0),
          maxHoldHours: z.number().default(72),
          trailingStopPct: z.number().default(2.0),
          trailingActivationPct: z.number().default(1.0),
        })
        .default({}),

      bounds: z
        .object({
          stopLossPct: z
            .object({ min: z.number().default(1.0), max: z.number().default(8.0) })
            .default({}),
          takeProfitPct: z
            .object({ min: z.number().default(2.0), max: z.number().default(15.0) })
            .default({}),
          maxHoldHours: z
            .object({ min: z.number().default(1), max: z.number().default(168) })
            .default({}),
          trailingStopPct: z
            .object({ min: z.number().default(0.5), max: z.number().default(5.0) })
            .default({}),
          trailingActivationPct: z
            .object({ min: z.number().default(0.0), max: z.number().default(5.0) })
            .default({}),
        })
        .default({}),

      maxAccountRiskPct: z.number().default(5.0),

      monitorIntervalSeconds: z.number().default(900),
      activeMonitorIntervalSeconds: z.number().default(60),

      useExchangeStops: z.boolean().default(true),

      liquidationGuardDistanceBps: z.number().default(800),

      closeExecution: z
        .object({
          closeTimeoutSeconds: z.number().default(5),
          closeSlippageMultiplier: z.number().default(2.0),
        })
        .default({}),
      closeRetryMinSeconds: z.number().default(30),

      // If residual position remains after close attempts but is below this notional, treat it as dust.
      dustMaxRemainingNotionalUsd: z.number().default(0.5),

      antiOvertrading: z
        .object({
          maxConcurrentPositions: z.number().default(2),
          cooldownAfterCloseSeconds: z.number().default(3600),
          maxDailyEntries: z.number().default(4),
          lossStreakPause: z
            .object({
              consecutiveLosses: z.number().default(3),
              pauseSeconds: z.number().default(21600),
            })
            .default({}),
        })
        .default({}),

      signalConvergence: z
        .object({
          minAgreeingSignals: z.number().default(2),
          threshold: z.number().default(1.5),
          weights: z
            .object({
              reflexivity_fragility: z.number().default(1.0),
              funding_oi_skew: z.number().default(0.8),
              cross_asset_divergence: z.number().default(0.6),
              orderflow_imbalance: z.number().default(0.4),
              price_vol_regime: z.number().default(0.3),
              onchain_flow: z.number().default(0.3),
            })
            .default({}),
        })
        .default({}),
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
          iterations: z.number().default(2),
          watchlistLimit: z.number().default(20),
          useLlm: z.boolean().default(true),
          recentIntelLimit: z.number().default(25),
          extraQueries: z.array(z.string()).default([]),
          includeLearnedQueries: z.boolean().default(true),
          learnedQueryLimit: z.number().default(8),
          webLimitPerQuery: z.number().default(5),
          fetchPerQuery: z.number().default(1),
          fetchMaxChars: z.number().default(4000),
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
          system: z.string().default('Markets'),
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
