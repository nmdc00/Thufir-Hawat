import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeToolCall } from '../../src/core/tool-executor.js';
import { runDueCloseFinalizationJobs } from '../../src/core/close_trade_finalizer.js';
import { HyperliquidClient } from '../../src/execution/hyperliquid/client.js';
import { PaperExecutor } from '../../src/execution/modes/paper.js';
import { countFinalPredictions } from '../../src/memory/calibration.js';
import { openDatabase } from '../../src/memory/db.js';
import { listLearningCases } from '../../src/memory/learning_cases.js';
import { listLearningSignalAudits } from '../../src/memory/learning_observability.js';
import { createPrediction, getPrediction } from '../../src/memory/predictions.js';
import { listTradePolicyAdjustments } from '../../src/memory/trade_policy_adjustments.js';

describe('tool-executor perps', () => {
  const baselineModulePath = '../../src/core/perp_prediction_baselines.js';
  const originalDbPath = process.env.THUFIR_DB_PATH;
  let currentMarkPrice = 50000;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-tool-executor-perps-'));
    process.env.THUFIR_DB_PATH = join(tempDir, 'thufir.sqlite');
    currentMarkPrice = 50000;
  });

  afterEach(() => {
    vi.doUnmock(baselineModulePath);
    delete (globalThis as { __thufirResolvePerpPredictionBaseline?: unknown })
      .__thufirResolvePerpPredictionBaseline;
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

  function createPaperPerpContext() {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    return {
      config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
      marketClient,
      executor,
      limiter,
    };
  }

  function mockPerpPredictionBaseline(baseline: Record<string, unknown>) {
    (globalThis as {
      __thufirResolvePerpPredictionBaseline?: () => Record<string, unknown>;
    }).__thufirResolvePerpPredictionBaseline = vi.fn(() => baseline);
  }

  it('perp_place_order routes to executor', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 1 },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
  });

  it('verifies paper reduce-only closes with explicit postcondition metadata', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };

    const openRes = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.1, mode: 'paper' },
      { config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any, marketClient, executor, limiter }
    );
    expect(openRes.success).toBe(true);

    const closeRes = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'sell', size: 0.1, reduce_only: true, mode: 'paper' },
      { config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any, marketClient, executor, limiter }
    );
    expect(closeRes.success).toBe(true);
    if (closeRes.success) {
      const post = (closeRes.data as { reduce_only_postcondition?: Record<string, unknown> })
        .reduce_only_postcondition;
      expect(post).toBeTruthy();
      expect(post?.verified).toBe(true);
      expect(post?.close_complete).toBe(true);
      expect(post?.after_size).toBe(0);
    }
  });

  it('resolves an open perp prediction on full close using realized net pnl', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const ctx = {
      config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
      marketClient,
      executor,
      limiter,
    };
    const symbol = 'BTCRESOLVE';
    const predictionId = createPrediction({
      marketId: symbol,
      marketTitle: `Perp: ${symbol}`,
      domain: 'perp',
      symbol,
      predictedOutcome: 'YES',
      predictedProbability: 0.62,
      modelProbability: 0.62,
      marketProbability: 0.5,
      learningComparable: true,
      signalScores: {
        technical: 0.8,
        news: 0.1,
        onChain: 0.2,
      },
      signalWeightsSnapshot: {
        technical: 0.5,
        news: 0.3,
        onChain: 0.2,
      },
      executed: true,
      executionPrice: 50000,
      positionSize: 500,
    });

    currentMarkPrice = 50000;
    expect(
      await executeToolCall(
        'perp_place_order',
        { symbol, side: 'buy', size: 0.01, mode: 'paper' },
        ctx
      )
    ).toMatchObject({ success: true });

    currentMarkPrice = 51000;
    expect(
      await executeToolCall(
        'perp_place_order',
        { symbol, side: 'sell', size: 0.01, reduce_only: true, mode: 'paper' },
        ctx
      )
    ).toMatchObject({ success: true });

    const prediction = getPrediction(predictionId);
    expect(prediction?.outcome).toBe('YES');
    expect(prediction?.outcomeBasis).toBe('final');
    expect(prediction?.resolutionStatus).toBe('resolved_true');
    expect(prediction?.pnl).toBeCloseTo(8.9900025, 6);
    expect(prediction?.resolutionMetadata?.basis).toBe('realized_net_pnl_close');
    expect(countFinalPredictions()).toBe(0);
    const db = openDatabase();
    const updates = db.prepare('SELECT COUNT(*) AS c FROM weight_updates').get() as { c: number };
    expect(updates.c).toBe(1);
    const audits = listLearningSignalAudits('perp');
    expect(audits).toHaveLength(1);
  });

  it('inherits signal_class onto reduce-only close journal entries on the real journal path', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const ctx = {
      config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
      marketClient,
      executor,
      limiter,
    };
    const symbol = 'BTCSIGCLS';

    expect(
      await executeToolCall(
        'perp_place_order',
        { symbol, side: 'buy', size: 0.01, mode: 'paper', signal_class: 'mean_reversion' },
        ctx
      )
    ).toMatchObject({ success: true });

    expect(
      await executeToolCall(
        'perp_place_order',
        { symbol, side: 'sell', size: 0.01, reduce_only: true, mode: 'paper', exit_mode: 'take_profit' },
        ctx
      )
    ).toMatchObject({ success: true });

    const listRes = await executeToolCall(
      'perp_trade_journal_list',
      { symbol, limit: 20 },
      ctx
    );
    expect(listRes.success).toBe(true);
    const entries = ((listRes as any).data?.entries ?? []) as Array<Record<string, unknown>>;
    const closed = entries.find(
      (entry) => entry.reduceOnly === true && entry.outcome === 'executed'
    );
    expect(closed).toBeDefined();
    expect(closed?.signalClass).toBe('mean_reversion');
  });

  it('does not resolve a perp prediction on partial reduce-only close', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const ctx = {
      config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
      marketClient,
      executor,
      limiter,
    };
    const symbol = 'BTCPARTIAL';
    const predictionId = createPrediction({
      marketId: symbol,
      marketTitle: `Perp: ${symbol}`,
      domain: 'perp',
      symbol,
      predictedOutcome: 'YES',
      predictedProbability: 0.62,
      modelProbability: 0.62,
      marketProbability: 0.5,
      learningComparable: true,
      executed: true,
      executionPrice: 50000,
      positionSize: 500,
    });

    currentMarkPrice = 50000;
    expect(
      await executeToolCall(
        'perp_place_order',
        { symbol, side: 'buy', size: 0.02, mode: 'paper' },
        ctx
      )
    ).toMatchObject({ success: true });

    currentMarkPrice = 50500;
    expect(
      await executeToolCall(
        'perp_place_order',
        { symbol, side: 'sell', size: 0.01, reduce_only: true, mode: 'paper' },
        ctx
      )
    ).toMatchObject({ success: true });

    const prediction = getPrediction(predictionId);
    expect(prediction?.outcome).toBeNull();
    expect(prediction?.outcomeBasis).toBe('legacy');
    expect(prediction?.resolutionStatus).toBe('open');
    expect(countFinalPredictions()).toBe(0);
  });

  it('materializes one persistent policy adjustment on a full reduce-only close when enabled', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const ctx = {
      config: {
        execution: { provider: 'hyperliquid', mode: 'paper' },
        autonomy: {
          enabled: true,
          fullAuto: true,
          signalPerformance: { minSamples: 99 },
          calibrationRisk: { enabled: false },
          tradeQuality: { enabled: false },
          tradePolicyAdjustments: {
            enabled: true,
            minSamples: 1,
            blockOnThesisFailureRatio: 2,
            blockBelowScore: 0.2,
            downweightOnThesisFailureRatio: 0.5,
            downweightBelowScore: 0.5,
            downweightMultiplier: 0.4,
          },
        },
      } as any,
      marketClient,
      executor,
      limiter,
    };
    const symbol = 'XYZ:SILVER';

    expect(
      await executeToolCall(
        'perp_place_order',
        { symbol, side: 'buy', size: 0.01, mode: 'paper', signal_class: 'mean_reversion' },
        ctx
      )
    ).toMatchObject({ success: true });

    currentMarkPrice = 49500;
    expect(
      await executeToolCall(
        'perp_place_order',
        {
          symbol,
          side: 'sell',
          size: 0.01,
          reduce_only: true,
          mode: 'paper',
          signal_class: 'mean_reversion',
          exit_mode: 'manual',
        },
        ctx
      )
    ).toMatchObject({ success: true });

    expect(runDueCloseFinalizationJobs({ config: ctx.config, workerId: 'test-finalizer', limit: 5 })).toMatchObject({
      finalized: 1,
    });

    const adjustments = listTradePolicyAdjustments('perp');
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]!.active).toBe(true);
    expect(adjustments[0]!.symbolClass).toBe('macro_contract');
    expect(adjustments[0]!.signalClass).toBe('mean_reversion');

    const laterRes = await executeToolCall(
      'perp_place_order',
      { symbol, side: 'buy', size: 0.01, mode: 'paper', signal_class: 'mean_reversion' },
      ctx
    );
    expect(laterRes).toMatchObject({ success: true });
    if (laterRes.success) {
      expect(laterRes.data.policy.reason_code).toBe('policy:size:downweight');
      expect(laterRes.data.policy.active_adjustment_ids.length).toBeGreaterThan(0);
      expect(laterRes.data.policy.size_multiplier).toBeLessThan(1);
      expect(laterRes.data.policy.adaptation_changed_outcome).toBe(true);
      expect(laterRes.data.policy.effective_size).toBeLessThan(laterRes.data.policy.requested_size);
    }
  });

  it('does not materialize a policy adjustment on a partial reduce-only close', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const ctx = {
      config: {
        execution: { provider: 'hyperliquid', mode: 'paper' },
        autonomy: { tradePolicyAdjustments: { enabled: true, minSamples: 1 } },
      } as any,
      marketClient,
      executor,
      limiter,
    };
    const symbol = 'BTCNOADJ';

    expect(
      await executeToolCall(
        'perp_place_order',
        { symbol, side: 'buy', size: 0.02, mode: 'paper', signal_class: 'mean_reversion' },
        ctx
      )
    ).toMatchObject({ success: true });

    currentMarkPrice = 49500;
    expect(
      await executeToolCall(
        'perp_place_order',
        {
          symbol,
          side: 'sell',
          size: 0.01,
          reduce_only: true,
          mode: 'paper',
          signal_class: 'mean_reversion',
          exit_mode: 'manual',
        },
        ctx
      )
    ).toMatchObject({ success: true });

    expect(listTradePolicyAdjustments('perp')).toHaveLength(0);
  });

  it('reuses one tradeId across a full paper position lifecycle', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const ctx = {
      config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
      marketClient,
      executor,
      limiter,
    };
    const symbol = 'BTCLIFE';

    const openRes = await executeToolCall(
      'perp_place_order',
      { symbol, side: 'buy', size: 0.05, mode: 'paper' },
      ctx
    );
    expect(openRes.success).toBe(true);

    const addRes = await executeToolCall(
      'perp_place_order',
      { symbol, side: 'buy', size: 0.02, mode: 'paper' },
      ctx
    );
    expect(addRes.success).toBe(true);

    const cutRes = await executeToolCall(
      'perp_place_order',
      { symbol, side: 'sell', size: 0.03, reduce_only: true, mode: 'paper' },
      ctx
    );
    expect(cutRes.success).toBe(true);

    const closeRes = await executeToolCall(
      'perp_place_order',
      { symbol, side: 'sell', size: 0.04, reduce_only: true, mode: 'paper' },
      ctx
    );
    expect(closeRes.success).toBe(true);

    const listRes = await executeToolCall(
      'perp_trade_journal_list',
      { symbol, limit: 20 },
      { config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any, marketClient }
    );
    expect(listRes.success).toBe(true);
    const entries = (((listRes as any).data?.entries ?? []) as Array<Record<string, unknown>>)
      .filter((entry) => entry.outcome === 'executed')
      .slice(0, 4);
    expect(entries.length).toBe(4);
    const tradeIds = entries
      .map((entry) => Number(entry.tradeId ?? NaN))
      .filter((tradeId) => Number.isFinite(tradeId) && tradeId > 0);
    expect(tradeIds.length).toBe(4);
    expect(new Set(tradeIds).size).toBe(1);
    const modes = entries.map((entry) => String(entry.execution_mode ?? ''));
    expect(modes.every((mode) => mode === 'paper')).toBe(true);
  });

  it('retries no-immediate-match failures with widened slippage and succeeds', async () => {
    const slippageSeen: number[] = [];
    let confirmCount = 0;
    let releaseCount = 0;
    const executor = {
      execute: async (_market: unknown, decision: { marketSlippageBps?: number }) => {
        slippageSeen.push(Number(decision.marketSlippageBps ?? -1));
        if (slippageSeen.length < 3) {
          return {
            executed: false,
            message:
              'Hyperliquid trade failed: Order 0: Order could not immediately match against any resting orders. asset=0',
          };
        }
        return { executed: true, message: 'Hyperliquid order filled (oid=1).' };
      },
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {
        confirmCount += 1;
      },
      release: () => {
        releaseCount += 1;
      },
    };

    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 1 },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          hyperliquid: { defaultSlippageBps: 10 },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );

    expect(res.success).toBe(true);
    expect(slippageSeen).toEqual([10, 35, 60]);
    expect(confirmCount).toBe(1);
    expect(releaseCount).toBe(0);
    if (res.success) {
      const data = res.data as { execution_attempts?: Array<{ attempt: number }> };
      expect(data.execution_attempts?.length).toBe(3);
    }
  });

  it('autofills missing entry contract fields when trade-contract enforcement is enabled', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.001 },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          autonomy: { tradeContract: { enabled: true } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(true);
  });

  it('accepts entry orders with a valid contract when enforcement is enabled', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const nowMs = Date.now();
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTC',
        side: 'buy',
        size: 0.01,
        trade_archetype: 'intraday',
        invalidation_type: 'price_level',
        invalidation_price: 49000,
        time_stop_at_ms: nowMs + 2 * 60 * 60 * 1000,
        take_profit_r: 2,
        trail_mode: 'structure',
      },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          autonomy: { tradeContract: { enabled: true } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(true);
  });

  it('perp_place_order blocks leverage above risk max', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 1, leverage: 7 },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          wallet: { perps: { maxLeverage: 5 } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/Leverage/i);
  });

  it('perp_place_order blocks oversized notional', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 1 },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          wallet: { perps: { maxOrderNotionalUsd: 1000 } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/notional/i);
  });

  it('perp_place_order blocks same-side live clustering beyond configured caps', async () => {
    vi.spyOn(HyperliquidClient.prototype, 'getAllMids').mockResolvedValue({
      BTC: 81000,
      ETH: 2350,
      SOL: 85,
    } as any);
    vi.spyOn(HyperliquidClient.prototype, 'getClearinghouseState').mockResolvedValue({
      assetPositions: [
        { position: { coin: 'BTC', szi: '-0.0015', positionValue: '121.5' } },
        { position: { coin: 'ETH', szi: '-0.04', positionValue: '94' } },
      ],
    } as any);
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };

    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'SOL', side: 'sell', size: 1, mode: 'live' },
      {
        config: {
          execution: { provider: 'hyperliquid', mode: 'live' },
          wallet: {
            perps: {
              sameSideExposureCaps: {
                maxOpenPositions: 2,
                maxTotalNotionalUsd: 200,
              },
            },
          },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(false);
    expect(String((res as any).error)).toMatch(/Same-side exposure cap exceeded/i);
  });

  it('perp_place_order allows reduce-only even if spending limiter blocks', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: false, reason: 'nope' }),
      confirm: () => {},
      release: () => {},
    };
    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'sell', size: 1, reduce_only: true, mode: 'live' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
  });

  it('accepts deterministic thesis evaluation fields for reduce-only exits', async () => {
    vi.spyOn(HyperliquidClient.prototype, 'getClearinghouseState').mockResolvedValue({
      assetPositions: [{ position: { coin: 'XBTTEST', szi: '0.005' } }],
    } as any);
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const symbol = 'XBTTEST';
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol,
        side: 'sell',
        size: 0.001,
        reduce_only: true,
        hypothesis_id: 'hyp_test_close',
        thesis_invalidation_hit: false,
        exit_mode: 'manual',
      },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
  });

  it('persists an executed trade snapshot artifact with segment context', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };

    currentMarkPrice = 50000;
    const openRes = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCSNAP',
        side: 'buy',
        size: 0.01,
        mode: 'paper',
        signal_class: 'mean_reversion',
        market_regime: 'trending',
        volatility_bucket: 'high',
        liquidity_bucket: 'deep',
        expected_edge: 0.08,
        entry_trigger: 'technical',
        invalidation_price: 49000,
        time_stop_at_ms: Date.now() + 3600000,
        plan_context: { setupKey: 'perp:mean_reversion' },
      },
      {
        config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(openRes.success).toBe(true);

    const db = openDatabase();
    const row = db.prepare(
      `SELECT payload FROM decision_artifacts WHERE kind = 'perp_trade_snapshot' AND market_id = 'BTCSNAP' ORDER BY id DESC LIMIT 1`
    ).get() as { payload?: string } | undefined;
    expect(row?.payload).toBeTruthy();
    const payload = JSON.parse(String(row?.payload ?? '{}')) as Record<string, unknown>;
    expect(payload.signalClass).toBe('mean_reversion');
    expect(payload.marketRegime).toBe('trending');
    expect(payload.volatilityBucket).toBe('high');
    expect(payload.liquidityBucket).toBe('deep');
    expect(payload.planContext).toEqual({ setupKey: 'perp:mean_reversion' });
    expect(typeof payload.createdAtMs).toBe('number');
  });

  it('blocks reduce-only when no live position exists', async () => {
    vi.spyOn(HyperliquidClient.prototype, 'getClearinghouseState').mockResolvedValue({
      assetPositions: [],
    } as any);
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'sell', size: 1, reduce_only: true, mode: 'live' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('no open BTC position');
  });

  it('blocks reduce-only when side would increase current position', async () => {
    vi.spyOn(HyperliquidClient.prototype, 'getClearinghouseState').mockResolvedValue({
      assetPositions: [{ position: { coin: 'BTC', szi: '0.4' } }],
    } as any);
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.1, reduce_only: true, mode: 'live' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('would increase current long BTC position');
  });

  it('caps reduce-only size to live position size before execution', async () => {
    vi.spyOn(HyperliquidClient.prototype, 'getClearinghouseState').mockResolvedValue({
      assetPositions: [{ position: { coin: 'BTC', szi: '0.25' } }],
    } as any);
    let executedSize = 0;
    const executor = {
      execute: async (_market: unknown, decision: { size?: number }) => {
        executedSize = Number(decision.size ?? 0);
        return { executed: true, message: 'ok' };
      },
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const res = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'sell', size: 0.8, reduce_only: true, mode: 'live' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
    expect(executedSize).toBeCloseTo(0.25, 8);
  });

  it('blocks manual reduce-only exits when exit FSM enforcement is enabled', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'XBTTEST',
        side: 'sell',
        size: 0.001,
        reduce_only: true,
        exit_mode: 'manual',
        thesis_invalidation_hit: false,
      },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          autonomy: { tradeContract: { enforceExitFsm: true } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/manual\/unknown reduce-only exits are blocked/i);
  });

  it('allows manual reduce-only exits with emergency override under FSM enforcement', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'XBTTEST',
        side: 'sell',
        size: 0.001,
        reduce_only: true,
        exit_mode: 'manual',
        emergency_override: true,
        emergency_reason: 'Exchange-side stop desynced after outage',
      },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          autonomy: { tradeContract: { enforceExitFsm: true } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(true);
  });

  it('normalizes missing reduce-only exit_mode when exit FSM enforcement is enabled', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'XBTTEST',
        side: 'sell',
        size: 0.001,
        reduce_only: true,
      },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          autonomy: { tradeContract: { enforceExitFsm: true } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(true);
  });

  it('normalizes conflicting reduce-only invalidation fields when exit FSM enforcement is enabled', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'XBTTEST',
        side: 'sell',
        size: 0.001,
        reduce_only: true,
        exit_mode: 'take_profit',
        thesis_invalidation_hit: true,
      },
      {
        config: {
          execution: { provider: 'hyperliquid' },
          autonomy: { tradeContract: { enforceExitFsm: true } },
        } as any,
        marketClient,
        executor,
        limiter,
      }
    );
    expect(res.success).toBe(true);
  });

  it('persists deterministic direction/timing/sizing/exit scores for closed trades', async () => {
    let markPrice = 100;
    const dynamicMarketClient = {
      getMarket: async (symbol: string) => ({
        id: symbol,
        question: `Perp: ${symbol}`,
        outcomes: ['LONG', 'SHORT'],
        prices: {},
        platform: 'hyperliquid',
        kind: 'perp',
        symbol,
        markPrice,
        metadata: { maxLeverage: 10 },
      }),
      listMarkets: async () => [],
      searchMarkets: async () => [],
    };
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };

    const symbol = 'SCORETESTBTC';
    const hypothesisId = 'hyp_component_scoring_test';
    const entryRes = await executeToolCall(
      'perp_place_order',
      {
        symbol,
        side: 'buy',
        size: 0.4,
        expected_edge: 0.6,
        hypothesis_id: hypothesisId,
      },
      {
        config: { execution: { provider: 'hyperliquid' } } as any,
        marketClient: dynamicMarketClient as any,
        executor,
        limiter,
      }
    );
    expect(entryRes.success).toBe(true);

    markPrice = 110;
    const closeRes = await executeToolCall(
      'perp_place_order',
      {
        symbol,
        side: 'sell',
        size: 0.4,
        reduce_only: true,
        hypothesis_id: hypothesisId,
        thesis_invalidation_hit: false,
        exit_mode: 'take_profit',
        price_path_high: 120,
        price_path_low: 90,
      },
      {
        config: { execution: { provider: 'hyperliquid' } } as any,
        marketClient: dynamicMarketClient as any,
        executor,
        limiter,
      }
    );
    expect(closeRes.success).toBe(true);

    const listRes = await executeToolCall(
      'perp_trade_journal_list',
      { symbol, limit: 20 },
      {
        config: { execution: { provider: 'hyperliquid' } } as any,
        marketClient: dynamicMarketClient as any,
      }
    );
    expect(listRes.success).toBe(true);
    const entries = ((listRes as any).data?.entries ?? []) as Array<Record<string, unknown>>;
    const closed = entries.find(
      (entry) =>
        entry.hypothesisId === hypothesisId &&
        entry.reduceOnly === true &&
        entry.outcome === 'executed'
    );
    expect(closed).toBeDefined();
    expect(Number(closed?.directionScore)).toBe(1);
    expect(Number(closed?.timingScore)).toBeCloseTo(2 / 3, 8);
    expect(Number(closed?.sizingScore)).toBeCloseTo(0.6857142857, 8);
    expect(Number(closed?.exitScore)).toBeCloseTo(0.5, 8);
    expect(Number(closed?.direction_score)).toBe(1);
    expect(Number(closed?.timing_score)).toBeCloseTo(2 / 3, 8);
    expect(Number(closed?.sizing_score)).toBeCloseTo(0.6857142857, 8);
    expect(Number(closed?.exit_score)).toBeCloseTo(0.5, 8);
  });

  it('accepts news provenance metadata on news-triggered entries', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const symbol = 'ETHTEST';
    const sources = ['https://example.com/news/a', 'intel:news:1234'];
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol,
        side: 'buy',
        size: 0.001,
        entry_trigger: 'news',
        news_subtype: 'macro',
        news_sources: sources,
      },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);
  });

  it('persists plan_context metadata in perp trade journal entries', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const symbol = 'PLANTESTBTC';
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol,
        side: 'buy',
        size: 0.001,
        plan_context: {
          plan_id: 'plan-abc',
          current_step_id: 'step-1',
          plan_revision_count: 2,
        },
      },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);

    const listRes = await executeToolCall(
      'perp_trade_journal_list',
      { symbol, limit: 5 },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient }
    );
    expect(listRes.success).toBe(true);
    const entries = ((listRes as any).data?.entries ?? []) as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.planContext).toMatchObject({
      plan_id: 'plan-abc',
      current_step_id: 'step-1',
      plan_revision_count: 2,
    });
  });

  it('infers signalClass from hypothesis_id when signal_class is omitted', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const symbol = 'SIGINF1';
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol,
        side: 'buy',
        size: 0.001,
        hypothesis_id: 'btc_trend_breakout_hypothesis',
      },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);

    const listRes = await executeToolCall(
      'perp_trade_journal_list',
      { symbol, limit: 5 },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient }
    );
    expect(listRes.success).toBe(true);
    const entries = ((listRes as any).data?.entries ?? []) as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.signalClass).toBe('momentum_breakout');
  });

  it('infers signalClass from plan_context setup_key when signal_class is omitted', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const symbol = 'SIGINF2';
    const res = await executeToolCall(
      'perp_place_order',
      {
        symbol,
        side: 'buy',
        size: 0.001,
        plan_context: {
          plan_id: 'plan-infer',
          setup_key: `${symbol}:mean_reversion`,
        },
      },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
    );
    expect(res.success).toBe(true);

    const listRes = await executeToolCall(
      'perp_trade_journal_list',
      { symbol, limit: 5 },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient }
    );
    expect(listRes.success).toBe(true);
    const entries = ((listRes as any).data?.entries ?? []) as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.signalClass).toBe('mean_reversion');
  });

  it('perp_open_orders returns executor orders', async () => {
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [{ id: '1' }],
      cancelOrder: async () => {},
    };
    const res = await executeToolCall(
      'perp_open_orders',
      {},
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor }
    );
    expect(res.success).toBe(true);
  });

  it('perp_cancel_order calls executor cancel', async () => {
    let called = false;
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {
        called = true;
      },
    };
    const res = await executeToolCall(
      'perp_cancel_order',
      { order_id: '123' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor }
    );
    expect(res.success).toBe(true);
    expect(called).toBe(true);
  });

  it('tracks paper open orders and positions with 200 USDC default bankroll', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const ctx = {
      config: { execution: { mode: 'paper', provider: 'hyperliquid' } } as any,
      marketClient,
      executor,
      limiter,
    };

    const placeLimit = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.01, order_type: 'limit', price: 49000 },
      ctx
    );
    expect(placeLimit.success).toBe(true);

    const openOrders = await executeToolCall('perp_open_orders', {}, ctx);
    expect(openOrders.success).toBe(true);
    const orders = ((openOrders as any).data?.orders ?? []) as Array<Record<string, unknown>>;
    expect(orders.length).toBeGreaterThan(0);
    const orderId = String(orders[0]?.id ?? '');
    expect(orderId.length).toBeGreaterThan(0);

    const cancel = await executeToolCall('perp_cancel_order', { order_id: orderId }, ctx);
    expect(cancel.success).toBe(true);

    const placeMarket = await executeToolCall(
      'perp_place_order',
      { symbol: 'BTC', side: 'buy', size: 0.005, order_type: 'market' },
      ctx
    );
    expect(placeMarket.success).toBe(true);

    const positions = await executeToolCall('perp_positions', {}, ctx);
    expect(positions.success).toBe(true);
    const perpPositions = ((positions as any).data?.positions ?? []) as Array<Record<string, unknown>>;
    expect(perpPositions.length).toBeGreaterThan(0);

    const portfolio = await executeToolCall('get_portfolio', {}, ctx);
    expect(portfolio.success).toBe(true);
    expect((portfolio as any).data?.summary?.perp_mode).toBe('paper');
    expect((portfolio as any).data?.perp_summary?.source).toBe('paper');
    expect(((portfolio as any).data?.perp_positions ?? []).length).toBeGreaterThan(0);
    expect(Number((portfolio as any).data?.perp_summary?.account_value)).toBe(
      Number((portfolio as any).data?.perp_summary?.withdrawable)
    );
    expect(Number((portfolio as any).data?.summary?.available_balance)).toBeGreaterThan(0);
  });

  it('paper_promotion_report returns gate evaluation', async () => {
    const symbol = 'GATETEST';
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    for (const side of ['buy', 'buy', 'sell', 'sell'] as const) {
      await executeToolCall(
        'perp_place_order',
        {
          symbol,
          side,
          size: 0.001,
          signal_class: 'momentum_breakout',
          thesis_invalidation_hit: side === 'sell',
          exit_mode: side === 'sell' ? 'take_profit' : undefined,
          reduce_only: side === 'sell',
        },
        { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter }
      );
    }

    const res = await executeToolCall(
      'paper_promotion_report',
      { symbol, signal_class: 'momentum_breakout' },
      {
        config: { execution: { provider: 'hyperliquid' }, paper: { promotionGates: { minTrades: 1 } } } as any,
        marketClient,
      }
    );
    expect(res.success).toBe(true);
    if (res.success) {
      expect((res.data as any).setupKey).toBe(`${symbol}:momentum_breakout`);
      expect((res.data as any).sampleCount).toBeGreaterThanOrEqual(1);
    }
  });

  it('creates a comparable perp prediction from a resolved baseline', async () => {
    mockPerpPredictionBaseline({
      probability: 0.62,
      comparable: true,
      source: 'segment_history_blended',
      fallbackLevel: 'signalClass+marketRegime',
      sampleCount: 8,
      wins: 5,
      priorProbability: 0.5,
      priorStrength: 20,
      segmentKey: 'momentum_breakout|high_vol_expansion',
      exclusionReason: null,
    });

    const ctx = createPaperPerpContext();

    const result = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCBASE',
        side: 'buy',
        size: 0.01,
        mode: 'paper',
        create_learning_prediction: true,
        prediction_model_probability: 0.74,
        signal_class: 'momentum_breakout',
        market_regime: 'high_vol_expansion',
        entry_trigger: 'technical',
        volatility_bucket: 'high',
        liquidity_bucket: 'deep',
      },
      ctx
    );

    expect(result.success).toBe(true);
    const predictionId = (result.data as { prediction_id?: string | null }).prediction_id;
    expect(predictionId).toBeTruthy();

    const storedPrediction = getPrediction(String(predictionId));
    expect(storedPrediction?.marketProbability).toBe(0.62);
    expect(storedPrediction?.learningComparable).toBe(true);

    const prediction = listLearningCases({
      caseType: 'comparable_forecast',
      entityType: 'symbol',
      entityId: 'BTCBASE',
      limit: 1,
    })[0];
    expect(prediction).toBeTruthy();
    expect(prediction.sourcePredictionId).toBe(predictionId);
    expect(prediction.comparable).toBe(true);
    expect(prediction.comparatorKind).toBe('market_price');
    expect(prediction.exclusionReason).toBeNull();
    expect(prediction.baseline).toMatchObject({
      marketProbability: 0.62,
      source: 'segment_history_blended',
      fallbackLevel: 'signalClass+marketRegime',
      sampleCount: 8,
    });
  });

  it('keeps perp prediction learning excluded when baseline is missing', async () => {
    mockPerpPredictionBaseline({
      probability: null,
      comparable: false,
      source: 'missing',
      fallbackLevel: null,
      sampleCount: 0,
      wins: 0,
      priorProbability: null,
      priorStrength: 20,
      segmentKey: null,
      exclusionReason: 'missing_comparator',
    });

    const ctx = createPaperPerpContext();

    const result = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCMISSBASE',
        side: 'buy',
        size: 0.01,
        mode: 'paper',
        create_learning_prediction: true,
        prediction_model_probability: 0.71,
        signal_class: 'momentum_breakout',
      },
      ctx
    );

    expect(result.success).toBe(true);
    const predictionId = (result.data as { prediction_id?: string | null }).prediction_id;
    expect(predictionId).toBeTruthy();

    const storedPrediction = getPrediction(String(predictionId));
    expect(storedPrediction?.marketProbability).toBeNull();
    expect(storedPrediction?.learningComparable).toBe(false);

    const prediction = listLearningCases({
      caseType: 'comparable_forecast',
      entityType: 'symbol',
      entityId: 'BTCMISSBASE',
      limit: 1,
    })[0];
    expect(prediction).toBeTruthy();
    expect(prediction.comparable).toBe(false);
    expect(prediction.comparatorKind).toBeNull();
    expect(['missing_comparator', 'insufficient_samples']).toContain(prediction.exclusionReason);
    expect(prediction.baseline).toMatchObject({
      marketProbability: null,
      source: 'missing',
    });
  });

  it('does not admit synthetic perp comparable learning cases from perp_place_order', async () => {
    mockPerpPredictionBaseline({
      probability: null,
      comparable: false,
      source: 'missing',
      fallbackLevel: null,
      sampleCount: 0,
      wins: 0,
      priorProbability: null,
      priorStrength: 20,
      segmentKey: null,
      exclusionReason: 'missing_comparator',
    });

    const ctx = createPaperPerpContext();

    const result = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCCOMP',
        side: 'buy',
        size: 0.01,
        mode: 'paper',
        create_learning_prediction: true,
        prediction_model_probability: 0.74,
        prediction_market_probability: 0.5,
        prediction_learning_comparable: true,
      },
      ctx
    );

    expect(result.success).toBe(true);

    const prediction = listLearningCases({
      caseType: 'comparable_forecast',
      entityType: 'symbol',
      entityId: 'BTCCOMP',
      limit: 1,
    })[0];
    expect(prediction).toBeTruthy();
    expect(prediction.sourcePredictionId).toBeTruthy();

    const storedPrediction = getPrediction(String(prediction.sourcePredictionId));
    expect(storedPrediction?.learningComparable).toBe(false);
    expect(storedPrediction?.marketProbability).toBeNull();

    expect(prediction.comparable).toBe(false);
    expect(prediction.comparatorKind).toBeNull();
    expect(prediction.exclusionReason).toBe('missing_comparator');
    expect(prediction.baseline?.marketProbability).toBeNull();
  });

  it('returns the linked prediction id on reduce-only close responses', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const ctx = {
      config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
      marketClient,
      executor,
      limiter,
    };

    const openResult = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCCLOSEID',
        side: 'buy',
        size: 0.01,
        mode: 'paper',
        create_learning_prediction: true,
        prediction_model_probability: 0.74,
        prediction_market_probability: 0.5,
        prediction_learning_comparable: true,
      },
      ctx
    );
    expect(openResult.success).toBe(true);
    const openPredictionId = (openResult.data as { prediction_id?: string | null }).prediction_id;
    expect(openPredictionId).toBeTruthy();

    const closeResult = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCCLOSEID',
        side: 'sell',
        size: 0.01,
        reduce_only: true,
        mode: 'paper',
        exit_mode: 'manual',
        emergency_override: true,
        emergency_reason: 'test close response prediction id',
      },
      ctx
    );
    expect(closeResult.success).toBe(true);
    expect((closeResult.data as { prediction_id?: string | null }).prediction_id).toBe(openPredictionId);

    const storedPrediction = getPrediction(String(openPredictionId));
    expect(storedPrediction?.outcomeBasis).toBe('final');
  });

  it('get_fills paper mode returns fill history with realized PnL after open+close', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const ctx = {
      config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
      marketClient,
      executor,
      limiter,
    };

    await executeToolCall('perp_place_order', { symbol: 'BTC', side: 'buy', size: 0.01, mode: 'paper' }, ctx);
    await executeToolCall('perp_place_order', { symbol: 'BTC', side: 'sell', size: 0.01, reduce_only: true, mode: 'paper' }, ctx);

    const res = await executeToolCall('get_fills', { symbol: 'BTC', limit: 10 }, ctx);
    expect(res.success).toBe(true);
    const data = (res as any).data;
    expect(data.mode).toBe('paper');
    expect(Array.isArray(data.fills)).toBe(true);
    expect(data.fills.length).toBeGreaterThanOrEqual(2);
    const closeFill = data.fills.find((f: any) => f.side === 'sell' && f.reduce_only === true);
    expect(closeFill).toBeDefined();
    expect(typeof closeFill.realized_pnl_usd).toBe('number');
    expect(typeof data.summary.total_realized_pnl_usd).toBe('number');
  });

  it('paper open+close persists an execution-quality learning case', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const ctx = {
      config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
      marketClient,
      executor,
      limiter,
    };

    await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCLEARN',
        side: 'buy',
        size: 0.01,
        mode: 'paper',
        signal_class: 'momentum_breakout',
        trade_archetype: 'intraday',
      },
      ctx
    );
    const closeRes = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCLEARN',
        side: 'sell',
        size: 0.01,
        reduce_only: true,
        mode: 'paper',
        thesis_invalidation_hit: false,
        exit_mode: 'take_profit',
      },
      ctx
    );

    expect(closeRes.success).toBe(true);

    const learningCase = listLearningCases({
      caseType: 'execution_quality',
      entityType: 'symbol',
      entityId: 'BTCLEARN',
      limit: 1,
    })[0];

    expect(learningCase).toBeTruthy();
    expect(learningCase.caseType).toBe('execution_quality');
    expect(learningCase.comparable).toBe(false);
    expect(learningCase.exclusionReason).toBe('execution_quality_case');
    expect(learningCase.context?.signalClass).toBe('momentum_breakout');
    expect(learningCase.action?.reduceOnly).toBe(true);
    expect(learningCase.outcome?.exitMode).toBe('take_profit');
    expect(learningCase.outcome?.thesisCorrect).toBe(true);
    expect(typeof learningCase.qualityScores?.compositeScore).toBe('number');
  });

  it('records partial reduce events and finalizes only full close artifacts asynchronously', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const config = {
      execution: { provider: 'hyperliquid', mode: 'paper' },
      autonomy: {
        tradePolicyAdjustments: {
          enabled: true,
          minSamples: 1,
        },
      },
    } as any;
    const ctx = { config, marketClient, executor, limiter };

    await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCCLOSELEARN',
        side: 'buy',
        size: 0.02,
        mode: 'paper',
        signal_class: 'momentum_breakout',
        trade_archetype: 'intraday',
      },
      ctx
    );
    await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCCLOSELEARN',
        side: 'sell',
        size: 0.01,
        reduce_only: true,
        mode: 'paper',
        thesis_invalidation_hit: false,
        exit_mode: 'risk_reduction',
      },
      ctx
    );

    const db = openDatabase();
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM trade_close_events WHERE close_kind = 'partial_reduce'").get() as { c: number }).c
    ).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM close_finalization_jobs').get() as { c: number }).c).toBe(0);

    await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCCLOSELEARN',
        side: 'sell',
        size: 0.01,
        reduce_only: true,
        mode: 'paper',
        thesis_invalidation_hit: true,
        exit_mode: 'thesis_invalidation',
      },
      ctx
    );

    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM trade_close_events WHERE close_kind = 'full_close'").get() as { c: number }).c
    ).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM close_finalization_jobs').get() as { c: number }).c).toBe(1);

    const result = runDueCloseFinalizationJobs({ config, workerId: 'test-finalizer', limit: 5 });
    expect(result.finalized).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM trade_closes').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM trade_reflections').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM trade_policy_adjustments').get() as { c: number }).c).toBeGreaterThanOrEqual(1);
  });

  it('does not admit synthetic perp comparable learning cases from perp_place_order', async () => {
    mockPerpPredictionBaseline({
      probability: null,
      comparable: false,
      source: 'missing',
      fallbackLevel: null,
      sampleCount: 0,
      wins: 0,
      priorProbability: null,
      priorStrength: 20,
      segmentKey: null,
      exclusionReason: 'missing_comparator',
    });

    const ctx = createPaperPerpContext();

    const result = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCCOMP',
        side: 'buy',
        size: 0.01,
        mode: 'paper',
        create_learning_prediction: true,
        prediction_model_probability: 0.74,
        prediction_market_probability: 0.5,
        prediction_learning_comparable: true,
      },
      ctx
    );

    expect(result.success).toBe(true);

    const prediction = listLearningCases({
      caseType: 'comparable_forecast',
      entityType: 'symbol',
      entityId: 'BTCCOMP',
      limit: 1,
    })[0];
    expect(prediction).toBeTruthy();
    expect(prediction.sourcePredictionId).toBeTruthy();

    const storedPrediction = getPrediction(String(prediction.sourcePredictionId));
    expect(storedPrediction?.learningComparable).toBe(false);
    expect(storedPrediction?.marketProbability).toBeNull();

    expect(prediction.comparable).toBe(false);
    expect(prediction.comparatorKind).toBeNull();
    expect(prediction.exclusionReason).toBe('missing_comparator');
    expect(prediction.baseline?.marketProbability).toBeNull();
  });

  it('returns the linked prediction id on reduce-only close responses', async () => {
    const executor = new PaperExecutor({ initialCashUsdc: 200 });
    const limiter = {
      checkAndReserve: async () => ({ allowed: true }),
      confirm: () => {},
      release: () => {},
    };
    const ctx = {
      config: { execution: { provider: 'hyperliquid', mode: 'paper' } } as any,
      marketClient,
      executor,
      limiter,
    };

    const openResult = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCCLOSEID',
        side: 'buy',
        size: 0.01,
        mode: 'paper',
        create_learning_prediction: true,
        prediction_model_probability: 0.74,
        prediction_market_probability: 0.5,
        prediction_learning_comparable: true,
      },
      ctx
    );
    expect(openResult.success).toBe(true);
    const openPredictionId = (openResult.data as { prediction_id?: string | null }).prediction_id;
    expect(openPredictionId).toBeTruthy();

    const closeResult = await executeToolCall(
      'perp_place_order',
      {
        symbol: 'BTCCLOSEID',
        side: 'sell',
        size: 0.01,
        reduce_only: true,
        mode: 'paper',
        exit_mode: 'manual',
        emergency_override: true,
        emergency_reason: 'test close response prediction id',
      },
      ctx
    );
    expect(closeResult.success).toBe(true);
    expect((closeResult.data as { prediction_id?: string | null }).prediction_id).toBe(openPredictionId);

    const storedPrediction = getPrediction(String(openPredictionId));
    expect(storedPrediction?.outcomeBasis).toBe('final');
  });

  it('get_fills live mode returns mapped fills from Hyperliquid API', async () => {
    vi.spyOn(HyperliquidClient.prototype, 'getAccountAddress').mockReturnValue('0xdeadbeef');
    vi.spyOn(HyperliquidClient.prototype, 'getUserFillsByTime').mockResolvedValue([
      {
        coin: 'BTC',
        px: '70500',
        sz: '0.01',
        side: 'A',
        closedPnl: '10.25',
        fee: '0.35',
        time: 1741996800000,
        oid: 987654,
        dir: 'Close Long',
        feeToken: 'USDC',
      },
      {
        coin: 'BTC',
        px: '70000',
        sz: '0.01',
        side: 'B',
        closedPnl: '0',
        fee: '0.35',
        time: 1741900000000,
        oid: 987600,
        dir: 'Open Long',
        feeToken: 'USDC',
      },
      {
        coin: 'ZEC',
        px: '230',
        sz: '0.5',
        side: 'B',
        closedPnl: '0',
        fee: '0.12',
        time: 1741800000000,
        oid: 111111,
        dir: 'Open Long',
        feeToken: 'USDC',
      },
    ] as any);

    const ctx = {
      config: { execution: { provider: 'hyperliquid' } } as any,
      marketClient,
    };

    // All symbols — mode: 'live' in toolInput to bypass requireExplicitLive guard
    const resAll = await executeToolCall('get_fills', { mode: 'live', limit: 10 }, ctx);
    expect(resAll.success).toBe(true);
    const allData = (resAll as any).data;
    expect(allData.mode).toBe('live');
    expect(allData.fills.length).toBe(3);
    expect(typeof allData.summary.total_realized_pnl_usd).toBe('number');
    expect(allData.summary.total_realized_pnl_usd).toBeCloseTo(10.25, 5);

    // Filter by symbol
    const resBtc = await executeToolCall('get_fills', { mode: 'live', symbol: 'BTC', limit: 10 }, ctx);
    expect(resBtc.success).toBe(true);
    const btcData = (resBtc as any).data;
    expect(btcData.fills.length).toBe(2);
    expect(btcData.fills.every((f: any) => f.symbol === 'BTC')).toBe(true);

    // Side mapping: 'A' → 'sell', 'B' → 'buy'
    const closeFill = btcData.fills[0];
    expect(closeFill.side).toBe('sell');
    expect(closeFill.fill_price).toBe(70500);
    expect(closeFill.realized_pnl_usd).toBeCloseTo(10.25, 5);
    expect(closeFill.dir).toBe('Close Long');
  });

  it('get_fills live mode respects limit parameter', async () => {
    vi.spyOn(HyperliquidClient.prototype, 'getAccountAddress').mockReturnValue('0xdeadbeef');
    const fills = Array.from({ length: 50 }, (_, i) => ({
      coin: 'ETH',
      px: '3000',
      sz: '0.1',
      side: 'B',
      closedPnl: '0',
      fee: '0.01',
      time: Date.now() - i * 1000,
      oid: i,
      dir: 'Open Long',
    }));
    vi.spyOn(HyperliquidClient.prototype, 'getUserFillsByTime').mockResolvedValue(fills as any);

    const res = await executeToolCall(
      'get_fills',
      { mode: 'live', symbol: 'ETH', limit: 5 },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient }
    );
    expect(res.success).toBe(true);
    expect((res as any).data.fills.length).toBe(5);
  });

  it('get_positions live: tier-2 leverage from positionValue/marginUsed', async () => {
    vi.spyOn(HyperliquidClient.prototype, 'getClearinghouseState').mockResolvedValue({
      assetPositions: [{
        position: {
          coin: 'ZEC',
          szi: '0.5',
          entryPx: '226.85',
          positionValue: '115.0',
          marginUsed: '38.33',
          unrealizedPnl: '1.67',
          // no leverage field
        },
      }],
      marginSummary: { accountValue: '603', totalNtlPos: '115', totalMarginUsed: '38.33' },
      withdrawable: '387.68',
    } as any);

    const res = await executeToolCall('get_positions', { mode: 'live' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient });
    expect(res.success).toBe(true);
    const zec = ((res as any).data?.positions ?? []).find((p: any) => p.symbol === 'ZEC');
    expect(zec).toBeDefined();
    // 115.0 / 38.33 ≈ 3.0
    expect(zec.leverage).not.toBeNull();
    expect(Number(zec.leverage)).toBeCloseTo(3.0, 1);
  });

  it('get_positions live: tier-3 leverage derived from ROE when marginUsed absent', async () => {
    // returnOnEquity = unrealizedPnl / marginUsed → marginUsed = unrealizedPnl / ROE
    // unrealizedPnl=1.67, ROE=0.04355 → marginUsed≈38.35 → leverage≈115/38.35≈3.0
    vi.spyOn(HyperliquidClient.prototype, 'getClearinghouseState').mockResolvedValue({
      assetPositions: [{
        position: {
          coin: 'ZEC',
          szi: '0.5',
          entryPx: '226.85',
          positionValue: '115.0',
          unrealizedPnl: '1.67',
          returnOnEquity: '0.04355',
          // no leverage, no marginUsed
        },
      }],
      marginSummary: { accountValue: '603', totalNtlPos: '115', totalMarginUsed: '38.33' },
      withdrawable: '387.68',
    } as any);

    const res = await executeToolCall('get_positions', { mode: 'live' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient });
    expect(res.success).toBe(true);
    const zec = ((res as any).data?.positions ?? []).find((p: any) => p.symbol === 'ZEC');
    expect(zec).toBeDefined();
    expect(zec.leverage).not.toBeNull();
    expect(Number(zec.leverage)).toBeCloseTo(3.0, 0);
  });

  it('get_positions live: tier-4 leverage from perp journal when all API fields absent', async () => {
    vi.spyOn(HyperliquidClient.prototype, 'getClearinghouseState').mockResolvedValue({
      assetPositions: [{
        position: {
          coin: 'ZECJOURNAL',
          szi: '0.5',
          entryPx: '226.85',
          positionValue: '115.0',
          unrealizedPnl: '0',      // zero PnL → ROE fallback can't fire
          returnOnEquity: '0',     // no leverage field, no marginUsed
        },
      }],
      marginSummary: { accountValue: '603', totalNtlPos: '115', totalMarginUsed: '38.33' },
      withdrawable: '387.68',
    } as any);

    // Record a live trade for this symbol with leverage=3 in the journal
    const executor = {
      execute: async () => ({ executed: true, message: 'ok' }),
      getOpenOrders: async () => [],
      cancelOrder: async () => {},
    };
    const limiter = { checkAndReserve: async () => ({ allowed: true }), confirm: () => {}, release: () => {} };
    await executeToolCall('perp_place_order',
      { symbol: 'ZECJOURNAL', side: 'buy', size: 0.5, leverage: 3 },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient, executor, limiter });

    const res = await executeToolCall('get_positions', { mode: 'live' },
      { config: { execution: { provider: 'hyperliquid' } } as any, marketClient });
    expect(res.success).toBe(true);
    const zec = ((res as any).data?.positions ?? []).find((p: any) => p.symbol === 'ZECJOURNAL');
    expect(zec).toBeDefined();
    expect(zec.leverage).toBe(3);
  });
});
