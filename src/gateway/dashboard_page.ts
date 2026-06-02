import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

function buildDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Thufir Dashboard</title>
    <style>
      :root {
        --bg-deep: #081223;
        --bg-mid: #102340;
        --bg-ink: #0f1c34;
        --sand: #f5d9b7;
        --sunset-orange: #d86a2b;
        --sunset-amber: #f59d43;
        --sunset-red: #a9422e;
        --oasis-blue: #4eb3d9;
        --text-main: #f4e8d8;
        --text-dim: #cbbba7;
        --good: #6ac78a;
        --bad: #dc6a5d;
        --mixed: #d3a85a;
        --border: rgba(245, 217, 183, 0.18);
        --card: rgba(12, 25, 47, 0.78);
        --card-2: rgba(16, 34, 62, 0.78);
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        min-height: 100%;
        font-family: "Space Grotesk", "Avenir Next", "Segoe UI", sans-serif;
        color: var(--text-main);
        background: radial-gradient(1200px 700px at 80% -10%, rgba(216, 106, 43, 0.28), transparent 55%),
                    radial-gradient(1000px 600px at -10% 110%, rgba(78, 179, 217, 0.18), transparent 52%),
                    linear-gradient(165deg, var(--bg-deep), var(--bg-mid) 45%, #1a2f4f 100%);
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image: linear-gradient(rgba(245, 217, 183, 0.04) 1px, transparent 1px),
                          linear-gradient(90deg, rgba(245, 217, 183, 0.04) 1px, transparent 1px);
        background-size: 28px 28px;
        mask-image: radial-gradient(circle at center, black 0%, rgba(0, 0, 0, 0.25) 70%, transparent 100%);
      }
      body::after {
        content: "";
        position: fixed;
        inset: -10% -10% 0 -10%;
        pointer-events: none;
        z-index: 0;
        opacity: 0.22;
        background:
          radial-gradient(110% 55% at 18% 108%, rgba(216, 106, 43, 0.35), transparent 66%),
          radial-gradient(95% 50% at 58% 112%, rgba(245, 157, 67, 0.20), transparent 70%),
          radial-gradient(100% 55% at 88% 110%, rgba(169, 66, 46, 0.24), transparent 72%);
        animation: duneDrift 48s ease-in-out infinite alternate;
        filter: blur(1px);
      }
      .dune-layer {
        position: fixed;
        left: -18vw;
        right: -18vw;
        bottom: -18vh;
        height: 44vh;
        pointer-events: none;
        z-index: 0;
        border-radius: 52% 48% 0 0 / 68% 72% 0 0;
        transform-origin: center bottom;
      }
      .dune-a {
        background: radial-gradient(120% 92% at 50% 100%, rgba(216, 106, 43, 0.30), rgba(216, 106, 43, 0.02) 74%);
        animation: duneFloatA 34s ease-in-out infinite alternate;
        filter: blur(0.8px);
      }
      .dune-b {
        height: 38vh;
        bottom: -14vh;
        background: radial-gradient(110% 88% at 54% 100%, rgba(245, 157, 67, 0.24), rgba(245, 157, 67, 0.01) 72%);
        animation: duneFloatB 46s ease-in-out infinite alternate;
      }
      .dune-c {
        height: 32vh;
        bottom: -9vh;
        background: radial-gradient(115% 82% at 46% 100%, rgba(169, 66, 46, 0.20), rgba(169, 66, 46, 0.01) 70%);
        animation: duneFloatC 56s ease-in-out infinite alternate;
      }
      @keyframes duneDrift {
        0% { transform: translate3d(-1.5%, 0, 0) scale(1.01); }
        50% { transform: translate3d(1.25%, -0.5%, 0) scale(1.02); }
        100% { transform: translate3d(-1%, 0.3%, 0) scale(1.01); }
      }
      @keyframes duneFloatA {
        0% { transform: translate3d(-2.5%, 0, 0) scale(1.02); }
        100% { transform: translate3d(2.1%, -1.8%, 0) scale(1.06); }
      }
      @keyframes duneFloatB {
        0% { transform: translate3d(2.4%, 0, 0) scale(1.01); }
        100% { transform: translate3d(-2.2%, -1.2%, 0) scale(1.05); }
      }
      @keyframes duneFloatC {
        0% { transform: translate3d(-1.8%, 0, 0) scale(1.00); }
        100% { transform: translate3d(1.6%, -0.9%, 0) scale(1.03); }
      }
      #app {
        max-width: 1380px;
        margin: 0 auto;
        padding: 24px 18px 40px;
        position: relative;
        z-index: 1;
      }
      .hero {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 16px;
        align-items: center;
        margin-bottom: 18px;
      }
      .title-wrap h1 { margin: 0; font-size: clamp(1.4rem, 3.2vw, 2.2rem); letter-spacing: 0.01em; }
      .title-wrap p { margin: 6px 0 0; color: var(--text-dim); font-size: 0.95rem; }
      .stamp { border: 1px solid var(--border); border-radius: 12px; background: rgba(5, 13, 29, 0.48); padding: 10px 12px; font-size: 0.84rem; color: var(--text-dim); }
      .filters { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 10px; margin-bottom: 18px; }
      .filter { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: 12px; background: var(--card); padding: 10px; }
      .filter label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-dim); }
      .filter select, .filter input, .filter button { width: 100%; border: 1px solid rgba(245, 217, 183, 0.24); background: rgba(8, 18, 35, 0.9); color: var(--text-main); border-radius: 9px; padding: 8px 10px; font-size: 0.9rem; }
      .filter button { cursor: pointer; background: linear-gradient(135deg, var(--sunset-orange), var(--sunset-red)); border-color: rgba(255, 167, 103, 0.55); font-weight: 600; }
      .tabs { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
      .tab-btn { border: 1px solid var(--border); background: rgba(8, 18, 35, 0.7); color: var(--text-main); border-radius: 999px; padding: 9px 14px; font-size: 0.84rem; font-weight: 600; cursor: pointer; transition: background 120ms ease, border-color 120ms ease, transform 120ms ease; }
      .tab-btn:hover { border-color: rgba(245, 217, 183, 0.35); transform: translateY(-1px); }
      .tab-btn.active { background: linear-gradient(135deg, rgba(216, 106, 43, 0.26), rgba(78, 179, 217, 0.16)); border-color: rgba(245, 217, 183, 0.38); }
      .kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 10px; margin-bottom: 16px; }
      .kpi { border: 1px solid var(--border); border-radius: 14px; background: linear-gradient(180deg, rgba(16, 34, 62, 0.85), rgba(8, 19, 36, 0.9)); padding: 12px; }
      .kpi .label { font-size: 0.72rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.1em; }
      .kpi .value { margin-top: 6px; font-size: 1.12rem; font-weight: 700; }
      .kpi .sub { margin-top: 4px; font-size: 0.78rem; color: var(--text-dim); }
      .grid { display: grid; grid-template-columns: 1.35fr 1fr; gap: 12px; margin-bottom: 12px; }
      .panel { border: 1px solid var(--border); border-radius: 14px; background: var(--card); overflow: hidden; }
      .panel .head { padding: 12px 14px; border-bottom: 1px solid var(--border); background: linear-gradient(90deg, rgba(216, 106, 43, 0.18), rgba(78, 179, 217, 0.06)); }
      .panel .head h3 { margin: 0; font-size: 0.95rem; }
      .panel .head p { margin: 4px 0 0; font-size: 0.78rem; color: var(--text-dim); }
      .panel .body { padding: 12px; }
      .chart-wrap { width: 100%; height: 320px; }
      table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
      th, td { padding: 8px; border-bottom: 1px solid rgba(245, 217, 183, 0.12); text-align: left; }
      th { color: var(--text-dim); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.67rem; }
      .scroll-x { overflow: auto; }
      .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.72rem; font-weight: 600; }
      .pill.good { background: rgba(106, 199, 138, 0.24); color: #91e3ad; }
      .pill.bad { background: rgba(220, 106, 93, 0.24); color: #ff9f95; }
      .pill.mixed { background: rgba(211, 168, 90, 0.24); color: #f4cd85; }
      .mono { font-variant-numeric: tabular-nums; font-family: "JetBrains Mono", "SFMono-Regular", monospace; }
      .policy-grid { display: grid; grid-template-columns: repeat(5, minmax(140px, 1fr)); gap: 10px; }
      .policy-card { border: 1px solid var(--border); background: var(--card-2); border-radius: 10px; padding: 10px; }
      .policy-card .k { color: var(--text-dim); font-size: 0.74rem; }
      .policy-card .v { margin-top: 4px; font-size: 0.96rem; font-weight: 700; }
      .learning-grid { display: grid; grid-template-columns: 1.05fr 1fr; gap: 12px; margin-bottom: 12px; }
      .learning-stat-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
      .learning-stat { border: 1px solid var(--border); border-radius: 10px; background: var(--card-2); padding: 10px; }
      .learning-stat .k { color: var(--text-dim); font-size: 0.74rem; }
      .learning-stat .v { margin-top: 4px; font-size: 0.98rem; font-weight: 700; }
      .learning-note { margin-top: 10px; padding: 10px 12px; border: 1px solid rgba(211, 168, 90, 0.28); border-radius: 10px; background: rgba(211, 168, 90, 0.08); color: #f4cd85; font-size: 0.8rem; }
      .muted { color: var(--text-dim); }
      .small { font-size: 0.75rem; }
      .perf-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .perf-box { border: 1px solid var(--border); border-radius: 10px; background: var(--card-2); padding: 10px; min-height: 94px; }
      .footer-note { margin-top: 10px; color: var(--text-dim); font-size: 0.74rem; }
      .error { background: rgba(220, 106, 93, 0.13); border: 1px solid rgba(220, 106, 93, 0.4); border-radius: 12px; padding: 10px; margin-bottom: 10px; color: #ffb7ae; }
      @media (max-width: 1080px) {
        .filters { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
        .kpi-grid { grid-template-columns: repeat(2, minmax(160px, 1fr)); }
        .grid { grid-template-columns: 1fr; }
        .learning-grid { grid-template-columns: 1fr; }
        .learning-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .policy-grid { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
        .perf-grid { grid-template-columns: 1fr; }
      }
      @media (max-width: 620px) {
        #app { padding: 14px 10px 24px; }
        .hero { grid-template-columns: 1fr; }
        .filters { grid-template-columns: 1fr; }
        .kpi-grid { grid-template-columns: 1fr; }
        .learning-stat-grid { grid-template-columns: 1fr; }
        .policy-grid { grid-template-columns: 1fr; }
        .chart-wrap { height: 240px; }
      }
    </style>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script crossorigin src="https://unpkg.com/recharts@2.12.7/umd/Recharts.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  </head>
  <body>
    <div class="dune-layer dune-a"></div>
    <div class="dune-layer dune-b"></div>
    <div class="dune-layer dune-c"></div>
    <div id="app">
      <div style="padding:14px;border:1px solid rgba(245,217,183,0.2);border-radius:12px;background:rgba(12,25,47,0.7);color:#f4e8d8">
        Loading dashboard UI...
      </div>
    </div>
    <script>
      (function () {
        var app = document.getElementById('app');
        function showBootError(message) {
          if (!app) return;
          app.innerHTML =
            '<div style=\"padding:14px;border:1px solid rgba(220,106,93,0.55);border-radius:12px;background:rgba(220,106,93,0.12);color:#ffb7ae\">' +
            '<strong>Dashboard failed to render.</strong><br/>' +
            '<span style=\"font-family:monospace\">' + String(message || 'unknown error') + '</span><br/>' +
            '<span style=\"color:#cbbba7\">Try hard-refresh. If this persists, CDN scripts may be blocked by network/extensions.</span>' +
            '</div>';
        }
        window.__dashboardShowBootError = showBootError;
        window.addEventListener('error', function (event) {
          if (event && event.message) showBootError(event.message);
        });
        window.addEventListener('unhandledrejection', function (event) {
          var msg = event && event.reason && event.reason.message ? event.reason.message : event.reason;
          showBootError(msg || 'unhandled promise rejection');
        });
      })();
    </script>
    <script type="text/babel" data-presets="env,react">
      if (!window.React || !window.ReactDOM) {
        window.__dashboardShowBootError && window.__dashboardShowBootError('React runtime failed to load');
      }

      const { useEffect, useMemo, useState } = React || {};
      const {
        ResponsiveContainer,
        AreaChart,
        Area,
        CartesianGrid,
        Tooltip,
        XAxis,
        YAxis
      } = window.Recharts || {};
      const hasRecharts = Boolean(window.Recharts && ResponsiveContainer);

      const PERIODS = ['1d', '7d', '14d', '30d', '90d'];

      function money(value) {
        if (value == null || Number.isNaN(Number(value))) return '-';
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value));
      }

      function pct(value) {
        if (value == null || Number.isNaN(Number(value))) return '-';
        return Number(value).toFixed(2) + '%';
      }

      function num(value, digits = 2) {
        if (value == null || Number.isNaN(Number(value))) return '-';
        return Number(value).toFixed(digits);
      }

      function fmtTime(iso) {
        if (!iso) return '-';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return String(iso);
        return d.toLocaleString();
      }

      function scorePillClass(band) {
        if (band === 'good') return 'pill good';
        if (band === 'poor') return 'pill bad';
        return 'pill mixed';
      }

      function EquityChartFallback({ points }) {
        if (!Array.isArray(points) || points.length === 0) {
          return <div className="muted small">No equity points for this filter window.</div>;
        }
        const W = 1000;
        const H = 320;
        const PAD = 24;
        const values = points
          .map((point) => Number(point && point.equity))
          .filter((value) => Number.isFinite(value));
        if (values.length === 0) {
          return <div className="muted small">No numeric equity values available.</div>;
        }
        let min = Math.min.apply(null, values);
        let max = Math.max.apply(null, values);
        if (Math.abs(max - min) < 1e-9) {
          min = min - 1;
          max = max + 1;
        }

        const xFor = (index) =>
          PAD + (index / Math.max(1, points.length - 1)) * (W - PAD * 2);
        const yFor = (value) =>
          PAD + ((max - value) / (max - min)) * (H - PAD * 2);

        const lineD = points
          .map((point, index) => {
            const x = xFor(index);
            const y = yFor(Number(point.equity));
            return (index === 0 ? 'M' : 'L') + x + ' ' + y;
          })
          .join(' ');

        const areaD = lineD + ' L ' + xFor(points.length - 1) + ' ' + (H - PAD) + ' L ' + xFor(0) + ' ' + (H - PAD) + ' Z';
        const startPoint = points[0];
        const endPoint = points[points.length - 1];

        return (
          <div style={{ width: '100%', height: '100%' }}>
            <svg viewBox={'0 0 ' + W + ' ' + H} width="100%" height="100%" preserveAspectRatio="none" role="img" aria-label="Equity curve">
              <defs>
                <linearGradient id="fallbackEqFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59d43" stopOpacity="0.48" />
                  <stop offset="95%" stopColor="#d86a2b" stopOpacity="0.06" />
                </linearGradient>
              </defs>
              <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="rgba(245,217,183,0.25)" />
              <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="rgba(245,217,183,0.25)" />
              <path d={areaD} fill="url(#fallbackEqFill)" />
              <path d={lineD} fill="none" stroke="#f5d9b7" strokeWidth="2.5" />
              <circle cx={xFor(0)} cy={yFor(Number(startPoint.equity))} r="3.5" fill="#4eb3d9" />
              <circle cx={xFor(points.length - 1)} cy={yFor(Number(endPoint.equity))} r="3.5" fill="#f59d43" />
            </svg>
            <div className="small muted" style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px' }}>
              <span>{fmtTime(startPoint.timestamp)} · {money(startPoint.equity)}</span>
              <span>{fmtTime(endPoint.timestamp)} · {money(endPoint.equity)}</span>
            </div>
          </div>
        );
      }

      function PerfTable({ rows }) {
        if (!Array.isArray(rows) || rows.length === 0) {
          return <div className="muted small">No data yet for this slice.</div>;
        }
        return (
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>Key</th><th>Win Rate</th><th>Expectancy R</th><th>Samples</th></tr>
              </thead>
              <tbody>
                {rows.slice(0, 8).map((row, idx) => (
                  <tr key={(row.key || row.label || row.name || 'row') + '_' + idx}>
                    <td>{String(row.key || row.label || row.name || '-')}</td>
                    <td className="mono">{pct((row.winRate ?? row.hitRate) != null ? Number(row.winRate ?? row.hitRate) * 100 : null)}</td>
                    <td className="mono">{num(row.expectancyR ?? row.expectancy ?? null, 3)}</td>
                    <td className="mono">{num(row.sampleCount ?? row.samples ?? null, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }

      function confidenceDelta(value) {
        if (value == null || Number.isNaN(Number(value))) return '-';
        const normalized = Number(value);
        const sign = normalized > 0 ? '+' : '';
        return sign + normalized.toFixed(4);
      }

      function MetricsTable({ rows }) {
        if (!Array.isArray(rows) || rows.length === 0) {
          return <div className="muted small">No comparable prediction windows available.</div>;
        }
        return (
          <div className="scroll-x">
            <table>
              <thead>
                <tr><th>Window</th><th>Samples</th><th>Accuracy</th><th>Brier Δ</th><th>Model</th><th>Market</th><th>Avg Edge</th><th>PnL</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={String(row.windowSize)}>
                    <td className="mono">{num(row.windowSize, 0)}</td>
                    <td className="mono">{num(row.sampleCount, 0)}</td>
                    <td className="mono">{row.accuracy == null ? '-' : pct(Number(row.accuracy) * 100)}</td>
                    <td className="mono">{num(row.brierDelta, 4)}</td>
                    <td className="mono">{num(row.brierModel, 4)}</td>
                    <td className="mono">{num(row.brierMarket, 4)}</td>
                    <td className="mono">{num(row.avgEdge, 4)}</td>
                    <td className="mono">{money(row.totalPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }

      function LearningTab({ observability, predictionAccuracy, learningAudit }) {
        const runtime = observability && observability.runtimeContext ? observability.runtimeContext : {};
        const activeWeights = Array.isArray(observability && observability.activeWeights) ? observability.activeWeights : [];
        const runSummaries = Array.isArray(observability && observability.runSummaries) ? observability.runSummaries : [];
        const recentAudits = Array.isArray(observability && observability.recentAudits) ? observability.recentAudits : [];
        const windows = Array.isArray(predictionAccuracy && predictionAccuracy.global) ? predictionAccuracy.global : [];
        const totalFinalPredictions = Number(predictionAccuracy && predictionAccuracy.totalFinalPredictions ? predictionAccuracy.totalFinalPredictions : 0);
        const exclusions = Array.isArray(learningAudit && learningAudit.exclusions && learningAudit.exclusions.byReason)
          ? learningAudit.exclusions.byReason
          : [];

        return (
          <div>
            <section className="learning-grid">
              <article className="panel">
                <div className="head"><h3>Learning Runtime</h3><p>Current run context and live shadow-learning counters.</p></div>
                <div className="body">
                  <div className="learning-stat-grid">
                    <div className="learning-stat"><div className="k">Run ID</div><div className="v small">{runtime.runId || 'default'}</div></div>
                    <div className="learning-stat"><div className="k">Policy Version</div><div className="v small">{runtime.policyVersion || 'default'}</div></div>
                    <div className="learning-stat"><div className="k">Shadow Audits</div><div className="v mono">{num(observability && observability.totalShadowAudits, 0)}</div></div>
                    <div className="learning-stat"><div className="k">Runtime Source</div><div className="v">{runtime.source || '-'}</div></div>
                  </div>
                  <div className="footer-note">Updated {fmtTime(runtime.updatedAt)}</div>
                </div>
              </article>

              <article className="panel">
                <div className="head"><h3>Comparable Prediction Accuracy</h3><p>Final comparable windows used for forecast-quality measurement.</p></div>
                <div className="body">
                  <div className="learning-stat-grid" style={{ marginBottom: '10px' }}>
                    <div className="learning-stat"><div className="k">Final Comparable Predictions</div><div className="v mono">{num(totalFinalPredictions, 0)}</div></div>
                    <div className="learning-stat"><div className="k">Comparable Cases</div><div className="v mono">{num(learningAudit && learningAudit.comparable && learningAudit.comparable.totalCaseCount, 0)}</div></div>
                    <div className="learning-stat"><div className="k">Excluded Rows</div><div className="v mono">{num(learningAudit && learningAudit.exclusions && learningAudit.exclusions.totalCaseCount, 0)}</div></div>
                    <div className="learning-stat"><div className="k">Execution Cases</div><div className="v mono">{num(learningAudit && learningAudit.execution && learningAudit.execution.totalCaseCount, 0)}</div></div>
                  </div>
                  <MetricsTable rows={windows} />
                  {totalFinalPredictions === 0 ? (
                    <div className="learning-note">
                      No final comparable predictions are available yet. This is expected when the comparable pipeline has not produced rows in <span className="mono">learning_examples</span>.
                    </div>
                  ) : null}
                </div>
              </article>
            </section>

            <section className="learning-grid">
              <article className="panel">
                <div className="head"><h3>Active Learned Weights</h3><p>Current weight rows being consumed by the runtime.</p></div>
                <div className="body scroll-x">
                  <table>
                    <thead><tr><th>Domain</th><th>Technical</th><th>News</th><th>On-Chain</th><th>Samples</th><th>Updated</th></tr></thead>
                    <tbody>
                      {activeWeights.length === 0 ? <tr><td colSpan="6" className="muted">No learned weight rows.</td></tr> : activeWeights.map((row) => (
                        <tr key={String(row.domain || 'domain')}>
                          <td>{row.domain || '-'}</td>
                          <td className="mono">{num(row.weights && row.weights.technical, 4)}</td>
                          <td className="mono">{num(row.weights && row.weights.news, 4)}</td>
                          <td className="mono">{num(row.weights && row.weights.onChain, 4)}</td>
                          <td className="mono">{num(row.samples, 0)}</td>
                          <td className="mono">{fmtTime(row.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className="panel">
                <div className="head"><h3>Exclusion Reasons</h3><p>Why predictions were filtered out of comparable forecast scoring.</p></div>
                <div className="body scroll-x">
                  <table>
                    <thead><tr><th>Reason</th><th>Count</th></tr></thead>
                    <tbody>
                      {exclusions.length === 0 ? <tr><td colSpan="2" className="muted">No excluded comparable rows.</td></tr> : exclusions.map((row, idx) => (
                        <tr key={String(row.reason || 'reason') + '_' + idx}>
                          <td>{row.reason}</td>
                          <td className="mono">{num(row.count, 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            </section>

            <section className="learning-grid">
              <article className="panel">
                <div className="head"><h3>Run Summaries</h3><p>Per-run shadow-learning rollups for changed behavior and confidence drift.</p></div>
                <div className="body scroll-x">
                  <table>
                    <thead><tr><th>Run</th><th>Policy</th><th>Events</th><th>Changed vs Default</th><th>Changed After Update</th><th>Avg Δ vs Default</th><th>Avg Δ After Update</th><th>Last Recorded</th></tr></thead>
                    <tbody>
                      {runSummaries.length === 0 ? <tr><td colSpan="8" className="muted">No run summaries yet.</td></tr> : runSummaries.map((row, idx) => (
                        <tr key={String(row.runId || 'run') + '_' + idx}>
                          <td>{row.runId || '-'}</td>
                          <td>{row.policyVersion || '-'}</td>
                          <td className="mono">{num(row.eventCount, 0)}</td>
                          <td className="mono">{num(row.changedVsDefaultCount, 0)}</td>
                          <td className="mono">{num(row.changedAfterUpdateCount, 0)}</td>
                          <td className="mono">{confidenceDelta(row.avgConfidenceDeltaVsDefault)}</td>
                          <td className="mono">{confidenceDelta(row.avgConfidenceDeltaAfterUpdate)}</td>
                          <td className="mono">{fmtTime(row.lastRecordedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className="panel">
                <div className="head"><h3>Recent Shadow Audits</h3><p>Latest before/after comparisons against default and updated weights.</p></div>
                <div className="body scroll-x">
                  <table>
                    <thead><tr><th>When</th><th>Domain</th><th>Run</th><th>Policy</th><th>Baseline</th><th>Decision</th><th>After Update</th><th>Δ vs Default</th><th>Δ After Update</th></tr></thead>
                    <tbody>
                      {recentAudits.length === 0 ? <tr><td colSpan="9" className="muted">No shadow audits yet.</td></tr> : recentAudits.map((row, idx) => (
                        <tr key={String(row.domain || 'audit') + '_' + idx}>
                          <td className="mono">{fmtTime(row.createdAt)}</td>
                          <td>{row.domain || '-'}</td>
                          <td>{row.runId || '-'}</td>
                          <td>{row.policyVersion || '-'}</td>
                          <td>{row.baselineDirection || '-'}</td>
                          <td>{row.decisionDirection || '-'}</td>
                          <td>{row.activeDirectionAfter || '-'}</td>
                          <td className="mono">{confidenceDelta(row.confidenceDeltaVsDefault)}</td>
                          <td className="mono">{confidenceDelta(row.confidenceDeltaAfterUpdate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            </section>
          </div>
        );
      }

      function App() {
        const [mode, setMode] = useState('paper');
        const [timeframe, setTimeframe] = useState('all');
        const [period, setPeriod] = useState('30d');
        const [from, setFrom] = useState('');
        const [to, setTo] = useState('');
        const [data, setData] = useState(null);
        const [loading, setLoading] = useState(false);
        const [error, setError] = useState('');
        const [lastSync, setLastSync] = useState('');
        const [tab, setTab] = useState('overview');

        const query = useMemo(() => {
          const params = new URLSearchParams();
          params.set('mode', mode);
          params.set('timeframe', timeframe);
          if (timeframe === 'period') params.set('period', period);
          if (timeframe === 'custom') {
            if (from) params.set('from', new Date(from).toISOString());
            if (to) params.set('to', new Date(to).toISOString());
          }
          return params.toString();
        }, [mode, timeframe, period, from, to]);

        async function load() {
          setLoading(true);
          setError('');
          try {
            const res = await fetch('/api/dashboard?' + query, { headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const payload = await res.json();
            setData(payload);
            setLastSync(new Date().toISOString());
          } catch (err) {
            setError(err && err.message ? String(err.message) : 'Failed to load dashboard');
          } finally {
            setLoading(false);
          }
        }

        useEffect(() => { load(); }, [query]);
        useEffect(() => {
          const id = setInterval(load, 30000);
          return () => clearInterval(id);
        }, [query]);

        const sections = data && data.sections ? data.sections : {};
        const meta = data && data.meta ? data.meta : {};
        const equity = sections.equityCurve || { points: [], summary: {} };
        const openPositions = sections.openPositions || { rows: [], summary: {} };
        const tradeLog = sections.tradeLog || { rows: [] };
        const promotion = sections.promotionGates || { rows: [] };
        const policy = sections.policyState || {};
        const perf = sections.performanceBreakdown || {};
        const predictionAccuracy = sections.predictionAccuracy || { global: [], byDomain: {}, totalFinalPredictions: 0 };
        const learningAudit = sections.learningAudit || { comparable: { totalCaseCount: 0, byDomain: [] }, execution: { totalCaseCount: 0, byDomain: [] }, exclusions: { totalCaseCount: 0, byReason: [] }, policyOutputs: [] };
        const learningObservability = sections.learningObservability || { runtimeContext: {}, activeWeights: [], totalShadowAudits: 0, runSummaries: [], recentAudits: [] };

        const chartPoints = Array.isArray(equity.points)
          ? equity.points.map((p) => ({ ...p, tsLabel: new Date(p.timestamp).toLocaleString() }))
          : [];

        return (
          <div>
            <header className="hero">
              <div className="title-wrap">
                <h1>Thufir Dashboard</h1>
                <p>Desert sunset control room for paper/live execution quality and promotion readiness.</p>
              </div>
              <div className="stamp">
                <div><strong>Generated:</strong> {fmtTime(meta.generatedAt)}</div>
                <div><strong>Refreshed:</strong> {lastSync ? fmtTime(lastSync) : '-'}</div>
              </div>
            </header>

            {error ? <div className="error">{error}</div> : null}

            <section className="filters">
              <div className="filter"><label>Mode</label><select value={mode} onChange={(e) => setMode(e.target.value)}><option value="paper">Paper</option><option value="live">Live</option><option value="combined">Combined</option></select></div>
              <div className="filter"><label>Timeframe</label><select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}><option value="all">Total</option><option value="day">Day</option><option value="period">Period</option><option value="custom">Custom</option></select></div>
              <div className="filter"><label>Period</label><select value={period} disabled={timeframe !== 'period'} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
              <div className="filter"><label>From</label><input type="datetime-local" value={from} disabled={timeframe !== 'custom'} onChange={(e) => setFrom(e.target.value)} /></div>
              <div className="filter"><label>To</label><input type="datetime-local" value={to} disabled={timeframe !== 'custom'} onChange={(e) => setTo(e.target.value)} /></div>
            </section>

            <section className="tabs" aria-label="Dashboard tabs">
              <button type="button" className={tab === 'overview' ? 'tab-btn active' : 'tab-btn'} onClick={() => setTab('overview')}>Overview</button>
              <button type="button" className={tab === 'learning' ? 'tab-btn active' : 'tab-btn'} onClick={() => setTab('learning')}>Learning</button>
            </section>

            {tab === 'overview' ? (
              <div>
            <section className="kpi-grid">
              <div className="kpi"><div className="label">Account Equity</div><div className="value mono">{money(equity.summary?.endEquity)}</div><div className="sub">Start {money(equity.summary?.startEquity)}</div></div>
              <div className="kpi"><div className="label">Return</div><div className="value mono">{pct(equity.summary?.returnPct)}</div><div className="sub">Max DD {pct(equity.summary?.maxDrawdownPct)}</div></div>
              <div className="kpi"><div className="label">Open PnL</div><div className="value mono">{money(openPositions.summary?.totalUnrealizedPnlUsd)}</div><div className="sub">Long {num(openPositions.summary?.longCount, 0)} / Short {num(openPositions.summary?.shortCount, 0)}</div></div>
              <div className="kpi"><div className="label">Records</div><div className="value mono">{num(meta.recordCounts?.journals, 0)} journals</div><div className="sub">{num(meta.recordCounts?.perpTrades, 0)} trades | {num(meta.recordCounts?.alerts, 0)} alerts</div></div>
            </section>

            <section className="grid">
              <article className="panel">
                <div className="head"><h3>Equity Curve</h3><p>Cash + unrealized PnL over the selected window.</p></div>
                <div className="body"><div className="chart-wrap">
                  {hasRecharts ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartPoints} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f59d43" stopOpacity="0.44" /><stop offset="95%" stopColor="#d86a2b" stopOpacity="0.04" /></linearGradient>
                        </defs>
                        <CartesianGrid stroke="rgba(245,217,183,0.10)" strokeDasharray="3 3" />
                        <XAxis dataKey="tsLabel" tick={{ fill: '#cbbba7', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'rgba(245,217,183,0.25)' }} minTickGap={40} />
                        <YAxis tick={{ fill: '#cbbba7', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'rgba(245,217,183,0.25)' }} width={70} tickFormatter={(v) => '$' + Number(v).toFixed(0)} />
                        <Tooltip contentStyle={{ background: 'rgba(8,18,35,0.95)', border: '1px solid rgba(245,217,183,0.25)', borderRadius: '10px', color: '#f4e8d8' }} formatter={(v, n) => [money(v), n]} labelFormatter={(v) => String(v)} />
                        <Area type="monotone" dataKey="equity" stroke="#f5d9b7" strokeWidth={2.4} fill="url(#eqFill)" dot={false} isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <EquityChartFallback points={chartPoints} />
                  )}
                </div></div>
              </article>

              <article className="panel">
                <div className="head"><h3>Policy State</h3><p>Execution guardrails and operating constraints.</p></div>
                <div className="body">
                  <div className="policy-grid">
                    <div className="policy-card"><div className="k">Observation</div><div className="v">{policy.observationMode ? 'ON' : 'OFF'}</div></div>
                    <div className="policy-card"><div className="k">Leverage Cap</div><div className="v mono">{policy.leverageCap == null ? '-' : num(policy.leverageCap, 2) + 'x'}</div></div>
                    <div className="policy-card"><div className="k">DD Cap Left</div><div className="v mono">{money(policy.drawdownCapRemainingUsd)}</div></div>
                    <div className="policy-card"><div className="k">Trades Left</div><div className="v mono">{policy.tradesRemainingToday == null ? '-' : num(policy.tradesRemainingToday, 0)}</div></div>
                    <div className="policy-card"><div className="k">Updated</div><div className="v small">{fmtTime(policy.updatedAt)}</div></div>
                  </div>
                  <div className="footer-note">Auto-refresh every 30s. Use mode/time filters to isolate paper vs live behavior.</div>
                </div>
              </article>
            </section>

            <section className="grid">
              <article className="panel">
                <div className="head"><h3>Open Positions</h3><p>Live mark-to-market status of open risk.</p></div>
                <div className="body scroll-x">
                  <table>
                    <thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Current</th><th>Size</th><th>Unrealized</th><th>Held</th></tr></thead>
                    <tbody>
                      {(openPositions.rows || []).length === 0 ? <tr><td colSpan="7" className="muted">No open positions.</td></tr> : (openPositions.rows || []).map((row) => (
                        <tr key={row.symbol + row.openedAt}><td>{row.symbol}</td><td><span className={row.side === 'long' ? 'pill good' : 'pill bad'}>{row.side}</span></td><td className="mono">{money(row.entryPrice)}</td><td className="mono">{money(row.currentPrice)}</td><td className="mono">{num(row.size, 4)}</td><td className="mono">{money(row.unrealizedPnlUsd)}</td><td className="mono">{Math.floor((row.heldSeconds || 0) / 3600) < 24 ? (Math.floor((row.heldSeconds || 0) / 3600) + 'h') : (Math.floor((row.heldSeconds || 0) / 86400) + 'd ' + Math.floor(((row.heldSeconds || 0) % 86400) / 3600) + 'h')}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className="panel">
                <div className="head"><h3>Signal Performance</h3><p>Calibration lenses by signal, regime, and session.</p></div>
                <div className="body perf-grid">
                  <div className="perf-box"><div className="small muted" style={{ marginBottom: '6px' }}>By Signal Class</div><PerfTable rows={perf.bySignalClass || []} /></div>
                  <div className="perf-box"><div className="small muted" style={{ marginBottom: '6px' }}>By Regime</div><PerfTable rows={perf.byRegime || []} /></div>
                  <div className="perf-box"><div className="small muted" style={{ marginBottom: '6px' }}>By Session</div><PerfTable rows={perf.bySession || []} /></div>
                </div>
              </article>
            </section>

            <section className="grid">
              <article className="panel">
                <div className="head"><h3>Trade Log with Component Scores</h3><p>Most recent learning loop entries and quality labels.</p></div>
                <div className="body scroll-x">
                  <table>
                    <thead><tr><th>Closed</th><th>Symbol</th><th>Side</th><th>Signal</th><th>D</th><th>T</th><th>S</th><th>X</th><th>PnL</th><th>R</th><th>Thesis</th><th>Quality</th></tr></thead>
                    <tbody>
                      {(tradeLog.rows || []).length === 0 ? <tr><td colSpan="12" className="muted">No trade log rows.</td></tr> : (tradeLog.rows || []).map((row, idx) => (
                        <tr key={String(row.tradeId) + '_' + idx}><td className="mono">{fmtTime(row.closedAt)}</td><td>{row.symbol}</td><td>{row.side || '-'}</td><td>{row.signalClass || 'unknown'}</td><td className="mono">{num(row.directionScore, 2)}</td><td className="mono">{num(row.timingScore, 2)}</td><td className="mono">{num(row.sizingScore, 2)}</td><td className="mono">{num(row.exitScore, 2)}</td><td className="mono">{money(typeof row.realizedPnlUsd === 'number' ? row.realizedPnlUsd : null)}</td><td className="mono">{num(row.rCaptured, 3)}</td><td>{row.thesisCorrect == null ? '-' : row.thesisCorrect ? 'yes' : 'no'}</td><td><span className={scorePillClass(row.qualityBand)}>{row.qualityBand}</span></td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className="panel">
                <div className="head"><h3>Promotion Gate Status</h3><p>Setup readiness by sample size, expectancy, hit-rate, and drawdown gates.</p></div>
                <div className="body scroll-x">
                  <table>
                    <thead><tr><th>Setup Key</th><th>Samples</th><th>Hit Rate</th><th>Expectancy R</th><th>Payoff</th><th>DD R</th><th>Promoted</th></tr></thead>
                    <tbody>
                      {(promotion.rows || []).length === 0 ? <tr><td colSpan="7" className="muted">No promotion gate rows.</td></tr> : (promotion.rows || []).map((row) => (
                        <tr key={row.setupKey}><td>{row.setupKey}</td><td className="mono">{num(row.sampleCount, 0)}</td><td className="mono">{pct((row.hitRate || 0) * 100)}</td><td className="mono">{num(row.expectancyR, 3)}</td><td className="mono">{num(row.payoffRatio, 3)}</td><td className="mono">{num(row.maxDrawdownR, 3)}</td><td><span className={row.promoted ? 'pill good' : 'pill bad'}>{row.promoted ? 'yes' : 'no'}</span></td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            </section>

            <div className="footer-note">{loading ? 'Loading latest dashboard snapshot...' : 'Snapshot loaded.'}</div>
              </div>
            ) : (
              <LearningTab
                observability={learningObservability}
                predictionAccuracy={predictionAccuracy}
                learningAudit={learningAudit}
              />
            )}
          </div>
        );
      }

      try {
        const mountEl = document.getElementById('app');
        if (!mountEl) {
          throw new Error('Missing #app mount element');
        }
        if (window.ReactDOM && typeof window.ReactDOM.createRoot === 'function') {
          window.ReactDOM.createRoot(mountEl).render(<App />);
        } else if (window.ReactDOM && typeof window.ReactDOM.render === 'function') {
          window.ReactDOM.render(<App />, mountEl);
        } else {
          throw new Error('ReactDOM renderer unavailable');
        }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        window.__dashboardShowBootError && window.__dashboardShowBootError(msg);
      }
    </script>
  </body>
</html>`;
}

export function resolveDashboardDistDir(params?: {
  envPath?: string;
  moduleDir?: string;
  exists?: (path: string) => boolean;
}): string {
  const exists = params?.exists ?? existsSync;
  const envPath = String(params?.envPath ?? process.env.THUFIR_DASHBOARD_DIST_PATH ?? '').trim();
  if (envPath) {
    return envPath;
  }

  const moduleDir = params?.moduleDir ?? fileURLToPath(new URL('.', import.meta.url));
  const compiledDistDir = join(moduleDir, 'dashboard-dist');
  const projectRoot = dirname(dirname(moduleDir));
  const sourceDistDir = join(projectRoot, 'src', 'gateway', 'dashboard-dist');
  return exists(compiledDistDir) ? compiledDistDir : sourceDistDir;
}

export function handleDashboardPageRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  if (path !== '/dashboard' && path !== '/dashboard/' && !path.startsWith('/dashboard/')) {
    return false;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return true;
  }

  const distDir = resolveDashboardDistDir();
  const indexPath = join(distDir, 'index.html');
  if (existsSync(indexPath)) {
    if (path.startsWith('/dashboard/assets/')) {
      const relative = path.slice('/dashboard/'.length);
      const assetPath = normalize(join(distDir, relative));
      if (!assetPath.startsWith(distDir) || !existsSync(assetPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return true;
      }
      const contentType =
        extname(assetPath) === '.js'
          ? 'text/javascript; charset=utf-8'
          : extname(assetPath) === '.css'
            ? 'text/css; charset=utf-8'
            : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(readFileSync(assetPath));
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(readFileSync(indexPath, 'utf-8'));
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(buildDashboardHtml());
  return true;
}
