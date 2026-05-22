import type { HeartbeatPoint, HeartbeatTriggerName } from './heartbeat_triggers.js';

export type DynamicProfitProtectionConfig = {
  enabled: boolean;
  minRMultiple: number;
  minRoePct: number;
  partialReduceRMultiple: number;
  tightenAndReduceRMultiple: number;
  terminalCloseRMultiple: number;
  adverseMovePct: number;
  terminalAdverseMovePct: number;
};

export type DynamicProfitProtectionDecision =
  | {
      action: 'tighten_invalidation';
      reason: string;
      newInvalidationPrice: number;
      rMultiple: number;
    }
  | {
      action: 'reduce';
      reason: string;
      newInvalidationPrice: number | null;
      reduceToFraction: number;
      rMultiple: number;
    }
  | {
      action: 'tighten_and_reduce';
      reason: string;
      newInvalidationPrice: number;
      reduceToFraction: number;
      rMultiple: number;
    }
  | {
      action: 'close';
      reason: string;
      rMultiple: number;
    };

export function evaluateDynamicProfitProtection(params: {
  side: 'long' | 'short';
  entryPrice: number | null;
  currentPrice: number | null;
  invalidationPrice: number | null;
  roePct: number | null;
  points: HeartbeatPoint[];
  triggerSignals: HeartbeatTriggerName[];
  cfg: DynamicProfitProtectionConfig;
}): DynamicProfitProtectionDecision | null {
  const entryPrice = toFinitePositive(params.entryPrice);
  const currentPrice = toFinitePositive(params.currentPrice);
  const invalidationPrice = toFinitePositive(params.invalidationPrice);
  if (!params.cfg.enabled || entryPrice == null || currentPrice == null || invalidationPrice == null) {
    return null;
  }

  const riskDistance = Math.abs(entryPrice - invalidationPrice);
  if (!Number.isFinite(riskDistance) || riskDistance <= 0) {
    return null;
  }

  const favorableMove =
    params.side === 'long' ? currentPrice - entryPrice : entryPrice - currentPrice;
  if (!Number.isFinite(favorableMove) || favorableMove <= 0) {
    return null;
  }

  const rMultiple = favorableMove / riskDistance;
  const roePct = Number(params.roePct ?? 0);
  if (rMultiple < params.cfg.minRMultiple || roePct < params.cfg.minRoePct) {
    return null;
  }

  const adverseMovePct = computeRecentAdverseMovePct(params.points, params.side);
  const deteriorationSignals = new Set<HeartbeatTriggerName>(
    params.triggerSignals.filter(
      (signal) => signal === 'liquidation_proximity'
    )
  );
  if (adverseMovePct >= params.cfg.adverseMovePct) {
    deteriorationSignals.add('pnl_shift');
  }
  if (deteriorationSignals.size === 0) {
    return null;
  }

  const tightenedInvalidation = computeTightenedInvalidationPrice({
    side: params.side,
    entryPrice,
    currentPrice,
    existingInvalidationPrice: invalidationPrice,
    rMultiple,
  });

  if (
    rMultiple >= params.cfg.terminalCloseRMultiple &&
    deteriorationSignals.size >= 2 &&
    adverseMovePct >= params.cfg.terminalAdverseMovePct
  ) {
    return {
      action: 'close',
      reason: `dynamic_profit_protection terminal_extension_failure (${rMultiple.toFixed(2)}R)`,
      rMultiple,
    };
  }

  if (
    tightenedInvalidation != null &&
    rMultiple >= params.cfg.tightenAndReduceRMultiple &&
    deteriorationSignals.size >= 2
  ) {
    return {
      action: 'tighten_and_reduce',
      reason: `dynamic_profit_protection tighten_and_reduce (${rMultiple.toFixed(2)}R)`,
      newInvalidationPrice: tightenedInvalidation,
      reduceToFraction: computeReduceToFraction(rMultiple),
      rMultiple,
    };
  }

  if (rMultiple >= params.cfg.partialReduceRMultiple) {
    return {
      action: 'reduce',
      reason: `dynamic_profit_protection partial_reduce (${rMultiple.toFixed(2)}R)`,
      newInvalidationPrice: tightenedInvalidation,
      reduceToFraction: computeReduceToFraction(rMultiple),
      rMultiple,
    };
  }

  if (tightenedInvalidation != null) {
    return {
      action: 'tighten_invalidation',
      reason: `dynamic_profit_protection tighten_invalidation (${rMultiple.toFixed(2)}R)`,
      newInvalidationPrice: tightenedInvalidation,
      rMultiple,
    };
  }

  return null;
}

function toFinitePositive(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function computeRecentAdverseMovePct(
  points: HeartbeatPoint[],
  side: 'long' | 'short'
): number {
  if (points.length < 2) return 0;
  const last = points[points.length - 1]?.mid;
  const prev = points[points.length - 2]?.mid;
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev == null || prev <= 0 || last == null || last <= 0) {
    return 0;
  }
  const changePct =
    side === 'long' ? ((prev - last) / prev) * 100 : ((last - prev) / prev) * 100;
  return Math.max(0, changePct);
}

function computeReduceToFraction(rMultiple: number): number {
  if (rMultiple >= 9) return 0.35;
  if (rMultiple >= 7) return 0.5;
  if (rMultiple >= 5.5) return 0.65;
  return 0.8;
}

function computeTightenedInvalidationPrice(params: {
  side: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  existingInvalidationPrice: number;
  rMultiple: number;
}): number | null {
  const lockFraction = params.rMultiple >= 7 ? 0.75 : params.rMultiple >= 5.5 ? 0.6 : 0.45;
  const favorableMove =
    params.side === 'long'
      ? params.currentPrice - params.entryPrice
      : params.entryPrice - params.currentPrice;
  if (!Number.isFinite(favorableMove) || favorableMove <= 0) {
    return null;
  }

  if (params.side === 'long') {
    const candidate = params.entryPrice + favorableMove * lockFraction;
    const bounded = Math.min(candidate, params.currentPrice * 0.9975);
    return bounded > params.existingInvalidationPrice ? bounded : null;
  }

  const candidate = params.entryPrice - favorableMove * lockFraction;
  const bounded = Math.max(candidate, params.currentPrice * 1.0025);
  return bounded < params.existingInvalidationPrice ? bounded : null;
}
