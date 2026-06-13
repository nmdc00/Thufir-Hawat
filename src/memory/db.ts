import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { ensureLearningSchema } from './learning_schema.js';
import { ensureOriginatorScorecardSchema } from './originator_scorecard.js';

const DEFAULT_DB_PATH = join(homedir(), '.thufir', 'thufir.sqlite');
const INSTANCES = new Map<string, Database.Database>();

function getSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(here, 'schema.sql');
  return readFileSync(schemaPath, 'utf-8');
}

function ensureDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function applySchema(db: Database.Database): void {
  migratePredictionsForDelphiResolution(db);
  migratePredictionsForPlil(db);  // must run before schema.sql so the view can reference outcome_basis
  const schemaSql = getSchemaSql();
  db.exec(schemaSql);
  ensureOriginatorScorecardSchema(db);
  migrateIntelReferentialIntegrity(db);
  migratePerpPositionLifecycleReferentialIntegrity(db);
  ensureLearningSchema(db);
  migratePredictionsForDelphiResolution(db);
  migrateAlertPersistenceLifecycle(db);
  migrateCausalEventReasoning(db);
}

function getTableSql(db: Database.Database, tableName: string): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as { sql?: string | null } | undefined;
  return typeof row?.sql === 'string' ? row.sql : null;
}

function migrateIntelReferentialIntegrity(db: Database.Database): void {
  const intelHashesSql = getTableSql(db, 'intel_hashes');
  if (
    intelHashesSql &&
    !/REFERENCES\s+intel_items\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i.test(intelHashesSql)
  ) {
    db.exec(`
      ALTER TABLE intel_hashes RENAME TO intel_hashes_legacy;
      CREATE TABLE intel_hashes (
        hash TEXT PRIMARY KEY,
        intel_id TEXT REFERENCES intel_items(id) ON DELETE CASCADE,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO intel_hashes (hash, intel_id, created_at)
      SELECT h.hash, h.intel_id, h.created_at
      FROM intel_hashes_legacy h
      LEFT JOIN intel_items i ON i.id = h.intel_id
      WHERE h.intel_id IS NULL OR i.id IS NOT NULL;
      DROP TABLE intel_hashes_legacy;
    `);
  }

  const intelEmbeddingsSql = getTableSql(db, 'intel_embeddings');
  if (
    intelEmbeddingsSql &&
    !/intel_id\s+TEXT\s+PRIMARY\s+KEY\s+REFERENCES\s+intel_items\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i.test(intelEmbeddingsSql)
  ) {
    db.exec(`
      ALTER TABLE intel_embeddings RENAME TO intel_embeddings_legacy;
      CREATE TABLE intel_embeddings (
        intel_id TEXT PRIMARY KEY REFERENCES intel_items(id) ON DELETE CASCADE,
        embedding TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO intel_embeddings (intel_id, embedding, created_at)
      SELECT e.intel_id, e.embedding, e.created_at
      FROM intel_embeddings_legacy e
      INNER JOIN intel_items i ON i.id = e.intel_id;
      DROP TABLE intel_embeddings_legacy;
      CREATE INDEX IF NOT EXISTS idx_intel_embeddings_created ON intel_embeddings(created_at);
    `);
  }
}

function migratePerpPositionLifecycleReferentialIntegrity(db: Database.Database): void {
  const lifecycleSql = getTableSql(db, 'perp_position_lifecycles');
  if (!lifecycleSql) {
    return;
  }
  if (/REFERENCES\s+perp_trades\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i.test(lifecycleSql)) {
    db.exec(`
      DELETE FROM perp_position_lifecycles
      WHERE trade_id NOT IN (SELECT id FROM perp_trades)
    `);
    return;
  }

  db.exec(`
    ALTER TABLE perp_position_lifecycles RENAME TO perp_position_lifecycles_legacy;
    CREATE TABLE perp_position_lifecycles (
      symbol TEXT PRIMARY KEY,
      trade_id INTEGER NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('long', 'short')),
      opened_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (trade_id) REFERENCES perp_trades(id) ON DELETE CASCADE
    );
    INSERT INTO perp_position_lifecycles (symbol, trade_id, side, opened_at, updated_at)
    SELECT l.symbol, l.trade_id, l.side, l.opened_at, l.updated_at
    FROM perp_position_lifecycles_legacy l
    INNER JOIN perp_trades pt ON pt.id = l.trade_id;
    DROP TABLE perp_position_lifecycles_legacy;
  `);
}

