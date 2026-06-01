import type { IncomingMessage, ServerResponse } from 'node:http';

import type Database from 'better-sqlite3';

import { buildPaperPromotionReport } from '../core/paper_promotion.js';
import { loadConfig, type ThufirConfig } from '../core/config.js';
import { getDailyPnLRollup } from '../core/daily_pnl.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import { openDatabase } from '../memory/db.js';
import type { PerpTradeJournalEntry } from '../memory/perp_trade_journal.js';
import { cached, cachedAsync } from './dashboard_cache.js';

export type DashboardMode = 'paper' | 'live' | 'combined';
export type DashboardTimeframe = 'day' | 'period' | 'all' | 'custom';

export type DashboardFilters = {
  mode: DashboardMode;
  timeframe: DashboardTimeframe;
  period: string | null;
  from: string | null;
  to: string | null;
};

export type ConversationSession = {
  sessionId: string;
  messageCount: number;
  firstMessage: string;
  startedAt: string;
  lastMessageAt: string;
};

export type ConversationsListResponse = {
  sessions: ConversationSession[];
};

export type ConversationThreadMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type ConversationThreadResponse = {
  sessionId: string;
  messages: ConversationThreadMessage[];
};

export type DashboardLogKind = 'decision' | 'incident';

export type ToolTraceEntry = {
  toolName: string;
  input: Record<string, unknown>;
  success: boolean;
};

export type DecisionAuditEntry = {
  kind: 'decision';
  id: number;
  createdAt: string;
  source: string | null;
  sessionId: string | null;
  marketId: string | null;
  tradeAction: string | null;
  confidence: number | null;
  edge: number | null;
  criticApproved: boolean | null;
  toolCallCount: number;
  iterations: number;
  toolTrace: ToolTraceEntry[];
  planTrace: unknown;
  notes: unknown;
};

export type IncidentEntry = {
  kind: 'incident';
  id: number;
  createdAt: string;
  goal: string | null;
  toolName: string | null;
  error: string;
  blockerKind: string | null;
  details: unknown;
};

export type LogsResponse = {
  entries: Array<DecisionAuditEntry | IncidentEntry>;
  total: number;
};

type GateAttributionSection = {
  config: {
    minEdge: number | null;
    requireHighConfidence: boolean;
    maxTradesPerScan: number | null;
    llmEntryGateEnabled: boolean;
    tradeQualityEnabled: boolean;
    calibrationRiskEnabled: boolean;
    signalPerformanceMinSharpe: number | null;
    signalPerformanceMinSamples: number | null;
  };
  policyState: {
    observationMode: boolean;
    minEdgeOverride: number | null;
    maxTradesPerScanOverride: number | null;
    leverageCapOverride: number | null;
    reason: string | null;
    updatedAt: string | null;
  };
  entryGate: {
    verdictCounts: { approve: number; reject: number; resize: number };
    reasonCounts: Array<{ reasonCode: string; count: number }>;
    recentDecisions: Array<{
      createdAt: string;
      symbol: string;
      verdict: string;
      reasonCode: string | null;
      adjustedSizeUsd: number | null;
      suggestedLeverage: number | null;
      reasoning: string;
    }>;
  };
  journal: {
    outcomeCounts: { executed: number; failed: number; blocked: number };
    blockedReasons: Array<{ reason: string; count: number }>;
    recentPolicyAdjustments: Array<{
      createdAt: string;
      symbol: string;
      policyReasonCode: string | null;
      policySizeMultiplier: number | null;
      entryGateVerdict: string | null;
      entryGateReasonCode: string | null;
      reasoning: string | null;
    }>;
  };
};

type TimeRange = {
  fromMs: number | null;
  toMs: number | null;
};

type PaperPerpFillRow = {
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  fillPrice: number;
  markPrice: number;
  realizedPnlUsd: number;
  feeUsd: number;
  createdAt: string;
};

type PositionState = {
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
};

type EquityPoint = {
  timestamp: string;
  cashBalance: number;
  unrealizedPnl: number;
  equity: number;
  cumulativeRealizedPnl: number;
  cumulativeFees: number;
};

type EquityCurveSection = {
  points: EquityPoint[];
  summary: {
    startEquity: number | null;
    endEquity: number | null;
    returnPct: number | null;
    maxDrawdownPct: number | null;
  };
};

type LearnedWeightRow = {
  domain: string;
  weights: {
    technical: number | null;
    news: number | null;
    onChain: number | null;
  };
  samples: number;
  updatedAt: string | null;
};

type PredictionAccuracyWindow = {
  windowSize: number;
  sampleCount: number;
  accuracy: number | null;
  brierModel: number | null;
  brierMarket: number | null;
  brierDelta: number | null;
  avgEdge: number | null;
  totalPnl: number | null;
};

type LearningAuditSection = {
  comparable: {
    totalCaseCount: number;
    byDomain: Array<{ domain: string; count: number }>;
  };
  exclusions: {
    totalCaseCount: number;
    byReason: Array<{ reason: string; count: number }>;
  };
  execution: {
    totalCaseCount: number;
    byDomain: Array<{ domain: string; count: number }>;
  };
};

type CloseLearningSection = {
  finalizer: {
    totalJobs: number;
    pending: number;
    running: number;
    finalized: number;
    failedRetryable: number;
    failedTerminal: number;
    delayed: number;
  };
  closeEvents: {
    partialReduces: number;
    fullCloses: number;
  };
  tradeCloses: {
    total: number;
    recent: Array<Record<string, unknown>>;
  };
  reflections: {
    total: number;
  };
  regretCases: {
    total: number;
    byType: Array<{ type: string; count: number }>;
  };
  policyLearning: {
    activeAdjustments: Array<Record<string, unknown>>;
    promotionEvents: Array<Record<string, unknown>>;
  };
};

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function getDashboardConfig(): ThufirConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

function normalizeIso(input: string | null): string | null {
  if (!input) return null;
  const value = input.trim();
  if (!value) return null;
  const dt = new Date(value);
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
}

function utcStartOfDayIso(now: Date): string {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export function parseDashboardFilters(url: URL, now = new Date()): DashboardFilters {
  const rawMode = String(url.searchParams.get('mode') ?? '').trim().toLowerCase();
  const mode: DashboardMode =
    rawMode === 'paper' || rawMode === 'live' || rawMode === 'combined' ? rawMode : 'combined';

  const rawTimeframe = String(url.searchParams.get('timeframe') ?? '').trim().toLowerCase();
  const timeframe: DashboardTimeframe =
    rawTimeframe === 'day' || rawTimeframe === 'period' || rawTimeframe === 'all' || rawTimeframe === 'custom'
      ? rawTimeframe
      : 'all';

  const period = String(url.searchParams.get('period') ?? '').trim() || null;
  const requestedFrom = normalizeIso(url.searchParams.get('from'));
  const requestedTo = normalizeIso(url.searchParams.get('to'));

  if (timeframe === 'day') {
    return {
      mode,
      timeframe,
      period: null,
      from: utcStartOfDayIso(now),
      to: now.toISOString(),
    };
  }

  if (timeframe === 'period') {
    return {
      mode,
      timeframe,
      period: period ?? '30d',
      from: requestedFrom,
      to: requestedTo,
    };
  }

  if (timeframe === 'custom') {
    return {
      mode,
      timeframe,
      period: null,
      from: requestedFrom,
      to: requestedTo,
    };
  }

  return {
    mode,
    timeframe: 'all',
    period: null,
    from: null,
    to: null,
  };
}

function resolvePeriodWindow(periodRaw: string | null, nowMs: number): TimeRange {
  const period = (periodRaw ?? '30d').trim().toLowerCase();
  const match = period.match(/^(\d+)([dhwm])$/);
  if (!match) {
    return { fromMs: null, toMs: null };
  }
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) {
    return { fromMs: null, toMs: null };
  }
  const multiplier =
    unit === 'd'
      ? 24 * 60 * 60 * 1000
      : unit === 'h'
        ? 60 * 60 * 1000
        : unit === 'w'
          ? 7 * 24 * 60 * 60 * 1000
          : 30 * 24 * 60 * 60 * 1000;
  return { fromMs: nowMs - value * multiplier, toMs: nowMs };
}

function resolveTimeRange(filters: DashboardFilters, now = new Date()): TimeRange {
  const nowMs = now.getTime();
  if (filters.timeframe === 'all') {
    return { fromMs: null, toMs: null };
  }

  if (filters.timeframe === 'day') {
    const fromMs = Date.parse(filters.from ?? '');
    const toMs = Date.parse(filters.to ?? '');
    return {
      fromMs: Number.isFinite(fromMs) ? fromMs : null,
      toMs: Number.isFinite(toMs) ? toMs : nowMs,
    };
  }

  if (filters.timeframe === 'period') {
    return resolvePeriodWindow(filters.period, nowMs);
  }

  const fromMs = Date.parse(filters.from ?? '');
  const toMs = Date.parse(filters.to ?? '');
  return {
    fromMs: Number.isFinite(fromMs) ? fromMs : null,
    toMs: Number.isFinite(toMs) ? toMs : null,
  };
}

function isLiveMode(filters: DashboardFilters): boolean {
  return filters.mode === 'live';
}

function isPaperMode(filters: DashboardFilters): boolean {
  return filters.mode === 'paper';
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function tableHasColumn(
  db: Database.Database,
  tableName: string,
  columnName: string
): boolean {
  if (!tableExists(db, tableName)) return false;
  try {
    const rows = db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === columnName);
  } catch {
    return false;
  }
}

