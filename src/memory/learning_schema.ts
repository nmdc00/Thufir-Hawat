import type Database from 'better-sqlite3';

export const LEARNING_EXAMPLES_VIEW_SQL = `CREATE VIEW learning_examples AS
SELECT
  id,
  domain,
  regime_tag           AS regime,
  strategy_class,
  symbol,
  model_probability,
  market_probability,
  executed,
  position_size,
  CASE WHEN outcome = 'YES' THEN 1 ELSE 0 END                               AS outcome_value,
  pnl,
  (model_probability  - CASE WHEN outcome = 'YES' THEN 1.0 ELSE 0.0 END)
  * (model_probability  - CASE WHEN outcome = 'YES' THEN 1.0 ELSE 0.0 END)  AS brier_model,
  (market_probability - CASE WHEN outcome = 'YES' THEN 1.0 ELSE 0.0 END)
  * (market_probability - CASE WHEN outcome = 'YES' THEN 1.0 ELSE 0.0 END)  AS brier_market,
  created_at,
  outcome_timestamp    AS resolved_at
FROM predictions
WHERE outcome_basis     = 'final'
  AND model_probability  IS NOT NULL
  AND market_probability IS NOT NULL
  AND learning_comparable = 1
  AND outcome            IS NOT NULL;`;

export const LEARNING_CASES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS learning_cases (
    id TEXT PRIMARY KEY,
    case_type TEXT NOT NULL CHECK(case_type IN ('comparable_forecast', 'execution_quality', 'thesis_quality', 'intervention_quality', 'regret_case')),
    domain TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    comparable INTEGER NOT NULL CHECK(comparable IN (0, 1)),
    comparator_kind TEXT,
    source_prediction_id TEXT,
    source_trade_id INTEGER,
    source_dossier_id TEXT,
    source_hypothesis_id TEXT,
    source_artifact_id INTEGER,
    belief_payload TEXT,
    baseline_payload TEXT,
    context_payload TEXT,
    action_payload TEXT,
    outcome_payload TEXT,
    quality_payload TEXT,
    policy_input_payload TEXT,
    exclusion_reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);`;

const LEARNING_CASES_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_type ON learning_cases(case_type);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_domain ON learning_cases(domain);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_comparable ON learning_cases(comparable);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_prediction ON learning_cases(source_prediction_id);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_trade ON learning_cases(source_trade_id);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_dossier ON learning_cases(source_dossier_id);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_hypothesis ON learning_cases(source_hypothesis_id);',
  'CREATE INDEX IF NOT EXISTS idx_learning_cases_entity ON learning_cases(entity_type, entity_id);',
];

const COMPARABLE_LEARNING_CASES_VIEW_SQL = `CREATE VIEW comparable_learning_cases AS
SELECT *
FROM learning_cases
WHERE case_type = 'comparable_forecast'
  AND comparable = 1;`;

const EXECUTION_LEARNING_CASES_VIEW_SQL = `CREATE VIEW execution_learning_cases AS
SELECT *
FROM learning_cases
WHERE case_type = 'execution_quality';`;

const LEARNING_SIGNAL_AUDITS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS learning_signal_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    learning_event_id INTEGER,
    domain TEXT NOT NULL,
    signal_scores TEXT NOT NULL,
    baseline_weights TEXT NOT NULL,
    decision_weights TEXT NOT NULL,
    active_weights_before TEXT NOT NULL,
    active_weights_after TEXT NOT NULL,
    weight_delta TEXT NOT NULL,
    baseline_score REAL,
    decision_score REAL,
    active_score_before REAL,
    active_score_after REAL,
    outcome_value INTEGER NOT NULL CHECK(outcome_value IN (0, 1)),
    changed INTEGER NOT NULL CHECK(changed IN (0, 1)),
    created_at TEXT DEFAULT (datetime('now'))
);`;

const LEARNING_SIGNAL_AUDITS_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_learning_signal_audits_event ON learning_signal_audits(learning_event_id);',
  'CREATE INDEX IF NOT EXISTS idx_learning_signal_audits_domain ON learning_signal_audits(domain);',
];

