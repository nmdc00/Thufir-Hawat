import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export type TradePolicyAdjustmentAction =
  | 'downweight'
  | 'block'
  | 'cap_leverage'
  | 'require_confirmation'
  | 'cooldown';

export type TradePolicyKey = 'size' | 'leverage' | 'confirmation' | 'cooldown';
export type TradePolicyAdjustmentValue = number | string | boolean | null;

export interface TradePolicyAdjustmentScope {
  symbol?: string | null;
  direction?: string | null;
  strategySource?: string | null;
  triggerReason?: string | null;
  signalClass?: string | null;
  symbolClass?: string | null;
  session?: string | null;
  marketRegime?: string | null;
  volatilityBucket?: string | null;
  liquidityBucket?: string | null;
}

export interface TradePolicyAdjustmentInput extends TradePolicyAdjustmentScope {
  id?: string;
  domain: string;
  policyKey?: TradePolicyKey;
  action: TradePolicyAdjustmentAction;
  sizeMultiplier?: number;
  leverageCap?: number | null;
  confirmationRequired?: boolean | null;
  cooldownMinutes?: number | null;
  confidence?: number | null;
  evidenceCount: number;
  thesisFailureRate?: number | null;
  negativePnlRate?: number | null;
  averageQualityScore?: number | null;
  sourceLearningCaseId?: string | null;
  sourceTradeId?: number | null;
  rationale?: string | null;
  evidencePayload?: Record<string, unknown> | null;
  expiresAt?: string | null;
  active?: boolean;
}