function safeCount(
  db: Database.Database,
  query: string,
  params: ReadonlyArray<unknown> = []
): number {
  try {
    const row = db.prepare(query).get(...params) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

function parsePositiveInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function buildDashboardCacheKey(namespace: string, url: URL): string {
  return `${namespace}:${url.pathname}?${url.searchParams.toString()}`;
}

export function buildConversationsListResponse(params?: {
  db?: Database.Database;
}): ConversationsListResponse {
  const db = params?.db ?? openDatabase();
  if (!tableExists(db, 'chat_messages')) {
    return { sessions: [] };
  }
  const rows = db.prepare(
    `
      SELECT
        cm.session_id AS sessionId,
        COUNT(*) AS messageCount,
        MIN(cm.created_at) AS startedAt,
        MAX(cm.created_at) AS lastMessageAt,
        COALESCE((
          SELECT content
          FROM chat_messages cm2
          WHERE cm2.session_id = cm.session_id
            AND cm2.role = 'user'
          ORDER BY cm2.created_at ASC, cm2.id ASC
          LIMIT 1
        ), '') AS firstMessage
      FROM chat_messages cm
      WHERE cm.role IN ('user', 'assistant')
        AND cm.session_id NOT GLOB '__*'
      GROUP BY cm.session_id
      ORDER BY MAX(cm.created_at) DESC, cm.session_id DESC
    `
  ).all() as Array<{
    sessionId: string;
    messageCount: number;
    startedAt: string;
    lastMessageAt: string;
    firstMessage: string;
  }>;

  return {
    sessions: rows.map((row) => ({
      sessionId: String(row.sessionId),
      messageCount: Number(row.messageCount ?? 0),
      startedAt: String(row.startedAt),
      lastMessageAt: String(row.lastMessageAt),
      firstMessage: truncateText(String(row.firstMessage ?? ''), 120),
    })),
  };
}

export function buildConversationThreadResponse(
  sessionId: string,
  params?: { db?: Database.Database; limit?: number }
): ConversationThreadResponse {
  const db = params?.db ?? openDatabase();
  if (!tableExists(db, 'chat_messages')) {
    return { sessionId, messages: [] };
  }
  const limit = Math.max(1, Math.min(200, Number(params?.limit ?? 50) || 50));
  const rows = db.prepare(
    `
      SELECT id, role, content, createdAt, rowOrder
      FROM (
        SELECT id, role, content, created_at AS createdAt, rowid AS rowOrder
        FROM chat_messages
        WHERE session_id = ?
          AND role IN ('user', 'assistant')
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      )
      ORDER BY createdAt ASC, rowOrder ASC
    `
  ).all(sessionId, limit) as Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
    rowOrder: number;
  }>;

  return {
    sessionId,
    messages: rows.map((row) => {
      let content = String(row.content ?? '');
      if (row.role === 'assistant') {
        content = content
          .replace(/^\s*(I['']m|I am)\s+Thufir\s+Hawat\.\s*(\r?\n)+/i, '')
          .replace(/^\s*(I['']m|I am)\s+Thufir\s+Hawat\.\s*/i, '');
      }
      return {
        id: String(row.id),
        role: row.role === 'assistant' ? 'assistant' : 'user',
        content,
        createdAt: String(row.createdAt),
      };
    }),
  };
}

function listDecisionAuditEntries(
  db: Database.Database,
  limit: number,
  offset: number
): DecisionAuditEntry[] {
  if (!tableExists(db, 'decision_audit')) {
    return [];
  }
  const rows = db.prepare(
    `
      SELECT
        id,
        created_at AS createdAt,
        source,
        session_id AS sessionId,
        market_id AS marketId,
        trade_action AS tradeAction,
        confidence,
        edge,
        critic_approved AS criticApproved,
        tool_calls AS toolCalls,
        iterations,
        tool_trace AS toolTrace,
        plan_trace AS planTrace,
        notes
      FROM decision_audit
      ORDER BY created_at DESC, id DESC
      LIMIT ?
      OFFSET ?
    `
  ).all(limit, offset) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const parsedToolTrace = parseJson<Array<Record<string, unknown>>>(row.toolTrace) ?? [];
    const toolTrace = parsedToolTrace.map((entry) => ({
      toolName: String(entry.toolName ?? entry.name ?? ''),
      input:
        entry.input && typeof entry.input === 'object' && !Array.isArray(entry.input)
          ? (entry.input as Record<string, unknown>)
          : {},
      success: Boolean(entry.success),
    }));
    const criticApprovedRaw = row.criticApproved;
    return {
      kind: 'decision',
      id: Number(row.id ?? 0),
      createdAt: String(row.createdAt ?? ''),
      source: row.source == null ? null : String(row.source),
      sessionId: row.sessionId == null ? null : String(row.sessionId),
      marketId: row.marketId == null ? null : String(row.marketId),
      tradeAction: row.tradeAction == null ? null : String(row.tradeAction),
      confidence: row.confidence == null ? null : Number(row.confidence),
      edge: row.edge == null ? null : Number(row.edge),
      criticApproved:
        criticApprovedRaw == null ? null : Number(criticApprovedRaw) === 1,
      toolCallCount: Math.max(Number(row.toolCalls ?? toolTrace.length ?? 0) || 0, toolTrace.length),
      iterations: Number(row.iterations ?? 0) || 0,
      toolTrace,
      planTrace: parseJson(row.planTrace),
      notes: parseJson(row.notes),
    } satisfies DecisionAuditEntry;
  });
}

function listIncidentEntries(
  db: Database.Database,
  limit: number,
  offset: number
): IncidentEntry[] {
  if (!tableExists(db, 'agent_incidents')) {
    return [];
  }
  const rows = db.prepare(
    `
      SELECT
        id,
        created_at AS createdAt,
        goal,
        tool_name AS toolName,
        error,
        blocker_kind AS blockerKind,
        details_json AS details
      FROM agent_incidents
      ORDER BY created_at DESC, id DESC
      LIMIT ?
      OFFSET ?
    `
  ).all(limit, offset) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    kind: 'incident',
    id: Number(row.id ?? 0),
    createdAt: String(row.createdAt ?? ''),
    goal: row.goal == null ? null : String(row.goal),
    toolName: row.toolName == null ? null : String(row.toolName),
    error: String(row.error ?? ''),
    blockerKind: row.blockerKind == null ? null : String(row.blockerKind),
    details: parseJson(row.details),
  }));
}

export function buildDashboardLogsResponse(params?: {
  db?: Database.Database;
  kind?: 'decision' | 'incident' | 'all';
  limit?: number;
  offset?: number;
}): LogsResponse {
  const db = params?.db ?? openDatabase();
  const kind = params?.kind ?? 'all';
  const limit = Math.max(1, Math.min(200, Number(params?.limit ?? 50) || 50));
  const offset = Math.max(0, Number(params?.offset ?? 0) || 0);

  if (kind === 'decision') {
    const total = safeCount(db, 'SELECT COUNT(*) AS c FROM decision_audit');
    return {
      entries: listDecisionAuditEntries(db, limit, offset),
      total,
    };
  }

  if (kind === 'incident') {
    const total = safeCount(db, 'SELECT COUNT(*) AS c FROM agent_incidents');
    return {
      entries: listIncidentEntries(db, limit, offset),
      total,
    };
  }

  const fetchWindow = limit + offset;
  const decisions = listDecisionAuditEntries(db, fetchWindow, 0);
  const incidents = listIncidentEntries(db, fetchWindow, 0);
  const entries = [...decisions, ...incidents]
    .sort((a, b) => {
      const timeDiff = Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt));
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return Number(b.id) - Number(a.id);
    })
    .slice(offset, offset + limit);

  return {
    entries,
    total:
      safeCount(db, 'SELECT COUNT(*) AS c FROM decision_audit') +
      safeCount(db, 'SELECT COUNT(*) AS c FROM agent_incidents'),
  };
}

function listPaperPerpFills(db: Database.Database): PaperPerpFillRow[] {
  if (!tableExists(db, 'paper_perp_fills')) {
    return [];
  }
  const rows = db
    .prepare(
      `
        SELECT symbol,
               side,
               size,
               fill_price as fillPrice,
               mark_price as markPrice,
               realized_pnl_usd as realizedPnlUsd,
               fee_usd as feeUsd,
               created_at as createdAt
        FROM paper_perp_fills
        ORDER BY created_at ASC, id ASC
      `
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    symbol: String(row.symbol ?? '').toUpperCase(),
    side: String(row.side ?? 'buy') === 'sell' ? 'sell' : 'buy',
    size: Number(row.size ?? 0),
    fillPrice: Number(row.fillPrice ?? 0),
    markPrice: Number(row.markPrice ?? row.fillPrice ?? 0),
    realizedPnlUsd: Number(row.realizedPnlUsd ?? 0),
    feeUsd: Number(row.feeUsd ?? 0),
    createdAt: String(row.createdAt ?? ''),
  }));
}

function applyFillToPositionState(
  map: Map<string, PositionState>,
  fill: PaperPerpFillRow
): void {
  const size = Number(fill.size);
  const price = Number(fill.fillPrice);
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
    return;
  }

  const symbol = fill.symbol;
  const existing = map.get(symbol);
  const existingSigned =
    existing == null ? 0 : existing.side === 'long' ? existing.size : -existing.size;
  const fillSigned = fill.side === 'buy' ? size : -size;
  const nextSigned = existingSigned + fillSigned;

  if (existingSigned === 0) {
    map.set(symbol, {
      side: fillSigned >= 0 ? 'long' : 'short',
      size: Math.abs(fillSigned),
      entryPrice: price,
    });
    return;
  }

  if (Math.sign(existingSigned) === Math.sign(fillSigned)) {
    if (!existing) {
      return;
    }
    const nextSize = Math.abs(nextSigned);
    const weightedEntry =
      (Math.abs(existingSigned) * existing.entryPrice + Math.abs(fillSigned) * price) / nextSize;
    map.set(symbol, {
      side: nextSigned >= 0 ? 'long' : 'short',
      size: nextSize,
      entryPrice: weightedEntry,
    });
    return;
  }

  if (Math.abs(fillSigned) < Math.abs(existingSigned)) {
    if (!existing) {
      return;
    }
    map.set(symbol, {
      side: existing.side,
      size: Math.abs(nextSigned),
      entryPrice: existing.entryPrice,
    });
    return;
  }

  if (Math.abs(fillSigned) === Math.abs(existingSigned)) {
    map.delete(symbol);
    return;
  }

  map.set(symbol, {
    side: nextSigned >= 0 ? 'long' : 'short',
    size: Math.abs(nextSigned),
    entryPrice: price,
  });
}

function computeUnrealizedPnl(
  positions: Map<string, PositionState>,
  lastMarkBySymbol: Map<string, number>
): number {
  let total = 0;
  for (const [symbol, position] of positions.entries()) {
    const mark = lastMarkBySymbol.get(symbol) ?? position.entryPrice;
    const delta =
      position.side === 'long'
        ? (mark - position.entryPrice) * position.size
        : (position.entryPrice - mark) * position.size;
    total += Number.isFinite(delta) ? delta : 0;
  }
  return total;
}

