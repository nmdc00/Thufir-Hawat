import type { ThufirConfig } from './config.js';
import type { Logger } from './logger.js';
import type { ToolExecutorContext, ToolResult } from './tool-executor.js';
import { executeToolCall } from './tool-executor.js';
import { gatherMarketContext } from '../markets/context.js';

import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import {
  evaluateHeartbeatTriggers,
  type HeartbeatPoint,
  type HeartbeatTriggerConfig,
  type HeartbeatTriggerName,
} from './heartbeat_triggers.js';
import { recordPositionHeartbeatDecision } from '../memory/position_heartbeat_journal.js';
import { placePaperPerpOrder } from '../memory/paper_perps.js';
import {
  clearPositionExitPolicy,
  getPositionExitPolicy,
  upsertPositionExitPolicy,
} from '../memory/position_exit_policy.js';
import type { LlmExitConsultant } from './llm_exit_consultant.js';
import { PositionBook, type BookEntry } from './position_book.js';
import {
  buildLegacyExitContract,
  evaluateExitContract,
  parseExitContract,
  serializeExitContract,
} from './exit_contract.js';
import {
  evaluateDynamicProfitProtection,
  type DynamicProfitProtectionConfig,
} from './dynamic_profit_protection.js';

type ToolExecutorFn = (
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: ToolExecutorContext
) => Promise<ToolResult>;

type PositionSnapshot = {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  positionValue: number | null;
  unrealizedPnl: number | null;
  roePct: number | null;
  liquidationPrice: number | null;
};

function summarizeMarketContext(snapshot: Awaited<ReturnType<typeof gatherMarketContext>>): string {
  const successful = snapshot.results.filter((item) => item.success);
  if (successful.length === 0) {
    return '';
  }
  return successful
    .map((item) => {
      const payload = typeof item.data === 'string' ? item.data : JSON.stringify(item.data);
      return `### ${item.label}\n${payload}`;
    })
    .join('\n\n')
    .slice(0, 4000);
}

export class PositionHeartbeatService {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  private bufferBySymbol = new Map<string, HeartbeatPoint[]>();
  private triggerStateBySymbol = new Map<string, Map<HeartbeatTriggerName, number>>();

  private client: HyperliquidClient;
  private toolExec: ToolExecutorFn;
  private notify?: (message: string) => Promise<void>;
  private exitConsultant?: LlmExitConsultant;
  private getBookEntry: (symbol: string) => BookEntry | undefined;