const TRADE_POLICY_ADJUSTMENTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS trade_policy_adjustments (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    policy_key TEXT NOT NULL DEFAULT 'size',
    scope_key TEXT NOT NULL,
    symbol TEXT,
    direction TEXT,
    strategy_source TEXT,
    trigger_reason TEXT,
    signal_class TEXT,
    symbol_class TEXT,
    session_tag TEXT,
    market_regime TEXT,
    volatility_bucket TEXT,
    liquidity_bucket TEXT,
    action TEXT NOT NULL CHECK(action IN ('downweight', 'block', 'cap_leverage', 'require_confirmation', 'cooldown')),
    size_multiplier REAL NOT NULL,
    leverage_cap REAL,
    confirmation_required INTEGER,
    cooldown_minutes INTEGER,
    confidence REAL,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    thesis_failure_rate REAL,
    negative_pnl_rate REAL,
    average_quality_score REAL,
    sample_count INTEGER,
    source_learning_case_id TEXT,
    source_trade_id INTEGER,
    source_trade_close_id TEXT,
    rationale TEXT,
    reason TEXT,
    evidence_payload TEXT,
    expires_at TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);`;

const TRADE_POLICY_ADJUSTMENTS_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_trade_policy_adjustments_scope ON trade_policy_adjustments(scope_key);',
  'CREATE INDEX IF NOT EXISTS idx_trade_policy_adjustments_active ON trade_policy_adjustments(active, domain);',
  'CREATE INDEX IF NOT EXISTS idx_trade_policy_adjustments_policy_scope ON trade_policy_adjustments(domain, policy_key, active, scope_key);',
  'CREATE INDEX IF NOT EXISTS idx_trade_policy_adjustments_signal ON trade_policy_adjustments(signal_class, trigger_reason, symbol_class, market_regime, session_tag, strategy_source, direction);',
];

export const CLOSE_TRADE_FINALIZER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trade_close_events (
    id TEXT PRIMARY KEY,
    lifecycle_id TEXT NOT NULL,
    trade_id INTEGER,
    symbol TEXT NOT NULL,
    execution_mode TEXT CHECK(execution_mode IN ('paper', 'live')),
    side TEXT CHECK(side IN ('buy', 'sell')),
    close_kind TEXT NOT NULL CHECK(close_kind IN ('partial_reduce', 'full_close')),
    size_reduced REAL,
    remaining_size REAL,
    realized_pnl_usd REAL,
    net_realized_pnl_usd REAL,
    realized_fee_usd REAL,
    exit_price REAL,
    exit_mode TEXT,
    thesis_invalidation_hit INTEGER CHECK(thesis_invalidation_hit IN (0, 1) OR thesis_invalidation_hit IS NULL),
    source_authority TEXT,
    entry_journal_payload TEXT,
    close_journal_payload TEXT,
    snapshot_payload TEXT,
    bootstrap_quality TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_close_events_trade_kind
ON trade_close_events(trade_id, close_kind, created_at);
CREATE INDEX IF NOT EXISTS idx_trade_close_events_symbol ON trade_close_events(symbol);
CREATE INDEX IF NOT EXISTS idx_trade_close_events_kind ON trade_close_events(close_kind);
CREATE INDEX IF NOT EXISTS idx_trade_close_events_mode ON trade_close_events(execution_mode);
CREATE INDEX IF NOT EXISTS idx_trade_close_events_created ON trade_close_events(created_at);

CREATE TABLE IF NOT EXISTS close_finalization_jobs (
    id TEXT PRIMARY KEY,
    close_event_id TEXT NOT NULL UNIQUE,
    lifecycle_id TEXT NOT NULL,
    trade_id INTEGER,
    symbol TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'finalized', 'failed_retryable', 'failed_terminal')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at TEXT,
    last_error TEXT,
    next_attempt_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    finalized_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_close_finalization_jobs_status ON close_finalization_jobs(status);
CREATE INDEX IF NOT EXISTS idx_close_finalization_jobs_symbol ON close_finalization_jobs(symbol);
CREATE INDEX IF NOT EXISTS idx_close_finalization_jobs_next_attempt ON close_finalization_jobs(next_attempt_at);

CREATE TABLE IF NOT EXISTS trade_closes (
    id TEXT PRIMARY KEY,
    close_event_id TEXT NOT NULL UNIQUE,
    lifecycle_id TEXT NOT NULL,
    trade_id INTEGER,
    symbol TEXT NOT NULL,
    closed_side TEXT CHECK(closed_side IN ('long', 'short')),
    execution_mode TEXT CHECK(execution_mode IN ('paper', 'live')),
    opened_at TEXT,
    closed_at TEXT NOT NULL,
    hold_seconds INTEGER,
    entry_price REAL,
    exit_price REAL,
    total_opened_size REAL,
    total_reduced_size REAL,
    final_close_size REAL,
    gross_realized_pnl_usd REAL,
    fees_usd REAL,
    net_realized_pnl_usd REAL,
    captured_r REAL,
    left_on_table_r REAL,
    exit_mode TEXT,
    thesis_invalidation_hit INTEGER CHECK(thesis_invalidation_hit IN (0, 1) OR thesis_invalidation_hit IS NULL),
    thesis_correct INTEGER CHECK(thesis_correct IN (0, 1) OR thesis_correct IS NULL),
    direction_score REAL,
    timing_score REAL,
    sizing_score REAL,
    exit_score REAL,
    composite_score REAL,
    linked_prediction_id TEXT,
    source_learning_case_id TEXT,
    source_authority TEXT,
    bootstrap_quality TEXT,
    deterministic_status TEXT NOT NULL DEFAULT 'finalized',
    llm_reflection_status TEXT NOT NULL DEFAULT 'not_requested',
    facts_payload TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_trade_closes_symbol ON trade_closes(symbol);
CREATE INDEX IF NOT EXISTS idx_trade_closes_trade ON trade_closes(trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_closes_mode ON trade_closes(execution_mode);
CREATE INDEX IF NOT EXISTS idx_trade_closes_closed_at ON trade_closes(closed_at);

CREATE TABLE IF NOT EXISTS trade_reflections (
    id TEXT PRIMARY KEY,
    trade_close_id TEXT NOT NULL UNIQUE,
    thesis_correct INTEGER CHECK(thesis_correct IN (0, 1) OR thesis_correct IS NULL),
    timing_correct INTEGER CHECK(timing_correct IN (0, 1) OR timing_correct IS NULL),
    exit_reason_appropriate INTEGER CHECK(exit_reason_appropriate IN (0, 1) OR exit_reason_appropriate IS NULL),
    what_worked TEXT,
    what_failed TEXT,
    lesson_for_next_trade TEXT,
    source_facts TEXT,
    confidence REAL,
    llm_status TEXT NOT NULL DEFAULT 'not_requested',
    llm_payload TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_trade_reflections_close ON trade_reflections(trade_close_id);

CREATE TABLE IF NOT EXISTS regret_learning_cases (
    id TEXT PRIMARY KEY,
    trade_close_id TEXT NOT NULL,
    lifecycle_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    regret_type TEXT NOT NULL,
    severity REAL,
    evidence_payload TEXT,
    policy_evidence_payload TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_regret_learning_cases_close ON regret_learning_cases(trade_close_id);
CREATE INDEX IF NOT EXISTS idx_regret_learning_cases_symbol ON regret_learning_cases(symbol);
CREATE INDEX IF NOT EXISTS idx_regret_learning_cases_type ON regret_learning_cases(regret_type);

CREATE TABLE IF NOT EXISTS policy_promotion_events (
    id TEXT PRIMARY KEY,
    adjustment_id TEXT,
    trade_close_id TEXT,
    learning_case_id TEXT,
    scope_key TEXT NOT NULL,
    action TEXT NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    payload TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_policy_promotion_events_scope ON policy_promotion_events(scope_key);
CREATE INDEX IF NOT EXISTS idx_policy_promotion_events_created ON policy_promotion_events(created_at);
`;

