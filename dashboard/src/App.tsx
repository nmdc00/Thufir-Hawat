import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import {
  buildDashboardQuery,
  fetchConversationThread,
  fetchConversations,
  fetchDashboardSummary,
  fetchLogs,
} from './api';
import type {
  ConversationSession,
  ConversationThreadResponse,
  DashboardMode,
  DashboardPayload,
  DashboardTimeframe,
  LogsResponse,
} from './types';

const PERIODS = ['1d', '7d', '14d', '30d', '90d'];
const TABS = ['overview', 'positions', 'trades', 'performance', 'learning', 'policy', 'conversations', 'logs'] as const;
type DashboardTab = (typeof TABS)[number];

function money(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value));
}

function percent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return `${Number(value).toFixed(2)}%`;
}

function numberText(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return Number(value).toFixed(digits);
}

function numericField(row: Record<string, unknown> | null | undefined, key: string): number | null {
  if (!row || row[key] == null) return null;
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : null;
}

function formatHeld(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `${d}d ${remH}h`;
}

function timeText(value: string | null | undefined): string {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString();
}

function shortDateLabel(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function conversationDayKey(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function conversationDayLabel(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function relativeTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const diffMs = Date.now() - parsed.getTime();
  const diffMinutes = Math.round(diffMs / 60_000);
  if (Math.abs(diffMinutes) < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 48) return `${diffHours}h ago`;
  return shortDateLabel(value);
}

function badgeClass(value: unknown): string {
  if (value === 'good' || value === 'long' || value === true) return 'badge good';
  if (value === 'poor' || value === 'bad' || value === 'short' || value === false) return 'badge bad';
  return 'badge mixed';
}

function EquityChart({ points }: { points: Array<{ timestamp: string; equity: number }> }) {
  if (!Array.isArray(points) || points.length === 0) {
    return <div className="empty-state">No equity points for this filter window.</div>;
  }
  const width = 960;
  const height = 320;
  const padding = 28;
  const chartPoints = points.map((point, index) => {
    const timestampMs = Date.parse(point.timestamp);
    return {
      ...point,
      equity: Number(point.equity),
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : index,
    };
  }).filter((point) => Number.isFinite(point.equity));
  const values = chartPoints.map((point) => point.equity);
  if (chartPoints.length === 0) {
    return <div className="empty-state">No valid equity points for this filter window.</div>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const floor = Math.abs(max - min) < 1e-9 ? min - 1 : min;
  const ceil = Math.abs(max - min) < 1e-9 ? max + 1 : max;
  const minTime = Math.min(...chartPoints.map((point) => point.timestampMs));
  const maxTime = Math.max(...chartPoints.map((point) => point.timestampMs));
  const timeSpan = maxTime - minTime;
  const xFor = (point: { timestampMs: number }, index: number) => {
    const ratio = timeSpan > 0
      ? (point.timestampMs - minTime) / timeSpan
      : index / Math.max(1, chartPoints.length - 1);
    return padding + ratio * (width - padding * 2);
  };
  const yFor = (value: number) => padding + ((ceil - value) / Math.max(1e-9, ceil - floor)) * (height - padding * 2);
  const line = chartPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(point, index)} ${yFor(point.equity)}`).join(' ');
  const area = `${line} L ${xFor(chartPoints[chartPoints.length - 1]!, chartPoints.length - 1)} ${height - padding} L ${xFor(chartPoints[0]!, 0)} ${height - padding} Z`;
  const first = chartPoints[0]!;
  const last = chartPoints[chartPoints.length - 1]!;
  return (
    <>
      <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Equity curve">
        <defs>
          <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(245,162,77,0.56)" />
            <stop offset="100%" stopColor="rgba(216,107,49,0.06)" />
          </linearGradient>
        </defs>
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="rgba(246,220,180,0.18)" />
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(246,220,180,0.18)" />
        <path d={area} fill="url(#equityFill)" />
        <path d={line} fill="none" stroke="#f6dcb4" strokeWidth="3" />
      </svg>
      <div className="line-chart-meta">
        <span>{timeText(first.timestamp)} · {money(first.equity)}</span>
        <span>{timeText(last.timestamp)} · {money(last.equity)}</span>
      </div>
    </>
  );
}

function DataTable({ headers, rows, empty }: { headers: string[]; rows: Array<Array<ReactNode>>; empty: string }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={headers.length} className="empty-state">{empty}</td></tr>
          ) : rows.map((row, index) => (
            <tr key={index}>{row.map((cell, cellIndex) => <td key={`${index}-${cellIndex}`}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PerfTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  return (
    <DataTable
      headers={['Key', 'Win Rate', 'Expectancy R', 'Samples']}
      empty="No data yet for this slice."
      rows={rows.slice(0, 8).map((row) => [
        String(row.key ?? row.label ?? row.name ?? '-'),
        <span className="mono">{percent((Number(row.winRate ?? row.hitRate ?? 0) || 0) * 100)}</span>,
        <span className="mono">{numberText(Number(row.expectancyR ?? row.expectancy ?? 0), 3)}</span>,
        <span className="mono">{numberText(Number(row.sampleCount ?? row.samples ?? 0), 0)}</span>,
      ])}
    />
  );
}

function ConversationThread({ thread }: { thread: ConversationThreadResponse | null }) {
  if (!thread || thread.messages.length === 0) {
    return <div className="empty-state">No messages in this thread.</div>;
  }
  return (
    <div className="thread">
      {thread.messages.map((message) => (
        <div key={message.id} className={`thread-bubble ${message.role === 'user' ? 'thread-user' : 'thread-assistant'}`}>
          <div className="thread-meta">
            <span>{timeText(message.createdAt)}</span>
          </div>
          <div className="thread-body">{message.content}</div>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState<DashboardMode>('paper');
  const [timeframe, setTimeframe] = useState<DashboardTimeframe>('all');
  const [period, setPeriod] = useState('30d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tab, setTab] = useState<DashboardTab>('overview');
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState('');
  const [conversations, setConversations] = useState<ConversationSession[]>([]);
  const [selectedConversationDay, setSelectedConversationDay] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [thread, setThread] = useState<ConversationThreadResponse | null>(null);
  const [conversationError, setConversationError] = useState('');
  const [conversationLoading, setConversationLoading] = useState(false);
  const [logs, setLogs] = useState<LogsResponse>({ entries: [], total: 0 });
  const [logsKind, setLogsKind] = useState<'all' | 'decision' | 'incident'>('all');
  const [logsOffset, setLogsOffset] = useState(0);
  const [logsError, setLogsError] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);

  const query = useMemo(() => ({ mode, timeframe, period, from, to }), [mode, timeframe, period, from, to]);
  const queryString = useMemo(() => buildDashboardQuery(query), [query]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const next = await fetchDashboardSummary(query);
        if (cancelled) return;
        setPayload(next);
        setRefreshedAt(new Date().toISOString());
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load dashboard');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    const handle = window.setInterval(() => void load(), mode === 'live' ? 5_000 : 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [query, queryString, mode]);

  useEffect(() => {
    if (tab !== 'conversations') {
      return;
    }
    let cancelled = false;
    async function loadConversations() {
      setConversationLoading(true);
      setConversationError('');
      try {
        const response = await fetchConversations();
        if (cancelled) return;
        setConversations(response.sessions);
        const nextDay = selectedConversationDay ?? (response.sessions[0] ? conversationDayKey(response.sessions[0].lastMessageAt) : null);
        if (nextDay) {
          setSelectedConversationDay(nextDay);
        }
      } catch (err) {
        if (!cancelled) {
          setConversationError(err instanceof Error ? err.message : 'Failed to load conversations');
        }
      } finally {
        if (!cancelled) {
          setConversationLoading(false);
        }
      }
    }
    void loadConversations();
    return () => {
      cancelled = true;
    };
  }, [tab, selectedConversationDay]);

  const conversationDays = useMemo(() => {
    const ordered = conversations.map((session) => conversationDayKey(session.lastMessageAt));
    return ordered.filter((day, index) => day && ordered.indexOf(day) === index);
  }, [conversations]);

  const filteredConversations = useMemo(() => {
    if (!selectedConversationDay) {
      return conversations;
    }
    return conversations.filter((session) => conversationDayKey(session.lastMessageAt) === selectedConversationDay);
  }, [conversations, selectedConversationDay]);

  useEffect(() => {
    if (tab !== 'conversations') {
      return;
    }
    if (!selectedConversationDay) {
      if (conversationDays[0]) {
        setSelectedConversationDay(conversationDays[0]);
      }
      return;
    }
    const selectedStillVisible = filteredConversations.some((session) => session.sessionId === selectedSessionId);
    if (!selectedStillVisible) {
      setSelectedSessionId(filteredConversations[0]?.sessionId ?? null);
      setThread(null);
    }
  }, [tab, conversationDays, filteredConversations, selectedConversationDay, selectedSessionId]);

  useEffect(() => {
    if (tab !== 'conversations' || !selectedSessionId) {
      return;
    }
    let cancelled = false;
    async function loadThread() {
      setConversationLoading(true);
      setConversationError('');
      try {
        const response = await fetchConversationThread(selectedSessionId, 50);
        if (!cancelled) {
          setThread(response);
        }
      } catch (err) {
        if (!cancelled) {
          setConversationError(err instanceof Error ? err.message : 'Failed to load thread');
        }
      } finally {
        if (!cancelled) {
          setConversationLoading(false);
        }
      }
    }
    void loadThread();
    return () => {
      cancelled = true;
    };
  }, [tab, selectedSessionId]);

  useEffect(() => {
    if (tab !== 'conversations' || selectedSessionId) {
      return;
    }
    setThread(null);
  }, [tab, selectedSessionId]);

  useEffect(() => {
    if (tab !== 'logs') {
      return;
    }
    let cancelled = false;
    async function loadLogs() {
      setLogsLoading(true);
      setLogsError('');
      try {
        const response = await fetchLogs(logsKind, 50, logsOffset);
        if (!cancelled) {
          setLogs(response);
        }
      } catch (err) {
        if (!cancelled) {
          setLogsError(err instanceof Error ? err.message : 'Failed to load logs');
        }
      } finally {
        if (!cancelled) {
          setLogsLoading(false);
        }
      }
    }
    void loadLogs();
    return () => {
      cancelled = true;
    };
  }, [tab, logsKind, logsOffset]);

  const summary = payload?.sections.equityCurve.summary;
  const points = payload?.sections.equityCurve.points ?? [];
  const openPositions = payload?.sections.openPositions.rows ?? [];
  const openPositionSummary = payload?.sections.openPositions.summary;
  const tradeRows = payload?.sections.tradeLog.rows ?? [];
  const promotionRows = payload?.sections.promotionGates.rows ?? [];
  const policy = payload?.sections.policyState;
  const performance = payload?.sections.performanceBreakdown;
  const closeLearning = payload?.sections.closeLearning;
  const predictionAccuracy = payload?.sections.predictionAccuracy ?? {};
  const accuracyWindows = Array.isArray(predictionAccuracy.global)
    ? predictionAccuracy.global as Array<Record<string, unknown>>
    : [];
  const accuracyDiagnostics = predictionAccuracy.diagnostics && typeof predictionAccuracy.diagnostics === 'object'
    ? predictionAccuracy.diagnostics as Record<string, unknown>
    : {};

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-card">
          <p className="hero-eyebrow">Autonomous Market Discovery Companion</p>
          <h1>Thufir Dashboard v2</h1>
          <p>A product-grade control room for trading state, execution quality, and release health. The gateway now serves a real bundled frontend instead of CDN React.</p>
          <div className="hero-meta">
            <div className="hero-stat"><div className="hero-eyebrow">Generated</div><div className="hero-stat-value">{timeText(payload?.meta.generatedAt)}</div></div>
            <div className="hero-stat"><div className="hero-eyebrow">Refreshed</div><div className="hero-stat-value">{timeText(refreshedAt)}</div></div>
            <div className="hero-stat"><div className="hero-eyebrow">Mode</div><div className="hero-stat-value">{mode}</div></div>
            <div className="hero-stat"><div className="hero-eyebrow">Window</div><div className="hero-stat-value">{timeframe === 'period' ? period : timeframe}</div></div>
          </div>
        </div>
        <div className="hero-side">
          <div className={`hero-card status-banner ${error ? 'status-error' : 'status-okay'}`}>
            <strong>{error ? 'Data feed degraded' : 'Dashboard online'}</strong>
            <span>{error ? error : loading ? 'Refreshing the latest control-room snapshot.' : 'Static bundle is serving correctly and the gateway API is responding.'}</span>
          </div>
          <div className="hero-card status-banner">
            <strong>Foundation complete</strong>
            <span>Conversations and structured decision logs can now be added as real tabs on top of this build pipeline and static serving path.</span>
          </div>
        </div>
      </section>

      <section className="toolbar">
        <div className="filter-card"><label>Mode</label><select value={mode} onChange={(event) => setMode(event.target.value as DashboardMode)}><option value="paper">Paper</option><option value="live">Live</option><option value="combined">Combined</option></select></div>
        <div className="filter-card"><label>Timeframe</label><select value={timeframe} onChange={(event) => setTimeframe(event.target.value as DashboardTimeframe)}><option value="all">All</option><option value="day">Day</option><option value="period">Period</option><option value="custom">Custom</option></select></div>
        <div className="filter-card"><label>Period</label><select value={period} disabled={timeframe !== 'period'} onChange={(event) => setPeriod(event.target.value)}>{PERIODS.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
        <div className="filter-card"><label>From</label><input type="datetime-local" value={from} disabled={timeframe !== 'custom'} onChange={(event) => setFrom(event.target.value)} /></div>
        <div className="filter-card"><label>To</label><input type="datetime-local" value={to} disabled={timeframe !== 'custom'} onChange={(event) => setTo(event.target.value)} /></div>
      </section>

      <section className="tabs">
        {TABS.map((value) => (
          <button key={value} type="button" className={`tab-button ${tab === value ? 'active' : ''}`} onClick={() => setTab(value)}>
            {value}
          </button>
        ))}
      </section>

      <section className="kpi-grid">
        <article className="kpi-card"><div className="kpi-label">Account Equity</div><div className="kpi-value mono">{money(summary?.endEquity)}</div><div className="kpi-sub">Start {money(summary?.startEquity)}</div></article>
        <article className="kpi-card"><div className="kpi-label">Return</div><div className="kpi-value mono">{percent(summary?.returnPct)}</div><div className="kpi-sub">Max drawdown {percent(summary?.maxDrawdownPct)}</div></article>
        <article className="kpi-card"><div className="kpi-label">Open PnL</div><div className="kpi-value mono">{money(openPositionSummary?.totalUnrealizedPnlUsd)}</div><div className="kpi-sub">Long {numberText(openPositionSummary?.longCount, 0)} / Short {numberText(openPositionSummary?.shortCount, 0)}</div></article>
        <article className="kpi-card"><div className="kpi-label">Records</div><div className="kpi-value mono">{numberText(payload?.meta.recordCounts?.journals, 0)} journals</div><div className="kpi-sub">{numberText(payload?.meta.recordCounts?.perpTrades, 0)} trades · {numberText(payload?.meta.recordCounts?.alerts, 0)} alerts</div></article>
      </section>

      {tab === 'overview' && (
        <section className="content-grid">
          <article className="panel"><div className="panel-head"><h2>Equity Curve</h2><p>Cash and unrealized PnL over the selected filter window.</p></div><div className="panel-body chart-card"><EquityChart points={points} /></div></article>
          <article className="panel"><div className="panel-head"><h2>Policy State</h2><p>Execution guardrails and current risk posture.</p></div><div className="panel-body"><div className="subgrid"><div className="subpanel"><h3>Observation</h3><div className={badgeClass(policy?.observationMode)}>{policy?.observationMode ? 'ON' : 'OFF'}</div></div><div className="subpanel"><h3>Leverage Cap</h3><div className="mono">{policy?.leverageCap == null ? '-' : `${numberText(policy.leverageCap, 2)}x`}</div></div><div className="subpanel"><h3>Drawdown Left</h3><div className="mono">{money(policy?.drawdownCapRemainingUsd)}</div></div><div className="subpanel"><h3>Trades Remaining</h3><div className="mono">{numberText(policy?.tradesRemainingToday, 0)}</div></div></div><div className="footnote">Updated {timeText(policy?.updatedAt)}</div></div></article>
        </section>
      )}

      {tab === 'positions' && (
        <section className="panel"><div className="panel-head"><h2>Open Positions</h2><p>Current mark-to-market exposure for paper or live mode.</p></div><div className="panel-body"><DataTable headers={['Symbol', 'Side', 'Entry', 'Current', 'Size', 'Lev', 'Unrealized', 'Held']} empty="No open positions." rows={openPositions.map((row) => [String(row.symbol ?? '-'), <span className={badgeClass(row.side)}>{String(row.side ?? '-')}</span>, <span className="mono">{money(Number(row.entryPrice ?? 0))}</span>, <span className="mono">{money(Number(row.currentPrice ?? 0))}</span>, <span className="mono">{numberText(Number(row.size ?? 0), 4)}</span>, <span className="mono">{row.leverage != null ? `${Number(row.leverage).toFixed(1)}x` : '-'}</span>, <span className="mono">{money(Number(row.unrealizedPnlUsd ?? 0))}</span>, <span className="mono">{formatHeld(Number(row.heldSeconds ?? 0))}</span>])} /></div></section>
      )}

      {tab === 'trades' && (
        <section className="panel"><div className="panel-head"><h2>Trade Log</h2><p>Recent scored journal rows with quality labels.</p></div><div className="panel-body"><DataTable headers={['Closed', 'Symbol', 'Side', 'Signal', 'PnL', 'R', 'Quality']} empty="No trade log rows." rows={tradeRows.map((row) => [<span className="mono">{timeText(String(row.closedAt ?? ''))}</span>, String(row.symbol ?? '-'), String(row.side ?? '-'), String(row.signalClass ?? 'unknown'), <span className="mono">{money(typeof row.realizedPnlUsd === 'number' ? row.realizedPnlUsd : null)}</span>, <span className="mono">{numberText(typeof row.rCaptured === 'number' ? row.rCaptured : null, 3)}</span>, <span className={badgeClass(row.qualityBand)}>{String(row.qualityBand ?? 'mixed')}</span>])} /></div></section>
      )}

      {tab === 'performance' && (
        <section className="subgrid">
          <article className="subpanel"><h3>By Signal Class</h3><PerfTable rows={performance?.bySignalClass ?? []} /></article>
          <article className="subpanel"><h3>By Regime</h3><PerfTable rows={performance?.byRegime ?? []} /></article>
          <article className="subpanel"><h3>By Session</h3><PerfTable rows={performance?.bySession ?? []} /></article>
          <article className="subpanel"><h3>Promotion Gates</h3><DataTable headers={['Setup', 'Samples', 'Hit Rate', 'Expectancy', 'Promoted']} empty="No promotion rows." rows={promotionRows.map((row) => [String(row.setupKey ?? '-'), <span className="mono">{numberText(Number(row.sampleCount ?? 0), 0)}</span>, <span className="mono">{percent(Number(row.hitRate ?? 0) * 100)}</span>, <span className="mono">{numberText(Number(row.expectancyR ?? 0), 3)}</span>, <span className={badgeClass(Boolean(row.promoted))}>{row.promoted ? 'yes' : 'no'}</span>])} /></article>
        </section>
      )}

      {tab === 'learning' && (
        <section className="learning-stack">
          <article className="panel">
            <div className="panel-head"><h2>Comparable Prediction Accuracy</h2><p>Rolling calibration windows for final comparable predictions.</p></div>
            <div className="panel-body">
              <div className="subgrid compact-grid">
                <div className="subpanel"><h3>Final Comparable</h3><div className="mono">{numberText(numericField(predictionAccuracy, 'totalFinalPredictions'), 0)}</div></div>
                <div className="subpanel"><h3>Total Considered</h3><div className="mono">{numberText(numericField(accuracyDiagnostics, 'totalPredictionsConsidered'), 0)}</div></div>
                <div className="subpanel"><h3>Final Outcomes</h3><div className="mono">{numberText(numericField(accuracyDiagnostics, 'finalOutcomePredictions'), 0)}</div></div>
                <div className="subpanel"><h3>Comparable Eligible</h3><div className="mono">{numberText(numericField(accuracyDiagnostics, 'comparableEligible'), 0)}</div></div>
                <div className="subpanel"><h3>Missing Comparator</h3><div className="mono">{numberText(numericField(accuracyDiagnostics, 'missingComparator'), 0)}</div></div>
                <div className="subpanel"><h3>Synthetic Blocked</h3><div className="mono">{numberText(numericField(accuracyDiagnostics, 'syntheticComparatorBlocked'), 0)}</div></div>
                <div className="subpanel"><h3>Insufficient Samples</h3><div className="mono">{numberText(numericField(accuracyDiagnostics, 'insufficientSamples'), 0)}</div></div>
              </div>
              <DataTable
                headers={['Window', 'Samples', 'Accuracy', 'Brier Δ', 'Model', 'Market', 'Avg Edge', 'PnL']}
                empty="No prediction-accuracy windows yet."
                rows={accuracyWindows.map((row) => [
                  <span className="mono">{numberText(numericField(row, 'windowSize'), 0)}</span>,
                  <span className="mono">{numberText(numericField(row, 'sampleCount'), 0)}</span>,
                  <span className="mono">{percent(numericField(row, 'accuracy') == null ? null : Number(numericField(row, 'accuracy')) * 100)}</span>,
                  <span className="mono">{numberText(numericField(row, 'brierDelta'), 4)}</span>,
                  <span className="mono">{numberText(numericField(row, 'brierModel'), 4)}</span>,
                  <span className="mono">{numberText(numericField(row, 'brierMarket'), 4)}</span>,
                  <span className="mono">{numberText(numericField(row, 'avgEdge'), 4)}</span>,
                  <span className="mono">{money(numericField(row, 'totalPnl'))}</span>,
                ])}
              />
              {accuracyWindows.length === 0 && (
                <div className="learning-note">
                  No final comparable predictions are available yet. Current exclusions are missing comparator, synthetic comparator, or insufficient historical baseline samples.
                </div>
              )}
            </div>
          </article>
          <section className="content-grid">
          <article className="panel">
            <div className="panel-head"><h2>Close Finalizer</h2><p>Durable close-learning queue and canonical lifecycle output.</p></div>
            <div className="panel-body">
              <div className="subgrid">
                <div className="subpanel"><h3>Jobs</h3><div className="mono">{numberText(closeLearning?.finalizer?.totalJobs, 0)}</div></div>
                <div className="subpanel"><h3>Pending</h3><div className="mono">{numberText(closeLearning?.finalizer?.pending, 0)}</div></div>
                <div className="subpanel"><h3>Finalized</h3><div className="mono">{numberText(closeLearning?.finalizer?.finalized, 0)}</div></div>
                <div className="subpanel"><h3>Failed</h3><div className="mono">{numberText((closeLearning?.finalizer?.failedRetryable ?? 0) + (closeLearning?.finalizer?.failedTerminal ?? 0), 0)}</div></div>
              </div>
              <DataTable headers={['Closed', 'Symbol', 'Side', 'PnL', 'R', 'Reflection']} empty="No finalized close artifacts yet." rows={(closeLearning?.tradeCloses?.recent ?? []).map((row) => [<span className="mono">{timeText(String(row.closedAt ?? ''))}</span>, String(row.symbol ?? '-'), String(row.closedSide ?? '-'), <span className="mono">{money(typeof row.netRealizedPnlUsd === 'number' ? row.netRealizedPnlUsd : null)}</span>, <span className="mono">{numberText(typeof row.capturedR === 'number' ? row.capturedR : null, 3)}</span>, String(row.deterministicStatus ?? '-')])} />
            </div>
          </article>
          <article className="panel">
            <div className="panel-head"><h2>Policy Learning</h2><p>Automatic policy promotions sourced from closed-trade evidence.</p></div>
            <div className="panel-body">
              <div className="subgrid">
                <div className="subpanel"><h3>Full Closes</h3><div className="mono">{numberText(closeLearning?.closeEvents?.fullCloses, 0)}</div></div>
                <div className="subpanel"><h3>Partial Reduces</h3><div className="mono">{numberText(closeLearning?.closeEvents?.partialReduces, 0)}</div></div>
                <div className="subpanel"><h3>Reflections</h3><div className="mono">{numberText(closeLearning?.reflections?.total, 0)}</div></div>
                <div className="subpanel"><h3>Regret Cases</h3><div className="mono">{numberText(closeLearning?.regretCases?.total, 0)}</div></div>
              </div>
              <DataTable headers={['Action', 'Symbol', 'Signal', 'Samples', 'Reason']} empty="No active learned policy adjustments." rows={(closeLearning?.policyLearning?.activeAdjustments ?? []).map((row) => [<span className={badgeClass(row.action === 'block' ? 'poor' : 'mixed')}>{String(row.action ?? '-')}</span>, String(row.symbol ?? 'any'), String(row.signalClass ?? 'any'), <span className="mono">{numberText(Number(row.sampleCount ?? 0), 0)}</span>, String(row.reason ?? '-')])} />
            </div>
          </article>
          </section>
        </section>
      )}

      {tab === 'policy' && (
        <section className="panel"><div className="panel-head"><h2>Policy Envelope</h2><p>Raw policy-state slice surfaced for release gates and execution control.</p></div><div className="panel-body"><pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(policy ?? {}, null, 2)}</pre></div></section>
      )}

      {tab === 'conversations' && (
        <section className="panel">
          <div className="panel-head">
            <h2>Conversation Thread</h2>
            <p>Rendered as a straight message thread, like the Telegram chat history.</p>
          </div>
          <div className="panel-body">
            <div className="conversation-toolbar">
              <div className="conversation-filters">
                <div className="conversation-picker conversation-day-picker">
                  <label htmlFor="conversation-day">Day</label>
                  <select
                    id="conversation-day"
                    value={selectedConversationDay ?? ''}
                    onChange={(event) => setSelectedConversationDay(event.target.value || null)}
                  >
                    {conversationDays.map((day) => (
                      <option key={day} value={day}>
                        {conversationDayLabel(day)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="conversation-picker">
                  <label htmlFor="conversation-session">Session</label>
                  <select
                    id="conversation-session"
                    value={selectedSessionId ?? ''}
                    onChange={(event) => setSelectedSessionId(event.target.value || null)}
                  >
                    {filteredConversations.map((session) => (
                      <option key={session.sessionId} value={session.sessionId}>
                        {shortDateLabel(session.lastMessageAt)} · {relativeTime(session.lastMessageAt)} · {session.firstMessage}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {selectedSessionId ? (
                <div className="conversation-summary">
                  <span>latest 50 of {filteredConversations.find((session) => session.sessionId === selectedSessionId)?.messageCount ?? 0} messages</span>
                  <span className="mono">{selectedSessionId.slice(0, 8)}</span>
                </div>
              ) : null}
            </div>
            {conversationError ? <div className="empty-state">{conversationError}</div> : null}
            {conversationLoading && !thread ? <div className="empty-state">Loading conversation…</div> : null}
            {!conversationLoading && filteredConversations.length === 0 ? <div className="empty-state">No conversations for this day.</div> : null}
            <ConversationThread thread={thread} />
          </div>
        </section>
      )}

      {tab === 'logs' && (
        <section className="panel">
          <div className="panel-head">
            <h2>Decision Logs</h2>
            <p>Structured decision audit and agent-incident feed.</p>
          </div>
          <div className="panel-body">
            <div className="tabs">
              {(['all', 'decision', 'incident'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={`tab-button ${logsKind === kind ? 'active' : ''}`}
                  onClick={() => {
                    setLogsKind(kind);
                    setLogsOffset(0);
                  }}
                >
                  {kind}
                </button>
              ))}
            </div>
            {logsError ? <div className="empty-state">{logsError}</div> : null}
            {logsLoading && logs.entries.length === 0 ? <div className="empty-state">Loading logs…</div> : null}
            <div className="log-list">
              {logs.entries.length === 0 && !logsLoading ? <div className="empty-state">No log entries yet.</div> : null}
              {logs.entries.map((entry, index) => (
                <article key={`${String(entry.kind)}-${String(entry.id)}-${index}`} className="log-card">
                  <div className="conversation-row">
                    <span className={badgeClass(entry.kind === 'decision' ? 'good' : 'mixed')}>{String(entry.kind ?? 'entry')}</span>
                    <span>{timeText(String(entry.createdAt ?? ''))}</span>
                  </div>
                  {entry.kind === 'decision' ? (
                    <>
                      <strong>{String(entry.marketId ?? 'global')} · {String(entry.tradeAction ?? 'observe')}</strong>
                      <div className="log-meta">
                        edge {numberText(Number(entry.edge ?? 0) * 100, 2)}% · confidence {numberText(Number(entry.confidence ?? 0) * 100, 0)}% · tools {numberText(Number(entry.toolCallCount ?? 0), 0)}
                      </div>
                      {Array.isArray(entry.toolTrace) && entry.toolTrace.length > 0 ? (
                        <pre className="log-pre mono">{JSON.stringify(entry.toolTrace, null, 2)}</pre>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <strong>{String(entry.toolName ?? 'unknown tool')} · {String(entry.blockerKind ?? 'incident')}</strong>
                      <div className="log-meta">{String(entry.error ?? '')}</div>
                      {entry.details ? <pre className="log-pre mono">{JSON.stringify(entry.details, null, 2)}</pre> : null}
                    </>
                  )}
                </article>
              ))}
            </div>
            <div className="conversation-row" style={{ marginTop: '14px' }}>
              <span>{logs.total} total entries</span>
              <div className="tabs" style={{ margin: 0 }}>
                <button type="button" className="tab-button" disabled={logsOffset === 0} onClick={() => setLogsOffset((value) => Math.max(0, value - 50))}>Prev</button>
                <button type="button" className="tab-button" disabled={logsOffset + 50 >= logs.total} onClick={() => setLogsOffset((value) => value + 50)}>Next</button>
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="footnote">Polling cadence: {mode === 'live' ? '5 seconds' : '30 seconds'} · query `{queryString || '(none)'}`.</div>
    </main>
  );
}
