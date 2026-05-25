export type TradeArchetype = 'scalp' | 'intraday' | 'swing';

export type InvalidationType = 'price_level' | 'structure_break';

export type TrailMode = 'none' | 'atr' | 'structure';
export type ExitReasonCode =
  | 'thesis_invalidation'
  | 'take_profit'
  | 'time_exit'
  | 'risk_reduction'
  | 'manual'
  | 'unknown';

export interface EntryTradeContractInput {
  tradeArchetype?: string | null;
  invalidationType?: string | null;
  invalidationPrice?: number | null;
  timeStopAtMs?: number | null;
  takeProfitR?: number | null;
  trailMode?: string | null;
}

export interface EntryTradeContract {
  tradeArchetype: TradeArchetype;
  invalidationType: InvalidationType;
  invalidationPrice: number | null;
  timeStopAtMs: number;
  takeProfitR: number | null;
  trailMode: TrailMode;
}

type ExitValidationResult = { valid: true } | { valid: false; error: string };

type ContractValidationResult =
  | { valid: true; contract: EntryTradeContract | null }
  | { valid: false; error: string };

const MIN_HOLD_MS_BY_ARCHETYPE: Record<TradeArchetype, number> = {
  scalp: 5 * 60 * 1000,
  intraday: 30 * 60 * 1000,
  swing: 4 * 60 * 60 * 1000,
};

const DEFAULT_HOLD_MS_BY_ARCHETYPE: Record<TradeArchetype, number> = {
  scalp: 90 * 60 * 1000,
  intraday: 6 * 60 * 60 * 1000,
  swing: 24 * 60 * 60 * 1000,
};

function normalizeArchetype(raw: string | null | undefined): TradeArchetype | null {
  if (raw === 'scalp' || raw === 'intraday' || raw === 'swing') return raw;
  return null;
}

function normalizeInvalidationType(raw: string | null | undefined): InvalidationType | null {
  if (raw === 'price_level' || raw === 'structure_break') return raw;
  return null;
}

function normalizeTrailMode(raw: string | null | undefined): TrailMode | null {
  if (raw === 'none' || raw === 'atr' || raw === 'structure') return raw;
  return null;
}

function toFiniteOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hydrateEntryTradeContract(params: {
  enabled: boolean;
  reduceOnly: boolean;
  side: 'buy' | 'sell';
  markPrice: number | null;
  input: EntryTradeContractInput;
  nowMs?: number;
}): EntryTradeContractInput {
  if (!params.enabled || params.reduceOnly) {
    return params.input;
  }

  const nowMs = params.nowMs ?? Date.now();
  const archetype = normalizeArchetype(params.input.tradeArchetype) ?? 'intraday';
  const invalidationType =
    normalizeInvalidationType(params.input.invalidationType) ??
    (toFiniteOrNull(params.markPrice) != null ? 'price_level' : 'structure_break');
  const trailMode = normalizeTrailMode(params.input.trailMode) ?? 'structure';
  const takeProfitR =
    toFiniteOrNull(params.input.takeProfitR) ??
    (trailMode === 'none' ? 2 : null);
  const timeStopAtMs =
    toFiniteOrNull(params.input.timeStopAtMs) ??
    nowMs + DEFAULT_HOLD_MS_BY_ARCHETYPE[archetype];

  let invalidationPrice = toFiniteOrNull(params.input.invalidationPrice);
  const markPrice = toFiniteOrNull(params.markPrice);
  if (invalidationType === 'price_level' && (invalidationPrice == null || invalidationPrice <= 0) && markPrice != null && markPrice > 0) {
    const stopBufferPct = 0.015;
    invalidationPrice =
      params.side === 'buy'
        ? markPrice * (1 - stopBufferPct)
        : markPrice * (1 + stopBufferPct);
  }

  return {
    tradeArchetype: archetype,
    invalidationType,
    invalidationPrice,
    timeStopAtMs,
    takeProfitR,
    trailMode,
  };
}