function migratePredictionsForPlil(db: Database.Database): void {
  const hasPredictionsTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'predictions' LIMIT 1")
    .get();
  if (!hasPredictionsTable) {
    return;
  }

  const columns = db
    .prepare("PRAGMA table_info('predictions')")
    .all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => String(column.name ?? '')));
  const addColumnIfMissing = (name: string, definition: string): void => {
    if (columnNames.has(name)) {
      return;
    }
    db.exec(`ALTER TABLE predictions ADD COLUMN ${definition}`);
    columnNames.add(name);
  };

  addColumnIfMissing('model_probability', 'model_probability REAL');
  addColumnIfMissing('market_probability', 'market_probability REAL');
  addColumnIfMissing(
    'learning_comparable',
    "learning_comparable INTEGER NOT NULL DEFAULT 0 CHECK(learning_comparable IN (0, 1))"
  );
  addColumnIfMissing('forecast_target_kind', 'forecast_target_kind TEXT');
  addColumnIfMissing('forecast_target_payload', 'forecast_target_payload TEXT');
  addColumnIfMissing('comparator_source', 'comparator_source TEXT');
  addColumnIfMissing('comparator_kind', 'comparator_kind TEXT');
  addColumnIfMissing('comparator_payload', 'comparator_payload TEXT');
  addColumnIfMissing(
    'outcome_basis',
    "outcome_basis TEXT DEFAULT 'legacy' CHECK(outcome_basis IN ('final', 'estimated', 'legacy'))"
  );
  addColumnIfMissing('signal_scores', 'signal_scores TEXT');
  addColumnIfMissing('signal_weights_snapshot', 'signal_weights_snapshot TEXT');

  if (columnNames.has('predicted_outcome')) {
    db.exec(`
      UPDATE predictions
      SET learning_comparable = CASE
        WHEN predicted_outcome IN ('YES', 'NO')
         AND model_probability IS NOT NULL
         AND market_probability IS NOT NULL
        THEN 1
        ELSE 0
      END
      WHERE learning_comparable IS NULL OR learning_comparable NOT IN (0, 1)
    `);
  }

}

function migrateCausalEventReasoning(db: Database.Database): void {
  // Idempotent: CREATE TABLE IF NOT EXISTS handles re-runs.
  // This migration is a no-op if the schema.sql CREATE statements have already
  // run, but we keep it here so the tables are guaranteed to exist even when
  // the schema.sql executes on an older database that predates v1.95.
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      domain TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      source_intel_ids TEXT,
      tags TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'superseded')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_event_key ON events(event_key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_domain ON events(domain)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON events(occurred_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS event_thoughts (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1,
      mechanism TEXT NOT NULL,
      causal_chain TEXT NOT NULL,
      impacted_assets TEXT NOT NULL,
      invalidation_conditions TEXT,
      model_version TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_thoughts_event_id ON event_thoughts(event_id)`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_thoughts_event_version
    ON event_thoughts(event_id, version)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS event_forecasts (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      thought_id TEXT NOT NULL REFERENCES event_thoughts(id) ON DELETE CASCADE,
      asset TEXT NOT NULL,
      domain TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('up', 'down', 'neutral')),
      horizon_hours INTEGER NOT NULL CHECK(horizon_hours > 0),
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      invalidation_conditions TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'confirmed', 'invalidated', 'expired')),
      expires_at TEXT NOT NULL,
      resolved_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_forecasts_event_id ON event_forecasts(event_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_forecasts_thought_id ON event_forecasts(thought_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_forecasts_status ON event_forecasts(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_forecasts_asset ON event_forecasts(asset)`);

  db.exec(`
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
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_outcomes_forecast_id ON event_outcomes(forecast_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_outcomes_event_id ON event_outcomes(event_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_outcomes_resolution ON event_outcomes(resolution_status)`);
}

function migratePredictionsForDelphiResolution(db: Database.Database): void {
  const hasPredictionsTable = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'predictions' LIMIT 1"
    )
    .get();
  if (!hasPredictionsTable) {
    return;
  }

  const columns = db
    .prepare("PRAGMA table_info('predictions')")
    .all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => String(column.name ?? '')));
  const addColumnIfMissing = (name: string, definition: string): void => {
    if (columnNames.has(name)) {
      return;
    }
    db.exec(`ALTER TABLE predictions ADD COLUMN ${definition}`);
    columnNames.add(name);
  };

  addColumnIfMissing(
    'domain',
    "domain TEXT"
  );
  addColumnIfMissing('session_tag', 'session_tag TEXT');
  addColumnIfMissing('regime_tag', 'regime_tag TEXT');
  addColumnIfMissing('strategy_class', 'strategy_class TEXT');
  addColumnIfMissing('symbol', 'symbol TEXT');
  addColumnIfMissing('created_at', 'created_at TEXT');
  addColumnIfMissing(
    'horizon_minutes',
    'horizon_minutes INTEGER CHECK(horizon_minutes IS NULL OR horizon_minutes > 0)'
  );
  addColumnIfMissing('expires_at', 'expires_at TEXT');
  addColumnIfMissing('context_tags', 'context_tags TEXT');
  addColumnIfMissing(
    'resolution_status',
    "resolution_status TEXT NOT NULL DEFAULT 'open' CHECK(resolution_status IN ('open', 'resolved_true', 'resolved_false', 'unresolved_error'))"
  );
  addColumnIfMissing('resolution_metadata', 'resolution_metadata TEXT');
  addColumnIfMissing('resolution_error', 'resolution_error TEXT');
  addColumnIfMissing('resolution_timestamp', 'resolution_timestamp TEXT');
  addColumnIfMissing('outcome', "outcome TEXT");
  addColumnIfMissing('outcome_timestamp', 'outcome_timestamp TEXT');
  addColumnIfMissing('pnl', 'pnl REAL');
  addColumnIfMissing('brier_contribution', 'brier_contribution REAL');

  db.exec(`
    UPDATE predictions
    SET created_at = datetime('now')
    WHERE created_at IS NULL OR TRIM(created_at) = ''
  `);

  db.exec(`
    UPDATE predictions
    SET domain = 'global'
    WHERE domain IS NULL OR TRIM(domain) = ''
  `);

  db.exec(`
    UPDATE predictions
    SET resolution_status = 'open'
    WHERE resolution_status IS NULL
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_predictions_domain
    ON predictions(domain)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_predictions_resolution_status
    ON predictions(resolution_status)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_predictions_open_expiry
    ON predictions(expires_at, created_at)
    WHERE resolution_status = 'open' AND expires_at IS NOT NULL
  `);
}