export interface TradePolicyAdjustmentRecord extends Omit<TradePolicyAdjustmentInput, 'policyKey'> {
  id: string;
  policyKey: TradePolicyKey;
  sizeMultiplier: number;
  scopeKey: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TradePolicyAdjustment extends TradePolicyAdjustmentRecord {
  policyDomain: 'size' | 'leverage' | 'confirmation' | 'cooldown' | 'confidence';
  adjustmentType: 'set' | 'scale' | 'flag';
  oldValue: TradePolicyAdjustmentValue;
  newValue: TradePolicyAdjustmentValue;
  delta: number | null;
  reasonSummary: string;
  scope: Record<string, unknown> | null;
}

type TradePolicyAdjustmentRow = {
  id: string;
  domain: string;
  policy_key: TradePolicyKey | null;
  scope_key: string;
  symbol: string | null;
  direction: string | null;
  strategy_source: string | null;
  trigger_reason: string | null;
  signal_class: string | null;
  symbol_class: string | null;
  session_tag: string | null;
  market_regime: string | null;
  volatility_bucket: string | null;
  liquidity_bucket: string | null;
  action: TradePolicyAdjustmentAction;
  size_multiplier: number;
  leverage_cap: number | null;
  confirmation_required: number | null;
  cooldown_minutes: number | null;
  confidence: number | null;
  evidence_count: number;
  thesis_failure_rate: number | null;
  negative_pnl_rate: number | null;
  average_quality_score: number | null;
  source_learning_case_id: string | null;
  source_trade_id: number | null;
  rationale: string | null;
  evidence_payload: string | null;
  expires_at: string | null;
  active: number;
  created_at: string;
  updated_at: string;
};

function normalizeScopeValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizePolicyKey(
  value: TradePolicyKey | null | undefined,
  action: TradePolicyAdjustmentAction
): TradePolicyKey {
  if (value === 'size' || value === 'leverage' || value === 'confirmation' || value === 'cooldown') {
    return value;
  }
  switch (action) {
    case 'cap_leverage':
      return 'leverage';
    case 'require_confirmation':
      return 'confirmation';
    case 'cooldown':
      return 'cooldown';
    default:
      return 'size';
  }
}

function normalizeFinite(value: number | null | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildTradePolicyAdjustmentScopeKey(scope: TradePolicyAdjustmentScope): string {
  return [
    `symbol=${normalizeScopeValue(scope.symbol) ?? 'any'}`,
    `direction=${normalizeScopeValue(scope.direction) ?? 'any'}`,
    `strategySource=${normalizeScopeValue(scope.strategySource) ?? 'any'}`,
    `triggerReason=${normalizeScopeValue(scope.triggerReason) ?? 'any'}`,
    `signalClass=${normalizeScopeValue(scope.signalClass) ?? 'any'}`,
    `symbolClass=${normalizeScopeValue(scope.symbolClass) ?? 'any'}`,
    `session=${normalizeScopeValue(scope.session) ?? 'any'}`,
    `marketRegime=${normalizeScopeValue(scope.marketRegime) ?? 'any'}`,
    `volatilityBucket=${normalizeScopeValue(scope.volatilityBucket) ?? 'any'}`,
    `liquidityBucket=${normalizeScopeValue(scope.liquidityBucket) ?? 'any'}`,
  ].join('|');
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getTradePolicyAdjustmentColumns(): Set<string> {
  const db = openDatabase();
  const rows = db.prepare("PRAGMA table_info('trade_policy_adjustments')").all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => String(row.name ?? '')));
}

function toLegacyAdjustmentType(policyKey: TradePolicyKey, action: TradePolicyAdjustmentAction): 'set' | 'scale' | 'flag' {
  if (policyKey === 'confirmation' || policyKey === 'cooldown') {
    return 'flag';
  }
  if (policyKey === 'size' && action === 'downweight') {
    return 'scale';
  }
  return 'set';
}

function toLegacyNewValue(params: {
  policyKey: TradePolicyKey;
  sizeMultiplier: number;
  leverageCap: number | null;
  confirmationRequired: number | null;
  cooldownMinutes: number | null;
}): number | null {
  switch (params.policyKey) {
    case 'leverage':
      return params.leverageCap;
    case 'confirmation':
      return params.confirmationRequired;
    case 'cooldown':
      return params.cooldownMinutes;
    default:
      return params.sizeMultiplier;
  }
}

function toRecord(row: TradePolicyAdjustmentRow): TradePolicyAdjustment {
  const policyKey = normalizePolicyKey(row.policy_key, row.action);
  const scope = {
    symbol: row.symbol,
    direction: row.direction,
    strategySource: row.strategy_source,
    triggerReason: row.trigger_reason,
    signalClass: row.signal_class,
    symbolClass: row.symbol_class,
    session: row.session_tag,
    marketRegime: row.market_regime,
    volatilityBucket: row.volatility_bucket,
    liquidityBucket: row.liquidity_bucket,
  };
  const newValue: TradePolicyAdjustmentValue =
    policyKey === 'leverage'
      ? row.leverage_cap
      : policyKey === 'confirmation'
        ? row.confirmation_required == null
          ? null
          : row.confirmation_required === 1
        : policyKey === 'cooldown'
          ? row.cooldown_minutes
          : row.size_multiplier;
  return {
    id: row.id,
    domain: row.domain,
    policyKey,
    policyDomain: policyKey,
    adjustmentType:
      policyKey === 'confirmation' || policyKey === 'cooldown'
        ? 'flag'
        : policyKey === 'size' && row.action === 'downweight'
          ? 'scale'
          : 'set',
    scopeKey: row.scope_key,
    scope,
    symbol: row.symbol,
    direction: row.direction,
    strategySource: row.strategy_source,
    triggerReason: row.trigger_reason,
    signalClass: row.signal_class,
    symbolClass: row.symbol_class,
    session: row.session_tag,
    marketRegime: row.market_regime,
    volatilityBucket: row.volatility_bucket,
    liquidityBucket: row.liquidity_bucket,
    action: row.action,
    sizeMultiplier: normalizeFinite(row.size_multiplier, 1),
    leverageCap: row.leverage_cap,
    confirmationRequired:
      row.confirmation_required == null ? null : row.confirmation_required === 1,
    cooldownMinutes: row.cooldown_minutes,
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    thesisFailureRate: row.thesis_failure_rate,
    negativePnlRate: row.negative_pnl_rate,
    averageQualityScore: row.average_quality_score,
    sourceLearningCaseId: row.source_learning_case_id,
    sourceTradeId: row.source_trade_id,
    rationale: row.rationale,
    reasonSummary: row.rationale ?? row.scope_key,
    oldValue: null,
    newValue,
    delta: policyKey === 'size' && typeof newValue === 'number' ? newValue - 1 : null,
    evidencePayload: parseJsonObject(row.evidence_payload),
    expiresAt: row.expires_at,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deactivateByScope(params: {
  domain: string;
  scope: TradePolicyAdjustmentScope;
  policyKey?: TradePolicyKey | null;
}): void {
  const db = openDatabase();
  db.prepare(
    `
      UPDATE trade_policy_adjustments
      SET active = 0,
          updated_at = datetime('now')
      WHERE domain = @domain
        AND scope_key = @scopeKey
        AND (@policyKey IS NULL OR COALESCE(policy_key, 'size') = @policyKey)
        AND active = 1
    `
  ).run({
    domain: params.domain,
    scopeKey: buildTradePolicyAdjustmentScopeKey(params.scope),
    policyKey: params.policyKey ?? null,
  });
}

export function deactivateTradePolicyAdjustmentsForScope(
  domain: string,
  scope: TradePolicyAdjustmentScope
): void {
  deactivateByScope({ domain, scope, policyKey: null });
}

export function createTradePolicyAdjustment(input: TradePolicyAdjustmentInput): TradePolicyAdjustmentRecord {
  const db = openDatabase();
  const columns = getTradePolicyAdjustmentColumns();
  const id = input.id ?? randomUUID();
  const policyKey = normalizePolicyKey(input.policyKey, input.action);
  const scopeKey = buildTradePolicyAdjustmentScopeKey(input);
  const symbol = normalizeScopeValue(input.symbol);
  const direction = normalizeScopeValue(input.direction);
  const strategySource = normalizeScopeValue(input.strategySource);
  const triggerReason = normalizeScopeValue(input.triggerReason);
  const signalClass = normalizeScopeValue(input.signalClass);
  const symbolClass = normalizeScopeValue(input.symbolClass);
  const session = normalizeScopeValue(input.session);
  const marketRegime = normalizeScopeValue(input.marketRegime);
  const volatilityBucket = normalizeScopeValue(input.volatilityBucket);
  const liquidityBucket = normalizeScopeValue(input.liquidityBucket);
  const sizeMultiplier =
    input.action === 'downweight' || input.action === 'block'
      ? Math.max(0, Math.min(1, normalizeFinite(input.sizeMultiplier, input.action === 'block' ? 0 : 1)))
      : 1;
  const leverageCap = input.leverageCap ?? null;
  const confirmationRequired = input.confirmationRequired == null ? null : input.confirmationRequired ? 1 : 0;
  const cooldownMinutes =
    input.cooldownMinutes == null ? null : Math.max(1, Math.floor(input.cooldownMinutes));
  const confidence = input.confidence ?? null;
  const evidenceCount = Math.max(0, Math.floor(input.evidenceCount));
  const thesisFailureRate = input.thesisFailureRate ?? null;
  const negativePnlRate = input.negativePnlRate ?? null;
  const averageQualityScore = input.averageQualityScore ?? null;
  const sourceLearningCaseId = input.sourceLearningCaseId ?? null;
  const sourceTradeId = input.sourceTradeId ?? null;
  const rationale = input.rationale ?? null;
  const evidencePayload = input.evidencePayload ? JSON.stringify(input.evidencePayload) : null;
  const expiresAt = input.expiresAt ?? null;
  const active = input.active === false ? 0 : 1;

  if (columns.has('policy_domain') && columns.has('adjustment_type')) {
    const scopePayload = JSON.stringify({
      symbol,
      direction,
      strategySource,
      triggerReason,
      signalClass,
      symbolClass,
      session,
      marketRegime,
      volatilityBucket,
      liquidityBucket,
    });
    const legacyNewValue = toLegacyNewValue({
      policyKey,
      sizeMultiplier,
      leverageCap,
      confirmationRequired,
      cooldownMinutes,
    });
    const legacyDelta = policyKey === 'size' && legacyNewValue != null ? legacyNewValue - 1 : null;

    db.prepare(
      `
        INSERT INTO trade_policy_adjustments (
          id,
          policy_domain,
          policy_key,
          scope_payload,
          adjustment_type,
          old_value,
          new_value,
          delta,
          evidence_count,
          reason_summary,
          confidence,
          active,
          created_at,
          expires_at,
          old_value_payload,
          new_value_payload,
          symbol,
          direction,
          strategy_source,
          trigger_reason,
          symbol_class,
          session_tag,
          leverage_cap,
          confirmation_required,
          cooldown_minutes,
          scope_key,
          domain,
          signal_class,
          market_regime,
          volatility_bucket,
          liquidity_bucket,
          action,
          size_multiplier,
          thesis_failure_rate,
          negative_pnl_rate,
          average_quality_score,
          source_learning_case_id,
          source_trade_id,
          rationale,
          evidence_payload,
          updated_at
        ) VALUES (
          @id,
          @policyDomain,
          @policyKey,
          @scopePayload,
          @adjustmentType,
          NULL,
          @newValue,
          @delta,
          @evidenceCount,
          @reasonSummary,
          @confidence,
          @active,
          datetime('now'),
          @expiresAt,
          NULL,
          NULL,
          @symbol,
          @direction,
          @strategySource,
          @triggerReason,
          @symbolClass,
          @session,
          @leverageCap,
          @confirmationRequired,
          @cooldownMinutes,
          @scopeKey,
          @domain,
          @signalClass,
          @marketRegime,
          @volatilityBucket,
          @liquidityBucket,
          @action,
          @sizeMultiplier,
          @thesisFailureRate,
          @negativePnlRate,
          @averageQualityScore,
          @sourceLearningCaseId,
          @sourceTradeId,
          @rationale,
          @evidencePayload,
          datetime('now')
        )
      `
    ).run({
      id,
      policyDomain: input.domain,
      policyKey,
      scopePayload,
      adjustmentType: toLegacyAdjustmentType(policyKey, input.action),
      newValue: legacyNewValue,
      delta: legacyDelta,
      evidenceCount,
      reasonSummary: rationale,
      confidence,
      active,
      expiresAt,
      symbol,
      direction,
      strategySource,
      triggerReason,
      symbolClass,
      session,
      leverageCap,
      confirmationRequired,
      cooldownMinutes,
      scopeKey,
      domain: input.domain,
      signalClass,
      marketRegime,
      volatilityBucket,
      liquidityBucket,
      action: input.action,
      sizeMultiplier,
      thesisFailureRate,
      negativePnlRate,
      averageQualityScore,
      sourceLearningCaseId,
      sourceTradeId,
      rationale,
      evidencePayload,
    });
  } else {
    db.prepare(
      `
        INSERT INTO trade_policy_adjustments (
          id,
          domain,
          policy_key,
          scope_key,
          symbol,
          direction,
          strategy_source,
          trigger_reason,
          signal_class,
          symbol_class,
          session_tag,
          market_regime,
          volatility_bucket,
          liquidity_bucket,
          action,
          size_multiplier,
          leverage_cap,
          confirmation_required,
          cooldown_minutes,
          confidence,
          evidence_count,
          thesis_failure_rate,
          negative_pnl_rate,
          average_quality_score,
          source_learning_case_id,
          source_trade_id,
          rationale,
          evidence_payload,
          expires_at,
          active
        ) VALUES (
          @id,
          @domain,
          @policyKey,
          @scopeKey,
          @symbol,
          @direction,
          @strategySource,
          @triggerReason,
          @signalClass,
          @symbolClass,
          @session,
          @marketRegime,
          @volatilityBucket,
          @liquidityBucket,
          @action,
          @sizeMultiplier,
          @leverageCap,
          @confirmationRequired,
          @cooldownMinutes,
          @confidence,
          @evidenceCount,
          @thesisFailureRate,
          @negativePnlRate,
          @averageQualityScore,
          @sourceLearningCaseId,
          @sourceTradeId,
          @rationale,
          @evidencePayload,
          @expiresAt,
          @active
        )
      `
    ).run({
      id,
      domain: input.domain,
      policyKey,
      scopeKey,
      symbol,
      direction,
      strategySource,
      triggerReason,
      signalClass,
      symbolClass,
      session,
      marketRegime,
      volatilityBucket,
      liquidityBucket,
      action: input.action,
      sizeMultiplier,
      leverageCap,
      confirmationRequired,
      cooldownMinutes,
      confidence,
      evidenceCount,
      thesisFailureRate,
      negativePnlRate,
      averageQualityScore,
      sourceLearningCaseId,
      sourceTradeId,
      rationale,
      evidencePayload,
      expiresAt,
      active,
    });
  }
  return getTradePolicyAdjustmentById(id);
}

export function replaceActiveTradePolicyAdjustment(
  input: TradePolicyAdjustmentInput
): TradePolicyAdjustmentRecord {
  deactivateByScope({
    domain: input.domain,
    scope: input,
    policyKey: normalizePolicyKey(input.policyKey, input.action),
  });
  return createTradePolicyAdjustment(input);
}

export function getTradePolicyAdjustmentById(id: string): TradePolicyAdjustmentRecord {
  const db = openDatabase();
  const row = db
    .prepare('SELECT * FROM trade_policy_adjustments WHERE id = ? LIMIT 1')
    .get(id) as TradePolicyAdjustmentRow | undefined;
  if (!row) {
    throw new Error(`Trade policy adjustment not found: ${id}`);
  }
  return toRecord(row);
}

export function listActiveTradePolicyAdjustments(input: {
  domain: string;
  symbol?: string | null;
  direction?: string | null;
  strategySource?: string | null;
  triggerReason?: string | null;
  signalClass?: string | null;
  symbolClass?: string | null;
  session?: string | null;
  marketRegime?: string | null;
  volatilityBucket?: string | null;
  liquidityBucket?: string | null;
}): TradePolicyAdjustmentRecord[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT *,
               (CASE WHEN symbol IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN direction IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN strategy_source IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN trigger_reason IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN signal_class IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN symbol_class IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN session_tag IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN market_regime IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN volatility_bucket IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN liquidity_bucket IS NOT NULL THEN 1 ELSE 0 END) AS specificity
        FROM trade_policy_adjustments
        WHERE domain = @domain
          AND active = 1
          AND (expires_at IS NULL OR expires_at > datetime('now'))
          AND (symbol IS NULL OR symbol = @symbol)
          AND (direction IS NULL OR direction = @direction)
          AND (strategy_source IS NULL OR strategy_source = @strategySource)
          AND (trigger_reason IS NULL OR trigger_reason = @triggerReason)
          AND (signal_class IS NULL OR signal_class = @signalClass)
          AND (symbol_class IS NULL OR symbol_class = @symbolClass)
          AND (session_tag IS NULL OR session_tag = @session)
          AND (market_regime IS NULL OR market_regime = @marketRegime)
          AND (volatility_bucket IS NULL OR volatility_bucket = @volatilityBucket)
          AND (liquidity_bucket IS NULL OR liquidity_bucket = @liquidityBucket)
        ORDER BY specificity DESC, updated_at DESC, created_at DESC
      `
    )
    .all({
      domain: input.domain,
      symbol: normalizeScopeValue(input.symbol),
      direction: normalizeScopeValue(input.direction),
      strategySource: normalizeScopeValue(input.strategySource),
      triggerReason: normalizeScopeValue(input.triggerReason),
      signalClass: normalizeScopeValue(input.signalClass),
      symbolClass: normalizeScopeValue(input.symbolClass),
      session: normalizeScopeValue(input.session),
      marketRegime: normalizeScopeValue(input.marketRegime),
      volatilityBucket: normalizeScopeValue(input.volatilityBucket),
      liquidityBucket: normalizeScopeValue(input.liquidityBucket),
    }) as TradePolicyAdjustmentRow[];
  return rows.map(toRecord);
}

export function selectActiveTradePolicyAdjustment(input: {
  domain: string;
  symbol?: string | null;
  direction?: string | null;
  strategySource?: string | null;
  triggerReason?: string | null;
  signalClass?: string | null;
  symbolClass?: string | null;
  session?: string | null;
  marketRegime?: string | null;
  volatilityBucket?: string | null;
  liquidityBucket?: string | null;
}): TradePolicyAdjustmentRecord | null {
  return listActiveTradePolicyAdjustments(input)[0] ?? null;
}

export function listTradePolicyAdjustments(domain?: string): TradePolicyAdjustmentRecord[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM trade_policy_adjustments
        WHERE (? IS NULL OR domain = ?)
        ORDER BY created_at DESC, id DESC
      `
    )
    .all(domain ?? null, domain ?? null) as TradePolicyAdjustmentRow[];
  return rows.map(toRecord);
}
