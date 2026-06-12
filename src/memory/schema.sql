-- Thufir Database Schema
-- SQLite compatible

-- ============================================================================
-- Predictions
-- ============================================================================

CREATE TABLE IF NOT EXISTS predictions (
    id TEXT PRIMARY KEY,
    market_id TEXT NOT NULL,
    market_title TEXT NOT NULL,

    -- Prediction details
    predicted_outcome TEXT CHECK(predicted_outcome IN ('YES', 'NO')),
    predicted_probability REAL CHECK(predicted_probability >= 0 AND predicted_probability <= 1),
    confidence_level TEXT CHECK(confidence_level IN ('low', 'medium', 'high')),
    confidence_raw REAL,
    confidence_adjusted REAL,
    signal_scores TEXT,
    signal_weights_snapshot TEXT,

    -- Execution details
    executed INTEGER DEFAULT 0,
    execution_price REAL,
    position_size REAL,

    -- Reasoning (JSON)
    reasoning TEXT,
    key_factors TEXT,  -- JSON array
    intel_ids TEXT,    -- JSON array of intel IDs used

    -- Metadata
    domain TEXT,
    session_tag TEXT,
    regime_tag TEXT,
    strategy_class TEXT,
    symbol TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    horizon_minutes INTEGER CHECK(horizon_minutes IS NULL OR horizon_minutes > 0),
    expires_at TEXT,
    context_tags TEXT, -- JSON array

    -- Outcome (filled when market resolves)
    resolution_status TEXT NOT NULL DEFAULT 'open' CHECK(resolution_status IN ('open', 'resolved_true', 'resolved_false', 'unresolved_error')),
    resolution_metadata TEXT, -- JSON object
    resolution_error TEXT,
    resolution_timestamp TEXT,
    outcome TEXT CHECK(outcome IS NULL OR outcome IN ('YES', 'NO')),
    outcome_timestamp TEXT,
    pnl REAL,
    brier_contribution REAL,

    -- PLIL v1.99: clean probability separation and outcome integrity
    model_probability REAL,    -- Thufir's raw probability estimate (never market price)
    market_probability REAL,   -- market-implied price at decision time
    learning_comparable INTEGER NOT NULL DEFAULT 0 CHECK(learning_comparable IN (0, 1)),
    forecast_target_kind TEXT,
    forecast_target_payload TEXT,
    comparator_source TEXT,
    comparator_kind TEXT,
    comparator_payload TEXT,
    outcome_basis TEXT DEFAULT 'legacy'
        CHECK(outcome_basis IN ('final', 'estimated', 'legacy'))
        -- 'final'    = confirmed market resolution (use for learning)
        -- 'estimated' = snapshot-threshold inference (exclude from learning)
        -- 'legacy'   = pre-v1.99 row (exclude from learning)
);

CREATE INDEX IF NOT EXISTS idx_predictions_market ON predictions(market_id);
CREATE INDEX IF NOT EXISTS idx_predictions_domain ON predictions(domain);
CREATE INDEX IF NOT EXISTS idx_predictions_session_tag ON predictions(session_tag);
CREATE INDEX IF NOT EXISTS idx_predictions_regime_tag ON predictions(regime_tag);
CREATE INDEX IF NOT EXISTS idx_predictions_strategy_class ON predictions(strategy_class);
CREATE INDEX IF NOT EXISTS idx_predictions_horizon_minutes ON predictions(horizon_minutes);
CREATE INDEX IF NOT EXISTS idx_predictions_symbol ON predictions(symbol);
CREATE INDEX IF NOT EXISTS idx_predictions_created ON predictions(created_at);
CREATE INDEX IF NOT EXISTS idx_predictions_outcome ON predictions(outcome);
CREATE INDEX IF NOT EXISTS idx_predictions_unresolved ON predictions(outcome) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS idx_predictions_outcome_basis ON predictions(outcome_basis);
CREATE INDEX IF NOT EXISTS idx_predictions_learning
  ON predictions(outcome_basis, domain, outcome_timestamp DESC)
  WHERE outcome_basis = 'final'
    AND model_probability IS NOT NULL
    AND market_probability IS NOT NULL
    AND outcome IS NOT NULL;