  constructor(
    private config: ThufirConfig,
    private toolContext: ToolExecutorContext,
    private logger: Logger,
    options?: {
      client?: HyperliquidClient;
      toolExec?: ToolExecutorFn;
      notify?: (message: string) => Promise<void>;
      exitConsultant?: LlmExitConsultant;
      /** Override for testing — defaults to PositionBook.getInstance().get */
      getBookEntry?: (symbol: string) => BookEntry | undefined;
    }
  ) {
    this.client = options?.client ?? new HyperliquidClient(config);
    this.toolExec = options?.toolExec ?? executeToolCall;
    this.notify = options?.notify;
    this.exitConsultant = options?.exitConsultant;
    this.getBookEntry = options?.getBookEntry ?? ((sym) => PositionBook.getInstance().get(sym));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.logger.info('PositionHeartbeat: started');
    this.scheduleNext(1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('PositionHeartbeat: stopped');
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const bounded = Math.max(250, Math.min(delayMs, 10 * 60 * 1000));
    this.timer = setTimeout(() => {
      // Clear before running so tickOnce can schedule the next interval cleanly.
      this.timer = null;
      this.tickOnce().catch((err) => this.logger.error('PositionHeartbeat: tick failed', err));
    }, bounded);
  }

  async tickOnce(): Promise<void> {
    if (this.stopped) return;

    await PositionBook.getInstance().refresh();

    const hb = this.config.heartbeat;
    if (!hb?.enabled) return;
    const executionMode = this.config.execution?.mode ?? 'paper';
    if (executionMode !== 'live' && executionMode !== 'paper') return;
    if ((this.config.execution?.provider ?? 'hyperliquid') !== 'hyperliquid') return;

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const posResult = await this.toolExec('get_positions', {}, this.toolContext);
    if (!posResult.success) {
      this.recordInfo('*', nowIso, [], `get_positions: ${posResult.error}`);
      this.scheduleNext(this.computeIdleIntervalMs());
      return;
    }

    const positions = this.parsePositions(posResult.data);
    if (positions.length === 0) {
      this.scheduleNext(this.computeIdleIntervalMs());
      return;
    }

    let mids: Record<string, number> = {};
    try {
      mids = await retryWithBackoff(() => this.client.getAllMids(), 3);
    } catch (err) {
      const allPositionsHaveFallbackMid = positions.every((pos) => resolveFallbackMidFromPosition(pos) != null);
      if (!allPositionsHaveFallbackMid) {
        this.logger.warn(`PositionHeartbeat: failed to load mids: ${stringifyError(err)}`);
      }
    }

    const cfg = normalizeTriggerConfig(this.config);
    for (const pos of positions) {
      const mid = resolveMid(mids, pos.symbol) ?? resolveFallbackMidFromPosition(pos);
      const liqDistPct = computeLiqDistancePct({
        side: pos.side,
        mid,
        liquidationPrice: pos.liquidationPrice,
      });

      const point: HeartbeatPoint = { ts: nowMs, mid, roePct: pos.roePct, liqDistPct };
      const buffer = this.bufferBySymbol.get(pos.symbol) ?? [];
      buffer.push(point);
      const max = Math.max(5, Number(hb.rollingBufferSize ?? 60) || 60);
      if (buffer.length > max) buffer.splice(0, buffer.length - max);
      this.bufferBySymbol.set(pos.symbol, buffer);

      // Per-position exit policy (written by scanner/LLM at entry time).
      const policy = (() => {
        try { return getPositionExitPolicy(pos.symbol); } catch { return null; }
      })();
      const exitContract = parseExitContract(policy?.notes ?? null);

      // Thesis time stop: TTL has elapsed — consult the exit consultant rather than
      // closing unconditionally.  The TTL is a review prompt, not a thesis invalidation.
      // Only the invalidationPrice (below) or an explicit LLM "close" decision should
      // cause an unconditional close.  If the LLM is unavailable, extend and hold.
      if (policy?.timeStopAtMs != null && nowMs >= policy.timeStopAtMs) {
        const bookEntry = this.getBookEntry(pos.symbol);
        const roe = (pos.roePct ?? 0) / 100;
        let handled = false;
        if (this.exitConsultant && this.config.heartbeat?.llmExitConsult?.enabled !== false && bookEntry) {
          try {
            const freshContextSnapshot = await gatherMarketContext(
              { message: `${pos.symbol} perpetual market context`, signalSymbols: [pos.symbol], marketLimit: 20 },
              (toolName, toolInput) => this.toolExec(toolName, toolInput, this.toolContext)
            );
            const freshContext = summarizeMarketContext(freshContextSnapshot);
            const decision = await this.exitConsultant.consult(bookEntry, mid ?? 0, roe, freshContext);
            bookEntry.lastConsultAtMs = nowMs;
            bookEntry.lastConsultDecision = JSON.stringify({ ...decision, roeAtConsult: roe, trigger: 'ttl_expired' });

            if (decision.action === 'reduce' && decision.reduceToFraction != null) {
              await this.executeContractReduce(
                pos,
                decision.reduceToFraction,
                `ttl_review (${decision.reasoning})`,
                liqDistPct,
                nowIso
              );
              upsertPositionExitPolicy(
                pos.symbol,
                pos.side,
                resolveExtendedTtl(nowMs + 4 * 60 * 60 * 1000, nowMs),
                policy.invalidationPrice ?? null,
                policy.notes ?? null
              );
            } else if (decision.action === 'extend_ttl' && decision.newTimeStopAtMs != null) {
              upsertPositionExitPolicy(
                pos.symbol,
                pos.side,
                resolveExtendedTtl(decision.newTimeStopAtMs, nowMs),
                policy.invalidationPrice ?? null,
                policy.notes ?? null
              );
            } else if (decision.action === 'update_invalidation' && decision.newInvalidationPrice != null) {
              upsertPositionExitPolicy(
                pos.symbol,
                pos.side,
                resolveExtendedTtl(nowMs + 4 * 60 * 60 * 1000, nowMs),
                decision.newInvalidationPrice,
                buildUpdatedExitPolicyNotes(bookEntry, pos.side, decision.newInvalidationPrice)
              );
            } else {
              upsertPositionExitPolicy(
                pos.symbol,
                pos.side,
                resolveExtendedTtl(nowMs + 4 * 60 * 60 * 1000, nowMs),
                policy.invalidationPrice ?? null,
                policy.notes ?? null
              );
            }
            handled = true;
          } catch (err) {
            this.logger.warn(`PositionHeartbeat: TTL fired for ${pos.symbol} but exit consultant failed — extending TTL 4 h`, err);
          }
        }
        if (!handled) {
          // No consultant or LLM unavailable — extend TTL rather than closing.
          try {
            upsertPositionExitPolicy(
              pos.symbol,
              pos.side,
              resolveExtendedTtl(nowMs + 4 * 60 * 60 * 1000, nowMs),
              policy.invalidationPrice ?? null,
              policy.notes ?? null
            );
          } catch { /* best-effort */ }
          this.logger.info(
            `PositionHeartbeat: TTL expired for ${pos.symbol} — no consultant available, extended TTL`
          );
        }
        continue;
      }

      // Thesis invalidation: mark crossed the level that invalidates the thesis.
      if (policy?.invalidationPrice != null && mid != null) {
        const invalidated =
          pos.side === 'long' ? mid <= policy.invalidationPrice : mid >= policy.invalidationPrice;
        if (invalidated) {
          const invStr = `$${policy.invalidationPrice.toFixed(2)}`;
          const midStr = `$${mid.toFixed(2)}`;
          await this.executePolicyClose(
            pos,
            `thesis_invalidation (mark ${midStr} crossed ${invStr})`,
            liqDistPct,
            nowIso
          );
          try { clearPositionExitPolicy(pos.symbol); } catch { /* best-effort */ }
          continue;
        }
      }

      const exitContractDecision = evaluateExitContract(exitContract, {
        markPrice: mid,
        roePct: pos.roePct,
        liqDistPct,
      });
      if (exitContractDecision?.action === 'close') {
        await this.executePolicyClose(pos, `exit_contract (${exitContractDecision.reason})`, liqDistPct, nowIso);
        try { clearPositionExitPolicy(pos.symbol); } catch { /* best-effort */ }
        continue;
      }
      if (exitContractDecision?.action === 'reduce') {
        await this.executeContractReduce(pos, exitContractDecision.reduceToFraction, exitContractDecision.reason, liqDistPct, nowIso);
        continue;
      }

      // LLM exit consultant: check whether to consult, and act on the decision.
      if (this.exitConsultant && this.config.heartbeat?.llmExitConsult?.enabled !== false) {
        const bookEntry = this.getBookEntry(pos.symbol);
        const roe = (pos.roePct ?? 0) / 100; // convert pct → decimal
        if (bookEntry && this.exitConsultant.shouldConsult(bookEntry, mid ?? pos.roePct ?? 0, roe, nowMs)) {
          try {
            const freshContextSnapshot = await gatherMarketContext(
              { message: `${pos.symbol} perpetual market context`, signalSymbols: [pos.symbol], marketLimit: 20 },
              (toolName, toolInput) => this.toolExec(toolName, toolInput, this.toolContext)
            );
            const freshContext = summarizeMarketContext(freshContextSnapshot);
            const decision = await this.exitConsultant.consult(bookEntry, mid ?? 0, roe, freshContext);
            bookEntry.lastConsultAtMs = nowMs;
            bookEntry.lastConsultDecision = JSON.stringify({ ...decision, roeAtConsult: roe });

            if (decision.action === 'reduce' && decision.reduceToFraction != null) {
              const side = pos.side === 'long' ? 'sell' : 'buy';
              const reduceSize = pos.size * (1 - decision.reduceToFraction);
              if (reduceSize > 0) {
                await this.toolExec(
                  'perp_place_order',
                  { symbol: pos.symbol, side, size: reduceSize, reduce_only: true, order_type: 'market' },
                  this.toolContext
                );
                this.logger.info(
                  `PositionHeartbeat: llm_exit_consultant reduce ${pos.symbol} by fraction=${1 - decision.reduceToFraction}`
                );
              }
            } else if (decision.action === 'extend_ttl' && decision.newTimeStopAtMs != null) {
              upsertPositionExitPolicy(
                pos.symbol,
                pos.side,
                resolveExtendedTtl(decision.newTimeStopAtMs, nowMs),
                policy?.invalidationPrice ?? null,
                policy?.notes ?? null
              );
            } else if (decision.action === 'update_invalidation' && decision.newInvalidationPrice != null) {
              upsertPositionExitPolicy(
                pos.symbol,
                pos.side,
                resolveExtendedTtl(bookEntry.thesisExpiresAtMs, nowMs),
                decision.newInvalidationPrice,
                buildUpdatedExitPolicyNotes(bookEntry, pos.side, decision.newInvalidationPrice)
              );
            }
            // 'hold' → do nothing
          } catch (err) {
            this.logger.warn(`PositionHeartbeat: exit consultant error: ${stringifyError(err)}`);
          }
        }
      }

      const triggerState =
        this.triggerStateBySymbol.get(pos.symbol) ?? new Map<HeartbeatTriggerName, number>();
      this.triggerStateBySymbol.set(pos.symbol, triggerState);
      // If the position has an explicit time-stop policy, suppress the generic time_ceiling
      // trigger — the policy governs when this position should be closed, not a global ceiling.
      const effectiveCfg = policy?.timeStopAtMs != null
        ? { ...cfg, timeCeilingMinutes: 999_999 }
        : cfg;
      const fired = evaluateHeartbeatTriggers({
        points: buffer,
        cfg: effectiveCfg,
        nowMs,
        lastFiredByTrigger: triggerState,
      });

      // Paper mode: simulate forced liquidation when mark crosses liquidation price.
      if (executionMode === 'paper' && liqDistPct !== null && liqDistPct <= 0 && pos.liquidationPrice != null) {
        const liqSide = pos.side === 'long' ? 'sell' : 'buy';
        const liqPrice = pos.liquidationPrice;
        let liqFillSuccess = false;
        let liqFillError: string | null = null;
        try {
          placePaperPerpOrder(
            { symbol: pos.symbol, side: liqSide, size: pos.size, orderType: 'market', markPrice: liqPrice, reduceOnly: true },
            { initialCashUsdc: (this.config as any).paper?.initialCashUsdc ?? 200 }
          );
          liqFillSuccess = true;
        } catch (err) {
          liqFillError = stringifyError(err);
        }

        const midStr = mid != null ? `$${mid.toFixed(2)}` : 'n/a';
        const liqStr = `$${liqPrice.toFixed(2)}`;
        this.logger.info(
          `PositionHeartbeat: [Paper] Liquidated ${pos.symbol} (${pos.side}) size=${pos.size} ` +
          `liqPrice=${liqStr} mark=${midStr}`
        );
        recordPositionHeartbeatDecision({
          kind: 'position_heartbeat_journal',
          symbol: pos.symbol,
          timestamp: nowIso,
          triggers: [],
          decision: { action: 'close_entirely', reason: `[Paper] Liquidation: mark ${midStr} crossed liq price ${liqStr}` },
          outcome: liqFillSuccess ? 'ok' : 'failed',
          snapshot: { liqDistPct, liqPrice, mid },
          error: liqFillError,
        });
        if (this.notify) {
          try {
            await this.notify(
              `💀 [Paper] Liquidated: ${pos.symbol} (${pos.side}). Mark: ${midStr}. Liq price: ${liqStr}. Margin lost.`
            );
          } catch (err) {
            this.logger.warn(`PositionHeartbeat: notify failed: ${stringifyError(err)}`);
          }
        }
        continue;
      }

      // Hard circuit breaker — bypass review/profit-protection logic, close immediately.
      const emergency = liqDistPct != null && liqDistPct < 2;
      if (!emergency) {
        const bookEntry = this.getBookEntry(pos.symbol);
        const dynamicDecision =
          bookEntry && policy?.invalidationPrice != null
            ? evaluateDynamicProfitProtection({
                side: pos.side,
                entryPrice: bookEntry.entryPrice,
                currentPrice: mid,
                invalidationPrice: policy.invalidationPrice,
                roePct: pos.roePct,
                points: buffer,
                triggerSignals: fired,
                cfg: normalizeDynamicProfitProtectionConfig(this.config),
              })
            : null;
        if (dynamicDecision?.action === 'tighten_invalidation' && bookEntry) {
          upsertPositionExitPolicy(
            pos.symbol,
            pos.side,
            policy?.timeStopAtMs ?? null,
            dynamicDecision.newInvalidationPrice,
            buildUpdatedExitPolicyNotes(bookEntry, pos.side, dynamicDecision.newInvalidationPrice)
          );
          this.recordInfo(pos.symbol, nowIso, fired, dynamicDecision.reason);
        } else if (dynamicDecision?.action === 'reduce') {
          if (dynamicDecision.newInvalidationPrice != null && bookEntry) {
            upsertPositionExitPolicy(
              pos.symbol,
              pos.side,
              policy?.timeStopAtMs ?? null,
              dynamicDecision.newInvalidationPrice,
              buildUpdatedExitPolicyNotes(bookEntry, pos.side, dynamicDecision.newInvalidationPrice)
            );
          }
          await this.executeContractReduce(
            pos,
            dynamicDecision.reduceToFraction,
            dynamicDecision.reason,
            liqDistPct,
            nowIso
          );
        } else if (dynamicDecision?.action === 'tighten_and_reduce' && bookEntry) {
          upsertPositionExitPolicy(
            pos.symbol,
            pos.side,
            policy?.timeStopAtMs ?? null,
            dynamicDecision.newInvalidationPrice,
            buildUpdatedExitPolicyNotes(bookEntry, pos.side, dynamicDecision.newInvalidationPrice)
          );
          await this.executeContractReduce(
            pos,
            dynamicDecision.reduceToFraction,
            dynamicDecision.reason,
            liqDistPct,
            nowIso
          );
        } else if (dynamicDecision?.action === 'close') {
          await this.executePolicyClose(pos, dynamicDecision.reason, liqDistPct, nowIso);
          try { clearPositionExitPolicy(pos.symbol); } catch { /* best-effort */ }
        } else {
          this.recordInfo(pos.symbol, nowIso, fired, null);
        }
        continue;
      }

      const side = pos.side === 'long' ? 'sell' : 'buy';
      const tool = await this.toolExec(
        'perp_place_order',
        { symbol: pos.symbol, side, size: pos.size, reduce_only: true, order_type: 'market' },
        this.toolContext
      );

      recordPositionHeartbeatDecision({
        kind: 'position_heartbeat_journal',
        symbol: pos.symbol,
        timestamp: nowIso,
        triggers: fired,
        decision: {
          action: 'close_entirely',
          reason: `Emergency close: liqDistPct=${liqDistPct ?? 'n/a'}`,
        },
        outcome: tool.success ? 'ok' : 'failed',
        snapshot: { liqDistPct, tool },
        error: tool.success ? null : tool.error,
      });

      if (this.notify) {
        const liqStr = liqDistPct != null ? `${liqDistPct.toFixed(2)}%` : 'n/a';
        try {
          await this.notify(
            `🚨 [Heartbeat] Emergency close: ${pos.symbol} (${pos.side}). Liq dist: ${liqStr}.`
          );
        } catch (err) {
          this.logger.warn(`PositionHeartbeat: notify failed: ${stringifyError(err)}`);
        }
      }
    }

    this.scheduleNext(this.computeActiveIntervalMs());
  }

  /** Close a position entirely due to a policy-based trigger (time stop or invalidation). */
  private async executePolicyClose(
    pos: PositionSnapshot,
    reason: string,
    liqDistPct: number | null,
    timestamp: string
  ): Promise<void> {
    const side = pos.side === 'long' ? 'sell' : 'buy';
    const roe = pos.roePct != null ? `${pos.roePct.toFixed(2)}%` : 'n/a';
    const tool = await this.toolExec(
      'perp_place_order',
      { symbol: pos.symbol, side, size: pos.size, reduce_only: true, order_type: 'market' },
      this.toolContext
    );
    this.logger.info(
      `PositionHeartbeat: policy_close ${pos.symbol} (${pos.side}) size=${pos.size} ` +
      `reason="${reason}" outcome=${tool.success ? 'ok' : 'failed'}`
    );
    recordPositionHeartbeatDecision({
      kind: 'position_heartbeat_journal',
      symbol: pos.symbol,
      timestamp,
      triggers: [],
      decision: { action: 'close_entirely', reason },
      outcome: tool.success ? 'ok' : 'failed',
      snapshot: { liqDistPct },
      error: tool.success ? null : tool.error,
    });

    if (this.notify) {
      try {
        await this.notify(
          `🎯 [Heartbeat] Closed ${pos.symbol} (${pos.side}) — ${reason}. ROE: ${roe}.`
        );
      } catch (err) {
        this.logger.warn(`PositionHeartbeat: notify failed: ${stringifyError(err)}`);
      }
    }
  }

  private async executeContractReduce(
    pos: PositionSnapshot,
    reduceToFraction: number,
    reason: string,
    liqDistPct: number | null,
    timestamp: string
  ): Promise<void> {
    const boundedFraction = Math.max(0, Math.min(1, reduceToFraction));
    const reduceSize = pos.size * (1 - boundedFraction);
    if (reduceSize <= 0) return;

    const side = pos.side === 'long' ? 'sell' : 'buy';
    const tool = await this.toolExec(
      'perp_place_order',
      { symbol: pos.symbol, side, size: reduceSize, reduce_only: true, order_type: 'market' },
      this.toolContext
    );

    this.logger.info(
      `PositionHeartbeat: exit_contract reduce ${pos.symbol} (${pos.side}) size=${reduceSize} ` +
      `reason="${reason}" outcome=${tool.success ? 'ok' : 'failed'}`
    );
    recordPositionHeartbeatDecision({
      kind: 'position_heartbeat_journal',
      symbol: pos.symbol,
      timestamp,
      triggers: [],
      decision: { action: 'take_partial_profit', reason: `exit_contract (${reason})` },
      outcome: tool.success ? 'ok' : 'failed',
      snapshot: { liqDistPct, reduceToFraction: boundedFraction },
      error: tool.success ? null : tool.error,
    });
    if (this.notify) {
      try {
        await this.notify(
          `⚠️ [Heartbeat] Reduced ${pos.symbol} (${pos.side}) to ${(boundedFraction * 100).toFixed(0)}% — exit_contract: ${reason}.`
        );
      } catch (err) {
        this.logger.warn(`PositionHeartbeat: notify failed: ${stringifyError(err)}`);
      }
    }
  }

  private parsePositions(raw: unknown): PositionSnapshot[] {
    const positionsRaw = (raw as any)?.positions;
    const positions = Array.isArray(positionsRaw) ? positionsRaw : [];
    return positions
      .map((p: any): PositionSnapshot | null => {
        const symbol = String(p?.symbol ?? '').trim();
        if (!symbol) return null;
        const side = String(p?.side ?? '') === 'short' ? 'short' : 'long';
        const size = toFinite(p?.size);
        if (size == null || size <= 0) return null;
        return {
          symbol,
          side,
          size,
          positionValue: toFinite(p?.position_value),
          unrealizedPnl: toFinite(p?.unrealized_pnl),
          roePct: toFinite(p?.return_on_equity),
          liquidationPrice: toFinite(p?.liquidation_price),
        };
      })
      .filter((p: any): p is PositionSnapshot => Boolean(p));
  }

  private recordInfo(
    symbol: string,
    timestamp: string,
    triggers: HeartbeatTriggerName[],
    message: string | null
  ): void {
    try {
      recordPositionHeartbeatDecision({
        kind: 'position_heartbeat_journal',
        symbol,
        timestamp,
        triggers,
        decision: { action: 'hold', reason: message ?? 'hold' },
        outcome: message ? 'failed' : 'info',
        snapshot: null,
        error: message,
      });
    } catch {
      // Best-effort only.
    }
  }

  private computeActiveIntervalMs(): number {
    const hb = this.config.heartbeat ?? ({} as any);
    return Math.max(1, Number(hb.tickIntervalSeconds ?? 30) || 30) * 1000;
  }

  private computeIdleIntervalMs(): number {
    return Math.max(60_000, this.computeActiveIntervalMs() * 5);
  }
}

function toFinite(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function resolveMid(mids: Record<string, number>, symbol: string): number | null {
  // Build a list of candidate keys to try, from most to least specific.
  const candidates: string[] = [symbol];

  // Strip DEX namespace prefix: "XYZ:CL" → "CL"
  const colonIdx = symbol.indexOf(':');
  const stripped = colonIdx !== -1 ? symbol.slice(colonIdx + 1) : symbol;
  if (stripped !== symbol) candidates.push(stripped);

  // Strip slash-quoted currency: "CL/USDC" → "CL"
  const slashIdx = stripped.indexOf('/');
  const base = slashIdx !== -1 ? stripped.slice(0, slashIdx) : stripped;
  if (base !== stripped) candidates.push(base);

  for (const key of candidates) {
    const direct = mids[key];
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    const upper = key.toUpperCase();
    const normalized = mids[upper];
    if (typeof normalized === 'number' && Number.isFinite(normalized)) return normalized;
  }
  return null;
}

function resolveFallbackMidFromPosition(position: PositionSnapshot): number | null {
  if (position.size <= 0 || position.positionValue == null) {
    return null;
  }
  const mid = position.positionValue / position.size;
  return Number.isFinite(mid) && mid > 0 ? mid : null;
}

function computeLiqDistancePct(params: {
  side: 'long' | 'short';
  mid: number | null;
  liquidationPrice: number | null;
}): number | null {
  if (params.mid == null || params.mid <= 0) return null;
  if (params.liquidationPrice == null || params.liquidationPrice <= 0) return null;
  const mid = params.mid;
  const liq = params.liquidationPrice;
  const dist = params.side === 'long' ? (mid - liq) / mid : (liq - mid) / mid;
  return dist * 100;
}

function normalizeTriggerConfig(config: ThufirConfig): HeartbeatTriggerConfig {
  const raw = config.heartbeat?.triggers ?? ({} as any);
  const toNumberOr = (value: unknown, fallback: number): number => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };
  return {
    pnlShiftPct: toNumberOr(raw.pnlShiftPct, 1.5),
    liquidationProximityPct: toNumberOr(raw.liquidationProximityPct, 5),
    volatilitySpikePct: toNumberOr(raw.volatilitySpikePct, 2),
    volatilitySpikeWindowTicks: toNumberOr(raw.volatilitySpikeWindowTicks, 10),
    timeCeilingMinutes: toNumberOr(raw.timeCeilingMinutes, 0),
    triggerCooldownSeconds: toNumberOr(raw.triggerCooldownSeconds, 180),
  };
}

function normalizeDynamicProfitProtectionConfig(config: ThufirConfig): DynamicProfitProtectionConfig {
  const raw = config.heartbeat?.dynamicProfitProtection ?? ({} as Record<string, unknown>);
  const toNumberOr = (value: unknown, fallback: number): number => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };
  return {
    enabled: raw.enabled !== false,
    minRMultiple: toNumberOr(raw.minRMultiple, 4),
    minRoePct: toNumberOr(raw.minRoePct, 12),
    partialReduceRMultiple: toNumberOr(raw.partialReduceRMultiple, 5.5),
    tightenAndReduceRMultiple: toNumberOr(raw.tightenAndReduceRMultiple, 7),
    terminalCloseRMultiple: toNumberOr(raw.terminalCloseRMultiple, 9),
    adverseMovePct: toNumberOr(raw.adverseMovePct, 1.5),
    terminalAdverseMovePct: toNumberOr(raw.terminalAdverseMovePct, 2.5),
  };
}

function resolveExtendedTtl(requestedStopAtMs: number, nowMs: number): number {
  if (!Number.isFinite(requestedStopAtMs) || requestedStopAtMs <= nowMs) {
    return nowMs + 60 * 1000;
  }
  return requestedStopAtMs;
}

function buildUpdatedExitPolicyNotes(
  position: BookEntry,
  side: 'long' | 'short',
  invalidationPrice: number
): string {
  const tradeType = position.exitContract?.tradeType ?? 'tactical';
  const thesis =
    position.exitContract?.thesis?.trim() ||
    position.entryReasoningText?.trim() ||
    `${position.symbol} ${side} thesis`;
  return serializeExitContract(
    buildLegacyExitContract({
      thesis,
      invalidationPrice,
      side,
      tradeType,
    })
  );
}

async function retryWithBackoff<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  const max = Math.max(1, attempts);
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = Math.min(5000, 200 * Math.pow(2, i));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
