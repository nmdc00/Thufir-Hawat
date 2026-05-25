import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const liveState = vi.hoisted(() => ({
  assetPositions: [] as Array<{ position: Record<string, unknown> }>,
  fills: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/execution/hyperliquid/client.js', () => {
  class HyperliquidClient {
    constructor(_config: unknown) {}

    getAccountAddress() {
      return '0xdeadbeef';
    }

    async getClearinghouseState() {
      return {
        assetPositions: liveState.assetPositions,
        marginSummary: { accountValue: '1000', totalNtlPos: '0', totalMarginUsed: '0' },
      };
    }

    async getUserFillsByTime() {
      return liveState.fills;
    }

    async getUserFees() {
      return {
        userCrossRate: '0.0005',
        userAddRate: '0.0002',
      };
    }

    async getAllMids() {
      return { BTC: 50000 };
    }

    async listPerpMarkets() {
      return [{ symbol: 'BTC', assetId: 0, szDecimals: 5 }];
    }
  }

  return { HyperliquidClient };
});

type ScenarioArtifacts = {
  mode: 'paper' | 'live';
  perpTrade: Record<string, unknown>;
  journal: Record<string, unknown>;
  prediction: Record<string, unknown>;
  exitPolicy: Record<string, unknown>;
  decisionAudit: Record<string, unknown>;
};

type CloseArtifacts = {
  journal: Record<string, unknown>;
  prediction: Record<string, unknown>;
  exitPolicy: Record<string, unknown> | null;
};

function round6(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(5)) : Number.NaN;
}

function normalizeSharedArtifacts(artifacts: ScenarioArtifacts) {
  return {
    perpTrade: {
      symbol: artifacts.perpTrade.symbol,
      side: artifacts.perpTrade.side,
      size: Number(artifacts.perpTrade.size),
      price: Number(artifacts.perpTrade.price),
      leverage: Number(artifacts.perpTrade.leverage),
      orderType: artifacts.perpTrade.orderType,
      status: artifacts.perpTrade.status,
    },
    journal: {
      symbol: artifacts.journal.symbol,
      side: artifacts.journal.side,
      size: Number(artifacts.journal.size),
      leverage: Number(artifacts.journal.leverage),
      orderType: artifacts.journal.orderType,
      reduceOnly: artifacts.journal.reduceOnly,
      markPrice: Number(artifacts.journal.markPrice),
      signalClass: artifacts.journal.signalClass,
      marketRegime: artifacts.journal.marketRegime,
      liquidityBucket: artifacts.journal.liquidityBucket,
      volatilityBucket: artifacts.journal.volatilityBucket,
      expectedEdge: Number(artifacts.journal.expectedEdge),
      entryTrigger: artifacts.journal.entryTrigger,
      realizedFeeUsd: Number(artifacts.journal.realizedFeeUsd),
      realizedFeeToken: artifacts.journal.realizedFeeToken,
      realizedFillCount: Number(artifacts.journal.realizedFillCount),
      hasRealizedOrderId:
        typeof artifacts.journal.realizedOrderId === 'number' &&
        Number.isFinite(Number(artifacts.journal.realizedOrderId)),
      hasRealizedOrderRef:
        typeof artifacts.journal.realizedOrderRef === 'string' &&
        String(artifacts.journal.realizedOrderRef).length > 0,
      outcome: artifacts.journal.outcome,
    },
    prediction: {
      marketId: artifacts.prediction.market_id,
      domain: artifacts.prediction.domain,
      symbol: artifacts.prediction.symbol,
      strategyClass: artifacts.prediction.strategy_class,
      sessionTag: artifacts.prediction.session_tag,
      regimeTag: artifacts.prediction.regime_tag,
      learningComparable: Number(artifacts.prediction.learning_comparable),
      executed: Number(artifacts.prediction.executed),
      executionPrice: Number(artifacts.prediction.execution_price),
      positionSize: Number(artifacts.prediction.position_size),
      modelProbability: Number(artifacts.prediction.model_probability),
      marketProbability: Number(artifacts.prediction.market_probability),
      signalScores: artifacts.prediction.signal_scores,
      signalWeightsSnapshot: artifacts.prediction.signal_weights_snapshot,
    },
    exitPolicy: {
      symbol: artifacts.exitPolicy.symbol,
      side: artifacts.exitPolicy.side,
      timeStopAtMs: Number(artifacts.exitPolicy.time_stop_at_ms),
      invalidationPrice: Number(artifacts.exitPolicy.invalidation_price),
      hasPredictionId:
        typeof artifacts.exitPolicy.prediction_id === 'string' &&
        String(artifacts.exitPolicy.prediction_id).length > 0,
    },
    decisionAudit: {
      source: artifacts.decisionAudit.source,
      marketId: artifacts.decisionAudit.market_id,
      tradeAction: artifacts.decisionAudit.trade_action,
      tradeOutcome: artifacts.decisionAudit.trade_outcome,
      tradeAmount: Number(artifacts.decisionAudit.trade_amount),
      edge: Number(artifacts.decisionAudit.edge),
    },
  };
}

