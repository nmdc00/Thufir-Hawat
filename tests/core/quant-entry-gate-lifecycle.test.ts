import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExpressionPlan, SignalCluster } from '../../src/discovery/types.js';
import type { EntryGateCandidate } from '../../src/core/llm_entry_gate.js';

// Synthetic fixture matching the observed META shape; never copied production memory.
const fixture = vi.hoisted(() => ({ expression: null as unknown as ExpressionPlan, cluster: null as unknown as SignalCluster }));
vi.mock('../../src/discovery/engine.js', () => ({ runDiscovery: async () => ({
  expressions: [fixture.expression], clusters: [fixture.cluster], hypotheses: [],
}) }));
vi.mock('../../src/execution/perp-risk.js', () => ({ checkPerpRiskLimits: async () => ({ allowed: true }) }));
const execute = vi.hoisted(() => vi.fn(async () => { throw new Error('No trade execution allowed in this test'); }));
vi.mock('../../src/core/tool-executor.js', () => ({ executeToolCall: execute }));
// Freeze non-target policy/sizing, keeping manager, gate, book, journals and SQLite real.
vi.mock('../../src/core/autonomy_policy.js', () => ({
  applyReflectionMutation: () => ({ mutated: false }), classifyMarketRegime: () => 'high_vol_expansion',
  classifySignalClass: () => 'mean_reversion', computeFractionalKellyFraction: () => 0.25,
  evaluateGlobalTradeGate: () => ({ allowed: true }), evaluateNewsEntryGate: () => ({ allowed: true }),
  isSignalClassAllowedForRegime: () => true, resolveLiquidityBucket: () => 'thin', resolveVolatilityBucket: () => 'medium',
}));
import { openDatabase, closeDatabase } from '../../src/memory/db.js';
import { LlmEntryGate } from '../../src/core/llm_entry_gate.js';
import { enrichQuantEntryGateCandidate } from '../../src/core/quant_entry_gate.js';
import { AutonomousManager } from '../../src/core/autonomous.js';
import { listPerpTradeJournals } from '../../src/memory/perp_trade_journal.js';
import { enrichExpressionContextPack } from '../../src/discovery/expressions.js';

let directory: string;
let previous: string | undefined;
const config = { execution: { mode: 'paper' }, paper: { initialCashUsdc: 200 },
  hyperliquid: { maxLeverage: 50, minOrderNotionalUsd: 10 },
  autonomy: { enabled: true, fullAuto: true, minEdge: 0.05, maxTradesPerScan: 1,
    exposure: { enabled: false }, llmEntryGate: { gateCooldownMinutes: 0 } } } as any;
const original: EntryGateCandidate = { symbol: 'XYZ:META', side: 'buy', notionalUsd: 10,
  leverage: 1, leverageMax: 50, edge: 0.0707, confidence: 0.96,
  signalClass: 'mean_reversion', regime: 'high_vol_expansion', session: 'us_close',
  entryReasoning: 'Continuation within hours', invalidationPrice: 634.3794,
  stopProvenance: 'mechanical_fallback' };
const reject = { verdict: 'reject', reasonCode: 'insufficient_data',
  reasoning: 'No supported target or exit basis; fallback stop is not a thesis.',
  stopLevelPrice: 634.3794, equityAtRiskPct: 1.5, targetRR: null };
const book = { hasConflict: () => false, hasPosition: () => false, getAll: () => [] } as any;
const row = () => openDatabase().prepare('SELECT * FROM llm_entry_gate_log ORDER BY id DESC LIMIT 1').get() as any;

beforeEach(() => {
  previous = process.env.THUFIR_DB_PATH;
  directory = mkdtempSync(join(tmpdir(), 'quant-gate-test-'));
  process.env.THUFIR_DB_PATH = join(directory, 'test.sqlite');
  fixture.expression = { id: 'expr_meta', hypothesisId: 'hyp_meta', symbol: 'XYZ:META/USDT',
    side: 'buy', confidence: 0.92, expectedEdge: 0.0707, entryZone: 'market',
    invalidation: 'Price breaks recent extremes', expectedMove: 'Continuation within hours',
    orderType: 'market', leverage: 1, probeSizeUsd: 10, liquidityBucket: 'thin', newsTrigger: null };
  fixture.cluster = { id: 'cluster_meta', symbol: 'XYZ:META/USDT', directionalBias: 'neutral',
    confidence: 0.92, timeHorizon: 'hours', signals: [
      { id: 'price', kind: 'price_vol_regime', symbol: 'XYZ:META/USDT', directionalBias: 'down',
        confidence: 1, timeHorizon: 'hours', metrics: { trend: -0.026, volZ: 1.07 } },
      { id: 'cross', kind: 'cross_asset_divergence', symbol: 'XYZ:META/USDT', directionalBias: 'up',
        confidence: 0.83, timeHorizon: 'hours', metrics: { divergence: 0.083 } },
    ] };
  execute.mockClear();
});
afterEach(() => {
  closeDatabase();
  if (previous === undefined) delete process.env.THUFIR_DB_PATH;
  else process.env.THUFIR_DB_PATH = previous;
  rmSync(directory, { recursive: true, force: true });
  expect(existsSync(directory)).toBe(false);
});