function buildPaperEquitySeries(
  db: Database.Database,
  filters: DashboardFilters,
  mids: Record<string, number>
): EquityCurveSection {
  const startingCash = safeCount(
    db,
    'SELECT COALESCE(starting_cash_usdc, 200) AS c FROM paper_perp_book WHERE id = 1'
  );
  const fills = listPaperPerpFills(db);
  const { fromMs, toMs } = resolveTimeRange(filters);
  const positions = new Map<string, PositionState>();
  const lastMarkBySymbol = new Map<string, number>();
  const points: EquityPoint[] = [];
  let cashBalance = startingCash > 0 ? startingCash : 200;
  let cumulativeRealized = 0;
  let cumulativeFees = 0;

  for (const fill of fills) {
    const fillMs = Date.parse(fill.createdAt);
    if (!Number.isFinite(fillMs)) {
      continue;
    }
    applyFillToPositionState(positions, fill);
    lastMarkBySymbol.set(fill.symbol, fill.markPrice);

    cumulativeRealized += fill.realizedPnlUsd;
    cumulativeFees += fill.feeUsd;
    cashBalance += fill.realizedPnlUsd - fill.feeUsd;
    const unrealizedPnl = computeUnrealizedPnl(positions, lastMarkBySymbol);
    const equity = cashBalance + unrealizedPnl;

    const inRange =
      (fromMs == null || fillMs >= fromMs) &&
      (toMs == null || fillMs <= toMs);
    if (inRange) {
      points.push({
        timestamp: new Date(fillMs).toISOString(),
        cashBalance,
        unrealizedPnl,
        equity,
        cumulativeRealizedPnl: cumulativeRealized,
        cumulativeFees,
      });
    }
  }

  // Re-mark surviving open positions to the current dashboard mids so the ending
  // paper equity matches the open-positions table's mark-to-market view.
  for (const [symbol, position] of positions.entries()) {
    const currentMid = resolveMidForDashboard(symbol, mids);
    if (typeof currentMid === 'number' && Number.isFinite(currentMid) && currentMid > 0) {
      lastMarkBySymbol.set(symbol, currentMid);
    } else if (!lastMarkBySymbol.has(symbol)) {
      lastMarkBySymbol.set(symbol, position.entryPrice);
    }
  }

  const finalUnrealizedPnl = computeUnrealizedPnl(positions, lastMarkBySymbol);
  const finalEquity = cashBalance + finalUnrealizedPnl;
  const lastPoint = points[points.length - 1];
  const shouldAppendFinalPoint =
    positions.size > 0 &&
    (!lastPoint ||
      Math.abs((lastPoint.unrealizedPnl ?? 0) - finalUnrealizedPnl) > 1e-9 ||
      Math.abs((lastPoint.equity ?? 0) - finalEquity) > 1e-9);

  if (shouldAppendFinalPoint) {
    points.push({
      timestamp: new Date().toISOString(),
      cashBalance,
      unrealizedPnl: finalUnrealizedPnl,
      equity: finalEquity,
      cumulativeRealizedPnl: cumulativeRealized,
      cumulativeFees,
    });
  }

  if (points.length === 0) {
    points.push({
      timestamp: new Date().toISOString(),
      cashBalance,
      unrealizedPnl: 0,
      equity: cashBalance,
      cumulativeRealizedPnl: cumulativeRealized,
      cumulativeFees,
    });
  }

  const startEquity = points[0]?.equity ?? null;
  const endEquity = points[points.length - 1]?.equity ?? null;
  const returnPct =
    startEquity != null && endEquity != null && Math.abs(startEquity) > 1e-9
      ? ((endEquity - startEquity) / startEquity) * 100
      : null;
  let peak = Number.NEGATIVE_INFINITY;
  let maxDrawdownPct = 0;
  for (const point of points) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      const dd = ((peak - point.equity) / peak) * 100;
      maxDrawdownPct = Math.max(maxDrawdownPct, dd);
    }
  }

  return {
    points,
    summary: {
      startEquity,
      endEquity,
      returnPct,
      maxDrawdownPct,
    },
  };
}

function buildEmptyEquitySeries(): EquityCurveSection {
  return {
    points: [],
    summary: {
      startEquity: null,
      endEquity: null,
      returnPct: null,
      maxDrawdownPct: null,
    },
  };
}

type LiveWalletSnapshot = {
  equityCurve: EquityCurveSection;
  openPositions: {
    rows: OpenPositionRow[];
    summary: {
      totalUnrealizedPnlUsd: number;
      longCount: number;
      shortCount: number;
    };
  };
};

async function tryBuildLiveWalletSnapshot(config: ThufirConfig): Promise<LiveWalletSnapshot | null> {
  try {
    const client = new HyperliquidClient(config);
    const state = (await client.getClearinghouseState()) as {
      assetPositions?: Array<{ position?: Record<string, unknown> }>;
      marginSummary?: Record<string, unknown>;
      crossMarginSummary?: Record<string, unknown>;
      withdrawable?: string | number;
    };
    const spotState = (await client.getSpotClearinghouseState()) as {
      balances?: Array<Record<string, unknown>>;
    };
    const dexAbstraction = await client.getUserDexAbstraction().catch(() => null);

    const toNumber = (value: unknown): number | null => {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };

    const nowIso = new Date().toISOString();
    const rows: OpenPositionRow[] = [];
    let totalUnrealizedPnlUsd = 0;
    let longCount = 0;
    let shortCount = 0;

    for (const entry of state.assetPositions ?? []) {
      const position = entry?.position ?? {};
      const signedSize = toNumber((position as { szi?: unknown }).szi);
      if (signedSize == null || signedSize === 0) continue;
      const size = Math.abs(signedSize);
      const side: 'long' | 'short' = signedSize > 0 ? 'long' : 'short';
      const entryPrice = toNumber((position as { entryPx?: unknown }).entryPx) ?? 0;
      const unrealizedPnlUsd = toNumber((position as { unrealizedPnl?: unknown }).unrealizedPnl) ?? 0;
      const impliedCurrent =
        size > 0
          ? side === 'long'
            ? entryPrice + unrealizedPnlUsd / size
            : entryPrice - unrealizedPnlUsd / size
          : entryPrice;
      rows.push({
        symbol: String((position as { coin?: unknown }).coin ?? '').toUpperCase(),
        side,
        entryPrice,
        currentPrice: Number.isFinite(impliedCurrent) ? impliedCurrent : entryPrice,
        size,
        leverage: null,
        unrealizedPnlUsd,
        heldSeconds: 0,
        openedAt: '',
        updatedAt: nowIso,
      });
      totalUnrealizedPnlUsd += unrealizedPnlUsd;
      if (side === 'long') longCount += 1;
      if (side === 'short') shortCount += 1;
    }

    const spotUsdcRow = (spotState.balances ?? []).find(
      (row) => String(row.coin ?? '').trim().toUpperCase() === 'USDC'
    );
    const spotUsdcTotal = toNumber(spotUsdcRow?.total ?? null) ?? 0;
    const spotUsdcHold = toNumber(spotUsdcRow?.hold ?? null) ?? 0;
    const spotUsdcFree = Math.max(0, spotUsdcTotal - spotUsdcHold);
    const perpWithdrawable = toNumber(state.withdrawable ?? null) ?? 0;
    const availableBalance =
      dexAbstraction === true
        ? spotUsdcFree
        : perpWithdrawable > 0
          ? perpWithdrawable
          : spotUsdcFree;
    const accountValue = availableBalance;
    const equityCurve =
      accountValue != null
        ? {
            points: [
              {
                timestamp: nowIso,
                cashBalance: accountValue - totalUnrealizedPnlUsd,
                unrealizedPnl: totalUnrealizedPnlUsd,
                equity: accountValue,
                cumulativeRealizedPnl: 0,
                cumulativeFees: 0,
              },
            ],
            summary: {
              startEquity: accountValue,
              endEquity: accountValue,
              returnPct: 0,
              maxDrawdownPct: 0,
            },
          }
        : buildEmptyEquitySeries();

    return {
      equityCurve,
      openPositions: {
        rows,
        summary: {
          totalUnrealizedPnlUsd,
          longCount,
          shortCount,
        },
      },
    };
  } catch {
    return null;
  }
}
type OpenPositionRow = {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number | null;
  unrealizedPnlUsd: number;
  heldSeconds: number;
  openedAt: string;
  updatedAt: string;
};

function resolveMidForDashboard(symbol: string, mids: Record<string, number>): number | undefined {
  if (mids[symbol] != null) return mids[symbol];
  if (symbol.includes(':')) {
    const base = symbol.split(':').at(-1);
    if (base && mids[base] != null) return mids[base];
  }
  const beforeSlash = symbol.split('/')[0];
  if (beforeSlash && beforeSlash !== symbol && mids[beforeSlash] != null) return mids[beforeSlash];
  return undefined;
}

function listPaperOpenPositionRows(db: Database.Database, mids: Record<string, number> = {}): OpenPositionRow[] {
  if (!tableExists(db, 'paper_perp_positions')) {
    return [];
  }

  const rows = db
    .prepare(
      `
        SELECT p.symbol,
               p.side,
               p.size,
               p.leverage,
               p.entry_price as entryPrice,
               p.opened_at as openedAt,
               p.updated_at as updatedAt,
               COALESCE(m.mark_price, p.entry_price) as currentPrice
        FROM paper_perp_positions p
        LEFT JOIN (
          SELECT f.symbol, f.mark_price
          FROM paper_perp_fills f
          INNER JOIN (
            SELECT symbol, MAX(id) as max_id
            FROM paper_perp_fills
            GROUP BY symbol
          ) latest
            ON latest.symbol = f.symbol
           AND latest.max_id = f.id
        ) m
          ON m.symbol = p.symbol
        ORDER BY p.symbol ASC
      `
    )
    .all() as Array<Record<string, unknown>>;

  const nowMs = Date.now();
  return rows.map((row) => {
    const symbol = String(row.symbol ?? '').toUpperCase();
    const side = String(row.side ?? 'long') === 'short' ? 'short' : 'long';
    const size = Number(row.size ?? 0);
    const entryPrice = Number(row.entryPrice ?? 0);
    const currentPrice = resolveMidForDashboard(symbol, mids) ?? Number(row.currentPrice ?? entryPrice);
    const openedAt = String(row.openedAt ?? '');
    const updatedAt = String(row.updatedAt ?? '');
    const openedMs = Date.parse(openedAt);
    const heldSeconds =
      Number.isFinite(openedMs) && nowMs > openedMs
        ? Math.floor((nowMs - openedMs) / 1000)
        : 0;
    const unrealizedPnlUsd =
      side === 'long'
        ? (currentPrice - entryPrice) * size
        : (entryPrice - currentPrice) * size;
    const leverageRaw = Number(row.leverage ?? NaN);
    const leverage = Number.isFinite(leverageRaw) && leverageRaw > 0 ? leverageRaw : null;
    return {
      symbol,
      side,
      entryPrice,
      currentPrice,
      size,
      leverage,
      unrealizedPnlUsd: Number.isFinite(unrealizedPnlUsd) ? unrealizedPnlUsd : 0,
      heldSeconds,
      openedAt,
      updatedAt,
    };
  });
}

type TradeLogRow = {
  tradeId: number | null;
  symbol: string;
  side: 'buy' | 'sell' | null;
  signalClass: string | null;
  outcome: 'executed' | 'failed' | 'blocked' | 'unknown';
  realizedPnlUsd: number | null;
  directionScore: number | null;
  timingScore: number | null;
  sizingScore: number | null;
  exitScore: number | null;
  rCaptured: number | null;
  thesisCorrect: boolean | null;
  qualityBand: 'good' | 'mixed' | 'poor' | 'unknown';
  closedAt: string;
};