const CANONICAL_TRADE_POLICY_SYMBOL_CLASS_SQL = `CASE
  WHEN symbol IS NULL OR TRIM(symbol) = '' THEN NULL
  WHEN UPPER(TRIM(symbol)) = 'BTC' OR UPPER(TRIM(symbol)) LIKE '%BTC' THEN 'major'
  WHEN UPPER(TRIM(symbol)) = 'ETH' OR UPPER(TRIM(symbol)) LIKE '%ETH'
    OR UPPER(TRIM(symbol)) = 'SOL' OR UPPER(TRIM(symbol)) LIKE '%SOL' THEN 'liquid_alt'
  WHEN UPPER(TRIM(symbol)) LIKE 'XYZ:%' AND (
    UPPER(TRIM(symbol)) LIKE '%COIN' OR UPPER(TRIM(symbol)) LIKE '%MSTR'
  ) THEN 'equity_proxy'
  WHEN UPPER(TRIM(symbol)) LIKE 'XYZ:%' THEN 'macro_contract'
  WHEN UPPER(TRIM(symbol)) LIKE 'FLX:%' THEN 'alt_perp'
  WHEN INSTR(symbol, '/') > 0 THEN 'spot_pair'
  ELSE 'alt'
END`;

const TRADE_POLICY_SCOPE_KEY_FROM_COLUMNS_SQL = `'symbol=' || COALESCE(NULLIF(TRIM(symbol), ''), 'any') ||
  '|direction=' || COALESCE(NULLIF(TRIM(direction), ''), 'any') ||
  '|strategySource=' || COALESCE(NULLIF(TRIM(strategy_source), ''), 'any') ||
  '|triggerReason=' || COALESCE(NULLIF(TRIM(trigger_reason), ''), 'any') ||
  '|signalClass=' || COALESCE(NULLIF(TRIM(signal_class), ''), 'any') ||
  '|symbolClass=' || COALESCE(NULLIF(TRIM(symbol_class), ''), 'any') ||
  '|session=' || COALESCE(NULLIF(TRIM(session_tag), ''), 'any') ||
  '|marketRegime=' || COALESCE(NULLIF(TRIM(market_regime), ''), 'any') ||
  '|volatilityBucket=' || COALESCE(NULLIF(TRIM(volatility_bucket), ''), 'any') ||
  '|liquidityBucket=' || COALESCE(NULLIF(TRIM(liquidity_bucket), ''), 'any')`;

type ColumnSpec = {
  name: string;
  sql: string;
};

const LEARNING_CASE_COLUMNS: ColumnSpec[] = [
  { name: 'source_dossier_id', sql: 'ALTER TABLE learning_cases ADD COLUMN source_dossier_id TEXT' },
  { name: 'source_hypothesis_id', sql: 'ALTER TABLE learning_cases ADD COLUMN source_hypothesis_id TEXT' },
];

