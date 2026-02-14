import type { ThufirConfig } from '../core/config.js';
import type { LlmClient } from '../core/llm.js';
import { Logger } from '../core/logger.js';
import type { MarketClient } from '../execution/market-client.js';
import type { ExecutionAdapter, TradeDecision } from '../execution/executor.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import {
  getOpenTradeEnvelopeBySymbol,
  listOpenTradeEnvelopes,
  listRecentTradePriceSamples,
  markTradeClosed,
  recordTradePriceSample,
  recordTradeCloseRecord,
  recordTradeEnvelope,
  recordTradeReflection,
  setTradeClosePending,
  updateTradeEnvelopeRuntimeState,
} from './db.js';
import type { TradeCloseRecord, TradeEnvelope, TradeExitReason, TradeReflection } from './types.js';
import { cancelExchangeOrderOids } from './hyperliquid-stops.js';
import { recordAgentIncident } from '../memory/incidents.js';
import { createHyperliquidCloid } from '../execution/hyperliquid/cloid.js';

type PositionSnapshot = {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPx: number | null;
  positionValueUsd: number | null;
  liquidationPx: number | null;
  marginUsedUsd: number | null;
  fundingSinceOpenUsd: number | null;
};

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function computePnlPct(params: { side: 'buy' | 'sell'; entry: number; mid: number }): number {
  const { side, entry, mid } = params;
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(mid) || mid <= 0) return 0;
  return side === 'buy' ? ((mid - entry) / entry) * 100 : ((entry - mid) / entry) * 100;
}

function computePnlUsd(params: { side: 'buy' | 'sell'; entry: number; exit: number; size: number }): number {
  const { side, entry, exit, size } = params;
  const delta = side === 'buy' ? exit - entry : entry - exit;
  return delta * size;
}