function toOptionalScore(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function resolveQualityBand(row: {
  directionScore: number | null;
  timingScore: number | null;
  sizingScore: number | null;
  exitScore: number | null;
}): 'good' | 'mixed' | 'poor' | 'unknown' {
  const scores = [row.directionScore, row.timingScore, row.sizingScore, row.exitScore].filter(
    (value): value is number => value != null
  );
  if (scores.length === 0) return 'unknown';
  const avg = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  if (avg >= 0.7) return 'good';
  if (avg < 0.45) return 'poor';
  return 'mixed';
}

function resolveJournalEntryMode(payload: Record<string, unknown>): DashboardMode | null {
  const candidates = [
    payload.mode,
    payload.bookMode,
    payload.perpMode,
    payload.executionMode,
    payload.execution_mode,
    payload.perp_mode,
    payload.book_mode,
  ];
  for (const candidate of candidates) {
    const value = String(candidate ?? '')
      .trim()
      .toLowerCase();
    if (value === 'paper' || value === 'live' || value === 'combined') {
      return value as DashboardMode;
    }
  }
  return null;
}

function journalModeMatches(payload: Record<string, unknown>, filters: DashboardFilters): boolean {
  if (filters.mode === 'combined') {
    return true;
  }
  const entryMode = resolveJournalEntryMode(payload);
  if (entryMode == null) {
    // Legacy journal entries are treated as paper unless explicitly tagged.
    return filters.mode === 'paper';
  }
  return entryMode === filters.mode;
}

function resolveJournalSignalClass(payload: Record<string, unknown>): string | null {
  const candidates = [payload.signalClass, payload.signal_class];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function resolveJournalMarketRegime(payload: Record<string, unknown>): string | null {
  const candidates = [payload.marketRegime, payload.market_regime];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function listTradeLogRows(
  db: Database.Database,
  filters: DashboardFilters,
  limit = 30
): TradeLogRow[] {
  // Fetch a larger window so temporal signalClass lookup has enough context.
  const fetchLimit = Math.max(1, Math.min(limit, 100));
  const rows = db
    .prepare(
      `
        SELECT payload, created_at as createdAt
        FROM decision_artifacts
        WHERE kind = 'perp_trade_journal'
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(fetchLimit * 4) as Array<{ payload?: string; createdAt?: string }>;

  // Build a per-symbol timeline of entry journals so close journals can borrow signalClass.
  type EntryCtx = { createdAtMs: number; signalClass: string | null };
  const entriesBySymbol = new Map<string, EntryCtx[]>();
  for (const row of rows) {
    if (!row.payload) continue;
    let p: Record<string, unknown>;
    try { p = JSON.parse(row.payload) as Record<string, unknown>; } catch { continue; }
    if (p.reduceOnly === true) continue;
    if (!journalModeMatches(p, filters)) continue;
    const sym = typeof p.symbol === 'string' ? p.symbol.trim().toUpperCase() : null;
    if (!sym) continue;
    const createdAtMs = resolveJournalClosedAtMs(p, row.createdAt);
    if (createdAtMs == null) continue;
    const arr = entriesBySymbol.get(sym) ?? [];
    arr.push({ createdAtMs, signalClass: resolveJournalSignalClass(p) });
    entriesBySymbol.set(sym, arr);
  }

  const out: TradeLogRow[] = [];
  for (const row of rows) {
    if (out.length >= fetchLimit) break;
    if (!row.payload) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!journalModeMatches(payload, filters)) {
      continue;
    }

    const outcomeRaw = String(payload.outcome ?? '').trim().toLowerCase();
    if (outcomeRaw !== 'executed' && outcomeRaw !== 'failed' && outcomeRaw !== 'blocked') {
      continue;
    }
    if (outcomeRaw === 'blocked') {
      continue;
    }

    const directionScore = toOptionalScore(payload.directionScore ?? payload.direction_score);
    const timingScore = toOptionalScore(payload.timingScore ?? payload.timing_score);
    const sizingScore = toOptionalScore(payload.sizingScore ?? payload.sizing_score);
    const exitScore = toOptionalScore(payload.exitScore ?? payload.exit_score);
    const realizedPnlRaw = Number(payload.realizedPnlUsd ?? payload.realized_pnl_usd);
    const realizedPnlUsd = Number.isFinite(realizedPnlRaw) ? realizedPnlRaw : null;
    const rCapturedRaw = Number(payload.capturedR ?? payload.captured_r);
    const rCaptured = Number.isFinite(rCapturedRaw) ? rCapturedRaw : null;
    const sideRaw = String(payload.side ?? '').trim().toLowerCase();
    const side: 'buy' | 'sell' | null = sideRaw === 'buy' || sideRaw === 'sell' ? sideRaw : null;
    const thesisCorrect =
      typeof payload.thesisCorrect === 'boolean' ? payload.thesisCorrect : null;
    const closedAt = String(payload.closedAt ?? row.createdAt ?? new Date().toISOString());
    const closedAtMs = resolveJournalClosedAtMs(payload, row.createdAt);

    // For close journals with no signalClass, borrow from the most recent entry for that symbol.
    let signalClass = resolveJournalSignalClass(payload);
    if (signalClass == null && payload.reduceOnly === true && closedAtMs != null) {
      const sym = typeof payload.symbol === 'string' ? payload.symbol.trim().toUpperCase() : null;
      let bestEntry: EntryCtx | null = null;
      for (const e of entriesBySymbol.get(sym ?? '') ?? []) {
        if (e.createdAtMs <= closedAtMs + 300_000) {
          if (bestEntry == null || e.createdAtMs > bestEntry.createdAtMs) {
            bestEntry = e;
          }
        }
      }
      signalClass = bestEntry?.signalClass ?? null;
    }

    const tradeIdRaw = Number(payload.tradeId);
    out.push({
      tradeId: Number.isFinite(tradeIdRaw) ? tradeIdRaw : null,
      symbol: String(payload.symbol ?? '').toUpperCase(),
      side,
      signalClass,
      outcome: outcomeRaw as 'executed' | 'failed',
      realizedPnlUsd,
      directionScore,
      timingScore,
      sizingScore,
      exitScore,
      rCaptured,
      thesisCorrect,
      qualityBand: resolveQualityBand({
        directionScore,
        timingScore,
        sizingScore,
        exitScore,
      }),
      closedAt,
    });
  }

  return out;
}

function listTradeLogRowsFromPerpTrades(
  db: Database.Database,
  filters: DashboardFilters,
  limit = 30
): TradeLogRow[] {
  if (!tableExists(db, 'perp_trades')) {
    return [];
  }
  const hasExecutionMode = tableHasColumn(db, 'perp_trades', 'execution_mode');
  if (!hasExecutionMode && filters.mode === 'live') {
    // Legacy perp_trades rows without execution_mode are treated as paper.
    return [];
  }
  const rows = hasExecutionMode
    ? (db
        .prepare(
          `
            SELECT id, symbol, side, status, created_at as createdAt, execution_mode
            FROM perp_trades
            WHERE (? IS NULL OR execution_mode = ?)
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `
        )
        .all(
          filters.mode === 'combined' ? null : filters.mode,
          filters.mode === 'combined' ? null : filters.mode,
          Math.max(1, Math.min(limit, 100))
        ) as Array<Record<string, unknown>>)
    : (db
        .prepare(
          `
            SELECT id, symbol, side, status, created_at as createdAt
            FROM perp_trades
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `
        )
        .all(Math.max(1, Math.min(limit, 100))) as Array<Record<string, unknown>>);

  return rows.map((row) => {
    const status = String(row.status ?? '')
      .trim()
      .toLowerCase();
    const sideRaw = String(row.side ?? '')
      .trim()
      .toLowerCase();
    const side: 'buy' | 'sell' | null = sideRaw === 'buy' || sideRaw === 'sell' ? sideRaw : null;
    const outcome: TradeLogRow['outcome'] =
      status === 'failed' || status === 'blocked' ? (status as 'failed' | 'blocked') : 'executed';
    return {
      tradeId: Number.isFinite(Number(row.id)) ? Number(row.id) : null,
      symbol: String(row.symbol ?? '').toUpperCase(),
      side,
      signalClass: null,
      outcome,
      realizedPnlUsd: null,
      directionScore: null,
      timingScore: null,
      sizingScore: null,
      exitScore: null,
      rCaptured: null,
      thesisCorrect: null,
      qualityBand: 'unknown',
      closedAt: String(row.createdAt ?? new Date().toISOString()),
    };
  });
}

type PromotionGateRow = {
  setupKey: string;
  sampleCount: number;
  hitRate: number;
  expectancyR: number;
  payoffRatio: number;
  maxDrawdownR: number;
  promoted: boolean;
  gates: {
    minTrades: { pass: boolean; required: number; actual: number; missing: number };
    maxDrawdownR: { pass: boolean; maxAllowed: number; actual: number; missing: number };
    minHitRate: { pass: boolean; required: number; actual: number; missing: number };
    minPayoffRatio: { pass: boolean; required: number; actual: number; missing: number };
    minExpectancyR: { pass: boolean; required: number; actual: number; missing: number };
  };
};

const DEFAULT_PROMOTION_GATES = {
  minTrades: 25,
  maxDrawdownR: 6,
  minHitRate: 0.5,
  minPayoffRatio: 1.2,
  minExpectancyR: 0.1,
};

function listPromotionGateRows(
  db: Database.Database,
  filters: DashboardFilters
): PromotionGateRow[] {
  if (!tableExists(db, 'decision_artifacts')) {
    return [];
  }

  const artifactRows = db
    .prepare(
      `
        SELECT payload
        FROM decision_artifacts
        WHERE kind = 'perp_trade_journal'
        ORDER BY created_at DESC
        LIMIT 500
      `
    )
    .all() as Array<{ payload?: string }>;

  const entries = artifactRows
    .map((row) => {
      if (!row.payload) return null;
      try {
        const parsedPayload = JSON.parse(row.payload) as Record<string, unknown>;
        if (!journalModeMatches(parsedPayload, filters)) {
          return null;
        }
        const parsed = parsedPayload as Partial<PerpTradeJournalEntry>;
        if (parsed.kind !== 'perp_trade_journal') {
          return null;
        }
        if (typeof parsed.symbol !== 'string' || !parsed.symbol.trim()) {
          return null;
        }
        const outcome = String(parsed.outcome ?? '').toLowerCase();
        if (outcome !== 'executed' && outcome !== 'failed' && outcome !== 'blocked') {
          return null;
        }
        return parsed as PerpTradeJournalEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is PerpTradeJournalEntry => entry != null);

  const keys = new Set<string>();
  for (const entry of entries) {
    const outcome = String(entry.outcome ?? '').toLowerCase();
    if ((outcome !== 'executed' && outcome !== 'failed') || !entry.symbol) {
      continue;
    }
    const signalClass =
      typeof entry.signalClass === 'string' && entry.signalClass.trim().length > 0
        ? entry.signalClass.trim()
        : typeof (entry as { signal_class?: unknown }).signal_class === 'string' &&
            String((entry as { signal_class?: unknown }).signal_class).trim().length > 0
          ? String((entry as { signal_class?: unknown }).signal_class).trim()
          : 'unknown';
    keys.add(`${String(entry.symbol).toUpperCase()}:${signalClass}`);
  }

  const rows: PromotionGateRow[] = [];
  for (const setupKey of keys) {
    const report = buildPaperPromotionReport({
      entries,
      setupKey,
      gates: DEFAULT_PROMOTION_GATES,
    });
    rows.push({
      setupKey: report.setupKey,
      sampleCount: report.sampleCount,
      hitRate: report.hitRate,
      expectancyR: report.expectancyR,
      payoffRatio: report.payoffRatio,
      maxDrawdownR: report.maxDrawdownR,
      promoted: report.promoted,
      gates: {
        minTrades: {
          pass: report.gates.minTrades.pass,
          required: report.gates.minTrades.required,
          actual: report.gates.minTrades.actual,
          missing: Math.max(0, report.gates.minTrades.required - report.gates.minTrades.actual),
        },
        maxDrawdownR: {
          pass: report.gates.maxDrawdownR.pass,
          maxAllowed: report.gates.maxDrawdownR.maxAllowed,
          actual: report.gates.maxDrawdownR.actual,
          missing: Math.max(0, report.gates.maxDrawdownR.actual - report.gates.maxDrawdownR.maxAllowed),
        },
        minHitRate: {
          pass: report.gates.minHitRate.pass,
          required: report.gates.minHitRate.required,
          actual: report.gates.minHitRate.actual,
          missing: Math.max(0, report.gates.minHitRate.required - report.gates.minHitRate.actual),
        },
        minPayoffRatio: {
          pass: report.gates.minPayoffRatio.pass,
          required: report.gates.minPayoffRatio.required,
          actual: report.gates.minPayoffRatio.actual,
          missing: Math.max(0, report.gates.minPayoffRatio.required - report.gates.minPayoffRatio.actual),
        },
        minExpectancyR: {
          pass: report.gates.minExpectancyR.pass,
          required: report.gates.minExpectancyR.required,
          actual: report.gates.minExpectancyR.actual,
          missing: Math.max(0, report.gates.minExpectancyR.required - report.gates.minExpectancyR.actual),
        },
      },
    });
  }

  return rows.sort((a, b) => {
    if (a.promoted !== b.promoted) return a.promoted ? 1 : -1;
    return b.sampleCount - a.sampleCount;
  });
}

type PerformanceBreakdownRow = {
  key: string;
  winRate: number;
  expectancyR: number;
  sampleCount: number;
};

function resolveJournalOutcome(payload: Record<string, unknown>): 'executed' | 'failed' | 'blocked' | 'unknown' {
  const raw = String(payload.outcome ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'executed' || raw === 'failed' || raw === 'blocked') {
    return raw;
  }
  return 'unknown';
}

function resolveJournalClosedAtMs(
  payload: Record<string, unknown>,
  createdAt: string | undefined
): number | null {
  const raw = String(payload.closedAt ?? createdAt ?? '');
  const value = raw ? Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z') : NaN;
  return Number.isFinite(value) ? value : null;
}

function resolveSessionKey(timestampMs: number): string {
  const hour = new Date(timestampMs).getUTCHours();
  if (hour < 8) return 'asia';
  if (hour < 16) return 'europe';
  return 'us';
}

function resolveJournalExpectancyScore(payload: Record<string, unknown>): number {
  const r = Number(payload.capturedR ?? payload.captured_r);
  if (Number.isFinite(r)) {
    return r;
  }
  if (payload.thesisCorrect === true) return 1;
  if (payload.thesisCorrect === false) return -1;
  const outcome = resolveJournalOutcome(payload);
  if (outcome === 'failed') return -1;
  if (outcome === 'executed') return 0;
  return 0;
}

function resolveJournalWin(payload: Record<string, unknown>): boolean {
  const r = Number(payload.capturedR ?? payload.captured_r);
  if (Number.isFinite(r)) return r > 0;
  return payload.thesisCorrect === true;
}

function listPerformanceBreakdown(
  db: Database.Database,
  filters: DashboardFilters
): {
  bySignalClass: PerformanceBreakdownRow[];
  byRegime: PerformanceBreakdownRow[];
  bySession: PerformanceBreakdownRow[];
} {
  if (!tableExists(db, 'decision_artifacts')) {
    return { bySignalClass: [], byRegime: [], bySession: [] };
  }
  const rows = db
    .prepare(
      `
        SELECT payload, created_at as createdAt
        FROM decision_artifacts
        WHERE kind = 'perp_trade_journal'
        ORDER BY created_at DESC
        LIMIT 2000
      `
    )
    .all() as Array<{ payload?: string; createdAt?: string }>;
  const { fromMs, toMs } = resolveTimeRange(filters);

  const signalAgg = new Map<string, { sampleCount: number; wins: number; scoreSum: number }>();
  const regimeAgg = new Map<string, { sampleCount: number; wins: number; scoreSum: number }>();
  const sessionAgg = new Map<string, { sampleCount: number; wins: number; scoreSum: number }>();
  const add = (map: Map<string, { sampleCount: number; wins: number; scoreSum: number }>, key: string, win: boolean, score: number) => {
    const current = map.get(key) ?? { sampleCount: 0, wins: 0, scoreSum: 0 };
    current.sampleCount += 1;
    current.wins += win ? 1 : 0;
    current.scoreSum += score;
    map.set(key, current);
  };

  // Close journals (reduceOnly=true) have performance data (capturedR, thesisCorrect) but
  // no signalClass/regime — those live on the corresponding entry journal. Link them
  // temporally: for each close, find the most recent entry for the same symbol that was
  // recorded before (or up to 5 min after) the close, and borrow its signalClass/regime.
  type EntryCtx = { createdAtMs: number; signalClass: string | null; regime: string | null };
  const entriesBySymbol = new Map<string, EntryCtx[]>();
  for (const row of rows) {
    if (!row.payload) continue;
    let p: Record<string, unknown>;
    try { p = JSON.parse(row.payload) as Record<string, unknown>; } catch { continue; }
    if (p.reduceOnly === true) continue;
    if (resolveJournalOutcome(p) !== 'executed') continue;
    if (!journalModeMatches(p, filters)) continue;
    const sym = typeof p.symbol === 'string' ? p.symbol.trim().toUpperCase() : null;
    if (!sym) continue;
    const createdAtMs = resolveJournalClosedAtMs(p, row.createdAt);
    if (createdAtMs == null) continue;
    const arr = entriesBySymbol.get(sym) ?? [];
    arr.push({ createdAtMs, signalClass: resolveJournalSignalClass(p), regime: resolveJournalMarketRegime(p) });
    entriesBySymbol.set(sym, arr);
  }

  // For each close journal, aggregate performance attributed to the matching entry's context.
  for (const row of rows) {
    if (!row.payload) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!journalModeMatches(payload, filters)) continue;
    if (payload.reduceOnly !== true) continue;
    const outcome = resolveJournalOutcome(payload);
    if (outcome !== 'executed' && outcome !== 'failed') continue;
    const closedAtMs = resolveJournalClosedAtMs(payload, row.createdAt);
    if (closedAtMs == null) continue;
    if ((fromMs != null && closedAtMs < fromMs) || (toMs != null && closedAtMs > toMs)) {
      continue;
    }

    const sym = typeof payload.symbol === 'string' ? payload.symbol.trim().toUpperCase() : null;
    // Find the most recent entry for this symbol recorded before (or ≤5 min after) this close.
    let bestEntry: EntryCtx | null = null;
    if (sym) {
      for (const e of entriesBySymbol.get(sym) ?? []) {
        if (e.createdAtMs <= closedAtMs + 300_000) {
          if (bestEntry == null || e.createdAtMs > bestEntry.createdAtMs) {
            bestEntry = e;
          }
        }
      }
    }

    const signalClass = bestEntry?.signalClass ?? resolveJournalSignalClass(payload) ?? 'unknown';
    const regime = bestEntry?.regime ?? resolveJournalMarketRegime(payload) ?? 'unknown';
    const session = resolveSessionKey(closedAtMs);
    const score = resolveJournalExpectancyScore(payload);
    const win = resolveJournalWin(payload);

    add(signalAgg, signalClass, win, score);
    add(regimeAgg, regime, win, score);
    add(sessionAgg, session, win, score);
  }

  const toRows = (
    map: Map<string, { sampleCount: number; wins: number; scoreSum: number }>
  ): PerformanceBreakdownRow[] =>
    [...map.entries()]
      .map(([key, value]) => ({
        key,
        winRate: value.sampleCount > 0 ? value.wins / value.sampleCount : 0,
        expectancyR: value.sampleCount > 0 ? value.scoreSum / value.sampleCount : 0,
        sampleCount: value.sampleCount,
      }))
      .sort((a, b) => b.sampleCount - a.sampleCount)
      .slice(0, 8);

  return {
    bySignalClass: toRows(signalAgg),
    byRegime: toRows(regimeAgg),
    bySession: toRows(sessionAgg),
  };
}

function countTradeJournalRows(
  db: Database.Database,
  filters: DashboardFilters
): number {
  if (filters.mode === 'combined') {
    return safeCount(
      db,
      "SELECT COUNT(*) AS c FROM decision_artifacts WHERE kind = 'perp_trade_journal'"
    );
  }

  const rows = db
    .prepare(
      `
        SELECT payload
        FROM decision_artifacts
        WHERE kind = 'perp_trade_journal'
      `
    )
    .all() as Array<{ payload?: string }>;
  let count = 0;
  for (const row of rows) {
    if (!row.payload) continue;
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (journalModeMatches(payload, filters)) {
        count += 1;
      }
    } catch {
      // ignore unparseable payloads
    }
  }
  return count;
}

function countFilteredPerpTradeRows(
  db: Database.Database,
  filters: DashboardFilters
): number {
  if (!tableExists(db, 'perp_trades')) {
    return 0;
  }
  const hasExecutionMode = tableHasColumn(db, 'perp_trades', 'execution_mode');
  if (filters.mode === 'combined' || !hasExecutionMode) {
    return safeCount(db, 'SELECT COUNT(*) AS c FROM perp_trades');
  }
  return safeCount(
    db,
    `
      SELECT COUNT(*) AS c
      FROM perp_trades
      WHERE execution_mode = ?
    `,
    [filters.mode]
  );
}

function countDistinctTradeRecords(
  db: Database.Database,
  filters: DashboardFilters
): number {
  if (!tableExists(db, 'decision_artifacts')) {
    return countFilteredPerpTradeRows(db, filters);
  }

  const rows = db
    .prepare(
      `
        SELECT payload
        FROM decision_artifacts
        WHERE kind = 'perp_trade_journal'
      `
    )
    .all() as Array<{ payload?: string }>;

  const tradeIds = new Set<number>();
  let journalRowsWithoutTradeId = 0;
  for (const row of rows) {
    if (!row.payload) continue;
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (!journalModeMatches(payload, filters)) {
        continue;
      }
      const tradeId = Number(payload.tradeId ?? NaN);
      if (Number.isFinite(tradeId) && tradeId > 0) {
        tradeIds.add(tradeId);
        continue;
      }
      journalRowsWithoutTradeId += 1;
    } catch {
      // ignore unparseable payloads
    }
  }

  const count = tradeIds.size + journalRowsWithoutTradeId;
  return count > 0 ? count : countFilteredPerpTradeRows(db, filters);
}

function buildPolicyStateSection(db: Database.Database): {
  observationMode: boolean;
  leverageCap: number | null;
  drawdownCapRemainingUsd: number | null;
  tradesRemainingToday: number | null;
  updatedAt: string | null;
} {
  const defaults = {
    observationMode: false,
    leverageCap: null,
    drawdownCapRemainingUsd: null,
    tradesRemainingToday: null,
    updatedAt: null,
  } as const;

  if (!tableExists(db, 'autonomy_policy_state')) {
    return defaults;
  }

  let observationOnlyUntilMsRaw: unknown = null;
  let leverageCapRawInput: unknown = null;
  let drawdownCapRemainingUsdRaw: unknown = null;
  let tradesRemainingTodayRaw: unknown = null;
  let updatedAtRaw: unknown = null;
  try {
    if (tableHasColumn(db, 'autonomy_policy_state', 'payload')) {
      const row = db
        .prepare(
          `
            SELECT payload, updated_at as updatedAt
            FROM autonomy_policy_state
            ORDER BY id DESC
            LIMIT 1
          `
        )
        .get() as { payload?: string | null; updatedAt?: string | null } | undefined;
      if (!row) return defaults;
      updatedAtRaw = row.updatedAt ?? null;
      if (row.payload) {
        try {
          const payload = JSON.parse(row.payload) as Record<string, unknown>;
          observationOnlyUntilMsRaw =
            payload.observationOnlyUntilMs ?? payload.observation_only_until_ms ?? null;
          leverageCapRawInput =
            payload.leverageCapOverride ?? payload.leverage_cap_override ?? payload.leverageCap ?? null;
          drawdownCapRemainingUsdRaw =
            payload.drawdownCapRemainingUsd ??
            payload.drawdown_cap_remaining_usd ??
            payload.drawdownRemainingUsd ??
            null;
          tradesRemainingTodayRaw =
            payload.tradesRemainingToday ??
            payload.trades_remaining_today ??
            payload.tradesRemaining ??
            null;
        } catch {
          observationOnlyUntilMsRaw = null;
          leverageCapRawInput = null;
          drawdownCapRemainingUsdRaw = null;
          tradesRemainingTodayRaw = null;
        }
      }
    } else {
      const row = db
        .prepare(
          `
            SELECT observation_only_until_ms as observationOnlyUntilMs,
                   leverage_cap_override as leverageCapOverride,
                   updated_at as updatedAt
            FROM autonomy_policy_state
            ORDER BY id DESC
            LIMIT 1
          `
        )
        .get() as {
          observationOnlyUntilMs?: number | null;
          leverageCapOverride?: number | null;
          updatedAt?: string | null;
        } | undefined;
      if (!row) return defaults;
      observationOnlyUntilMsRaw = row.observationOnlyUntilMs ?? null;
      leverageCapRawInput = row.leverageCapOverride ?? null;
      updatedAtRaw = row.updatedAt ?? null;
    }
  } catch {
    return defaults;
  }

  const nowMs = Date.now();
  const observationOnlyUntilMs = Number(observationOnlyUntilMsRaw ?? NaN);
  const observationMode = Number.isFinite(observationOnlyUntilMs) && observationOnlyUntilMs > nowMs;

  const leverageCapRaw = Number(leverageCapRawInput ?? NaN);
  const leverageCap = Number.isFinite(leverageCapRaw) ? leverageCapRaw : null;
  const payloadDrawdownCapRemainingRaw = Number(drawdownCapRemainingUsdRaw ?? NaN);
  const payloadDrawdownCapRemainingUsd = Number.isFinite(payloadDrawdownCapRemainingRaw)
    ? payloadDrawdownCapRemainingRaw
    : null;

  const config = getDashboardConfig();
  const maxTradesEnvRaw = Number(process.env.THUFIR_DASHBOARD_MAX_TRADES_PER_DAY ?? NaN);
  const maxTradesConfigRaw = Number(
    (config?.autonomy as { maxTradesPerDay?: unknown } | undefined)?.maxTradesPerDay ?? NaN
  );
  const configuredMaxTradesPerDay =
    Number.isFinite(maxTradesEnvRaw) && maxTradesEnvRaw > 0
      ? Math.floor(maxTradesEnvRaw)
      : Number.isFinite(maxTradesConfigRaw) && maxTradesConfigRaw > 0
        ? Math.floor(maxTradesConfigRaw)
        : null;

  let tradesRemainingToday =
    tradesRemainingTodayRaw == null
      ? null
      : Number.isFinite(Number(tradesRemainingTodayRaw))
        ? Number(tradesRemainingTodayRaw)
        : null;
  if (configuredMaxTradesPerDay != null) {
    const todayCount = safeCount(
      db,
      `
        SELECT COUNT(*) AS c
        FROM perp_trades
        WHERE status = 'executed'
          AND date(created_at) = date('now')
      `
    );
    tradesRemainingToday = Math.max(0, configuredMaxTradesPerDay - todayCount);
  }

  const drawdownCapEnvRaw = Number(process.env.THUFIR_DASHBOARD_DAILY_DRAWDOWN_CAP_USD ?? NaN);
  const drawdownCapConfigRaw = Number(
    (config?.autonomy as { dailyDrawdownCapUsd?: unknown } | undefined)?.dailyDrawdownCapUsd ?? NaN
  );
  const configuredDrawdownCapUsd =
    Number.isFinite(drawdownCapEnvRaw) && drawdownCapEnvRaw > 0
      ? drawdownCapEnvRaw
      : Number.isFinite(drawdownCapConfigRaw) && drawdownCapConfigRaw > 0
        ? drawdownCapConfigRaw
        : null;

  let drawdownCapRemainingUsd = payloadDrawdownCapRemainingUsd;
  if (configuredDrawdownCapUsd != null) {
    try {
      const rollup = getDailyPnLRollup();
      const totalPnl = Number(rollup.totalPnl ?? 0);
      const boundedTotalPnl = Number.isFinite(totalPnl) ? totalPnl : 0;
      const remaining = configuredDrawdownCapUsd + boundedTotalPnl;
      drawdownCapRemainingUsd = Math.max(0, Math.min(configuredDrawdownCapUsd, remaining));
    } catch {
      drawdownCapRemainingUsd = payloadDrawdownCapRemainingUsd;
    }
  }

  const drawdownCapRemainingUsdFinal = Number.isFinite(Number(drawdownCapRemainingUsd))
    ? Number(drawdownCapRemainingUsd)
    : null;

  return {
    observationMode,
    leverageCap,
    drawdownCapRemainingUsd: drawdownCapRemainingUsdFinal,
    tradesRemainingToday,
    updatedAt: updatedAtRaw ? String(updatedAtRaw) : null,
  };
}

function normalizeWeightPayload(value: unknown): LearnedWeightRow['weights'] {
  const parsed = parseJson<Record<string, unknown>>(value);
  const technical = Number(parsed?.technical);
  const news = Number(parsed?.news);
  const onChain = Number(parsed?.onChain);
  return {
    technical: Number.isFinite(technical) ? technical : null,
    news: Number.isFinite(news) ? news : null,
    onChain: Number.isFinite(onChain) ? onChain : null,
  };
}

function listActiveLearnedWeights(db: Database.Database): LearnedWeightRow[] {
  if (!tableExists(db, 'signal_weights')) {
    return [];
  }
  const rows = db
    .prepare(
      `
        SELECT domain, weights, samples, updated_at AS updatedAt
        FROM signal_weights
        ORDER BY datetime(updated_at) DESC, domain ASC
        LIMIT 25
      `
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    domain: String(row.domain ?? 'global'),
    weights: normalizeWeightPayload(row.weights),
    samples: Number(row.samples ?? 0) || 0,
    updatedAt: row.updatedAt == null ? null : String(row.updatedAt),
  }));
}

function buildPredictionAccuracySection(db: Database.Database): {
  totalFinalPredictions: number;
  global: PredictionAccuracyWindow[];
} {
  if (!tableExists(db, 'learning_examples')) {
    return { totalFinalPredictions: 0, global: [] };
  }

  const totalFinalPredictions = safeCount(db, 'SELECT COUNT(*) AS c FROM learning_examples');
  const rows = db
    .prepare(
      `
        SELECT
          id,
          CASE
            WHEN model_probability >= 0.5 AND outcome_value = 1 THEN 1
            WHEN model_probability < 0.5 AND outcome_value = 0 THEN 1
            ELSE 0
          END AS correct,
          brier_model AS brierModel,
          brier_market AS brierMarket,
          (brier_market - brier_model) AS brierDelta,
          (model_probability - market_probability) AS edge,
          pnl
        FROM learning_examples
        ORDER BY datetime(resolved_at) DESC, datetime(created_at) DESC, id DESC
        LIMIT 500
      `
    )
    .all() as Array<Record<string, unknown>>;

  const windows = [25, 50, 100, 250].filter(
    (windowSize) => rows.length >= windowSize || (windowSize === 25 && rows.length > 0)
  );

  return {
    totalFinalPredictions,
    global: windows.map((windowSize) => {
      const slice = rows.slice(0, Math.min(windowSize, rows.length));
      const sampleCount = slice.length;
      const avg = (field: string): number | null => {
        const values = slice
          .map((row) => Number(row[field]))
          .filter((value) => Number.isFinite(value));
        if (values.length === 0) return null;
        return values.reduce((sum, value) => sum + value, 0) / values.length;
      };
      const total = (field: string): number | null => {
        const values = slice
          .map((row) => Number(row[field]))
          .filter((value) => Number.isFinite(value));
        if (values.length === 0) return null;
        return values.reduce((sum, value) => sum + value, 0);
      };
      return {
        windowSize,
        sampleCount,
        accuracy: avg('correct'),
        brierModel: avg('brierModel'),
        brierMarket: avg('brierMarket'),
        brierDelta: avg('brierDelta'),
        avgEdge: avg('edge'),
        totalPnl: total('pnl'),
      };
    }),
  };
}

function buildLearningAuditSection(db: Database.Database): LearningAuditSection {
  const empty: LearningAuditSection = {
    comparable: { totalCaseCount: 0, byDomain: [] },
    exclusions: { totalCaseCount: 0, byReason: [] },
    execution: { totalCaseCount: 0, byDomain: [] },
  };
  if (!tableExists(db, 'learning_cases')) {
    return empty;
  }

  const comparableCount = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM learning_cases WHERE case_type = 'comparable_forecast' AND comparable = 1"
  );
  const excludedCount = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM learning_cases WHERE case_type = 'comparable_forecast' AND comparable = 0"
  );
  const executionCount = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM learning_cases WHERE case_type = 'execution_quality'"
  );
  const comparableByDomain = db
    .prepare(
      `
        SELECT COALESCE(domain, 'unknown') AS domain, COUNT(*) AS count
        FROM learning_cases
        WHERE case_type = 'comparable_forecast'
          AND comparable = 1
        GROUP BY COALESCE(domain, 'unknown')
        ORDER BY count DESC, domain ASC
        LIMIT 20
      `
    )
    .all() as Array<{ domain: string; count: number }>;
  const exclusionsByReason = db
    .prepare(
      `
        SELECT COALESCE(exclusion_reason, 'unspecified') AS reason, COUNT(*) AS count
        FROM learning_cases
        WHERE case_type = 'comparable_forecast'
          AND comparable = 0
        GROUP BY COALESCE(exclusion_reason, 'unspecified')
        ORDER BY count DESC, reason ASC
        LIMIT 20
      `
    )
    .all() as Array<{ reason: string; count: number }>;
  const executionByDomain = db
    .prepare(
      `
        SELECT COALESCE(domain, 'unknown') AS domain, COUNT(*) AS count
        FROM learning_cases
        WHERE case_type = 'execution_quality'
        GROUP BY COALESCE(domain, 'unknown')
        ORDER BY count DESC, domain ASC
        LIMIT 20
      `
    )
    .all() as Array<{ domain: string; count: number }>;

  return {
    comparable: {
      totalCaseCount: comparableCount,
      byDomain: comparableByDomain.map((row) => ({
        domain: String(row.domain),
        count: Number(row.count ?? 0),
      })),
    },
    exclusions: {
      totalCaseCount: excludedCount,
      byReason: exclusionsByReason.map((row) => ({
        reason: String(row.reason),
        count: Number(row.count ?? 0),
      })),
    },
    execution: {
      totalCaseCount: executionCount,
      byDomain: executionByDomain.map((row) => ({
        domain: String(row.domain),
        count: Number(row.count ?? 0),
      })),
    },
  };
}

function buildLearningObservabilitySection(db: Database.Database): {
  runtimeContext: {
    runId: string;
    policyVersion: string;
    source: string | null;
    updatedAt: string | null;
  };
  totalShadowAudits: number;
  activeWeights: LearnedWeightRow[];
  runSummaries: unknown[];
  recentAudits: unknown[];
} {
  const activeWeights = listActiveLearnedWeights(db);
  return {
    runtimeContext: {
      runId: 'default',
      policyVersion: 'default',
      source: activeWeights.length > 0 ? 'signal_weights' : null,
      updatedAt: activeWeights[0]?.updatedAt ?? null,
    },
    totalShadowAudits: tableExists(db, 'learning_signal_audits')
      ? safeCount(db, 'SELECT COUNT(*) AS c FROM learning_signal_audits')
      : 0,
    activeWeights,
    runSummaries: [],
    recentAudits: [],
  };
}

function buildCloseLearningSection(db: Database.Database): CloseLearningSection {
  const count = (sql: string) => safeCount(db, sql);
  const finalizer = tableExists(db, 'close_finalization_jobs')
    ? {
        totalJobs: count('SELECT COUNT(*) AS c FROM close_finalization_jobs'),
        pending: count("SELECT COUNT(*) AS c FROM close_finalization_jobs WHERE status = 'pending'"),
        running: count("SELECT COUNT(*) AS c FROM close_finalization_jobs WHERE status = 'running'"),
        finalized: count("SELECT COUNT(*) AS c FROM close_finalization_jobs WHERE status = 'finalized'"),
        failedRetryable: count("SELECT COUNT(*) AS c FROM close_finalization_jobs WHERE status = 'failed_retryable'"),
        failedTerminal: count("SELECT COUNT(*) AS c FROM close_finalization_jobs WHERE status = 'failed_terminal'"),
        delayed: count(
          "SELECT COUNT(*) AS c FROM close_finalization_jobs WHERE status != 'finalized' AND created_at <= datetime('now', '-30 seconds')"
        ),
      }
    : { totalJobs: 0, pending: 0, running: 0, finalized: 0, failedRetryable: 0, failedTerminal: 0, delayed: 0 };

  const recentCloses = tableExists(db, 'trade_closes')
    ? (db
        .prepare(
          `
            SELECT id, close_event_id AS closeEventId, symbol, closed_side AS closedSide,
                   execution_mode AS executionMode, closed_at AS closedAt,
                   net_realized_pnl_usd AS netRealizedPnlUsd, captured_r AS capturedR,
                   thesis_correct AS thesisCorrect, composite_score AS compositeScore,
                   source_learning_case_id AS sourceLearningCaseId,
                   deterministic_status AS deterministicStatus,
                   llm_reflection_status AS llmReflectionStatus
            FROM trade_closes
            ORDER BY datetime(closed_at) DESC, id DESC
            LIMIT 20
          `
        )
        .all() as Array<Record<string, unknown>>)
    : [];
  const regretByType = tableExists(db, 'regret_learning_cases')
    ? (db
        .prepare(
          `
            SELECT regret_type AS type, COUNT(*) AS count
            FROM regret_learning_cases
            GROUP BY regret_type
            ORDER BY count DESC, type ASC
            LIMIT 20
          `
        )
        .all() as Array<{ type: string; count: number }>)
    : [];
  const activeAdjustments = tableExists(db, 'trade_policy_adjustments')
    ? (db
        .prepare(
          `
            SELECT id, scope_key AS scopeKey, symbol, direction, signal_class AS signalClass,
                   market_regime AS marketRegime, trigger_reason AS triggerReason,
                   action, size_multiplier AS sizeMultiplier, leverage_cap AS leverageCap,
                   confidence, sample_count AS sampleCount,
                   source_trade_close_id AS sourceTradeCloseId,
                   source_learning_case_id AS sourceLearningCaseId,
                   reason, expires_at AS expiresAt, created_at AS createdAt
            FROM trade_policy_adjustments
            WHERE active = 1
            ORDER BY datetime(created_at) DESC
            LIMIT 25
          `
        )
        .all() as Array<Record<string, unknown>>)
    : [];
  const promotionEvents = tableExists(db, 'policy_promotion_events')
    ? (db
        .prepare(
          `
            SELECT id, adjustment_id AS adjustmentId, trade_close_id AS tradeCloseId,
                   learning_case_id AS learningCaseId, scope_key AS scopeKey,
                   action, sample_count AS sampleCount, reason, created_at AS createdAt
            FROM policy_promotion_events
            ORDER BY datetime(created_at) DESC
            LIMIT 25
          `
        )
        .all() as Array<Record<string, unknown>>)
    : [];

  return {
    finalizer,
    closeEvents: {
      partialReduces: tableExists(db, 'trade_close_events')
        ? count("SELECT COUNT(*) AS c FROM trade_close_events WHERE close_kind = 'partial_reduce'")
        : 0,
      fullCloses: tableExists(db, 'trade_close_events')
        ? count("SELECT COUNT(*) AS c FROM trade_close_events WHERE close_kind = 'full_close'")
        : 0,
    },
    tradeCloses: {
      total: tableExists(db, 'trade_closes') ? count('SELECT COUNT(*) AS c FROM trade_closes') : 0,
      recent: recentCloses,
    },
    reflections: {
      total: tableExists(db, 'trade_reflections') ? count('SELECT COUNT(*) AS c FROM trade_reflections') : 0,
    },
    regretCases: {
      total: tableExists(db, 'regret_learning_cases') ? count('SELECT COUNT(*) AS c FROM regret_learning_cases') : 0,
      byType: regretByType.map((row) => ({ type: String(row.type), count: Number(row.count ?? 0) })),
    },
    policyLearning: {
      activeAdjustments,
      promotionEvents,
    },
  };
}

function buildGateAttributionSection(db: Database.Database): GateAttributionSection {
  const config = getDashboardConfig();
  const section: GateAttributionSection = {
    config: {
      minEdge: Number.isFinite(Number(config?.autonomy?.minEdge)) ? Number(config?.autonomy?.minEdge) : null,
      requireHighConfidence: Boolean(config?.autonomy?.requireHighConfidence),
      maxTradesPerScan: Number.isFinite(Number((config?.autonomy as Record<string, unknown> | undefined)?.maxTradesPerScan))
        ? Number((config?.autonomy as Record<string, unknown>).maxTradesPerScan)
        : null,
      llmEntryGateEnabled: (config?.autonomy as { llmEntryGate?: { enabled?: boolean } } | undefined)?.llmEntryGate?.enabled !== false,
      tradeQualityEnabled: Boolean((config?.autonomy as { tradeQuality?: { enabled?: boolean } } | undefined)?.tradeQuality?.enabled),
      calibrationRiskEnabled: (config?.autonomy as { calibrationRisk?: { enabled?: boolean } } | undefined)?.calibrationRisk?.enabled !== false,
      signalPerformanceMinSharpe: Number.isFinite(Number((config?.autonomy as { signalPerformance?: { minSharpe?: unknown } } | undefined)?.signalPerformance?.minSharpe))
        ? Number((config?.autonomy as { signalPerformance?: { minSharpe?: unknown } }).signalPerformance?.minSharpe)
        : null,
      signalPerformanceMinSamples: Number.isFinite(Number((config?.autonomy as { signalPerformance?: { minSamples?: unknown } } | undefined)?.signalPerformance?.minSamples))
        ? Number((config?.autonomy as { signalPerformance?: { minSamples?: unknown } }).signalPerformance?.minSamples)
        : null,
    },
    policyState: {
      observationMode: false,
      minEdgeOverride: null,
      maxTradesPerScanOverride: null,
      leverageCapOverride: null,
      reason: null,
      updatedAt: null,
    },
    entryGate: {
      verdictCounts: { approve: 0, reject: 0, resize: 0 },
      reasonCounts: [],
      recentDecisions: [],
    },
    journal: {
      outcomeCounts: { executed: 0, failed: 0, blocked: 0 },
      blockedReasons: [],
      recentPolicyAdjustments: [],
    },
  };

  if (tableExists(db, 'autonomy_policy_state')) {
    try {
      const row = db.prepare('SELECT payload, updated_at FROM autonomy_policy_state WHERE id = 1').get() as
        | { payload?: string | null; updated_at?: string | null }
        | undefined;
      if (row?.payload) {
        const payload = JSON.parse(row.payload) as Record<string, unknown>;
        const observationOnlyUntilMs = Number(payload.observationOnlyUntilMs ?? NaN);
        section.policyState = {
          observationMode: Number.isFinite(observationOnlyUntilMs) && observationOnlyUntilMs > Date.now(),
          minEdgeOverride: Number.isFinite(Number(payload.minEdgeOverride)) ? Number(payload.minEdgeOverride) : null,
          maxTradesPerScanOverride: Number.isFinite(Number(payload.maxTradesPerScanOverride))
            ? Number(payload.maxTradesPerScanOverride)
            : null,
          leverageCapOverride: Number.isFinite(Number(payload.leverageCapOverride))
            ? Number(payload.leverageCapOverride)
            : null,
          reason: typeof payload.reason === 'string' && payload.reason.trim().length > 0 ? payload.reason : null,
          updatedAt: row.updated_at ? String(row.updated_at) : null,
        };
      }
    } catch {
      // Keep defaults.
    }
  }

  if (tableExists(db, 'llm_entry_gate_log')) {
    try {
      const verdictRows = db.prepare('SELECT verdict, COUNT(*) AS count FROM llm_entry_gate_log GROUP BY verdict').all() as
        Array<{ verdict?: string | null; count?: number | null }>;
      for (const row of verdictRows) {
        const verdict = String(row.verdict ?? '').trim().toLowerCase();
        if (verdict === 'approve' || verdict === 'reject' || verdict === 'resize') {
          section.entryGate.verdictCounts[verdict] = Number(row.count ?? 0);
        }
      }

      const hasReasonCode = tableHasColumn(db, 'llm_entry_gate_log', 'reason_code');
      if (hasReasonCode) {
        section.entryGate.reasonCounts = (db.prepare(
          `
            SELECT COALESCE(NULLIF(TRIM(reason_code), ''), 'unknown') AS reasonCode,
                   COUNT(*) AS count
            FROM llm_entry_gate_log
            GROUP BY 1
            ORDER BY count DESC, reasonCode ASC
            LIMIT 12
          `
        ).all() as Array<{ reasonCode?: string | null; count?: number | null }>).map((row) => ({
          reasonCode: String(row.reasonCode ?? 'unknown'),
          count: Number(row.count ?? 0),
        }));
      }

      section.entryGate.recentDecisions = (db.prepare(
        `
          SELECT created_at, symbol, verdict,
                 ${hasReasonCode ? 'reason_code' : 'NULL'} AS reason_code,
                 adjusted_size_usd, suggested_leverage, reasoning
          FROM llm_entry_gate_log
          ORDER BY id DESC
          LIMIT 15
        `
      ).all() as Array<Record<string, unknown>>).map((row) => ({
        createdAt: String(row.created_at ?? ''),
        symbol: String(row.symbol ?? ''),
        verdict: String(row.verdict ?? ''),
        reasonCode: row.reason_code == null ? null : String(row.reason_code),
        adjustedSizeUsd: Number.isFinite(Number(row.adjusted_size_usd)) ? Number(row.adjusted_size_usd) : null,
        suggestedLeverage: Number.isFinite(Number(row.suggested_leverage)) ? Number(row.suggested_leverage) : null,
        reasoning: String(row.reasoning ?? ''),
      }));
    } catch {
      // Keep defaults.
    }
  }

  if (!tableExists(db, 'decision_artifacts')) {
    return section;
  }

  try {
    const rows = db.prepare(
      `
        SELECT payload, created_at
        FROM decision_artifacts
        WHERE kind = 'perp_trade_journal'
        ORDER BY created_at DESC
        LIMIT 2000
      `
    ).all() as Array<{ payload?: string | null; created_at?: string | null }>;
    const blockedReasonCounts = new Map<string, number>();
    for (const row of rows) {
      if (!row.payload) continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const outcome = resolveJournalOutcome(payload);
      if (outcome === 'executed' || outcome === 'failed' || outcome === 'blocked') {
        section.journal.outcomeCounts[outcome] += 1;
      }
      if (outcome === 'blocked') {
        const reason = String(payload.reasoning ?? payload.error ?? 'unknown').trim().slice(0, 120) || 'unknown';
        blockedReasonCounts.set(reason, (blockedReasonCounts.get(reason) ?? 0) + 1);
      }
      const policySizeMultiplier = Number(payload.policySizeMultiplier ?? NaN);
      if (Number.isFinite(policySizeMultiplier) && policySizeMultiplier < 1 && section.journal.recentPolicyAdjustments.length < 12) {
        section.journal.recentPolicyAdjustments.push({
          createdAt: row.created_at ? String(row.created_at) : '',
          symbol: typeof payload.symbol === 'string' ? payload.symbol : '',
          policyReasonCode:
            typeof payload.policyReasonCode === 'string' && payload.policyReasonCode.trim().length > 0
              ? payload.policyReasonCode
              : null,
          policySizeMultiplier,
          entryGateVerdict:
            typeof payload.entryGateVerdict === 'string' && payload.entryGateVerdict.trim().length > 0
              ? payload.entryGateVerdict
              : null,
          entryGateReasonCode:
            typeof payload.entryGateReasonCode === 'string' && payload.entryGateReasonCode.trim().length > 0
              ? payload.entryGateReasonCode
              : null,
          reasoning:
            typeof payload.reasoning === 'string' && payload.reasoning.trim().length > 0
              ? payload.reasoning
              : null,
        });
      }
    }
    section.journal.blockedReasons = [...blockedReasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, 12);
  } catch {
    return section;
  }

  return section;
}

export function buildDashboardApiPayload(params?: {
  db?: Database.Database;
  filters?: DashboardFilters;
  mids?: Record<string, number>;
}): {
  meta: {
    generatedAt: string;
    mode: DashboardMode;
    timeframe: DashboardTimeframe;
    period: string | null;
    from: string | null;
    to: string | null;
    recordCounts: {
      perpTrades: number;
      journals: number;
      openPaperPositions: number;
      alerts: number;
    };
  };
  sections: {
    equityCurve: {
      points: EquityPoint[];
      summary: {
        startEquity: number | null;
        endEquity: number | null;
        returnPct: number | null;
        maxDrawdownPct: number | null;
      };
    };
    openPositions: {
      rows: OpenPositionRow[];
      summary: {
        totalUnrealizedPnlUsd: number;
        longCount: number;
        shortCount: number;
      };
    };
    tradeLog: {
      rows: TradeLogRow[];
      limit: number;
    };
    promotionGates: {
      rows: PromotionGateRow[];
    };
    policyState: {
      observationMode: boolean;
      leverageCap: number | null;
      drawdownCapRemainingUsd: number | null;
      tradesRemainingToday: number | null;
      updatedAt: string | null;
    };
    performanceBreakdown: {
      bySignalClass: unknown[];
      byRegime: unknown[];
      bySession: unknown[];
    };
    predictionAccuracy: {
      totalFinalPredictions: number;
      global: PredictionAccuracyWindow[];
    };
    learningAudit: LearningAuditSection;
    learningObservability: {
      runtimeContext: {
        runId: string;
        policyVersion: string;
        source: string | null;
        updatedAt: string | null;
      };
      totalShadowAudits: number;
      activeWeights: LearnedWeightRow[];
      runSummaries: unknown[];
      recentAudits: unknown[];
    };
    closeLearning: CloseLearningSection;
    gateAttribution: GateAttributionSection;
  };
} {
  const db = params?.db ?? openDatabase();
  const filters = params?.filters ?? {
    mode: 'combined',
    timeframe: 'all',
    period: null,
    from: null,
    to: null,
  };
  const mids = params?.mids ?? {};

  const perpTrades = countDistinctTradeRecords(db, filters);
  const journals = countTradeJournalRows(db, filters);
  const alerts = safeCount(db, 'SELECT COUNT(*) AS c FROM alerts');
  const openPaperPositions = !isLiveMode(filters) && tableExists(db, 'paper_perp_positions')
    ? safeCount(db, 'SELECT COUNT(*) AS c FROM paper_perp_positions')
    : 0;
  const equityCurve = isPaperMode(filters) || filters.mode === 'combined'
    ? buildPaperEquitySeries(db, filters, mids)
    : buildEmptyEquitySeries();
  const openPositionRows = isLiveMode(filters) ? [] : listPaperOpenPositionRows(db, mids);
  const longCount = openPositionRows.filter((row) => row.side === 'long').length;
  const shortCount = openPositionRows.filter((row) => row.side === 'short').length;
  const totalUnrealizedPnlUsd = openPositionRows.reduce(
    (sum, row) => sum + row.unrealizedPnlUsd,
    0
  );
  let tradeLogRows = listTradeLogRows(db, filters, 30);
  if (tradeLogRows.length === 0) {
    tradeLogRows = listTradeLogRowsFromPerpTrades(db, filters, 30);
  }
  const promotionGateRows = listPromotionGateRows(db, filters);
  const policyState = buildPolicyStateSection(db);
  const performanceBreakdown = listPerformanceBreakdown(db, filters);
  const predictionAccuracy = buildPredictionAccuracySection(db);
  const learningAudit = buildLearningAuditSection(db);
  const learningObservability = buildLearningObservabilitySection(db);
  const closeLearning = buildCloseLearningSection(db);
  const gateAttribution = buildGateAttributionSection(db);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      mode: filters.mode,
      timeframe: filters.timeframe,
      period: filters.period,
      from: filters.from,
      to: filters.to,
      recordCounts: {
        perpTrades,
        journals,
        openPaperPositions,
        alerts,
      },
    },
    sections: {
      equityCurve,
      openPositions: {
        rows: openPositionRows,
        summary: {
          totalUnrealizedPnlUsd,
          longCount,
          shortCount,
        },
      },
      tradeLog: {
        rows: tradeLogRows,
        limit: 30,
      },
      promotionGates: {
        rows: promotionGateRows,
      },
      policyState: {
        observationMode: policyState.observationMode,
        leverageCap: policyState.leverageCap,
        drawdownCapRemainingUsd: policyState.drawdownCapRemainingUsd,
        tradesRemainingToday: policyState.tradesRemainingToday,
        updatedAt: policyState.updatedAt,
      },
      performanceBreakdown: {
        bySignalClass: performanceBreakdown.bySignalClass,
        byRegime: performanceBreakdown.byRegime,
        bySession: performanceBreakdown.bySession,
      },
      predictionAccuracy,
      learningAudit,
      learningObservability,
      closeLearning,
      gateAttribution,
    },
  };
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function handleDashboardApiRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  if (!path.startsWith('/api/dashboard') && !path.startsWith('/api/conversations') && !path.startsWith('/api/logs')) {
    return false;
  }

  if (req.method !== 'GET') {
    writeJson(res, 405, { ok: false, error: 'Method not allowed' });
    return true;
  }

  if (path === '/api/dashboard/health') {
    writeJson(res, 200, { ok: true, service: 'dashboard-api' });
    return true;
  }

  if (path === '/api/dashboard' || path === '/api/dashboard/summary') {
    const filters = parseDashboardFilters(url);
    const ttlMs = isLiveMode(filters) ? 5_000 : 30_000;
    const cacheKey = buildDashboardCacheKey('dashboard', url);
    const baseConfig = (req as IncomingMessage & { thufirConfig?: ThufirConfig }).thufirConfig;

    if (!isLiveMode(filters)) {
      if (!baseConfig) {
        const payload = cached(cacheKey, ttlMs, () => buildDashboardApiPayload({ filters }));
        writeJson(res, 200, payload);
        return true;
      }
      void cachedAsync(cacheKey, ttlMs, async () => {
        let mids: Record<string, number> = {};
        if (baseConfig.hyperliquid?.enabled !== false) {
          try {
            const raw = await new HyperliquidClient(baseConfig).getAllMids();
            // Normalize keys to uppercase so "xyz:CL" → "XYZ:CL" matches position symbols
            mids = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toUpperCase(), v]));
          } catch { /* fall through with empty mids */ }
        }
        return buildDashboardApiPayload({ filters, mids });
      })
        .then((payload) => writeJson(res, 200, payload))
        .catch(() => writeJson(res, 200, buildDashboardApiPayload({ filters })));
      return true;
    }

    // Live mode: overlay latest wallet snapshot from Hyperliquid when credentials are available.
    // If unavailable, return the DB-backed payload as-is.
    if (!baseConfig) {
      const payload = cached(cacheKey, ttlMs, () => buildDashboardApiPayload({ filters }));
      writeJson(res, 200, payload);
      return true;
    }
    void cachedAsync(cacheKey, ttlMs, async () => {
      const payload = buildDashboardApiPayload({ filters });
      const snapshot = await tryBuildLiveWalletSnapshot(baseConfig);
      if (!snapshot) {
        return payload;
      }
      return {
        ...payload,
        sections: {
          ...payload.sections,
          equityCurve: snapshot.equityCurve,
          openPositions: snapshot.openPositions,
        },
      };
    })
      .then((payload) => {
        writeJson(res, 200, payload);
      })
      .catch(() => {
        const payload = buildDashboardApiPayload({ filters });
        writeJson(res, 200, payload);
      });
    return true;
  }

  if (path === '/api/conversations') {
    const payload = cached(buildDashboardCacheKey('conversations', url), 10_000, () =>
      buildConversationsListResponse()
    );
    writeJson(res, 200, payload);
    return true;
  }

  if (path.startsWith('/api/conversations/')) {
    const sessionId = decodeURIComponent(path.slice('/api/conversations/'.length)).trim();
    if (!sessionId) {
      writeJson(res, 400, { ok: false, error: 'Missing session id' });
      return true;
    }
    const limit = parsePositiveInt(url.searchParams.get('limit'), 50, 1, 200);
    const payload = cached(buildDashboardCacheKey('conversation-thread', url), 10_000, () =>
      buildConversationThreadResponse(sessionId, { limit })
    );
    writeJson(res, 200, payload);
    return true;
  }

  if (path === '/api/logs') {
    const kindRaw = String(url.searchParams.get('kind') ?? 'all').trim().toLowerCase();
    const kind: 'decision' | 'incident' | 'all' =
      kindRaw === 'decision' || kindRaw === 'incident' ? kindRaw : 'all';
    const limit = parsePositiveInt(url.searchParams.get('limit'), 50, 1, 200);
    const offset = parsePositiveInt(url.searchParams.get('offset'), 0, 0, 10_000);
    const payload = cached(buildDashboardCacheKey('logs', url), 15_000, () =>
      buildDashboardLogsResponse({ kind, limit, offset })
    );
    writeJson(res, 200, payload);
    return true;
  }

  writeJson(res, 404, { ok: false, error: 'Not found' });
  return true;
}