function migrateAlertPersistenceLifecycle(db: Database.Database): void {
  db.exec(`
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
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK(event_type IN ('open', 'suppressed', 'sent', 'resolved', 'acknowledged', 'delivery')),
      from_state TEXT,
      to_state TEXT,
      reason_code TEXT,
      payload_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
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
    )
  `);

  const columns = db.prepare("PRAGMA table_info('alerts')").all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => String(column.name ?? '')));
  const addColumnIfMissing = (name: string, definition: string): void => {
    if (columnNames.has(name)) {
      return;
    }
    db.exec(`ALTER TABLE alerts ADD COLUMN ${definition}`);
    columnNames.add(name);
  };

  addColumnIfMissing('state', "state TEXT NOT NULL DEFAULT 'open'");
  addColumnIfMissing('metadata_json', 'metadata_json TEXT');
  addColumnIfMissing('occurred_at', 'occurred_at TEXT');
  addColumnIfMissing('acknowledged_at', 'acknowledged_at TEXT');
  addColumnIfMissing('acknowledged_by', 'acknowledged_by TEXT');
  addColumnIfMissing('suppressed_at', 'suppressed_at TEXT');
  addColumnIfMissing('sent_at', 'sent_at TEXT');
  addColumnIfMissing('resolved_at', 'resolved_at TEXT');
  addColumnIfMissing('last_error', 'last_error TEXT');
  addColumnIfMissing('created_at', 'created_at TEXT');
  addColumnIfMissing('updated_at', 'updated_at TEXT');

  db.exec(`
    UPDATE alerts
    SET state = 'open'
    WHERE state IS NULL OR TRIM(state) = ''
  `);
  db.exec(`
    UPDATE alerts
    SET created_at = COALESCE(created_at, datetime('now')),
        updated_at = COALESCE(updated_at, datetime('now'))
    WHERE created_at IS NULL OR updated_at IS NULL
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_state
    ON alerts(state)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_dedupe_key
    ON alerts(dedupe_key)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_created
    ON alerts(created_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alert_events_alert_id
    ON alert_events(alert_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alert_events_created
    ON alert_events(created_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alert_deliveries_alert_id
    ON alert_deliveries(alert_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alert_deliveries_status
    ON alert_deliveries(status)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alert_deliveries_created
    ON alert_deliveries(created_at)
  `);
}

export function openDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? process.env.THUFIR_DB_PATH ?? DEFAULT_DB_PATH;

  const existing = INSTANCES.get(resolvedPath);
  if (existing) {
    return existing;
  }

  ensureDirectory(resolvedPath);

  const db = new Database(resolvedPath);
  try {
    db.pragma('journal_mode = WAL');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (!/readonly/i.test(message)) {
      throw error;
    }
  }
  db.pragma('foreign_keys = ON');

  applySchema(db);

  INSTANCES.set(resolvedPath, db);
  return db;
}

export function closeDatabase(dbPath?: string): void {
  const resolvedPath = dbPath ?? process.env.THUFIR_DB_PATH ?? DEFAULT_DB_PATH;
  const existing = INSTANCES.get(resolvedPath);
  if (!existing) {
    return;
  }
  existing.close();
  INSTANCES.delete(resolvedPath);
}