-- ============================================================================
-- Learning Examples (view — single source of truth for metrics and calibration)
-- ============================================================================

CREATE VIEW IF NOT EXISTS learning_examples AS
SELECT
  id,
  domain,
  regime_tag           AS regime,
  strategy_class,
  symbol,
  model_probability,
  market_probability,
  comparator_kind,
  comparator_source,
  forecast_target_kind,
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
  AND outcome            IS NOT NULL;

CREATE VIEW IF NOT EXISTS market_comparable_learning_examples AS
SELECT *
FROM learning_examples
WHERE comparator_kind IN ('exogenous_price_climatology', 'exogenous_options_implied');

CREATE VIEW IF NOT EXISTS internal_comparable_learning_examples AS
SELECT
  id,
  domain,
  regime_tag           AS regime,
  strategy_class,
  symbol,
  model_probability,
  market_probability,
  comparator_kind,
  comparator_source,
  forecast_target_kind,
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
  AND comparator_kind = 'internal_segment_history'
  AND outcome            IS NOT NULL;

-- ============================================================================
-- Calibration Cache
-- ============================================================================

-- Cached calibration stats, refreshed periodically
CREATE TABLE IF NOT EXISTS calibration_cache (
    domain TEXT PRIMARY KEY,
    total_predictions INTEGER,
    brier_score REAL,
    accuracy_overall REAL,
    accuracy_low REAL,
    accuracy_medium REAL,
    accuracy_high REAL,
    calibration_curve TEXT,  -- JSON
    recent_trend TEXT CHECK(recent_trend IN ('improving', 'stable', 'declining')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================================
-- User Context
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_context (
    user_id TEXT PRIMARY KEY,
    preferences TEXT,          -- JSON
    domains_of_interest TEXT,  -- JSON array
    risk_tolerance TEXT CHECK(risk_tolerance IN ('conservative', 'moderate', 'aggressive')),
    notification_settings TEXT, -- JSON
    conversation_summary TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================================
-- Trade Management State
-- ============================================================================

-- Minimal durable state for exchange-native risk controls (TP/SL, expiry, etc.).
CREATE TABLE IF NOT EXISTS trade_management_state (
    symbol TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================================
-- Intel Cache
-- ============================================================================

-- Stores intel items for reference (vectors stored in ChromaDB)
CREATE TABLE IF NOT EXISTS intel_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT,
    source TEXT NOT NULL,
    source_type TEXT CHECK(source_type IN ('news', 'social', 'data', 'custom')),
    category TEXT,
    url TEXT,
    timestamp TEXT NOT NULL,
    entities TEXT,    -- JSON array
    sentiment REAL,
    metadata TEXT,    -- JSON
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_intel_source ON intel_items(source);
CREATE INDEX IF NOT EXISTS idx_intel_category ON intel_items(category);
CREATE INDEX IF NOT EXISTS idx_intel_timestamp ON intel_items(timestamp);

-- Deduplication tracking
CREATE TABLE IF NOT EXISTS intel_hashes (
    hash TEXT PRIMARY KEY,
    intel_id TEXT REFERENCES intel_items(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================================
-- Wallet Audit Log
-- ============================================================================

-- Immutable log of all wallet operations
CREATE TABLE IF NOT EXISTS wallet_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    operation TEXT NOT NULL,  -- 'sign', 'submit', 'confirm', 'reject'
    to_address TEXT,
    amount REAL,
    transaction_hash TEXT,
    status TEXT,  -- 'pending', 'confirmed', 'failed', 'rejected'
    reason TEXT,
    metadata TEXT  -- JSON
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON wallet_audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_operation ON wallet_audit_log(operation);

-- ============================================================================
-- Spending State
-- ============================================================================

CREATE TABLE IF NOT EXISTS spending_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),  -- Singleton row
    today_spent REAL DEFAULT 0,
    last_reset_date TEXT,
    today_trade_count INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Initialize singleton row
INSERT OR IGNORE INTO spending_state (id, today_spent, last_reset_date, today_trade_count)
VALUES (1, 0, date('now'), 0);

-- ============================================================================
-- Portfolio State
-- ============================================================================

CREATE TABLE IF NOT EXISTS portfolio_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),  -- Singleton row
    cash_balance REAL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO portfolio_state (id, cash_balance)
VALUES (1, 0);

-- ============================================================================
-- Trade Ledger
-- ============================================================================

CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prediction_id TEXT,
    market_id TEXT NOT NULL,
    market_title TEXT NOT NULL,
    outcome TEXT CHECK(outcome IN ('YES', 'NO')) NOT NULL,
    side TEXT CHECK(side IN ('buy', 'sell')) NOT NULL,
    price REAL,
    amount REAL,
    shares REAL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trades_prediction ON trades(prediction_id);
CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);

-- Perp trades (for derivatives execution)
CREATE TABLE IF NOT EXISTS perp_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hypothesis_id TEXT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    size REAL NOT NULL,
    execution_mode TEXT CHECK(execution_mode IN ('paper', 'live')),
    price REAL,
    leverage REAL,
    order_type TEXT,
    status TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_perp_trades_symbol ON perp_trades(symbol);
CREATE INDEX IF NOT EXISTS idx_perp_trades_status ON perp_trades(status);
CREATE INDEX IF NOT EXISTS idx_perp_trades_created ON perp_trades(created_at);

-- Learning events
CREATE TABLE IF NOT EXISTS learning_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prediction_id TEXT,
    market_id TEXT NOT NULL,
    domain TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    predicted_outcome TEXT,
    predicted_probability REAL,
    outcome TEXT,
    brier REAL,
    pnl REAL,
    edge REAL,
    confidence_raw REAL,
    confidence_adjusted REAL,
    signal_scores TEXT,
    signal_weights TEXT,
    market_snapshot TEXT,
    model_version TEXT,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_learning_prediction ON learning_events(prediction_id);
CREATE INDEX IF NOT EXISTS idx_learning_domain ON learning_events(domain);
CREATE INDEX IF NOT EXISTS idx_learning_resolved ON learning_events(resolved_at);

-- Proactive query learning memory
CREATE TABLE IF NOT EXISTS proactive_query_stats (
    query TEXT PRIMARY KEY,
    runs INTEGER DEFAULT 0,
    successes INTEGER DEFAULT 0,
    total_new_items INTEGER DEFAULT 0,
    total_web_results INTEGER DEFAULT 0,
    total_web_fetches INTEGER DEFAULT 0,
    score REAL DEFAULT 0,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_run_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_proactive_query_score ON proactive_query_stats(score);
CREATE INDEX IF NOT EXISTS idx_proactive_query_last_run ON proactive_query_stats(last_run_at);

-- Signal weights
CREATE TABLE IF NOT EXISTS signal_weights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT DEFAULT 'global',
    weights TEXT NOT NULL,
    samples INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_weights_domain ON signal_weights(domain);

CREATE TABLE IF NOT EXISTS weight_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    learning_event_id INTEGER,
    domain TEXT,
    delta TEXT,
    method TEXT,
    learning_rate REAL,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================================
-- Market Cache
-- ============================================================================

-- Cache of market data to reduce API calls
CREATE TABLE IF NOT EXISTS market_cache (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    description TEXT,
    outcomes TEXT,  -- JSON array
    prices TEXT,    -- JSON object
    volume REAL,
    liquidity REAL,
    end_date TEXT,
    category TEXT,
    resolved INTEGER DEFAULT 0,
    resolution TEXT,
    created_at TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================================
-- Mentat Storage (Assumptions / Mechanisms / Fragility Cards)
-- ============================================================================

CREATE TABLE IF NOT EXISTS assumptions (
    id TEXT PRIMARY KEY,
    system TEXT,
    statement TEXT NOT NULL,
    dependencies TEXT,       -- JSON array
    evidence_for TEXT,        -- JSON array
    evidence_against TEXT,    -- JSON array
    stress_score REAL,
    last_tested TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assumptions_system ON assumptions(system);
CREATE INDEX IF NOT EXISTS idx_assumptions_updated ON assumptions(updated_at);

CREATE TABLE IF NOT EXISTS assumption_deltas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assumption_id TEXT NOT NULL,
    changed_at TEXT DEFAULT (datetime('now')),
    previous_snapshot TEXT,   -- JSON
    current_snapshot TEXT,    -- JSON
    stress_delta REAL,
    fields_changed TEXT       -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_assumption_deltas_id ON assumption_deltas(assumption_id);

CREATE TABLE IF NOT EXISTS mechanisms (
    id TEXT PRIMARY KEY,
    system TEXT,
    name TEXT NOT NULL,
    causal_chain TEXT,        -- JSON array
    trigger_class TEXT,
    propagation_path TEXT,    -- JSON array
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mechanisms_system ON mechanisms(system);
CREATE INDEX IF NOT EXISTS idx_mechanisms_updated ON mechanisms(updated_at);

CREATE TABLE IF NOT EXISTS mechanism_deltas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mechanism_id TEXT NOT NULL,
    changed_at TEXT DEFAULT (datetime('now')),
    previous_snapshot TEXT,   -- JSON
    current_snapshot TEXT,    -- JSON
    fields_changed TEXT       -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_mechanism_deltas_id ON mechanism_deltas(mechanism_id);

CREATE TABLE IF NOT EXISTS system_maps (
    id TEXT PRIMARY KEY,
    system TEXT,
    nodes TEXT,             -- JSON array
    edges TEXT,             -- JSON array
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_system_maps_system ON system_maps(system);
CREATE INDEX IF NOT EXISTS idx_system_maps_updated ON system_maps(updated_at);

CREATE TABLE IF NOT EXISTS fragility_cards (
    id TEXT PRIMARY KEY,
    system TEXT,
    mechanism_id TEXT,
    exposure_surface TEXT,
    convexity TEXT,
    early_signals TEXT,       -- JSON array
    falsifiers TEXT,          -- JSON array
    downside TEXT,
    recovery_capacity TEXT,
    score REAL,
    updated_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fragility_cards_system ON fragility_cards(system);
CREATE INDEX IF NOT EXISTS idx_fragility_cards_score ON fragility_cards(score);

CREATE TABLE IF NOT EXISTS fragility_card_deltas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL,
    changed_at TEXT DEFAULT (datetime('now')),
    previous_score REAL,
    current_score REAL,
    score_delta REAL,
    previous_snapshot TEXT,   -- JSON
    current_snapshot TEXT,    -- JSON
    fields_changed TEXT       -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_fragility_card_deltas_id ON fragility_card_deltas(card_id);

CREATE INDEX IF NOT EXISTS idx_market_category ON market_cache(category);
CREATE INDEX IF NOT EXISTS idx_market_resolved ON market_cache(resolved);

-- ============================================================================
-- Decision Audit (Evaluation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS decision_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    source TEXT,
    user_id TEXT,
    session_id TEXT,
    mode TEXT,
    goal TEXT,
    market_id TEXT,
    prediction_id TEXT,
    trade_action TEXT,
    trade_outcome TEXT,
    trade_amount REAL,
    confidence REAL,
    edge REAL,
    critic_approved INTEGER,
    critic_issues TEXT,         -- JSON array
    fragility_score REAL,
    tool_calls INTEGER,
    iterations INTEGER,
    tool_trace TEXT,            -- JSON
    plan_trace TEXT,            -- JSON
    notes TEXT                  -- JSON
);

CREATE INDEX IF NOT EXISTS idx_decision_audit_created ON decision_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_decision_audit_market ON decision_audit(market_id);
CREATE INDEX IF NOT EXISTS idx_decision_audit_prediction ON decision_audit(prediction_id);

-- ============================================================================
-- Decision Artifacts (Learning / Reuse)
-- ============================================================================

CREATE TABLE IF NOT EXISTS decision_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT,
    source TEXT,
    kind TEXT NOT NULL,
    market_id TEXT,
    fingerprint TEXT,
    outcome TEXT,
    confidence REAL,
    expires_at TEXT,
    payload TEXT,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_decision_artifacts_created ON decision_artifacts(created_at);
CREATE INDEX IF NOT EXISTS idx_decision_artifacts_kind ON decision_artifacts(kind);
CREATE INDEX IF NOT EXISTS idx_decision_artifacts_market ON decision_artifacts(market_id);
CREATE INDEX IF NOT EXISTS idx_decision_artifacts_fingerprint ON decision_artifacts(fingerprint);
CREATE INDEX IF NOT EXISTS idx_decision_artifacts_expires ON decision_artifacts(expires_at);

-- ============================================================================
-- Execution State (Execution Mode Gating)
-- ============================================================================

CREATE TABLE IF NOT EXISTS execution_state (
    source TEXT PRIMARY KEY,
    fingerprint TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    last_mode TEXT,
    last_reason TEXT
);

-- ============================================================================
-- Intel Embeddings
-- ============================================================================

CREATE TABLE IF NOT EXISTS intel_embeddings (
    intel_id TEXT PRIMARY KEY REFERENCES intel_items(id) ON DELETE CASCADE,
    embedding TEXT NOT NULL,  -- JSON array
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_intel_embeddings_created ON intel_embeddings(created_at);

-- ============================================================================
-- Chat Memory
-- ============================================================================

CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);

CREATE TABLE IF NOT EXISTS chat_embeddings (
    message_id TEXT PRIMARY KEY,
    embedding TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_embeddings_created ON chat_embeddings(created_at);

-- ============================================================================
-- Watchlist
-- ============================================================================

CREATE TABLE IF NOT EXISTS watchlist (
    market_id TEXT PRIMARY KEY,
    added_at TEXT DEFAULT (datetime('now')),
    notes TEXT,
    alert_threshold REAL  -- Alert if price moves more than this
);

-- ============================================================================
-- Agent Incidents + Playbooks
-- ============================================================================

-- Structured failure artifacts. This is the substrate for "learning" from ops
-- failures: detect -> diagnose -> remediate -> verify -> save.
CREATE TABLE IF NOT EXISTS agent_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    goal TEXT,
    mode TEXT,
    tool_name TEXT,
    error TEXT,
    blocker_kind TEXT,
    details_json TEXT,
    resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_incidents_created ON agent_incidents(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_incidents_blocker ON agent_incidents(blocker_kind);

-- Playbooks are durable operator knowledge. They should be small, high-signal
-- remediation procedures keyed by capability/blocker.
CREATE TABLE IF NOT EXISTS agent_playbooks (
    key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_playbooks_updated ON agent_playbooks(updated_at);

-- ============================================================================
-- Scheduler Control Plane
-- ============================================================================

CREATE TABLE IF NOT EXISTS scheduler_jobs (
    name TEXT PRIMARY KEY,
    schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('interval', 'daily')),
    interval_ms INTEGER,
    daily_time TEXT,
    status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'success', 'failed')),
    last_run_at TEXT,
    next_run_at TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    lock_owner TEXT,
    lock_expires_at TEXT,
    lease_ms INTEGER NOT NULL DEFAULT 120000,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_next_run ON scheduler_jobs(next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_lock_expires ON scheduler_jobs(lock_expires_at);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    scheduler_job_name TEXT NOT NULL UNIQUE,
    channel TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('once', 'daily', 'interval')),
    run_at TEXT,
    daily_time TEXT,
    interval_minutes INTEGER,
    instruction TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    last_ran_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_active ON scheduled_tasks(active);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_recipient ON scheduled_tasks(channel, recipient_id);

-- ============================================================================
-- Alert Incident Lifecycle
-- ============================================================================

CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL,
    source TEXT NOT NULL,
    reason TEXT NOT NULL,
    severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'high', 'critical')),
    summary TEXT NOT NULL,
    message TEXT,
    state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open', 'suppressed', 'sent', 'resolved')),
    metadata_json TEXT,
    occurred_at TEXT,
    acknowledged_at TEXT,
    acknowledged_by TEXT,
    suppressed_at TEXT,
    sent_at TEXT,
    resolved_at TEXT,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alerts_state ON alerts(state);
CREATE INDEX IF NOT EXISTS idx_alerts_dedupe_key ON alerts(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

CREATE TABLE IF NOT EXISTS alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK(event_type IN ('open', 'suppressed', 'sent', 'resolved', 'acknowledged', 'delivery')),
    from_state TEXT,
    to_state TEXT,
    reason_code TEXT,
    payload_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alert_events_alert_id ON alert_events(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_events_created ON alert_events(created_at);

CREATE TABLE IF NOT EXISTS alert_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('retrying', 'sent', 'failed')),
    attempt INTEGER NOT NULL DEFAULT 1,
    provider_message_id TEXT,
    error TEXT,
    metadata_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alert_deliveries_alert_id ON alert_deliveries(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_deliveries_status ON alert_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_alert_deliveries_created ON alert_deliveries(created_at);

-- ============================================================================
-- Causal Event Reasoning (v1.95)
-- ============================================================================

-- Normalized events: canonical representation of a market-moving occurrence.
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE,   -- deterministic dedup key
    title TEXT NOT NULL,
    domain TEXT NOT NULL,             -- crypto, energy, agri, macro, equity, rates, fx, metals, other
    occurred_at TEXT NOT NULL,        -- ISO8601 event timestamp (not ingest timestamp)
    source_intel_ids TEXT,            -- JSON array of intel_items.id
    tags TEXT,                        -- JSON array of mechanism/category tags
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'superseded')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_event_key ON events(event_key);
CREATE INDEX IF NOT EXISTS idx_events_domain ON events(domain);
CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- Versioned thought artifacts linked to events.
CREATE TABLE IF NOT EXISTS event_thoughts (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    mechanism TEXT NOT NULL,          -- plain-text causal mechanism
    causal_chain TEXT NOT NULL,       -- JSON array of ordered steps
    impacted_assets TEXT NOT NULL,    -- JSON array of {symbol, direction, confidence}
    invalidation_conditions TEXT,     -- JSON array of falsifier conditions
    model_version TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_thoughts_event_id ON event_thoughts(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_thoughts_event_version ON event_thoughts(event_id, version);

-- Explicit asset/direction/horizon forecasts derived from thoughts.
CREATE TABLE IF NOT EXISTS event_forecasts (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    thought_id TEXT NOT NULL REFERENCES event_thoughts(id) ON DELETE CASCADE,
    asset TEXT NOT NULL,
    domain TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('up', 'down', 'neutral')),
    horizon_hours INTEGER NOT NULL CHECK(horizon_hours > 0),
    confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
    invalidation_conditions TEXT,     -- JSON array
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'confirmed', 'invalidated', 'expired')),
    expires_at TEXT NOT NULL,
    resolved_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_forecasts_event_id ON event_forecasts(event_id);
CREATE INDEX IF NOT EXISTS idx_event_forecasts_thought_id ON event_forecasts(thought_id);
CREATE INDEX IF NOT EXISTS idx_event_forecasts_status ON event_forecasts(status);
CREATE INDEX IF NOT EXISTS idx_event_forecasts_asset ON event_forecasts(asset);
CREATE INDEX IF NOT EXISTS idx_event_forecasts_open ON event_forecasts(expires_at) WHERE status = 'open';

-- Outcome records: deferred resolution of forecasts.
CREATE TABLE IF NOT EXISTS event_outcomes (
    id TEXT PRIMARY KEY,
    forecast_id TEXT NOT NULL REFERENCES event_forecasts(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    resolution_status TEXT NOT NULL CHECK(resolution_status IN ('confirmed', 'invalidated', 'expired', 'error')),
    resolution_note TEXT,
    actual_direction TEXT NOT NULL CHECK(actual_direction IN ('up', 'down', 'neutral', 'unknown')),
    resolution_price REAL,
    resolved_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_outcomes_forecast_id ON event_outcomes(forecast_id);
CREATE INDEX IF NOT EXISTS idx_event_outcomes_event_id ON event_outcomes(event_id);
CREATE INDEX IF NOT EXISTS idx_event_outcomes_resolution ON event_outcomes(resolution_status);

-- ============================================================================
-- LLM Exit Consult Log (v1.97)
-- ============================================================================

CREATE TABLE IF NOT EXISTS llm_exit_consult_log (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  symbol                 TEXT NOT NULL,
  side                   TEXT NOT NULL,
  roe_at_consult         REAL NOT NULL,
  time_held_ms           INTEGER NOT NULL,
  action                 TEXT NOT NULL,
  reasoning              TEXT NOT NULL,
  new_time_stop_at_ms    INTEGER,
  new_invalidation_price REAL,
  reduce_to_fraction     REAL,
  used_fallback          INTEGER NOT NULL DEFAULT 0
);

-- ============================================================================
-- Views
-- ============================================================================

-- Recent predictions with outcomes
CREATE VIEW IF NOT EXISTS recent_predictions AS
SELECT
    p.*,
    m.question as market_question,
    m.prices as current_prices
FROM predictions p
LEFT JOIN market_cache m ON p.market_id = m.id
ORDER BY p.created_at DESC
LIMIT 100;

-- Calibration by domain (live calculation)
CREATE VIEW IF NOT EXISTS calibration_by_domain AS
SELECT
    domain,
    COUNT(*) as total_predictions,
    SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) as resolved_predictions,
    AVG(CASE
        WHEN outcome IS NOT NULL THEN
            CASE WHEN predicted_outcome = outcome THEN 1.0 ELSE 0.0 END
        ELSE NULL
    END) as accuracy,
    AVG(CASE
        WHEN outcome IS NOT NULL THEN
            brier_contribution
        ELSE NULL
    END) as avg_brier
FROM predictions
GROUP BY domain;

-- Open positions (predictions that executed but haven't resolved)
CREATE VIEW IF NOT EXISTS open_positions AS
SELECT
    p.id,
    p.market_id,
    p.market_title,
    p.predicted_outcome,
    p.execution_price,
    p.position_size,
    p.created_at,
    m.prices as current_prices
FROM predictions p
LEFT JOIN market_cache m ON p.market_id = m.id
WHERE p.executed = 1 AND p.outcome IS NULL
ORDER BY p.created_at DESC;

-- ============================================================================
-- LLM Entry Gate Log (v1.97)
-- ============================================================================

CREATE TABLE IF NOT EXISTS llm_entry_gate_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  symbol            TEXT NOT NULL,
  side              TEXT NOT NULL,
  notional_usd      REAL NOT NULL,
  verdict           TEXT NOT NULL,
  reasoning         TEXT NOT NULL,
  reason_code       TEXT,
  adjusted_size_usd REAL,
  used_fallback     INTEGER NOT NULL DEFAULT 0,
  signal_class      TEXT,
  regime            TEXT,
  session           TEXT,
  edge              REAL,
  stop_level_price  REAL,
  equity_at_risk_pct REAL,
  target_rr         REAL,
  suggested_leverage REAL,
  mechanical_leverage_ceiling REAL,
  stop_distance_pct REAL,
  liquidity_score   REAL,
  execution_score   REAL,
  liquidity_bucket  TEXT
);
