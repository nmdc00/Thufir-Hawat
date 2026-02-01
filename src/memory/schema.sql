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
