import type { ThufirConfig } from '../core/config.js';
import type { ExpressionPlan } from '../discovery/types.js';
import type { TradeEnvelope } from './types.js';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toIsoNow(): string {
  return new Date().toISOString();
}

export function buildTradeEnvelopeFromExpression(params: {
  config: ThufirConfig;
  tradeId: string;
  expr: ExpressionPlan;
  entryPrice: number;
  size: number;
  notionalUsd: number;
  entryCloid?: string | null;
  entryFeesUsd?: number | null;
}): TradeEnvelope {
  const { config, tradeId, expr, entryPrice, size, notionalUsd } = params;
  const tm = config.tradeManagement ?? ({} as any);
  const defaults = tm.defaults ?? {};
  const bounds = tm.bounds ?? {};

  const proposedStopLossPct = Number(expr.stopLossPct ?? defaults.stopLossPct ?? 3.0);
  const proposedTakeProfitPct = Number(expr.takeProfitPct ?? defaults.takeProfitPct ?? 5.0);
  const proposedMaxHoldSeconds = Number(
    expr.maxHoldSeconds ?? Math.round(Number(defaults.maxHoldHours ?? 72) * 3600)
  );
  const proposedTrailingStopPctRaw =
    expr.trailingStopPct === undefined ? (defaults.trailingStopPct ?? 2.0) : expr.trailingStopPct;
  const proposedTrailingStopPct =
    proposedTrailingStopPctRaw == null ? null : Number(proposedTrailingStopPctRaw);
  const proposedTrailingActivationPct = Number(
    expr.trailingActivationPct ?? defaults.trailingActivationPct ?? 1.0
  );

  const appliedStopLossPct = clamp(
    proposedStopLossPct,
    Number(bounds.stopLossPct?.min ?? 1.0),
    Number(bounds.stopLossPct?.max ?? 8.0)
  );
  const appliedTakeProfitPct = clamp(
    proposedTakeProfitPct,
    Number(bounds.takeProfitPct?.min ?? 2.0),
    Number(bounds.takeProfitPct?.max ?? 15.0)
  );
  const appliedMaxHoldSeconds = Math.round(
    clamp(
      proposedMaxHoldSeconds,
      Number(bounds.maxHoldHours?.min ?? 1) * 3600,
      Number(bounds.maxHoldHours?.max ?? 168) * 3600
    )
  );
  const appliedTrailingStopPct =
    proposedTrailingStopPct == null
      ? null
      : clamp(
          proposedTrailingStopPct,
          Number(bounds.trailingStopPct?.min ?? 0.5),
          Number(bounds.trailingStopPct?.max ?? 5.0)
        );
  const appliedTrailingActivationPct = clamp(
    proposedTrailingActivationPct,
    Number(bounds.trailingActivationPct?.min ?? 0.0),
    Number(bounds.trailingActivationPct?.max ?? 5.0)
  );

  const clamped =
    proposedStopLossPct !== appliedStopLossPct ||
    proposedTakeProfitPct !== appliedTakeProfitPct ||
    proposedMaxHoldSeconds !== appliedMaxHoldSeconds ||
    proposedTrailingActivationPct !== appliedTrailingActivationPct ||
    (proposedTrailingStopPct ?? null) !== (appliedTrailingStopPct ?? null);

  const proposed = clamped
    ? {
        stopLossPct: proposedStopLossPct,
        takeProfitPct: proposedTakeProfitPct,
        maxHoldSeconds: proposedMaxHoldSeconds,
        trailingStopPct: proposedTrailingStopPct,
        trailingActivationPct: proposedTrailingActivationPct,
      }
    : null;

  const now = new Date();
  const enteredAt = toIsoNow();
  const expiresAt = new Date(now.getTime() + appliedMaxHoldSeconds * 1000).toISOString();

  const leverage = Number(expr.leverage ?? null);
  const leverageFinite = Number.isFinite(leverage) && leverage > 0 ? leverage : null;
  const marginUsd =
    leverageFinite != null && leverageFinite > 0 ? notionalUsd / leverageFinite : null;
  const maxLossUsd = Number.isFinite(notionalUsd)
    ? (appliedStopLossPct / 100) * notionalUsd
    : null;

  return {
    tradeId,
    hypothesisId: expr.hypothesisId ?? null,
    symbol: (expr.symbol.includes('/') ? expr.symbol.split('/')[0]! : expr.symbol).trim().toUpperCase(),
    side: expr.side,

    entryPrice,
    size,
    leverage: leverageFinite,
    notionalUsd,
    marginUsd,

    stopLossPct: appliedStopLossPct,
    takeProfitPct: appliedTakeProfitPct,
    maxHoldSeconds: appliedMaxHoldSeconds,
    trailingStopPct: appliedTrailingStopPct,
    trailingActivationPct: appliedTrailingActivationPct,
    maxLossUsd,

    proposed,

    thesis: expr.thesis ?? null,
    signalKinds: Array.isArray(expr.signalKinds) ? expr.signalKinds.map(String) : [],
    invalidation: expr.invalidation ?? null,
    catalystId: expr.catalystId ?? null,
    narrativeSnapshot: expr.narrativeSnapshot ?? null,

    highWaterPrice: expr.side === 'buy' ? entryPrice : null,
    lowWaterPrice: expr.side === 'sell' ? entryPrice : null,
    trailingActivated: false,
    fundingSinceOpenUsd: null,

    closePending: false,
    closePendingReason: null,
    closePendingAt: null,

    entryCloid: params.entryCloid ?? null,
    entryFeesUsd: params.entryFeesUsd ?? null,

    enteredAt,
    expiresAt,

    tpOid: null,
    slOid: null,

    status: 'open',
  };
}
