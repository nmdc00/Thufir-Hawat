import { openDatabase } from './db.js';

export interface GateVerdictCooldown {
  symbol: string;
  side: string;
  lastRejectAt: string;
  lastEdge: number;
}

function ensureSchema(): void {
  const db = openDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS gate_verdict_cooldowns (
      symbol         TEXT NOT NULL,
      side           TEXT NOT NULL,
      last_reject_at TEXT NOT NULL,
      last_edge      REAL NOT NULL,
      PRIMARY KEY (symbol, side)
    )
  `);
}

export function getGateVerdictCooldown(symbol: string, side: string): GateVerdictCooldown | null {
  ensureSchema();
  const db = openDatabase();
  const statement = db.prepare(
    `SELECT symbol, side, last_reject_at AS lastRejectAt, last_edge AS lastEdge
     FROM gate_verdict_cooldowns
     WHERE symbol = @symbol AND side = @side`
  );
  if (typeof statement.get !== 'function') {
    return null;
  }
  const row = statement.get({ symbol, side }) as GateVerdictCooldown | undefined;
  return row ?? null;
}

export function recordGateVerdictReject(input: {
  symbol: string;
  side: string;
  edge: number;
  rejectedAt?: Date;
}): void {
  ensureSchema();
  const db = openDatabase();
  db.prepare(
    `INSERT INTO gate_verdict_cooldowns (symbol, side, last_reject_at, last_edge)
     VALUES (@symbol, @side, @lastRejectAt, @lastEdge)
     ON CONFLICT(symbol, side) DO UPDATE SET
       last_reject_at = excluded.last_reject_at,
       last_edge = excluded.last_edge`
  ).run({
    symbol: input.symbol,
    side: input.side,
    lastRejectAt: (input.rejectedAt ?? new Date()).toISOString(),
    lastEdge: Number.isFinite(input.edge) ? input.edge : 0,
  });
}