function liquidationDistanceBps(params: { side: 'long' | 'short'; mid: number; liq: number }): number {
  const { side, mid, liq } = params;
  if (!Number.isFinite(mid) || mid <= 0 || !Number.isFinite(liq) || liq <= 0) return Infinity;
  const diff = side === 'long' ? mid - liq : liq - mid;
  return (diff / mid) * 10000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TradeMonitor {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private logger: Logger;
  private lastIncidentAt = new Map<string, number>();

  constructor(
    private params: {
      config: ThufirConfig;
      marketClient: MarketClient;
      executor: ExecutionAdapter;
      llm?: LlmClient;
      logger?: Logger;
    }
  ) {
    this.logger = params.logger ?? new Logger('info');
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.scheduleNext(1);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delaySeconds: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) => this.logger.error('Trade monitor tick failed', err))
        .finally(() => {
          const open = listOpenTradeEnvelopes().length;
          const base = this.params.config.tradeManagement?.monitorIntervalSeconds ?? 900;
          const active = this.params.config.tradeManagement?.activeMonitorIntervalSeconds ?? 60;
          const next = open > 0 ? active : base;
          this.scheduleNext(next);
        });
    }, Math.max(1, delaySeconds) * 1000);
  }

  async tick(): Promise<void> {
    const cfg = this.params.config;
    if (cfg.tradeManagement?.enabled !== true) return;

    if (cfg.execution?.mode === 'paper' || cfg.execution?.mode === 'webhook') {
      await this.tickSynthetic({ executeCloses: cfg.execution?.mode === 'webhook' });
      return;
    }
    if (cfg.execution?.mode !== 'live') return;
    if (cfg.execution?.provider !== 'hyperliquid') return;

    const client = new HyperliquidClient(cfg);
    const state = (await client.getClearinghouseState()) as {
      assetPositions?: Array<{ position?: Record<string, unknown> }>;
    };

    const mids = await client.getAllMids();

    const positions = (state.assetPositions ?? [])
      .map((p) => p?.position ?? {})
      .map((p): PositionSnapshot | null => {
        const szi = toFiniteNumber((p as any).szi);
        if (szi == null || szi === 0) return null;
        const symbol = String((p as any).coin ?? '');
        if (!symbol) return null;
        const entryPx = toFiniteNumber((p as any).entryPx);
        const positionValueUsd = toFiniteNumber((p as any).positionValue);
        const liquidationPx = toFiniteNumber((p as any).liquidationPx);
        const marginUsedUsd = toFiniteNumber((p as any).marginUsed);
        const fundingSinceOpenUsd = toFiniteNumber((p as any).cumFunding?.sinceOpen);
        return {
          symbol,
          side: szi > 0 ? 'long' : 'short',
          size: Math.abs(szi),
          entryPx,
          positionValueUsd,
          liquidationPx,
          marginUsedUsd,
          fundingSinceOpenUsd,
        };
      })
      .filter((p): p is NonNullable<typeof p> => Boolean(p));

    const positionsBySymbol = new Map<string, PositionSnapshot>();
    for (const pos of positions) {
      positionsBySymbol.set(normalizeSymbol(pos.symbol), pos);
    }

    for (const pos of positions) {
      const symbol = normalizeSymbol(pos.symbol);
      const mid = mids[symbol];
      if (typeof mid !== 'number' || !Number.isFinite(mid) || mid <= 0) {
        continue;
      }

      let env = getOpenTradeEnvelopeBySymbol(symbol);
      if (!env) {
        // Orphan position: create a default envelope so it is monitored.
        env = this.buildOrphanEnvelope(cfg, pos, mid);
        recordTradeEnvelope(env);
      }

      recordTradePriceSample({ tradeId: env.tradeId, symbol: env.symbol, midPrice: mid });

      // If a close is pending, avoid spamming close attempts on every tick.
      if (env.closePending && env.closePendingAt) {
        const retryMin = Number((cfg.tradeManagement as any)?.closeRetryMinSeconds ?? 30);
        const ageSec = (Date.now() - Date.parse(env.closePendingAt)) / 1000;
        if (Number.isFinite(ageSec) && ageSec >= 0 && ageSec < retryMin) {
          continue;
        }
      }

      // Update watermark + trailing arm state.
      const pnlPct = computePnlPct({ side: env.side, entry: env.entryPrice, mid });

      if (env.side === 'buy') {
        const nextHigh = env.highWaterPrice == null ? mid : Math.max(env.highWaterPrice, mid);
        const nextLow = env.lowWaterPrice == null ? mid : Math.min(env.lowWaterPrice, mid);
        const armed = env.trailingActivated || pnlPct >= env.trailingActivationPct;
        updateTradeEnvelopeRuntimeState({
          tradeId: env.tradeId,
          highWaterPrice: nextHigh,
          lowWaterPrice: nextLow,
          trailingActivated: armed,
          fundingSinceOpenUsd: pos.fundingSinceOpenUsd ?? null,
        });
        env.highWaterPrice = nextHigh;
        env.lowWaterPrice = nextLow;
        env.trailingActivated = armed;
      } else {
        const nextLow = env.lowWaterPrice == null ? mid : Math.min(env.lowWaterPrice, mid);
        const nextHigh = env.highWaterPrice == null ? mid : Math.max(env.highWaterPrice, mid);
        const armed = env.trailingActivated || pnlPct >= env.trailingActivationPct;
        updateTradeEnvelopeRuntimeState({
          tradeId: env.tradeId,
          highWaterPrice: nextHigh,
          lowWaterPrice: nextLow,
          trailingActivated: armed,
          fundingSinceOpenUsd: pos.fundingSinceOpenUsd ?? null,
        });
        env.lowWaterPrice = nextLow;
        env.highWaterPrice = nextHigh;
        env.trailingActivated = armed;
      }

      const exit = this.evaluateExit(cfg, env, pos, mid, pnlPct);
      if (!exit) continue;

      setTradeClosePending({ tradeId: env.tradeId, pending: true, reason: exit });

      await this.closePositionAndRecord({
        env,
        pos,
        mid,
        exitReason: exit,
      });
    }

    // Reconcile envelopes that are open in DB but no longer open on the venue (e.g., exchange-side TP/SL filled).
    const openEnvelopes = listOpenTradeEnvelopes();
    for (const env of openEnvelopes) {
      const symbol = normalizeSymbol(env.symbol);
      if (positionsBySymbol.has(symbol)) continue;
      const mid = mids[symbol];
      if (typeof mid !== 'number' || !Number.isFinite(mid) || mid <= 0) {
        continue;
      }
      await this.reconcileClosedEnvelope({ env, mid });
    }
  }

  private async tickSynthetic(params: { executeCloses: boolean }): Promise<void> {
    const open = listOpenTradeEnvelopes();
    if (open.length === 0) return;

    for (const env of open) {
      const market = await this.params.marketClient.getMarket(env.symbol);
      const mid = market.markPrice ?? null;
      if (mid == null || !Number.isFinite(mid) || mid <= 0) continue;

      recordTradePriceSample({ tradeId: env.tradeId, symbol: env.symbol, midPrice: mid });

      if (env.closePending && env.closePendingAt) {
        const retryMin = Number((this.params.config.tradeManagement as any)?.closeRetryMinSeconds ?? 30);
        const ageSec = (Date.now() - Date.parse(env.closePendingAt)) / 1000;
        if (Number.isFinite(ageSec) && ageSec >= 0 && ageSec < retryMin) {
          continue;
        }
      }

      const pnlPct = computePnlPct({ side: env.side, entry: env.entryPrice, mid });

      // Update runtime state for trailing + watermarks based on sampled mid.
      if (env.side === 'buy') {
        const nextHigh = env.highWaterPrice == null ? mid : Math.max(env.highWaterPrice, mid);
        const nextLow = env.lowWaterPrice == null ? mid : Math.min(env.lowWaterPrice, mid);
        const armed = env.trailingActivated || pnlPct >= env.trailingActivationPct;
        updateTradeEnvelopeRuntimeState({
          tradeId: env.tradeId,
          highWaterPrice: nextHigh,
          lowWaterPrice: nextLow,
          trailingActivated: armed,
        });
        env.highWaterPrice = nextHigh;
        env.lowWaterPrice = nextLow;
        env.trailingActivated = armed;
      } else {
        const nextLow = env.lowWaterPrice == null ? mid : Math.min(env.lowWaterPrice, mid);
        const nextHigh = env.highWaterPrice == null ? mid : Math.max(env.highWaterPrice, mid);
        const armed = env.trailingActivated || pnlPct >= env.trailingActivationPct;
        updateTradeEnvelopeRuntimeState({
          tradeId: env.tradeId,
          highWaterPrice: nextHigh,
          lowWaterPrice: nextLow,
          trailingActivated: armed,
        });
        env.lowWaterPrice = nextLow;
        env.highWaterPrice = nextHigh;
        env.trailingActivated = armed;
      }

      // No liquidation guard in paper mode.
      const exit = this.evaluateExit(
        this.params.config,
        env,
        {
          symbol: env.symbol,
          side: env.side === 'buy' ? 'long' : 'short',
          size: env.size,
          entryPx: env.entryPrice,
          positionValueUsd: null,
          liquidationPx: null,
          marginUsedUsd: env.marginUsd ?? null,
          fundingSinceOpenUsd: null,
        },
        mid,
        pnlPct
      );
      if (!exit) continue;
      setTradeClosePending({ tradeId: env.tradeId, pending: true, reason: exit });

      if (params.executeCloses) {
        const closeSide: 'buy' | 'sell' = env.side === 'buy' ? 'sell' : 'buy';
        try {
          await this.params.executor.execute(market, {
            action: closeSide,
            side: closeSide,
            symbol: env.symbol,
            size: env.size,
            orderType: 'market',
            reduceOnly: true,
            clientOrderId: createHyperliquidCloid(),
            reasoning: `trade_management_synthetic_close(${exit})`,
          });
        } catch (err) {
          this.logger.warn('Synthetic close order failed (will retry next tick)', {
            tradeId: env.tradeId,
            symbol: env.symbol,
            exitReason: exit,
            err,
          });
          continue;
        }
      }

      const closedAt = nowIso();
      const holdSeconds = Math.max(0, Math.round((Date.parse(closedAt) - Date.parse(env.enteredAt)) / 1000));
      const pnlUsd = computePnlUsd({ side: env.side, entry: env.entryPrice, exit: mid, size: env.size });

      recordTradeCloseRecord({
        tradeId: env.tradeId,
        symbol: env.symbol,
        exitPrice: mid,
        exitReason: exit,
        pnlUsd,
        pnlPct,
        holdDurationSeconds: holdSeconds,
        fundingPaidUsd: 0,
        feesUsd: 0,
        closedAt,
      });
      markTradeClosed(env.tradeId);
      setTradeClosePending({ tradeId: env.tradeId, pending: false });
    }
  }

  private evaluateExit(
    cfg: ThufirConfig,
    env: TradeEnvelope,
    pos: PositionSnapshot,
    mid: number,
    pnlPct: number
  ): TradeExitReason | null {
    const liqGuardBps = cfg.tradeManagement?.liquidationGuardDistanceBps ?? 800;
    if (pos.liquidationPx != null) {
      const dist = liquidationDistanceBps({ side: pos.side, mid, liq: pos.liquidationPx });
      if (dist <= liqGuardBps) return 'liquidation_guard';
    }

    if (pnlPct <= -Math.abs(env.stopLossPct)) return 'stop_loss';

    if (env.trailingStopPct != null && env.trailingStopPct > 0 && env.trailingActivated) {
      const trail = env.trailingStopPct / 100;
      if (env.side === 'buy') {
        const high = env.highWaterPrice ?? env.entryPrice;
        if (mid <= high * (1 - trail)) return 'trailing_stop';
      } else {
        const low = env.lowWaterPrice ?? env.entryPrice;
        if (mid >= low * (1 + trail)) return 'trailing_stop';
      }
    }

    if (pnlPct >= Math.abs(env.takeProfitPct)) return 'take_profit';

    const now = Date.now();
    const expires = Date.parse(env.expiresAt);
    if (Number.isFinite(expires) && now > expires) return 'time_stop';

    return null;
  }

  private async closePositionAndRecord(params: {
    env: TradeEnvelope;
    pos: PositionSnapshot;
    mid: number;
    exitReason: TradeExitReason;
  }): Promise<void> {
    const { env, pos, mid, exitReason } = params;

      // Cancel any bracket TP/SL triggers before manual closes (prevents stale triggers).
      if (exitReason !== 'take_profit' && exitReason !== 'stop_loss') {
      const oids = [env.tpOid, env.slOid].filter((v): v is string => Boolean(v));
      if (oids.length) {
        try {
          await cancelExchangeOrderOids({
            config: this.params.config,
            symbol: env.symbol,
            oids,
          });
        } catch (err) {
          this.logger.warn('Failed to cancel TP/SL orders (continuing)', { tradeId: env.tradeId, err });
        }
      }
    }

      const closeSide: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy';

      const closeTimeout = this.params.config.tradeManagement?.closeExecution?.closeTimeoutSeconds ?? 5;
      const slippageMult = this.params.config.tradeManagement?.closeExecution?.closeSlippageMultiplier ?? 2.0;
      const baseSlippage = this.params.config.hyperliquid?.defaultSlippageBps ?? 10;

      const market = await this.params.marketClient.getMarket(env.symbol);
      const size = pos.size;
      const closeStartMs = Date.now();
      const closeCloids: string[] = [];

    const attempt = async (slippageBps: number): Promise<void> => {
      const cloid = createHyperliquidCloid();
      closeCloids.push(cloid);
      const decision: TradeDecision = {
        action: closeSide,
        side: closeSide,
        symbol: env.symbol,
        size,
        orderType: 'market',
        reduceOnly: true,
        // Not part of the official interface, but used by HyperliquidLiveExecutor if present.
        ...(slippageBps ? ({ slippageBps } as any) : {}),
        clientOrderId: cloid,
        reasoning: `trade_management_close(${exitReason})`,
      };
      await this.params.executor.execute(market, decision);
    };

    // Close with base slippage, then retry once with expanded slippage if still open.
    await attempt(baseSlippage);
    await sleep(Math.max(1, closeTimeout) * 1000);
    let stillOpen = await this.isSymbolPositionOpen(env.symbol);
    if (stillOpen) {
      await attempt(Math.round(baseSlippage * Math.max(1, slippageMult)));
      await sleep(Math.max(1, closeTimeout) * 1000);
      stillOpen = await this.isSymbolPositionOpen(env.symbol);
    }

    if (stillOpen) {
      const key = `${env.tradeId}:${exitReason}`;
      const last = this.lastIncidentAt.get(key) ?? 0;
      // Dust handling: if remaining position notional is tiny, stop retrying and close the envelope.
      const dustMaxNotional =
        this.params.config.tradeManagement?.dustMaxRemainingNotionalUsd ?? 0.5;
      const snapshot = await this.fetchPositionSnapshot(env.symbol).catch(() => null);
      const remainingNotional =
        snapshot?.positionValueUsd != null ? Math.abs(snapshot.positionValueUsd) : null;
      const remainingSize = snapshot?.size ?? null;
      if (
        remainingNotional != null &&
        Number.isFinite(remainingNotional) &&
        remainingNotional > 0 &&
        remainingNotional <= dustMaxNotional
      ) {
        // Cancel brackets (best-effort) and close envelope with dust reason.
        const oids = [env.tpOid, env.slOid].filter((v): v is string => Boolean(v));
        if (oids.length) {
          await cancelExchangeOrderOids({ config: this.params.config, symbol: env.symbol, oids }).catch(
            () => {}
          );
        }
        const closedAt = nowIso();
        const holdSeconds = Math.max(
          0,
          Math.round((Date.parse(closedAt) - Date.parse(env.enteredAt)) / 1000)
        );
        const pnlPct = computePnlPct({ side: env.side, entry: env.entryPrice, mid });
        const pnlUsd = computePnlUsd({ side: env.side, entry: env.entryPrice, exit: mid, size: env.size });
        recordTradeCloseRecord({
          tradeId: env.tradeId,
          symbol: env.symbol,
          exitPrice: mid,
          exitReason: 'dust',
          pnlUsd,
          pnlPct,
          holdDurationSeconds: holdSeconds,
          fundingPaidUsd: pos.fundingSinceOpenUsd ?? 0,
          feesUsd: 0,
          closedAt,
        });
        markTradeClosed(env.tradeId);
        setTradeClosePending({ tradeId: env.tradeId, pending: false });
        this.logger.warn('Closed envelope as dust (residual position below threshold)', {
          tradeId: env.tradeId,
          symbol: env.symbol,
          remainingNotional,
          remainingSize,
        });
        return;
      }

      if (Date.now() - last > 10 * 60_000) {
        this.lastIncidentAt.set(key, Date.now());
        recordAgentIncident({
          goal: 'trade_management_close',
          mode: 'trade_management',
          toolName: 'perp_place_order',
          error: `Close failed after retry (position still open): ${env.symbol} reason=${exitReason}`,
          blockerKind: 'network_or_rate_limit',
          details: { tradeId: env.tradeId, symbol: env.symbol, exitReason, closeCloids, remainingNotional, remainingSize },
        });
      }
      this.logger.warn('Close failed after retry; leaving position open for next tick', {
        tradeId: env.tradeId,
        symbol: env.symbol,
        exitReason,
      });
      return;
    }

    const closedAt = nowIso();
    const holdSeconds = Math.max(
      0,
      Math.round((Date.parse(closedAt) - Date.parse(env.enteredAt)) / 1000)
    );
    let exitPrice = mid;
    let feesUsd = 0;
    let pnlUsd: number | null = null;

    // Best-effort: reconcile actual fill px/fees/closedPnl via user fills using the close cloid(s).
    try {
      const client = new HyperliquidClient(this.params.config);
      const fills = await client.getUserFillsByTime({
        startTimeMs: closeStartMs - 30_000,
        endTimeMs: Date.now() + 5_000,
        aggregateByTime: true,
      });
      const matches = Array.isArray(fills)
        ? fills
            .filter((f: any) => normalizeSymbol(String(f.coin ?? '')) === normalizeSymbol(env.symbol))
            .filter((f: any) => {
              const cl = typeof f.cloid === 'string' ? f.cloid : '';
              return cl && closeCloids.includes(cl);
            })
        : [];

      const totalSz = matches.reduce((sum: number, f: any) => sum + Number(f.sz ?? 0), 0);
      if (totalSz > 0) {
        const pxSz = matches.reduce(
          (sum: number, f: any) => sum + Number(f.px ?? 0) * Number(f.sz ?? 0),
          0
        );
        const avgPx = pxSz / totalSz;
        if (Number.isFinite(avgPx) && avgPx > 0) exitPrice = avgPx;
        feesUsd = matches.reduce((sum: number, f: any) => sum + Number(f.fee ?? 0), 0);
        const closedPnl = matches.reduce((sum: number, f: any) => sum + Number(f.closedPnl ?? 0), 0);
        if (Number.isFinite(closedPnl)) pnlUsd = closedPnl;
      }
    } catch {
      // ignore reconciliation failures
    }

    const pnlPct = computePnlPct({ side: env.side, entry: env.entryPrice, mid: exitPrice });
    const fallbackPnlUsd = computePnlUsd({
      side: env.side,
      entry: env.entryPrice,
      exit: exitPrice,
      size: env.size,
    });

    const close: TradeCloseRecord = {
      tradeId: env.tradeId,
      symbol: env.symbol,
      exitPrice,
      exitReason,
      pnlUsd: pnlUsd ?? fallbackPnlUsd,
      pnlPct,
      holdDurationSeconds: holdSeconds,
      fundingPaidUsd: pos.fundingSinceOpenUsd ?? 0,
      feesUsd,
      closedAt,
    };
    recordTradeCloseRecord(close);
    markTradeClosed(env.tradeId);
    setTradeClosePending({ tradeId: env.tradeId, pending: false });

    // Reflection is best-effort and should never block monitoring.
    if (this.params.llm) {
      this.generateAndStoreReflection(env, close).catch((err) =>
        this.logger.warn('Trade reflection failed', { tradeId: env.tradeId, err })
      );
    }
  }

  private async isSymbolPositionOpen(symbol: string): Promise<boolean> {
    if (this.params.config.execution?.mode !== 'live') return false;
    if (this.params.config.execution?.provider !== 'hyperliquid') return false;
    try {
      const client = new HyperliquidClient(this.params.config);
      const state = (await client.getClearinghouseState()) as {
        assetPositions?: Array<{ position?: Record<string, unknown> }>;
      };
      const norm = normalizeSymbol(symbol);
      for (const entry of state.assetPositions ?? []) {
        const p = entry?.position ?? {};
        const coin = normalizeSymbol(String((p as any).coin ?? ''));
        if (coin !== norm) continue;
        const szi = toFiniteNumber((p as any).szi);
        if (szi != null && szi !== 0) return true;
      }
    } catch {
      // If we cannot verify, assume still open so the next tick retries.
      return true;
    }
    return false;
  }

  private async fetchPositionSnapshot(symbol: string): Promise<PositionSnapshot | null> {
    if (this.params.config.execution?.mode !== 'live') return null;
    if (this.params.config.execution?.provider !== 'hyperliquid') return null;
    const client = new HyperliquidClient(this.params.config);
    const state = (await client.getClearinghouseState()) as {
      assetPositions?: Array<{ position?: Record<string, unknown> }>;
    };
    const norm = normalizeSymbol(symbol);
    for (const entry of state.assetPositions ?? []) {
      const p = entry?.position ?? {};
      const coin = normalizeSymbol(String((p as any).coin ?? ''));
      if (coin !== norm) continue;
      const szi = toFiniteNumber((p as any).szi);
      if (szi == null || szi === 0) return null;
      return {
        symbol: coin,
        side: szi > 0 ? 'long' : 'short',
        size: Math.abs(szi),
        entryPx: toFiniteNumber((p as any).entryPx),
        positionValueUsd: toFiniteNumber((p as any).positionValue),
        liquidationPx: toFiniteNumber((p as any).liquidationPx),
        marginUsedUsd: toFiniteNumber((p as any).marginUsed),
        fundingSinceOpenUsd: toFiniteNumber((p as any).cumFunding?.sinceOpen),
      };
    }
    return null;
  }

  private buildOrphanEnvelope(cfg: ThufirConfig, pos: PositionSnapshot, mid: number): TradeEnvelope {
    const tm = cfg.tradeManagement ?? ({} as any);
    const d = tm.defaults ?? {};
    const stopLossPct = Number(d.stopLossPct ?? 3.0);
    const takeProfitPct = Number(d.takeProfitPct ?? 5.0);
    const maxHoldSeconds = Math.round(Number(d.maxHoldHours ?? 72) * 3600);
    const trailingStopPct = Number(d.trailingStopPct ?? 2.0);
    const trailingActivationPct = Number(d.trailingActivationPct ?? 1.0);
    const side: TradeEnvelope['side'] = pos.side === 'long' ? 'buy' : 'sell';
    const entryPrice = pos.entryPx ?? mid;
    const tradeId = `orphan_${normalizeSymbol(pos.symbol)}_${Date.now()}`;
    const enteredAt = nowIso();
    const expiresAt = new Date(Date.now() + maxHoldSeconds * 1000).toISOString();
    return {
      tradeId,
      hypothesisId: null,
      symbol: normalizeSymbol(pos.symbol),
      side,
      entryPrice,
      size: pos.size,
      leverage: null,
      notionalUsd: null,
      marginUsd: pos.marginUsedUsd ?? null,
      stopLossPct,
      takeProfitPct,
      maxHoldSeconds,
      trailingStopPct: trailingStopPct || null,
      trailingActivationPct,
      maxLossUsd: null,
      proposed: null,
      thesis: 'Orphan position (no recorded envelope). Applying defaults.',
      signalKinds: [],
      invalidation: null,
      catalystId: null,
      narrativeSnapshot: null,
      highWaterPrice: side === 'buy' ? entryPrice : null,
      lowWaterPrice: side === 'sell' ? entryPrice : null,
      trailingActivated: false,
      fundingSinceOpenUsd: pos.fundingSinceOpenUsd ?? null,
      closePending: false,
      closePendingReason: null,
      closePendingAt: null,
      entryCloid: null,
      entryFeesUsd: null,
      enteredAt,
      expiresAt,
      tpOid: null,
      slOid: null,
      status: 'open',
    };
  }

  private async reconcileClosedEnvelope(params: { env: TradeEnvelope; mid: number }): Promise<void> {
    const { env, mid } = params;
    const cfg = this.params.config;
    if (cfg.execution?.mode !== 'live' || cfg.execution?.provider !== 'hyperliquid') return;

    // If we can't observe the position but do have a bracket, attempt to determine which order filled.
    const client = new HyperliquidClient(cfg);

    const tpOidNum = env.tpOid ? Number(env.tpOid) : NaN;
    const slOidNum = env.slOid ? Number(env.slOid) : NaN;

    const tpFilled = Number.isFinite(tpOidNum) ? await this.isOrderFilled(client, tpOidNum) : false;
    const slFilled = Number.isFinite(slOidNum) ? await this.isOrderFilled(client, slOidNum) : false;

    let exitReason: TradeExitReason = 'manual';
    let filledOid: number | null = null;
    if (tpFilled && !slFilled) {
      exitReason = 'take_profit';
      filledOid = tpOidNum;
      // Best-effort OCO: cancel sibling.
      if (env.slOid) {
        await cancelExchangeOrderOids({ config: cfg, symbol: env.symbol, oids: [env.slOid] }).catch(
          () => {}
        );
      }
    } else if (slFilled && !tpFilled) {
      exitReason = 'stop_loss';
      filledOid = slOidNum;
      if (env.tpOid) {
        await cancelExchangeOrderOids({ config: cfg, symbol: env.symbol, oids: [env.tpOid] }).catch(
          () => {}
        );
      }
    } else if (tpFilled && slFilled) {
      // Should not happen, but prefer stop-loss as the more safety-critical reason.
      exitReason = 'stop_loss';
      filledOid = slOidNum;
    }

    const entered = Date.parse(env.enteredAt);
    const fills = await client
      .getUserFillsByTime({
        startTimeMs: Number.isFinite(entered) ? entered - 60_000 : Date.now() - 6 * 60 * 60_000,
        endTimeMs: Date.now() + 5_000,
        aggregateByTime: true,
      })
      .catch(() => []);
    const matching = Array.isArray(fills)
      ? fills
          .filter((f: any) => normalizeSymbol(String(f.coin ?? '')) === normalizeSymbol(env.symbol))
          .filter((f: any) => (filledOid != null ? Number(f.oid) === filledOid : true))
          .filter((f: any) => {
            const t = Number(f.time);
            if (!Number.isFinite(t) || t <= 0) return true;
            return !Number.isFinite(entered) || t >= entered - 60_000;
          })
      : [];

    let exitPrice = mid;
    let feesUsd = 0;
    let pnlUsd: number | null = null;

    const totalSz = matching.reduce((sum: number, f: any) => sum + Number(f.sz ?? 0), 0);
    if (totalSz > 0) {
      const pxSz = matching.reduce((sum: number, f: any) => sum + Number(f.px ?? 0) * Number(f.sz ?? 0), 0);
      const avgPx = pxSz / totalSz;
      if (Number.isFinite(avgPx) && avgPx > 0) exitPrice = avgPx;
      feesUsd = matching.reduce((sum: number, f: any) => sum + Number(f.fee ?? 0), 0);
      const closedPnl = matching.reduce((sum: number, f: any) => sum + Number(f.closedPnl ?? 0), 0);
      if (Number.isFinite(closedPnl)) pnlUsd = closedPnl;
    }

    const closedAt = nowIso();
    const holdSeconds = Math.max(
      0,
      Math.round((Date.parse(closedAt) - Date.parse(env.enteredAt)) / 1000)
    );

    const pnlPct = computePnlPct({ side: env.side, entry: env.entryPrice, mid: exitPrice });
    const fallbackPnlUsd = computePnlUsd({ side: env.side, entry: env.entryPrice, exit: exitPrice, size: env.size });

    const close: TradeCloseRecord = {
      tradeId: env.tradeId,
      symbol: env.symbol,
      exitPrice,
      exitReason,
      pnlUsd: pnlUsd ?? fallbackPnlUsd,
      pnlPct,
      holdDurationSeconds: holdSeconds,
      fundingPaidUsd: env.fundingSinceOpenUsd ?? 0,
      feesUsd,
      closedAt,
    };
    recordTradeCloseRecord(close);
    markTradeClosed(env.tradeId);
    setTradeClosePending({ tradeId: env.tradeId, pending: false });

    if (this.params.llm) {
      this.generateAndStoreReflection(env, close).catch(() => {});
    }
  }

  private async isOrderFilled(client: HyperliquidClient, oid: number): Promise<boolean> {
    try {
      const status = await client.getOrderStatus({ oid });
      if (!status || typeof status !== 'object') return false;
      if ((status as any).status !== 'order') return false;
      const st = String((status as any).order?.status ?? '');
      return st === 'filled';
    } catch {
      return false;
    }
  }

  private async generateAndStoreReflection(env: TradeEnvelope, close: TradeCloseRecord): Promise<void> {
    const llm = this.params.llm;
    if (!llm) return;

    const maxChars = 120;
    const samples = listRecentTradePriceSamples({ tradeId: env.tradeId, limit: 12 }).reverse();
    const high = env.highWaterPrice ?? env.entryPrice;
    const low = env.lowWaterPrice ?? env.entryPrice;
    const mfePct =
      env.side === 'buy' ? ((high - env.entryPrice) / env.entryPrice) * 100 : ((env.entryPrice - low) / env.entryPrice) * 100;
    const maePct =
      env.side === 'buy' ? ((low - env.entryPrice) / env.entryPrice) * 100 : ((env.entryPrice - high) / env.entryPrice) * 100;

    const facts = {
      tradeId: env.tradeId,
      symbol: env.symbol,
      side: env.side,
      entryPrice: env.entryPrice,
      exitPrice: close.exitPrice,
      pnlUsd: close.pnlUsd,
      pnlPct: close.pnlPct,
      exitReason: close.exitReason,
      enteredAt: env.enteredAt,
      closedAt: close.closedAt,
      maxHoldSeconds: env.maxHoldSeconds,
      stopLossPct: env.stopLossPct,
      takeProfitPct: env.takeProfitPct,
      trailingStopPct: env.trailingStopPct,
      trailingActivationPct: env.trailingActivationPct,
      highWaterPrice: env.highWaterPrice,
      lowWaterPrice: env.lowWaterPrice,
      mfePct: Number.isFinite(mfePct) ? Number(mfePct.toFixed(2)) : 0,
      maePct: Number.isFinite(maePct) ? Number(maePct.toFixed(2)) : 0,
      pricePathSamples: samples,
      signalKinds: env.signalKinds,
      thesis: env.thesis,
      invalidation: env.invalidation,
      proposed: env.proposed,
    };

    const messages = [
      {
        role: 'system' as const,
        content:
          'You are a trading journal reviewer. Output ONLY valid JSON matching the schema. ' +
          `Each of whatWorked/whatFailed/lessonForNextTrade must be <= ${maxChars} chars and must cite a fact from the provided records.`,
      },
      {
        role: 'user' as const,
        content:
          `Trade records (facts):\n${JSON.stringify(facts, null, 2)}\n\n` +
          'Return JSON:\n' +
          '{\n' +
          '  "tradeId": string,\n' +
          '  "thesisCorrect": boolean,\n' +
          '  "timingCorrect": boolean,\n' +
          '  "exitReasonAppropriate": boolean,\n' +
          '  "whatWorked": string,\n' +
          '  "whatFailed": string,\n' +
          '  "lessonForNextTrade": string\n' +
          '}\n',
      },
    ];

    const res = await llm.complete(messages, { temperature: 0.2, maxTokens: 400 });
    const parsed = safeJson(res.content);
    if (!parsed || typeof parsed !== 'object') return;

    const reflection: TradeReflection = {
      tradeId: String((parsed as any).tradeId ?? env.tradeId),
      thesisCorrect: Boolean((parsed as any).thesisCorrect),
      timingCorrect: Boolean((parsed as any).timingCorrect),
      exitReasonAppropriate: Boolean((parsed as any).exitReasonAppropriate),
      whatWorked: String((parsed as any).whatWorked ?? '').slice(0, maxChars),
      whatFailed: String((parsed as any).whatFailed ?? '').slice(0, maxChars),
      lessonForNextTrade: String((parsed as any).lessonForNextTrade ?? '').slice(0, maxChars),
    };
    if (!reflection.tradeId) return;
    recordTradeReflection(reflection);
  }
}

function safeJson(text: string): unknown | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  const slice = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}