const TRADE_POLICY_ADJUSTMENT_COLUMNS: ColumnSpec[] = [
  { name: 'domain', sql: "ALTER TABLE trade_policy_adjustments ADD COLUMN domain TEXT NOT NULL DEFAULT 'perp'" },
  { name: 'policy_key', sql: "ALTER TABLE trade_policy_adjustments ADD COLUMN policy_key TEXT NOT NULL DEFAULT 'size'" },
  { name: 'scope_key', sql: "ALTER TABLE trade_policy_adjustments ADD COLUMN scope_key TEXT NOT NULL DEFAULT ''" },
  { name: 'symbol', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN symbol TEXT' },
  { name: 'direction', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN direction TEXT' },
  { name: 'strategy_source', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN strategy_source TEXT' },
  { name: 'trigger_reason', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN trigger_reason TEXT' },
  { name: 'signal_class', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN signal_class TEXT' },
  { name: 'symbol_class', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN symbol_class TEXT' },
  { name: 'session_tag', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN session_tag TEXT' },
  { name: 'market_regime', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN market_regime TEXT' },
  { name: 'volatility_bucket', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN volatility_bucket TEXT' },
  { name: 'liquidity_bucket', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN liquidity_bucket TEXT' },
  { name: 'action', sql: "ALTER TABLE trade_policy_adjustments ADD COLUMN action TEXT NOT NULL DEFAULT 'downweight'" },
  { name: 'size_multiplier', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN size_multiplier REAL NOT NULL DEFAULT 1' },
  { name: 'leverage_cap', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN leverage_cap REAL' },
  { name: 'confirmation_required', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN confirmation_required INTEGER' },
  { name: 'cooldown_minutes', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN cooldown_minutes INTEGER' },
  { name: 'thesis_failure_rate', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN thesis_failure_rate REAL' },
  { name: 'negative_pnl_rate', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN negative_pnl_rate REAL' },
  { name: 'average_quality_score', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN average_quality_score REAL' },
  { name: 'sample_count', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN sample_count INTEGER' },
  { name: 'source_learning_case_id', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN source_learning_case_id TEXT' },
  { name: 'source_trade_id', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN source_trade_id INTEGER' },
  { name: 'source_trade_close_id', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN source_trade_close_id TEXT' },
  { name: 'rationale', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN rationale TEXT' },
  { name: 'reason', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN reason TEXT' },
  { name: 'evidence_payload', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN evidence_payload TEXT' },
  { name: 'expires_at', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN expires_at TEXT' },
  { name: 'updated_at', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN updated_at TEXT' },
];

const CLOSE_FINALIZER_COLUMN_REPAIRS: Record<string, ColumnSpec[]> = {
  trade_close_events: [
    { name: 'lifecycle_id', sql: 'ALTER TABLE trade_close_events ADD COLUMN lifecycle_id TEXT' },
    { name: 'trade_id', sql: 'ALTER TABLE trade_close_events ADD COLUMN trade_id INTEGER' },
    { name: 'symbol', sql: 'ALTER TABLE trade_close_events ADD COLUMN symbol TEXT' },
    { name: 'execution_mode', sql: 'ALTER TABLE trade_close_events ADD COLUMN execution_mode TEXT' },
    { name: 'side', sql: 'ALTER TABLE trade_close_events ADD COLUMN side TEXT' },
    { name: 'close_kind', sql: "ALTER TABLE trade_close_events ADD COLUMN close_kind TEXT DEFAULT 'full_close'" },
    { name: 'size_reduced', sql: 'ALTER TABLE trade_close_events ADD COLUMN size_reduced REAL' },
    { name: 'remaining_size', sql: 'ALTER TABLE trade_close_events ADD COLUMN remaining_size REAL' },
    { name: 'realized_pnl_usd', sql: 'ALTER TABLE trade_close_events ADD COLUMN realized_pnl_usd REAL' },
    { name: 'net_realized_pnl_usd', sql: 'ALTER TABLE trade_close_events ADD COLUMN net_realized_pnl_usd REAL' },
    { name: 'realized_fee_usd', sql: 'ALTER TABLE trade_close_events ADD COLUMN realized_fee_usd REAL' },
    { name: 'exit_price', sql: 'ALTER TABLE trade_close_events ADD COLUMN exit_price REAL' },
    { name: 'exit_mode', sql: 'ALTER TABLE trade_close_events ADD COLUMN exit_mode TEXT' },
    { name: 'thesis_invalidation_hit', sql: 'ALTER TABLE trade_close_events ADD COLUMN thesis_invalidation_hit INTEGER' },
    { name: 'source_authority', sql: 'ALTER TABLE trade_close_events ADD COLUMN source_authority TEXT' },
    { name: 'entry_journal_payload', sql: 'ALTER TABLE trade_close_events ADD COLUMN entry_journal_payload TEXT' },
    { name: 'close_journal_payload', sql: 'ALTER TABLE trade_close_events ADD COLUMN close_journal_payload TEXT' },
    { name: 'snapshot_payload', sql: 'ALTER TABLE trade_close_events ADD COLUMN snapshot_payload TEXT' },
    { name: 'bootstrap_quality', sql: 'ALTER TABLE trade_close_events ADD COLUMN bootstrap_quality TEXT' },
    { name: 'created_at', sql: 'ALTER TABLE trade_close_events ADD COLUMN created_at TEXT' },
    { name: 'updated_at', sql: 'ALTER TABLE trade_close_events ADD COLUMN updated_at TEXT' },
  ],
  close_finalization_jobs: [
    { name: 'close_event_id', sql: 'ALTER TABLE close_finalization_jobs ADD COLUMN close_event_id TEXT' },
    { name: 'lifecycle_id', sql: 'ALTER TABLE close_finalization_jobs ADD COLUMN lifecycle_id TEXT' },
    { name: 'trade_id', sql: 'ALTER TABLE close_finalization_jobs ADD COLUMN trade_id INTEGER' },
    { name: 'symbol', sql: 'ALTER TABLE close_finalization_jobs ADD COLUMN symbol TEXT' },
    { name: 'status', sql: "ALTER TABLE close_finalization_jobs ADD COLUMN status TEXT DEFAULT 'pending'" },
    { name: 'attempts', sql: 'ALTER TABLE close_finalization_jobs ADD COLUMN attempts INTEGER DEFAULT 0' },
    { name: 'lease_owner', sql: 'ALTER TABLE close_finalization_jobs ADD COLUMN lease_owner TEXT' },
    { name: 'lease_expires_at', sql: 'ALTER TABLE close_finalization_jobs ADD COLUMN lease_expires_at TEXT' },
    { name: 'last_error', sql: 'ALTER TABLE close_finalization_jobs ADD COLUMN last_error TEXT' },
    { name: 'next_attempt_at', sql: 'ALTER TABLE close_finalization_jobs ADD COLUMN next_attempt_at TEXT' },
    { name: 'created_at', sql: 'ALTER TABLE close_finalization_jobs ADD COLUMN created_at TEXT' },
    { name: 'updated_at', sql: 'ALTER TABLE close_finalization_jobs ADD COLUMN updated_at TEXT' },
    { name: 'finalized_at', sql: 'ALTER TABLE close_finalization_jobs ADD COLUMN finalized_at TEXT' },
  ],
  trade_closes: [
    { name: 'id', sql: 'ALTER TABLE trade_closes ADD COLUMN id TEXT' },
    { name: 'close_event_id', sql: 'ALTER TABLE trade_closes ADD COLUMN close_event_id TEXT' },
    { name: 'lifecycle_id', sql: 'ALTER TABLE trade_closes ADD COLUMN lifecycle_id TEXT' },
    { name: 'trade_id', sql: 'ALTER TABLE trade_closes ADD COLUMN trade_id INTEGER' },
    { name: 'symbol', sql: 'ALTER TABLE trade_closes ADD COLUMN symbol TEXT' },
    { name: 'closed_side', sql: 'ALTER TABLE trade_closes ADD COLUMN closed_side TEXT' },
    { name: 'execution_mode', sql: 'ALTER TABLE trade_closes ADD COLUMN execution_mode TEXT' },
    { name: 'opened_at', sql: 'ALTER TABLE trade_closes ADD COLUMN opened_at TEXT' },
    { name: 'closed_at', sql: 'ALTER TABLE trade_closes ADD COLUMN closed_at TEXT' },
    { name: 'hold_seconds', sql: 'ALTER TABLE trade_closes ADD COLUMN hold_seconds INTEGER' },
    { name: 'entry_price', sql: 'ALTER TABLE trade_closes ADD COLUMN entry_price REAL' },
    { name: 'exit_price', sql: 'ALTER TABLE trade_closes ADD COLUMN exit_price REAL' },
    { name: 'total_opened_size', sql: 'ALTER TABLE trade_closes ADD COLUMN total_opened_size REAL' },
    { name: 'total_reduced_size', sql: 'ALTER TABLE trade_closes ADD COLUMN total_reduced_size REAL' },
    { name: 'final_close_size', sql: 'ALTER TABLE trade_closes ADD COLUMN final_close_size REAL' },
    { name: 'gross_realized_pnl_usd', sql: 'ALTER TABLE trade_closes ADD COLUMN gross_realized_pnl_usd REAL' },
    { name: 'fees_usd', sql: 'ALTER TABLE trade_closes ADD COLUMN fees_usd REAL' },
    { name: 'net_realized_pnl_usd', sql: 'ALTER TABLE trade_closes ADD COLUMN net_realized_pnl_usd REAL' },
    { name: 'captured_r', sql: 'ALTER TABLE trade_closes ADD COLUMN captured_r REAL' },
    { name: 'left_on_table_r', sql: 'ALTER TABLE trade_closes ADD COLUMN left_on_table_r REAL' },
    { name: 'exit_mode', sql: 'ALTER TABLE trade_closes ADD COLUMN exit_mode TEXT' },
    { name: 'thesis_invalidation_hit', sql: 'ALTER TABLE trade_closes ADD COLUMN thesis_invalidation_hit INTEGER' },
    { name: 'thesis_correct', sql: 'ALTER TABLE trade_closes ADD COLUMN thesis_correct INTEGER' },
    { name: 'direction_score', sql: 'ALTER TABLE trade_closes ADD COLUMN direction_score REAL' },
    { name: 'timing_score', sql: 'ALTER TABLE trade_closes ADD COLUMN timing_score REAL' },
    { name: 'sizing_score', sql: 'ALTER TABLE trade_closes ADD COLUMN sizing_score REAL' },
    { name: 'exit_score', sql: 'ALTER TABLE trade_closes ADD COLUMN exit_score REAL' },
    { name: 'composite_score', sql: 'ALTER TABLE trade_closes ADD COLUMN composite_score REAL' },
    { name: 'linked_prediction_id', sql: 'ALTER TABLE trade_closes ADD COLUMN linked_prediction_id TEXT' },
    { name: 'source_learning_case_id', sql: 'ALTER TABLE trade_closes ADD COLUMN source_learning_case_id TEXT' },
    { name: 'source_authority', sql: 'ALTER TABLE trade_closes ADD COLUMN source_authority TEXT' },
    { name: 'bootstrap_quality', sql: 'ALTER TABLE trade_closes ADD COLUMN bootstrap_quality TEXT' },
    { name: 'deterministic_status', sql: "ALTER TABLE trade_closes ADD COLUMN deterministic_status TEXT DEFAULT 'finalized'" },
    { name: 'llm_reflection_status', sql: "ALTER TABLE trade_closes ADD COLUMN llm_reflection_status TEXT DEFAULT 'not_requested'" },
    { name: 'facts_payload', sql: 'ALTER TABLE trade_closes ADD COLUMN facts_payload TEXT' },
    { name: 'reflection_payload', sql: 'ALTER TABLE trade_closes ADD COLUMN reflection_payload TEXT' },
    { name: 'created_at', sql: 'ALTER TABLE trade_closes ADD COLUMN created_at TEXT' },
    { name: 'updated_at', sql: 'ALTER TABLE trade_closes ADD COLUMN updated_at TEXT' },
  ],
  trade_reflections: [
    { name: 'trade_close_id', sql: 'ALTER TABLE trade_reflections ADD COLUMN trade_close_id TEXT' },
    { name: 'thesis_correct', sql: 'ALTER TABLE trade_reflections ADD COLUMN thesis_correct INTEGER' },
    { name: 'timing_correct', sql: 'ALTER TABLE trade_reflections ADD COLUMN timing_correct INTEGER' },
    { name: 'exit_reason_appropriate', sql: 'ALTER TABLE trade_reflections ADD COLUMN exit_reason_appropriate INTEGER' },
    { name: 'what_worked_payload', sql: 'ALTER TABLE trade_reflections ADD COLUMN what_worked_payload TEXT' },
    { name: 'what_failed_payload', sql: 'ALTER TABLE trade_reflections ADD COLUMN what_failed_payload TEXT' },
    { name: 'lesson_for_next_trade_payload', sql: 'ALTER TABLE trade_reflections ADD COLUMN lesson_for_next_trade_payload TEXT' },
    { name: 'source_facts_payload', sql: 'ALTER TABLE trade_reflections ADD COLUMN source_facts_payload TEXT' },
    { name: 'llm_reflection_payload', sql: 'ALTER TABLE trade_reflections ADD COLUMN llm_reflection_payload TEXT' },
    { name: 'confidence', sql: 'ALTER TABLE trade_reflections ADD COLUMN confidence REAL' },
    { name: 'created_at', sql: 'ALTER TABLE trade_reflections ADD COLUMN created_at TEXT' },
    { name: 'updated_at', sql: 'ALTER TABLE trade_reflections ADD COLUMN updated_at TEXT' },
  ],
};
export const LEGACY_PERP_CONTAMINATION_WHERE_SQL = `domain = 'perp'
  AND outcome_basis = 'final'
  AND predicted_outcome IN ('YES', 'NO')
  AND model_probability IS NOT NULL
  AND market_probability = 0.5
  AND learning_comparable = 1`;

export const OPEN_SYNTHETIC_PERP_COMPARABLE_WHERE_SQL = `domain = 'perp'
  AND predicted_outcome IN ('YES', 'NO')
  AND model_probability IS NOT NULL
  AND market_probability = 0.5
  AND learning_comparable = 1`;

export const SYNTHETIC_PERP_COMPARABLE_LEARNING_CASE_WHERE_SQL = `case_type = 'comparable_forecast'
  AND domain = 'perp'
  AND comparable = 1
  AND comparator_kind = 'market_price'
  AND json_extract(baseline_payload, '$.marketProbability') = 0.5`;

function hasPredictionColumns(db: Database.Database, columnNames: string[]): boolean {
  const hasPredictionsTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'predictions' LIMIT 1")
    .get();
  if (!hasPredictionsTable) {
    return false;
  }

  const columns = db.prepare("PRAGMA table_info('predictions')").all() as Array<{ name?: string }>;
  const present = new Set(columns.map((column) => String(column.name ?? '')));
  return columnNames.every((name) => present.has(name));
}

export function ensureLearningSchema(db: Database.Database): void {
  db.exec(LEARNING_CASES_TABLE_SQL);
  ensureLearningCaseColumns(db);
  for (const statement of LEARNING_CASES_INDEX_SQL) {
    db.exec(statement);
  }
  db.exec(LEARNING_SIGNAL_AUDITS_TABLE_SQL);
  for (const statement of LEARNING_SIGNAL_AUDITS_INDEX_SQL) {
    db.exec(statement);
  }
  dropLegacyCloseFinalizerViews(db);
  repairLegacyCloseFinalizerColumns(db);
  db.exec(CLOSE_TRADE_FINALIZER_SCHEMA_SQL);
  ensureCloseFinalizerCompatibility(db);
  db.exec(TRADE_POLICY_ADJUSTMENTS_TABLE_SQL);
  ensureTradePolicyAdjustmentColumns(db);
  for (const statement of TRADE_POLICY_ADJUSTMENTS_INDEX_SQL) {
    db.exec(statement);
  }
  repairActiveTradePolicyAdjustmentScopeMismatches(db);

  cleanupSyntheticPerpComparableRows(db);
  cleanupSyntheticPerpComparableLearningCases(db);

  // Recreate views explicitly so older definitions do not survive forever.
  db.exec('DROP VIEW IF EXISTS learning_examples;');
  db.exec(LEARNING_EXAMPLES_VIEW_SQL);
  db.exec('DROP VIEW IF EXISTS comparable_learning_cases;');
  db.exec(COMPARABLE_LEARNING_CASES_VIEW_SQL);
  db.exec('DROP VIEW IF EXISTS execution_learning_cases;');
  db.exec(EXECUTION_LEARNING_CASES_VIEW_SQL);
}

function ensureCloseFinalizerCompatibility(db: Database.Database): void {
  const hasTable = (table: string): boolean =>
    Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table));
  const hasColumn = (table: string, column: string): boolean => {
    if (!hasTable(table)) return false;
    const columns = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name?: string }>;
    return columns.some((row) => String(row.name ?? '') === column);
  };

  if (hasColumn('close_finalization_jobs', 'close_event_id')) {
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_close_finalization_jobs_close_event_unique ON close_finalization_jobs(close_event_id)'
    );
  }
  if (hasColumn('trade_closes', 'close_event_id')) {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_closes_close_event_unique ON trade_closes(close_event_id)');
  }
  if (hasColumn('trade_reflections', 'trade_close_id')) {
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_reflections_trade_close_unique ON trade_reflections(trade_close_id)'
    );
  }
}

function ensureLearningCaseColumns(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info('learning_cases')").all() as Array<{ name?: string }>;
  const present = new Set(columns.map((column) => String(column.name ?? '')));
  for (const column of LEARNING_CASE_COLUMNS) {
    if (!present.has(column.name)) {
      db.exec(column.sql);
    }
  }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(tableName)
  );
}

function dropLegacyCloseFinalizerViews(db: Database.Database): void {
  for (const viewName of ['trade_close_events', 'close_finalization_jobs', 'trade_closes', 'trade_reflections', 'regret_learning_cases', 'policy_promotion_events']) {
    const row = db
      .prepare("SELECT type FROM sqlite_master WHERE name = ? LIMIT 1")
      .get(viewName) as { type?: string } | undefined;
    if (row?.type === 'view') {
      db.exec(`DROP VIEW IF EXISTS ${viewName}`);
    }
  }
}

function backfillLegacyCloseFinalizerColumns(db: Database.Database): void {
  if (tableExists(db, 'trade_closes')) {
    const rows = db.prepare("PRAGMA table_info('trade_closes')").all() as Array<{ name?: string }>;
    const present = new Set(rows.map((row) => String(row.name ?? '')));
    if (present.has('id')) {
      const sourceExpression = present.has('close_event_id') && present.has('trade_id')
        ? "COALESCE(NULLIF(TRIM(id), ''), NULLIF(TRIM(close_event_id), ''), CAST(trade_id AS TEXT))"
        : present.has('trade_id')
          ? "COALESCE(NULLIF(TRIM(id), ''), CAST(trade_id AS TEXT))"
          : "COALESCE(NULLIF(TRIM(id), ''), rowid)";
      db.exec(`
        UPDATE trade_closes
        SET id = ${sourceExpression}
        WHERE id IS NULL OR TRIM(id) = ''
      `);
    }
  }
}

function repairLegacyCloseFinalizerColumns(db: Database.Database): void {
  for (const [tableName, columns] of Object.entries(CLOSE_FINALIZER_COLUMN_REPAIRS)) {
    if (!tableExists(db, tableName)) {
      continue;
    }
    const rows = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name?: string }>;
    const present = new Set(rows.map((row) => String(row.name ?? '')));
    for (const column of columns) {
      if (!present.has(column.name)) {
        db.exec(column.sql);
      }
    }
  }
  backfillLegacyCloseFinalizerColumns(db);
}

function ensureTradePolicyAdjustmentColumns(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info('trade_policy_adjustments')").all() as Array<{ name?: string }>;
  const present = new Set(columns.map((column) => String(column.name ?? '')));
  for (const column of TRADE_POLICY_ADJUSTMENT_COLUMNS) {
    if (!present.has(column.name)) {
      db.exec(column.sql);
    }
  }
  const updatedColumns = db.prepare("PRAGMA table_info('trade_policy_adjustments')").all() as Array<{ name?: string }>;
  const updatedPresent = new Set(updatedColumns.map((column) => String(column.name ?? '')));
  backfillLegacyTradePolicyAdjustmentColumns(db, updatedPresent);
  backfillTradePolicyAdjustmentScopeKeys(db);
}

function backfillLegacyTradePolicyAdjustmentColumns(db: Database.Database, present: Set<string>): void {
  if (present.has('policy_domain') && present.has('domain')) {
    db.exec(`
      UPDATE trade_policy_adjustments
      SET domain = COALESCE(NULLIF(TRIM(domain), ''), policy_domain, 'perp')
      WHERE domain IS NULL OR TRIM(domain) = ''
    `);
  }

  if (present.has('reason_summary') && present.has('rationale')) {
    db.exec(`
      UPDATE trade_policy_adjustments
      SET rationale = COALESCE(NULLIF(TRIM(rationale), ''), reason_summary)
      WHERE rationale IS NULL OR TRIM(rationale) = ''
    `);
  }

  if (present.has('rationale') && present.has('reason')) {
    db.exec(`
      UPDATE trade_policy_adjustments
      SET reason = COALESCE(NULLIF(TRIM(reason), ''), rationale)
      WHERE reason IS NULL OR TRIM(reason) = ''
    `);
  }

  if (present.has('evidence_count') && present.has('sample_count')) {
    db.exec(`
      UPDATE trade_policy_adjustments
      SET sample_count = COALESCE(sample_count, evidence_count)
      WHERE sample_count IS NULL
    `);
  }

  if (present.has('created_at') && present.has('updated_at')) {
    db.exec(`
      UPDATE trade_policy_adjustments
      SET updated_at = COALESCE(updated_at, created_at, datetime('now'))
      WHERE updated_at IS NULL OR TRIM(updated_at) = ''
    `);
  }

  if (present.has('scope_payload')) {
    if (present.has('signal_class')) {
      db.exec(`
        UPDATE trade_policy_adjustments
        SET signal_class = COALESCE(NULLIF(TRIM(signal_class), ''), json_extract(scope_payload, '$.signalClass'))
        WHERE signal_class IS NULL OR TRIM(signal_class) = ''
      `);
    }
    if (present.has('market_regime')) {
      db.exec(`
        UPDATE trade_policy_adjustments
        SET market_regime = COALESCE(NULLIF(TRIM(market_regime), ''), json_extract(scope_payload, '$.marketRegime'))
        WHERE market_regime IS NULL OR TRIM(market_regime) = ''
      `);
    }
    if (present.has('volatility_bucket')) {
      db.exec(`
        UPDATE trade_policy_adjustments
        SET volatility_bucket = COALESCE(NULLIF(TRIM(volatility_bucket), ''), json_extract(scope_payload, '$.volatilityBucket'))
        WHERE volatility_bucket IS NULL OR TRIM(volatility_bucket) = ''
      `);
    }
    if (present.has('liquidity_bucket')) {
      db.exec(`
        UPDATE trade_policy_adjustments
        SET liquidity_bucket = COALESCE(NULLIF(TRIM(liquidity_bucket), ''), json_extract(scope_payload, '$.liquidityBucket'))
        WHERE liquidity_bucket IS NULL OR TRIM(liquidity_bucket) = ''
      `);
    }
  }

  if (present.has('policy_key') && present.has('action')) {
    const hasAdjustmentType = present.has('adjustment_type');
    const hasNewValue = present.has('new_value');
    db.exec(`
      UPDATE trade_policy_adjustments
      SET action = CASE
        WHEN COALESCE(policy_key, 'size') = 'leverage' THEN 'cap_leverage'
        WHEN COALESCE(policy_key, 'size') = 'confirmation' THEN 'require_confirmation'
        WHEN COALESCE(policy_key, 'size') = 'cooldown' THEN 'cooldown'
        ${
          hasAdjustmentType && hasNewValue
            ? "WHEN COALESCE(policy_key, 'size') = 'size' AND adjustment_type = 'flag' AND COALESCE(new_value, 0) = 0 THEN 'block'"
            : ''
        }
        ELSE 'downweight'
      END
    `);
  }

  if (present.has('policy_key') && present.has('new_value')) {
    if (present.has('size_multiplier')) {
      db.exec(`
        UPDATE trade_policy_adjustments
        SET size_multiplier = CASE
          WHEN COALESCE(policy_key, 'size') = 'size' AND new_value IS NOT NULL THEN new_value
          WHEN action = 'block' THEN 0
          ELSE COALESCE(size_multiplier, 1)
        END
      `);
    }
    if (present.has('leverage_cap')) {
      db.exec(`
        UPDATE trade_policy_adjustments
        SET leverage_cap = COALESCE(leverage_cap, CASE WHEN policy_key = 'leverage' THEN new_value END)
        WHERE leverage_cap IS NULL
      `);
    }
    if (present.has('confirmation_required')) {
      db.exec(`
        UPDATE trade_policy_adjustments
        SET confirmation_required = COALESCE(
          confirmation_required,
          CASE WHEN policy_key = 'confirmation' AND new_value IS NOT NULL THEN CASE WHEN new_value <> 0 THEN 1 ELSE 0 END END
        )
        WHERE confirmation_required IS NULL
      `);
    }
    if (present.has('cooldown_minutes')) {
      db.exec(`
        UPDATE trade_policy_adjustments
        SET cooldown_minutes = COALESCE(cooldown_minutes, CASE WHEN policy_key = 'cooldown' THEN CAST(new_value AS INTEGER) END)
        WHERE cooldown_minutes IS NULL
      `);
    }
  }

  if (present.has('evidence_payload')) {
    const pieces: string[] = [];
    if (present.has('scope_payload')) pieces.push("'scopePayload', scope_payload");
    if (present.has('old_value')) pieces.push("'oldValue', old_value");
    if (present.has('new_value')) pieces.push("'newValue', new_value");
    if (present.has('old_value_payload')) pieces.push("'oldValuePayload', old_value_payload");
    if (present.has('new_value_payload')) pieces.push("'newValuePayload', new_value_payload");
    if (pieces.length > 0) {
      db.exec(`
        UPDATE trade_policy_adjustments
        SET evidence_payload = json_object(${pieces.join(', ')})
        WHERE evidence_payload IS NULL OR TRIM(evidence_payload) = ''
      `);
    }
  }
}

function backfillTradePolicyAdjustmentScopeKeys(db: Database.Database): void {
  db.exec(`
    UPDATE trade_policy_adjustments
    SET scope_key = ${TRADE_POLICY_SCOPE_KEY_FROM_COLUMNS_SQL}
    WHERE scope_key IS NULL OR TRIM(scope_key) = ''
  `);
}

export function repairActiveTradePolicyAdjustmentScopeMismatches(db: Database.Database): number {
  const hasAdjustmentsTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trade_policy_adjustments' LIMIT 1")
    .get();
  if (!hasAdjustmentsTable) {
    return 0;
  }

  const result = db
    .prepare(
      `UPDATE trade_policy_adjustments
       SET symbol_class = ${CANONICAL_TRADE_POLICY_SYMBOL_CLASS_SQL},
           scope_key =
             'symbol=' || COALESCE(NULLIF(TRIM(symbol), ''), 'any') ||
             '|direction=' || COALESCE(NULLIF(TRIM(direction), ''), 'any') ||
             '|strategySource=' || COALESCE(NULLIF(TRIM(strategy_source), ''), 'any') ||
             '|triggerReason=' || COALESCE(NULLIF(TRIM(trigger_reason), ''), 'any') ||
             '|signalClass=' || COALESCE(NULLIF(TRIM(signal_class), ''), 'any') ||
             '|symbolClass=' || COALESCE(${CANONICAL_TRADE_POLICY_SYMBOL_CLASS_SQL}, 'any') ||
             '|session=' || COALESCE(NULLIF(TRIM(session_tag), ''), 'any') ||
             '|marketRegime=' || COALESCE(NULLIF(TRIM(market_regime), ''), 'any') ||
             '|volatilityBucket=' || COALESCE(NULLIF(TRIM(volatility_bucket), ''), 'any') ||
             '|liquidityBucket=' || COALESCE(NULLIF(TRIM(liquidity_bucket), ''), 'any'),
           updated_at = datetime('now')
       WHERE active = 1
         AND symbol IS NOT NULL
         AND TRIM(symbol) != ''
         AND COALESCE(symbol_class, '') != COALESCE(${CANONICAL_TRADE_POLICY_SYMBOL_CLASS_SQL}, '')`
    )
    .run();
  return result.changes;
}
export function cleanupLegacyPerpComparableRows(db: Database.Database): number {
  if (
    !hasPredictionColumns(db, [
      'domain',
      'outcome_basis',
      'predicted_outcome',
      'model_probability',
      'market_probability',
      'learning_comparable',
    ])
  ) {
    return 0;
  }
  const result = db
    .prepare(
      `UPDATE predictions
       SET learning_comparable = 0
       WHERE ${LEGACY_PERP_CONTAMINATION_WHERE_SQL}`
    )
    .run();
  return result.changes;
}

export function cleanupSyntheticPerpComparableRows(db: Database.Database): number {
  if (
    !hasPredictionColumns(db, [
      'domain',
      'predicted_outcome',
      'model_probability',
      'market_probability',
      'learning_comparable',
    ])
  ) {
    return 0;
  }
  const result = db
    .prepare(
      `UPDATE predictions
       SET learning_comparable = 0
       WHERE ${OPEN_SYNTHETIC_PERP_COMPARABLE_WHERE_SQL}`
    )
    .run();
  return result.changes;
}

export function cleanupSyntheticPerpComparableLearningCases(db: Database.Database): number {
  const hasLearningCasesTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'learning_cases' LIMIT 1")
    .get();
  if (!hasLearningCasesTable) {
    return 0;
  }
  const result = db
    .prepare(
      `UPDATE learning_cases
       SET comparable = 0,
           comparator_kind = NULL,
           exclusion_reason = 'missing_comparator',
           updated_at = datetime('now')
       WHERE ${SYNTHETIC_PERP_COMPARABLE_LEARNING_CASE_WHERE_SQL}`
    )
    .run();
  return result.changes;
}

export type LearningSchemaSummary = {
  predictionCount: number;
  comparablePredictionCount: number;
  contaminatedComparableCount: number;
  learningExamplesCount: number;
  learningCasesCount: number;
  comparableLearningCasesCount: number;
  executionLearningCasesCount: number;
  learningSignalAuditsCount: number;
  tradePolicyAdjustmentsCount: number;
  tradeCloseEventsCount: number;
  closeFinalizationJobsCount: number;
  tradeClosesCount: number;
  tradeReflectionsCount: number;
  regretLearningCasesCount: number;
  policyPromotionEventsCount: number;
};

function countIfTableExists(db: Database.Database, tableName: string): number {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName);
  if (!exists) {
    return 0;
  }
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${tableName}`).get() as { c: number };
  return row.c;
}

function countIfViewExists(db: Database.Database, viewName: string): number {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ? LIMIT 1")
    .get(viewName);
  if (!exists) {
    return 0;
  }
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${viewName}`).get() as { c: number };
  return row.c;
}

export function summarizeLearningSchema(db: Database.Database): LearningSchemaSummary {
  const predictionCount = (db.prepare('SELECT COUNT(*) AS c FROM predictions').get() as { c: number }).c;
  const comparablePredictionCount = (
    db.prepare('SELECT COUNT(*) AS c FROM predictions WHERE learning_comparable = 1').get() as {
      c: number;
    }
  ).c;
  const contaminatedComparableCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM predictions WHERE ${LEGACY_PERP_CONTAMINATION_WHERE_SQL}`).get() as {
      c: number;
    }
  ).c;

  return {
    predictionCount,
    comparablePredictionCount,
    contaminatedComparableCount,
    learningExamplesCount: countIfViewExists(db, 'learning_examples'),
    learningCasesCount: countIfTableExists(db, 'learning_cases'),
    comparableLearningCasesCount: countIfViewExists(db, 'comparable_learning_cases'),
    executionLearningCasesCount: countIfViewExists(db, 'execution_learning_cases'),
    learningSignalAuditsCount: countIfTableExists(db, 'learning_signal_audits'),
    tradePolicyAdjustmentsCount: countIfTableExists(db, 'trade_policy_adjustments'),
    tradeCloseEventsCount: countIfTableExists(db, 'trade_close_events'),
    closeFinalizationJobsCount: countIfTableExists(db, 'close_finalization_jobs'),
    tradeClosesCount: countIfTableExists(db, 'trade_closes'),
    tradeReflectionsCount: countIfTableExists(db, 'trade_reflections'),
    regretLearningCasesCount: countIfTableExists(db, 'regret_learning_cases'),
    policyPromotionEventsCount: countIfTableExists(db, 'policy_promotion_events'),
  };
}