async function evaluate(candidate: EntryGateCandidate, response = reject) {
  const complete = vi.fn(async () => ({ content: JSON.stringify(response) }));
  const fail = { complete: async () => { throw new Error('Unexpected fallback'); } };
  const gate = new LlmEntryGate({ complete } as any, fail as any, async () => {}, book, config);
  const result = await gate.evaluate(candidate, 644.04);
  expect(complete).toHaveBeenCalledOnce();
  expect(row().llm_consulted).toBe(1);
  expect(row().used_fallback).toBe(0);
  return { result, prompt: complete.mock.calls[0]![0] as any };
}

describe('quant gate evidence lifecycle', () => {
  it('replays original/enriched/control through real gate and persists unknown versus calculated risk', async () => {
    const a = await evaluate(original);
    const enriched = enrichQuantEntryGateCandidate(original, fixture.expression, fixture.cluster, Date.now());
    const b = await evaluate(enriched);
    const control = await evaluate({ ...enriched, expectedRMultiple: 2.5, suggestedTtlMinutes: 90, accountEquityUsd: 200 });
    const prompt = (r: typeof a) => JSON.stringify(r.prompt);
    expect(prompt(a)).toContain('Liquidity bucket: unknown');
    expect(prompt(a)).not.toMatch(/undefinedR|undefinedmin/);
    expect(prompt(b)).toContain('Liquidity bucket: thin');
    expect(prompt(b)).toContain('Trend bias: down');
    expect(prompt(b)).toContain('cross_asset_divergence');
    expect(prompt(b)).toContain('Execution score: unknown');
    expect(prompt(b)).toContain('mechanical_fallback');
    expect(prompt(control)).toContain('2.50R');
    expect(prompt(control)).toContain('90min');
    expect(a.result.verdict).toBe('reject');
    expect(b.result.verdict).toBe('reject');
    expect(a.result.equityAtRiskPct).toBeNull();
    expect(control.result.equityAtRiskPct).toBeCloseTo(0.075, 8);
    expect(row()).toMatchObject({ reason_code: 'insufficient_data', model_equity_at_risk_pct: 1.5,
      risk_source: 'calculated', account_equity_usd: 200, stop_provenance: 'mechanical_fallback', missing_plan_fields: '[]' });
  });

  it('preserves the model resize decision and recomputes final-stop risk without leverage double count', async () => {
    const response = { verdict: 'resize', reasoning: 'SYNTHETIC supported qualitative exit basis', reasonCode: 'size_downshift',
      adjustedSizeUsd: 5, stopLevelPrice: 630, equityAtRiskPct: 99, targetRR: null, suggestedLeverage: 3 };
    const { result } = await evaluate({ ...original, leverage: 10, accountEquityUsd: 100 }, response as any);
    expect(result.verdict).toBe('resize');
    expect(result.equityAtRiskPct).toBeCloseTo(5 * (644.04 - 630) / 644.04, 10);
    expect(row()).toMatchObject({ adjusted_size_usd: 5, stop_level_price: 630, stop_provenance: 'model_proposed',
      target_rr: null, model_equity_at_risk_pct: 99, missing_plan_fields: '["expectedRMultiple","suggestedTtlMinutes"]' });
  });

  it('persists the same scripted approval control with original and enriched inputs', async () => {
    const response = { ...reject, verdict: 'approve', reasonCode: 'approve', equityAtRiskPct: null,
      reasoning: 'SYNTHETIC qualitative exit basis supported; numeric target and TTL remain unknown', suggestedLeverage: 1 };
    for (const candidate of [original, enrichQuantEntryGateCandidate(original, fixture.expression, fixture.cluster, Date.now())]) {
      const { result } = await evaluate(candidate, response as any);
      expect(result.verdict).toBe('approve');
      expect(result.targetRR).toBeNull();
      expect(result.equityAtRiskPct).toBeNull();
      expect(row().missing_plan_fields).toBe('["expectedRMultiple","suggestedTtlMinutes"]');
    }
  });

  it('calculates short stop risk from exposure and keeps invalid geometry unavailable', async () => {
    const candidate = { ...original, side: 'sell' as const, invalidationPrice: 650, accountEquityUsd: 200 };
    const { result } = await evaluate(candidate, { ...reject, stopLevelPrice: 650 });
    expect(result.equityAtRiskPct).toBeCloseTo(10 * (650 - 644.04) / 644.04 / 200 * 100, 10);
    const complete = vi.fn();
    const gate = new LlmEntryGate({ complete } as any, {} as any, async () => {}, book, config);
    const invalid = await gate.evaluate({ ...candidate, invalidationPrice: 630 }, 644.04);
    expect(invalid.reasonCode).toBe('invalid_leverage_geometry');
    expect(invalid.equityAtRiskPct).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    expect(row().risk_source).toBe('unavailable');
  });

  it.each([undefined, null, 0, -1, NaN])('keeps unavailable equity %s distinct from zero', async equity => {
    const { result } = await evaluate({ ...original, accountEquityUsd: equity });
    expect(result.equityAtRiskPct).toBeNull();
    expect(row().risk_source).toBe('unavailable');
  });

  it('transports source event data without turning event expiry into thesis TTL or inventing publication time', () => {
    fixture.expression.newsTrigger = { enabled: true, expiresAtMs: Date.now() + 60_000, sources: [{ source: 'test' }] };
    let candidate = enrichQuantEntryGateCandidate(original, fixture.expression, fixture.cluster, Date.now());
    expect(candidate.suggestedTtlMinutes).toBeUndefined();
    expect(candidate.expectedRMultiple).toBeUndefined();
    expect(candidate.catalystTimestamp).toBeUndefined();
    fixture.expression.newsTrigger.sources![0]!.publishedAtMs = 1000;
    candidate = enrichQuantEntryGateCandidate(original, fixture.expression, fixture.cluster, Date.now());
    expect(candidate.catalystTimestamp).toBe(new Date(1000).toISOString());
  });

  it('runs actual quant caller -> gate -> real normalized log and blocked journal, preserving discovery unknowns', async () => {
    fixture.expression = await enrichExpressionContextPack({ expression: fixture.expression, cluster: fixture.cluster,
      hypothesis: { id: 'hyp_meta', clusterId: 'cluster_meta', pressureSource: 'Crowded positioning (technical hypothesis)',
        expectedExpression: 'Continuation within hours', timeHorizon: 'hours', invalidation: 'Recent extremes', tradeMap: 'Contrarian', riskNotes: [] },
      providers: { executionQuality: () => ({ score: null, status: 'unknown' }) },
    });
    expect(fixture.expression.contextPack!.executionQuality.score).toBeNull();
    const noLiquidity = { ...fixture.expression, liquidityBucket: undefined };
    expect(enrichQuantEntryGateCandidate(original, noLiquidity, fixture.cluster, Date.now()).marketContext!.liquidityBucket).toBe('unknown');
    const complete = vi.fn(async () => ({ content: JSON.stringify(reject) }));
    const manager = new AutonomousManager({ complete } as any, { complete } as any,
      { getMarket: async () => ({ symbol: 'XYZ:META', markPrice: 644.04, metadata: { maxLeverage: 50 } }) } as any,
      { execute: execute } as any, { getRemainingDaily: () => 100 } as any, config);
    await (manager as any).runDiscoveryScan({ executeTrades: true });
    expect(complete).toHaveBeenCalledOnce();
    const prompt = JSON.stringify(complete.mock.calls[0]);
    expect(prompt).toContain('Liquidity bucket: thin');
    expect(prompt).toContain('Trend bias: down');
    expect(prompt).toContain('Crowded positioning');
    expect(prompt).toContain('mechanical_fallback');
    expect(prompt).not.toMatch(/undefinedR|undefinedmin/);
    expect(row()).toMatchObject({ verdict: 'reject', reason_code: 'insufficient_data', liquidity_bucket: 'thin',
      execution_score: null, risk_source: 'calculated', account_equity_usd: 200 });
    const journals = listPerpTradeJournals({ limit: 5 });
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({ symbol: 'XYZ:META', outcome: 'blocked', execution_mode: 'paper',
      hypothesisId: 'hyp_meta', entryGateVerdict: row().verdict, entryGateReasonCode: row().reason_code });
    expect(execute).not.toHaveBeenCalled();
  });
});