export function validateEntryTradeContract(params: {
  enabled: boolean;
  reduceOnly: boolean;
  input: EntryTradeContractInput;
  nowMs?: number;
}): ContractValidationResult {
  if (!params.enabled || params.reduceOnly) {
    return { valid: true, contract: null };
  }

  const nowMs = params.nowMs ?? Date.now();
  const archetype = normalizeArchetype(params.input.tradeArchetype);
  if (!archetype) {
    return { valid: false, error: 'Missing/invalid trade_archetype (scalp|intraday|swing)' };
  }

  const invalidationType = normalizeInvalidationType(params.input.invalidationType);
  if (!invalidationType) {
    return {
      valid: false,
      error: 'Missing/invalid invalidation_type (price_level|structure_break)',
    };
  }

  const timeStopAtMs = Number(params.input.timeStopAtMs);
  if (!Number.isFinite(timeStopAtMs) || timeStopAtMs <= nowMs) {
    return { valid: false, error: 'Missing/invalid time_stop_at_ms (must be in the future)' };
  }
  const minHoldMs = MIN_HOLD_MS_BY_ARCHETYPE[archetype];
  if (timeStopAtMs - nowMs < minHoldMs) {
    return {
      valid: false,
      error: `time_stop_at_ms too close for ${archetype} (minimum hold ${Math.floor(minHoldMs / 60000)}m)`,
    };
  }

  let invalidationPrice: number | null = null;
  if (invalidationType === 'price_level') {
    invalidationPrice = Number(params.input.invalidationPrice);
    if (!Number.isFinite(invalidationPrice) || invalidationPrice <= 0) {
      return {
        valid: false,
        error: 'invalidation_price is required and must be > 0 for invalidation_type=price_level',
      };
    }
  }

  const takeProfitRRaw = params.input.takeProfitR;
  const takeProfitR =
    takeProfitRRaw != null && Number.isFinite(Number(takeProfitRRaw)) ? Number(takeProfitRRaw) : null;
  const trailMode = normalizeTrailMode(params.input.trailMode ?? null);
  if (trailMode == null) {
    return { valid: false, error: 'Missing/invalid trail_mode (none|atr|structure)' };
  }
  if (takeProfitR == null && trailMode === 'none') {
    return {
      valid: false,
      error: 'Trade contract requires take_profit_r or trail_mode!=none',
    };
  }
  if (takeProfitR != null && takeProfitR <= 0) {
    return { valid: false, error: 'take_profit_r must be > 0 when provided' };
  }

  return {
    valid: true,
    contract: {
      tradeArchetype: archetype,
      invalidationType,
      invalidationPrice,
      timeStopAtMs,
      takeProfitR,
      trailMode,
    },
  };
}

export function validateReduceOnlyExitFsm(params: {
  enabled: boolean;
  reduceOnly: boolean;
  exitMode: ExitReasonCode | null;
  thesisInvalidationHit: boolean | null;
  emergencyOverride: boolean;
  emergencyReason: string | null;
}): ExitValidationResult {
  if (!params.enabled || !params.reduceOnly) {
    return { valid: true };
  }
  if (params.emergencyOverride) {
    if (!params.emergencyReason || params.emergencyReason.trim().length < 8) {
      return {
        valid: false,
        error: 'emergency_reason is required (>=8 chars) when emergency_override=true',
      };
    }
    return { valid: true };
  }
  if (!params.exitMode) {
    return {
      valid: false,
      error:
        'reduce-only exit requires exit_mode (thesis_invalidation|take_profit|time_exit|risk_reduction) when exit FSM is enabled',
    };
  }
  if (params.exitMode === 'manual' || params.exitMode === 'unknown') {
    return {
      valid: false,
      error:
        'manual/unknown reduce-only exits are blocked by exit FSM; use emergency_override with reason',
    };
  }
  if (params.exitMode === 'thesis_invalidation' && params.thesisInvalidationHit !== true) {
    return {
      valid: false,
      error: 'exit_mode=thesis_invalidation requires thesis_invalidation_hit=true',
    };
  }
  if (
    (params.exitMode === 'take_profit' ||
      params.exitMode === 'time_exit' ||
      params.exitMode === 'risk_reduction') &&
    params.thesisInvalidationHit === true
  ) {
    return {
      valid: false,
      error: 'thesis_invalidation_hit=true conflicts with non-invalidation exit_mode',
    };
  }
  return { valid: true };
}

export function normalizeReduceOnlyExitFsmInput(params: {
  enabled: boolean;
  reduceOnly: boolean;
  exitMode: ExitReasonCode | null;
  thesisInvalidationHit: boolean | null;
}): { exitMode: ExitReasonCode | null; thesisInvalidationHit: boolean | null } {
  if (!params.enabled || !params.reduceOnly) {
    return {
      exitMode: params.exitMode,
      thesisInvalidationHit: params.thesisInvalidationHit,
    };
  }

  let exitMode = params.exitMode;
  let thesisInvalidationHit = params.thesisInvalidationHit;

  if (thesisInvalidationHit === true) {
    exitMode = 'thesis_invalidation';
  }

  if (exitMode === 'thesis_invalidation' && thesisInvalidationHit !== true) {
    thesisInvalidationHit = true;
  }

  if (
    (exitMode === 'take_profit' || exitMode === 'time_exit' || exitMode === 'risk_reduction') &&
    thesisInvalidationHit === true
  ) {
    thesisInvalidationHit = false;
  }

  if (exitMode == null && thesisInvalidationHit == null) {
    exitMode = 'risk_reduction';
    thesisInvalidationHit = false;
  } else if (exitMode == null) {
    exitMode = thesisInvalidationHit === true ? 'thesis_invalidation' : 'risk_reduction';
  } else if (thesisInvalidationHit == null) {
    thesisInvalidationHit = exitMode === 'thesis_invalidation';
  }

  return { exitMode, thesisInvalidationHit };
}
