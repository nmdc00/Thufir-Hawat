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
    created_at TEXT DEFAULT (datetime('now')),

    -- Outcome (filled when market resolves)
    outcome TEXT CHECK(outcome IS NULL OR outcome IN ('YES', 'NO')),
    outcome_timestamp TEXT,
    pnl REAL,
    brier_contribution REAL
);

CREATE INDEX IF NOT EXISTS idx_predictions_market ON predictions(market_id);
CREATE INDEX IF NOT EXISTS idx_predictions_domain ON predictions(domain);
CREATE INDEX IF NOT EXISTS idx_predictions_created ON predictions(created_at);
CREATE INDEX IF NOT EXISTS idx_predictions_outcome ON predictions(outcome);
CREATE INDEX IF NOT EXISTS idx_predictions_unresolved ON predictions(outcome) WHERE outcome IS NULL;

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
    intel_id TEXT REFERENCES intel_items(id),
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
    price REAL,
    leverage REAL,
    order_type TEXT,
    status TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

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
-- Trade Management (Hyperliquid Perps)
-- ============================================================================

-- Immutable at-entry envelope + mutable monitor state.
CREATE TABLE IF NOT EXISTS trade_envelopes (
    trade_id TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT,

    hypothesis_id TEXT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,

    entry_price REAL NOT NULL,
    size REAL NOT NULL,
    leverage REAL,
    notional_usd REAL,
    margin_usd REAL,

    stop_loss_pct REAL NOT NULL,
    take_profit_pct REAL NOT NULL,
    max_hold_seconds INTEGER NOT NULL,
    trailing_stop_pct REAL,
    trailing_activation_pct REAL NOT NULL,
    max_loss_usd REAL,

    proposed_json TEXT,

    thesis TEXT,
    signal_kinds TEXT,
    invalidation TEXT,
    catalyst_id TEXT,
    narrative_snapshot TEXT,

    high_water_price REAL,
    low_water_price REAL,
    trailing_activated INTEGER DEFAULT 0,
    funding_since_open_usd REAL,

    close_pending INTEGER DEFAULT 0,
    close_pending_reason TEXT,
    close_pending_at TEXT,

    entry_cloid TEXT,
    entry_fees_usd REAL,

    status TEXT DEFAULT 'open',
    entered_at TEXT,
    expires_at TEXT,

    tp_oid TEXT,
    sl_oid TEXT
);

CREATE INDEX IF NOT EXISTS idx_trade_envelopes_symbol_status ON trade_envelopes(symbol, status);
CREATE INDEX IF NOT EXISTS idx_trade_envelopes_entered_at ON trade_envelopes(entered_at);
CREATE INDEX IF NOT EXISTS idx_trade_envelopes_expires_at ON trade_envelopes(expires_at);

CREATE TABLE IF NOT EXISTS trade_closes (
    trade_id TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now')),

    symbol TEXT NOT NULL,
    exit_price REAL NOT NULL,
    exit_reason TEXT NOT NULL,
    pnl_usd REAL NOT NULL,
    pnl_pct REAL NOT NULL,
    hold_duration_seconds INTEGER NOT NULL,
    funding_paid_usd REAL DEFAULT 0,
    fees_usd REAL DEFAULT 0,
    closed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_closes_created_at ON trade_closes(created_at);
CREATE INDEX IF NOT EXISTS idx_trade_closes_symbol ON trade_closes(symbol);
CREATE INDEX IF NOT EXISTS idx_trade_closes_reason ON trade_closes(exit_reason);

CREATE TABLE IF NOT EXISTS trade_reflections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),

    trade_id TEXT NOT NULL,
    thesis_correct INTEGER NOT NULL,
    timing_correct INTEGER NOT NULL,
    exit_reason_appropriate INTEGER NOT NULL,
    what_worked TEXT,
    what_failed TEXT,
    lesson_for_next_trade TEXT,

    FOREIGN KEY (trade_id) REFERENCES trade_envelopes(trade_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trade_reflections_trade_id ON trade_reflections(trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_reflections_created_at ON trade_reflections(created_at);

CREATE TABLE IF NOT EXISTS trade_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),

    trade_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    signal_kind TEXT NOT NULL,
    weight REAL,
    directional_bias TEXT,
    time_horizon TEXT,

    FOREIGN KEY (trade_id) REFERENCES trade_envelopes(trade_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trade_signals_trade_id ON trade_signals(trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_signals_signal_kind ON trade_signals(signal_kind);

CREATE TABLE IF NOT EXISTS trade_price_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    trade_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    mid_price REAL NOT NULL,
    FOREIGN KEY (trade_id) REFERENCES trade_envelopes(trade_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trade_price_samples_trade_id ON trade_price_samples(trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_price_samples_created_at ON trade_price_samples(created_at);

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
    intel_id TEXT PRIMARY KEY,
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