describe('tool-executor live/paper open-path persistence parity', () => {
  const originalDbPath = process.env.THUFIR_DB_PATH;
  const sharedTimeStopAtMs = 1_779_744_000_000;

  beforeEach(() => {
    liveState.assetPositions = [];
    liveState.fills = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (process.env.THUFIR_DB_PATH) {
      rmSync(process.env.THUFIR_DB_PATH, { force: true });
      rmSync(dirname(process.env.THUFIR_DB_PATH), { recursive: true, force: true });
    }
    if (originalDbPath === undefined) {
      delete process.env.THUFIR_DB_PATH;
    } else {
      process.env.THUFIR_DB_PATH = originalDbPath;
    }
  });

  it('writes the same shared lifecycle surfaces for paper and live opens', async () => {
    const runScenario = async (mode: 'paper' | 'live'): Promise<ScenarioArtifacts> => {
      const tempDir = mkdtempSync(join(tmpdir(), `thufir-open-parity-${mode}-`));
      process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');

      const [
        { executeToolCall },
        { openDatabase },
        { listPerpTrades },
        { listPerpTradeJournals },
        { getPositionExitPolicy },
        { PaperExecutor },
      ] = await Promise.all([
        import('../../src/core/tool-executor.js'),
        import('../../src/memory/db.js'),
        import('../../src/memory/perp_trades.js'),
        import('../../src/memory/perp_trade_journal.js'),
        import('../../src/memory/position_exit_policy.js'),
        import('../../src/execution/modes/paper.js'),
      ]);

      const marketClient = {
        getMarket: async (symbol: string) => ({
          id: symbol,
          question: `Perp: ${symbol}`,
          outcomes: ['LONG', 'SHORT'],
          prices: {},
          platform: 'hyperliquid',
          kind: 'perp',
          symbol,
          markPrice: 50000,
          metadata: { maxLeverage: 10 },
        }),
        listMarkets: async () => [],
        searchMarkets: async () => [],
      };

      const limiter = {
        checkAndReserve: vi.fn(async () => ({ allowed: true })),
        confirm: vi.fn(),
        release: vi.fn(),
      };

      const liveExecutor = {
        execute: vi.fn(async (_market: unknown, decision: Record<string, unknown>) => {
          const size = Number(decision.size);
          const side = String(decision.side);
          liveState.assetPositions = [
            {
              position: {
                coin: 'BTC',
                szi: side === 'buy' ? String(size) : String(-size),
              },
            },
          ];
          liveState.fills = [
            {
              coin: 'BTC',
              oid: 123,
              fee: 0.250125,
              feeToken: 'USDC',
              time: Date.now(),
            },
          ];
          return { executed: true, message: 'live ok oid=123', orderId: '123', feeUsd: 0.250125 };
        }),
        getOpenOrders: async () => [],
        cancelOrder: async () => {},
      };

      const ctx = {
        config: {
          execution: { provider: 'hyperliquid', mode },
          hyperliquid: { enabled: true, defaultSlippageBps: 10 },
          paper: { initialCashUsdc: 200 },
        } as any,
        marketClient,
        executor: mode === 'paper' ? new PaperExecutor({ initialCashUsdc: 200 }) : liveExecutor,
        limiter,
      };

      const result = await executeToolCall(
        'perp_place_order',
        {
          symbol: 'BTC',
          side: 'buy',
          size: 0.01,
          mode,
          leverage: 3,
          signal_class: 'momentum_breakout',
          market_regime: 'trending',
          volatility_bucket: 'medium',
          liquidity_bucket: 'normal',
          expected_edge: 0.12,
          entry_trigger: 'technical',
          invalidation_type: 'price_level',
          invalidation_price: 49000,
          time_stop_at_ms: sharedTimeStopAtMs,
          trade_archetype: 'intraday',
          reasoning: 'shared lifecycle parity proof',
          confidence: 0.73,
          create_learning_prediction: true,
          prediction_market_title: 'BTC long parity proof',
          prediction_model_probability: 0.73,
          prediction_market_probability: 0.51,
          prediction_signal_scores: { technical: 0.8, news: 0.1, onChain: 0.2 },
          prediction_signal_weights: { technical: 0.5, news: 0.3, onChain: 0.2 },
          prediction_session_tag: 'us_open',
          prediction_regime_tag: 'trending',
          prediction_strategy_class: 'momentum_breakout',
          prediction_horizon_minutes: 60,
        },
        ctx as any
      );

      expect(result.success).toBe(true);

      const db = openDatabase();
      const perpTrade = listPerpTrades({ symbol: 'BTC', limit: 1 })[0]!;
      const journal = listPerpTradeJournals({ symbol: 'BTC', limit: 1 })[0]!;
      const prediction = db
        .prepare(
          `SELECT market_id, domain, symbol, strategy_class, session_tag, regime_tag,
                  learning_comparable, executed, execution_price, position_size,
                  model_probability, market_probability, signal_scores, signal_weights_snapshot
             FROM predictions
            WHERE symbol = 'BTC'
            ORDER BY created_at DESC
            LIMIT 1`
        )
        .get() as Record<string, unknown>;
      const exitPolicy = getPositionExitPolicy('BTC') as Record<string, unknown>;
      const decisionAudit = db
        .prepare(
          `SELECT source, mode, market_id, trade_action, trade_outcome, trade_amount, edge
             FROM decision_audit
            ORDER BY id DESC
            LIMIT 1`
        )
        .get() as Record<string, unknown>;

      expect(perpTrade.executionMode).toBe(mode);
      expect(journal.execution_mode).toBe(mode);
      expect(decisionAudit.mode).toBe(mode);
      expect(typeof exitPolicy.predictionId).toBe('string');

      return {
        mode,
        perpTrade: perpTrade as unknown as Record<string, unknown>,
        journal: journal as unknown as Record<string, unknown>,
        prediction,
        exitPolicy: {
          symbol: exitPolicy.symbol,
          side: exitPolicy.side,
          time_stop_at_ms: exitPolicy.timeStopAtMs,
          invalidation_price: exitPolicy.invalidationPrice,
          prediction_id: exitPolicy.predictionId,
        },
        decisionAudit,
      };
    };

    const paper = await runScenario('paper');
    const live = await runScenario('live');

    expect(normalizeSharedArtifacts(live)).toEqual(normalizeSharedArtifacts(paper));
  });

  it('writes the same blocked-journal contract for paper and live limiter rejects', async () => {
    const runBlockedScenario = async (mode: 'paper' | 'live') => {
      const tempDir = mkdtempSync(join(tmpdir(), `thufir-blocked-parity-${mode}-`));
      process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');

      const [{ executeToolCall }, { listPerpTradeJournals }, { PaperExecutor }] =
        await Promise.all([
          import('../../src/core/tool-executor.js'),
          import('../../src/memory/perp_trade_journal.js'),
          import('../../src/execution/modes/paper.js'),
        ]);

      const marketClient = {
        getMarket: async (symbol: string) => ({
          id: symbol,
          question: `Perp: ${symbol}`,
          outcomes: ['LONG', 'SHORT'],
          prices: {},
          platform: 'hyperliquid',
          kind: 'perp',
          symbol,
          markPrice: 50000,
          metadata: { maxLeverage: 10 },
        }),
        listMarkets: async () => [],
        searchMarkets: async () => [],
      };

      const ctx = {
        config: {
          execution: { provider: 'hyperliquid', mode },
          hyperliquid: { enabled: true, defaultSlippageBps: 10 },
          paper: { initialCashUsdc: 200 },
        } as any,
        marketClient,
        executor:
          mode === 'paper'
            ? new PaperExecutor({ initialCashUsdc: 200 })
            : {
                execute: vi.fn(async () => ({ executed: true, message: 'should not execute' })),
                getOpenOrders: async () => [],
                cancelOrder: async () => {},
              },
        limiter: {
          checkAndReserve: vi.fn(async () => ({
            allowed: false,
            reason: 'limit exceeded for parity test',
          })),
          confirm: vi.fn(),
          release: vi.fn(),
        },
      };

      const result = await executeToolCall(
        'perp_place_order',
        {
          symbol: 'BTC',
          side: 'buy',
          size: 0.01,
          mode,
          leverage: 3,
          signal_class: 'momentum_breakout',
          market_regime: 'trending',
          volatility_bucket: 'medium',
          liquidity_bucket: 'normal',
          expected_edge: 0.12,
          entry_trigger: 'technical',
          trade_archetype: 'intraday',
          reasoning: 'blocked parity proof',
        },
        ctx as any
      );

      expect(result.success).toBe(false);
      const journal = listPerpTradeJournals({ symbol: 'BTC', limit: 1 })[0]!;
      return {
        symbol: journal.symbol,
        side: journal.side,
        size: journal.size,
        leverage: journal.leverage,
        orderType: journal.orderType,
        reduceOnly: journal.reduceOnly,
        signalClass: journal.signalClass,
        marketRegime: journal.marketRegime,
        liquidityBucket: journal.liquidityBucket,
        volatilityBucket: journal.volatilityBucket,
        expectedEdge: journal.expectedEdge,
        entryTrigger: journal.entryTrigger,
        outcome: journal.outcome,
        error: journal.error,
      };
    };

    const paperBlocked = await runBlockedScenario('paper');
    const liveBlocked = await runBlockedScenario('live');
    expect(liveBlocked).toEqual(paperBlocked);
  });

  it('keeps close-path learning and cleanup aligned for paper and mocked live', async () => {
    const runCloseScenario = async (mode: 'paper' | 'live'): Promise<CloseArtifacts> => {
      const tempDir = mkdtempSync(join(tmpdir(), `thufir-close-parity-${mode}-`));
      process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');

      liveState.assetPositions = [];
      liveState.fills = [];
      let currentMarkPrice = 50000;

      const [{ executeToolCall }, { openDatabase }, { getPositionExitPolicy }, { PaperExecutor }] =
        await Promise.all([
          import('../../src/core/tool-executor.js'),
          import('../../src/memory/db.js'),
          import('../../src/memory/position_exit_policy.js'),
          import('../../src/execution/modes/paper.js'),
        ]);

      const marketClient = {
        getMarket: async (symbol: string) => ({
          id: symbol,
          question: `Perp: ${symbol}`,
          outcomes: ['LONG', 'SHORT'],
          prices: {},
          platform: 'hyperliquid',
          kind: 'perp',
          symbol,
          markPrice: currentMarkPrice,
          metadata: { maxLeverage: 10 },
        }),
        listMarkets: async () => [],
        searchMarkets: async () => [],
      };

      const limiter = {
        checkAndReserve: vi.fn(async () => ({ allowed: true })),
        confirm: vi.fn(),
        release: vi.fn(),
      };

      const liveExecutor = {
        execute: vi.fn(async (_market: unknown, decision: Record<string, unknown>) => {
          const size = Number(decision.size);
          const side = String(decision.side);
          const reduceOnly = Boolean(decision.reduceOnly);
          if (!reduceOnly) {
            currentMarkPrice = 50000;
            liveState.assetPositions = [
              {
                position: {
                  coin: 'BTC',
                  szi: side === 'buy' ? String(size) : String(-size),
                },
              },
            ];
            liveState.fills = [
              {
                coin: 'BTC',
                oid: 123,
                fee: 0.250125,
                feeToken: 'USDC',
                time: Date.now(),
              },
            ];
            return {
              executed: true,
              message: 'live open ok oid=123',
              orderId: '123',
              feeUsd: 0.250125,
            };
          }
          currentMarkPrice = 51000;
          liveState.assetPositions = [];
          liveState.fills = [
            {
              coin: 'BTC',
              oid: 124,
              fee: 0.2548725,
              feeToken: 'USDC',
              closedPnl: 9.495,
              time: Date.now(),
            },
          ];
          return {
            executed: true,
            message: 'live close ok oid=124',
            orderId: '124',
            feeUsd: 0.2548725,
            realizedPnlUsd: 9.495,
          };
        }),
        getOpenOrders: async () => [],
        cancelOrder: async () => {},
      };

      const ctx = {
        config: {
          execution: { provider: 'hyperliquid', mode },
          hyperliquid: { enabled: true, defaultSlippageBps: 10 },
          paper: { initialCashUsdc: 200 },
        } as any,
        marketClient,
        executor: mode === 'paper' ? new PaperExecutor({ initialCashUsdc: 200 }) : liveExecutor,
        limiter,
      };

      await executeToolCall(
        'perp_place_order',
        {
          symbol: 'BTC',
          side: 'buy',
          size: 0.01,
          mode,
          leverage: 3,
          signal_class: 'momentum_breakout',
          market_regime: 'trending',
          volatility_bucket: 'medium',
          liquidity_bucket: 'normal',
          expected_edge: 0.12,
          entry_trigger: 'technical',
          invalidation_type: 'price_level',
          invalidation_price: 49000,
          time_stop_at_ms: sharedTimeStopAtMs,
          trade_archetype: 'intraday',
          reasoning: 'shared close parity proof',
          confidence: 0.73,
          create_learning_prediction: true,
          prediction_market_title: 'BTC long close parity proof',
          prediction_model_probability: 0.73,
          prediction_market_probability: 0.51,
          prediction_signal_scores: { technical: 0.8, news: 0.1, onChain: 0.2 },
          prediction_signal_weights: { technical: 0.5, news: 0.3, onChain: 0.2 },
          prediction_session_tag: 'us_open',
          prediction_regime_tag: 'trending',
          prediction_strategy_class: 'momentum_breakout',
          prediction_horizon_minutes: 60,
        },
        ctx as any
      );

      currentMarkPrice = 51000;

      const closeResult = await executeToolCall(
        'perp_place_order',
        {
          symbol: 'BTC',
          side: 'sell',
          size: 0.01,
          reduce_only: true,
          mode,
          exit_mode: 'take_profit',
          thesis_invalidation_hit: false,
          signal_class: 'momentum_breakout',
          reasoning: 'shared close parity proof',
        },
        ctx as any
      );

      expect(closeResult.success, JSON.stringify(closeResult)).toBe(true);

      const db = openDatabase();
      const closeJournal = db
        .prepare(
          `SELECT payload
             FROM decision_artifacts
            WHERE kind = 'perp_trade_journal' AND market_id = 'BTC'
            ORDER BY id DESC
            LIMIT 1`
        )
        .get() as { payload: string };
      const journal = JSON.parse(closeJournal.payload) as Record<string, unknown>;
      const prediction = db
        .prepare(
          `SELECT outcome, outcome_basis, resolution_status, pnl, resolution_metadata
             FROM predictions
            WHERE symbol = 'BTC'
            ORDER BY created_at DESC
            LIMIT 1`
        )
        .get() as Record<string, unknown>;
      const exitPolicy = getPositionExitPolicy('BTC');

      return {
        journal,
        prediction,
        exitPolicy: exitPolicy
          ? {
              symbol: exitPolicy.symbol,
              side: exitPolicy.side,
              timeStopAtMs: exitPolicy.timeStopAtMs,
              invalidationPrice: exitPolicy.invalidationPrice,
              predictionId: exitPolicy.predictionId,
            }
          : null,
      };
    };

    const normalizeClose = (artifacts: CloseArtifacts) => ({
      journal: {
        symbol: artifacts.journal.symbol,
        side: artifacts.journal.side,
        reduceOnly: artifacts.journal.reduceOnly,
        exitMode: artifacts.journal.exitMode,
        thesisCorrect: artifacts.journal.thesisCorrect,
        thesisInvalidationHit: artifacts.journal.thesisInvalidationHit,
        emotionalExitFlag: artifacts.journal.emotionalExitFlag,
        realizedFeeUsd: round6(artifacts.journal.realizedFeeUsd),
        realizedFillCount: Number(artifacts.journal.realizedFillCount),
        realizedPnlCaptured:
          typeof artifacts.journal.snapshot === 'object' &&
          artifacts.journal.snapshot !== null &&
          'exitPrice' in (artifacts.journal.snapshot as Record<string, unknown>),
      },
      prediction: {
        outcome: artifacts.prediction.outcome,
        outcomeBasis: artifacts.prediction.outcome_basis,
        resolutionStatus: artifacts.prediction.resolution_status,
        pnl: round6(artifacts.prediction.pnl),
        resolutionMetadata: (() => {
          const raw =
            typeof artifacts.prediction.resolution_metadata === 'string'
              ? JSON.parse(String(artifacts.prediction.resolution_metadata))
              : artifacts.prediction.resolution_metadata;
          const meta = raw as Record<string, unknown>;
          return {
            basis: meta.basis,
            closeBasis: meta.closeBasis,
            feeUsd: round6(meta.feeUsd),
            closeFeeUsd: round6(meta.closeFeeUsd),
            entryFeeUsd: round6(meta.entryFeeUsd),
            netRealizedPnlUsd: round6(meta.netRealizedPnlUsd),
            realizedPnlUsd: round6(meta.realizedPnlUsd),
            fillCount: Number(meta.fillCount),
            closeFillCount: Number(meta.closeFillCount),
            entryFillCount: Number(meta.entryFillCount),
            hasOrderId: typeof meta.orderId === 'number' && Number.isFinite(Number(meta.orderId)),
            hasOrderRef: typeof meta.orderRef === 'string' && String(meta.orderRef).length > 0,
            symbol: meta.symbol,
          };
        })(),
      },
      exitPolicyCleared: artifacts.exitPolicy === null,
    });

    const paperClose = await runCloseScenario('paper');
    const liveClose = await runCloseScenario('live');
    expect(normalizeClose(liveClose)).toEqual(normalizeClose(paperClose));
  });
});
