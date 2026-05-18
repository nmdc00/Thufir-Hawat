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
    source_learning_case_id TEXT,
    source_trade_id INTEGER,
    rationale TEXT,
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
  { name: 'source_learning_case_id', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN source_learning_case_id TEXT' },
  { name: 'source_trade_id', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN source_trade_id INTEGER' },
  { name: 'rationale', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN rationale TEXT' },
  { name: 'evidence_payload', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN evidence_payload TEXT' },
  { name: 'expires_at', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN expires_at TEXT' },
  { name: 'updated_at', sql: 'ALTER TABLE trade_policy_adjustments ADD COLUMN updated_at TEXT' },
];

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
  db.exec(TRADE_POLICY_ADJUSTMENTS_TABLE_SQL);
  ensureTradePolicyAdjustmentColumns(db);
  for (const statement of TRADE_POLICY_ADJUSTMENTS_INDEX_SQL) {
    db.exec(statement);
  }

  cleanupSyntheticPerpComparableRows(db);

  // Recreate views explicitly so older definitions do not survive forever.
  db.exec('DROP VIEW IF EXISTS learning_examples;');
  db.exec(LEARNING_EXAMPLES_VIEW_SQL);
  db.exec('DROP VIEW IF EXISTS comparable_learning_cases;');
  db.exec(COMPARABLE_LEARNING_CASES_VIEW_SQL);
  db.exec('DROP VIEW IF EXISTS execution_learning_cases;');
  db.exec(EXECUTION_LEARNING_CASES_VIEW_SQL);
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
    SET scope_key =
      'symbol=' || COALESCE(NULLIF(TRIM(symbol), ''), 'any') ||
      '|direction=' || COALESCE(NULLIF(TRIM(direction), ''), 'any') ||
      '|strategySource=' || COALESCE(NULLIF(TRIM(strategy_source), ''), 'any') ||
      '|triggerReason=' || COALESCE(NULLIF(TRIM(trigger_reason), ''), 'any') ||
      '|signalClass=' || COALESCE(NULLIF(TRIM(signal_class), ''), 'any') ||
      '|symbolClass=' || COALESCE(NULLIF(TRIM(symbol_class), ''), 'any') ||
      '|session=' || COALESCE(NULLIF(TRIM(session_tag), ''), 'any') ||
      '|marketRegime=' || COALESCE(NULLIF(TRIM(market_regime), ''), 'any') ||
      '|volatilityBucket=' || COALESCE(NULLIF(TRIM(volatility_bucket), ''), 'any') ||
      '|liquidityBucket=' || COALESCE(NULLIF(TRIM(liquidity_bucket), ''), 'any')
    WHERE scope_key IS NULL OR TRIM(scope_key) = ''
  `);
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
  };
}
