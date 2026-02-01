import { openDatabase } from './db.js';

export interface DecisionAuditInput {
  source?: string;
  userId?: string;
  sessionId?: string;
  mode?: string;
  goal?: string;
  marketId?: string;
  predictionId?: string;
  tradeAction?: string;
  tradeOutcome?: string;
  tradeAmount?: number | null;
  confidence?: number | null;
  edge?: number | null;
  criticApproved?: boolean | null;
  criticIssues?: Array<string | { type: string; severity: string; description: string }>;
  fragilityScore?: number | null;
  toolCalls?: number | null;
  iterations?: number | null;
  toolTrace?: unknown;
  planTrace?: unknown;
  notes?: Record<string, unknown>;
}

function serializeJson(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function ensureDecisionAuditTable(): void {
  const db = openDatabase();
  db.exec(`
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
      critic_issues TEXT,
      fragility_score REAL,
      tool_calls INTEGER,
      iterations INTEGER,
      tool_trace TEXT,
      plan_trace TEXT,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_decision_audit_created ON decision_audit(created_at);
    CREATE INDEX IF NOT EXISTS idx_decision_audit_market ON decision_audit(market_id);
    CREATE INDEX IF NOT EXISTS idx_decision_audit_prediction ON decision_audit(prediction_id);
  `);
}

export function recordDecisionAudit(input: DecisionAuditInput): void {
  ensureDecisionAuditTable();
  const db = openDatabase();
  db.prepare(
    `
      INSERT INTO decision_audit (
        source,
        user_id,
        session_id,
        mode,
        goal,
        market_id,
        prediction_id,
        trade_action,
        trade_outcome,
        trade_amount,
        confidence,
        edge,
        critic_approved,
        critic_issues,
        fragility_score,
        tool_calls,
        iterations,
        tool_trace,
        plan_trace,
        notes
      ) VALUES (
        @source,
        @userId,
        @sessionId,
        @mode,
        @goal,
        @marketId,
        @predictionId,
        @tradeAction,
        @tradeOutcome,
        @tradeAmount,
        @confidence,
        @edge,
        @criticApproved,
        @criticIssues,
        @fragilityScore,
        @toolCalls,
        @iterations,
        @toolTrace,
        @planTrace,
        @notes
      )
    `
  ).run({
    source: input.source ?? null,
    userId: input.userId ?? null,
    sessionId: input.sessionId ?? null,
    mode: input.mode ?? null,
    goal: input.goal ?? null,
    marketId: input.marketId ?? null,
    predictionId: input.predictionId ?? null,
    tradeAction: input.tradeAction ?? null,
    tradeOutcome: input.tradeOutcome ?? null,
    tradeAmount: input.tradeAmount ?? null,
    confidence: input.confidence ?? null,
    edge: input.edge ?? null,
    criticApproved:
      input.criticApproved === undefined || input.criticApproved === null
        ? null
        : input.criticApproved
          ? 1
          : 0,
    criticIssues: serializeJson(input.criticIssues ?? null),
    fragilityScore: input.fragilityScore ?? null,
    toolCalls: input.toolCalls ?? null,
    iterations: input.iterations ?? null,
    toolTrace: serializeJson(input.toolTrace ?? null),
    planTrace: serializeJson(input.planTrace ?? null),
    notes: serializeJson(input.notes ?? null),
  });
}
