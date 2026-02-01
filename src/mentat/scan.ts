import type { LlmClient } from '../core/llm.js';
import type { Market, PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { listRecentIntel } from '../intel/store.js';
import { upsertAssumption, upsertMechanism, upsertFragilityCard } from '../memory/mentat.js';

import {
  type MentatAssumptionInput,
  type MentatMechanismInput,
  type MentatFragilityCardInput,
  type MentatScanOutput,
  type MentatSignals,
  type SystemMap,
} from './types.js';
import { computeDetectorBundle, summarizeSignals } from './detectors.js';

interface MentatScanOptions {
  system: string;
  llm: LlmClient;
  marketClient: PolymarketMarketClient;
  marketIds?: string[];
  marketQuery?: string;
  limit?: number;
  intelLimit?: number;
  store?: boolean;
}

interface MentatLlmResponse {
  system_map?: SystemMap;
  assumptions?: MentatAssumptionInput[];
  mechanisms?: MentatMechanismInput[];
  fragility_cards?: MentatFragilityCardInput[];
  irreversibility?: number;
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => String(item)).filter((item) => item.length > 0);
}

function parseJsonBlock(content: string): MentatLlmResponse | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as MentatLlmResponse;
  } catch {
    return null;
  }
}

function normalizeSystemMap(raw?: SystemMap): SystemMap {
  return {
    nodes: Array.isArray(raw?.nodes) ? raw?.nodes.map((node) => String(node)) : [],
    edges: Array.isArray(raw?.edges)
      ? raw.edges
          .map((edge) => ({
            from: String(edge?.from ?? ''),
            to: String(edge?.to ?? ''),
            relation: String(edge?.relation ?? ''),
          }))
          .filter((edge) => edge.from && edge.to && edge.relation)
      : [],
  };
}

function normalizeAssumptions(raw: MentatAssumptionInput[] | undefined, now: string): MentatAssumptionInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((assumption) => ({
      statement: String(assumption.statement ?? '').trim(),
      dependencies: asStringArray(assumption.dependencies) ?? [],
      evidence_for: asStringArray(assumption.evidence_for) ?? [],
      evidence_against: asStringArray(assumption.evidence_against) ?? [],
      stress_score: assumption.stress_score == null ? null : clamp(Number(assumption.stress_score)),
      last_tested: assumption.last_tested ? String(assumption.last_tested) : now,
    }))
    .filter((assumption) => assumption.statement.length > 0);
}

function normalizeMechanisms(raw: MentatMechanismInput[] | undefined): MentatMechanismInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((mechanism) => ({
      name: String(mechanism.name ?? '').trim(),
      causal_chain: asStringArray(mechanism.causal_chain) ?? [],
      trigger_class: mechanism.trigger_class ? String(mechanism.trigger_class) : null,
      propagation_path: asStringArray(mechanism.propagation_path) ?? [],
    }))
    .filter((mechanism) => mechanism.name.length > 0);
}

function normalizeFragilityCards(raw: MentatFragilityCardInput[] | undefined): MentatFragilityCardInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((card) => ({
      mechanism: String(card.mechanism ?? '').trim(),
      exposure_surface: String(card.exposure_surface ?? '').trim(),
      convexity: card.convexity ? String(card.convexity) : null,
      early_signals: asStringArray(card.early_signals) ?? [],
      falsifiers: asStringArray(card.falsifiers) ?? [],
      downside: card.downside ? String(card.downside) : null,
      recovery_capacity: card.recovery_capacity ? String(card.recovery_capacity) : null,
      score: card.score == null ? null : clamp(Number(card.score)),
    }))
    .filter((card) => card.mechanism.length > 0 && card.exposure_surface.length > 0);
}

function mergeSystemMaps(maps: SystemMap[]): SystemMap {
  const nodes = new Set<string>();
  const edges: SystemMap['edges'] = [];
  for (const map of maps) {
    for (const node of map.nodes ?? []) {
      nodes.add(node);
    }
    for (const edge of map.edges ?? []) {
      if (!edge?.from || !edge?.to || !edge?.relation) continue;
      const key = `${edge.from}|${edge.to}|${edge.relation}`;
      if (!edges.some((e) => `${e.from}|${e.to}|${e.relation}` === key)) {
        edges.push(edge);
      }
    }
  }
  return { nodes: Array.from(nodes), edges };
}

function mergeAssumptions(items: MentatAssumptionInput[]): MentatAssumptionInput[] {
  const byStatement = new Map<string, MentatAssumptionInput>();
  for (const item of items) {
    const key = item.statement.toLowerCase();
    const existing = byStatement.get(key);
    if (!existing) {
      byStatement.set(key, { ...item });
      continue;
    }
    const merged: MentatAssumptionInput = {
      statement: existing.statement,
      dependencies: Array.from(new Set([...(existing.dependencies ?? []), ...(item.dependencies ?? [])])),
      evidence_for: Array.from(new Set([...(existing.evidence_for ?? []), ...(item.evidence_for ?? [])])),
      evidence_against: Array.from(new Set([...(existing.evidence_against ?? []), ...(item.evidence_against ?? [])])),
      stress_score: Math.max(existing.stress_score ?? 0, item.stress_score ?? 0),
      last_tested: [existing.last_tested, item.last_tested].filter(Boolean).sort().slice(-1)[0],
    };
    byStatement.set(key, merged);
  }
  return Array.from(byStatement.values());
}

function mergeMechanisms(items: MentatMechanismInput[]): MentatMechanismInput[] {
  const byName = new Map<string, MentatMechanismInput>();
  for (const item of items) {
    const key = item.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { ...item });
      continue;
    }
    const merged: MentatMechanismInput = {
      name: existing.name,
      causal_chain: Array.from(new Set([...(existing.causal_chain ?? []), ...(item.causal_chain ?? [])])),
      trigger_class: existing.trigger_class ?? item.trigger_class ?? null,
      propagation_path: Array.from(new Set([...(existing.propagation_path ?? []), ...(item.propagation_path ?? [])])),
    };
    byName.set(key, merged);
  }
  return Array.from(byName.values());
}

function mergeFragilityCards(items: MentatFragilityCardInput[]): MentatFragilityCardInput[] {
  const byKey = new Map<string, MentatFragilityCardInput>();
  for (const item of items) {
    const key = `${item.mechanism.toLowerCase()}|${item.exposure_surface.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item });
      continue;
    }
    const merged: MentatFragilityCardInput = {
      mechanism: existing.mechanism,
      exposure_surface: existing.exposure_surface,
      convexity: existing.convexity ?? item.convexity ?? null,
      early_signals: Array.from(new Set([...(existing.early_signals ?? []), ...(item.early_signals ?? [])])),
      falsifiers: Array.from(new Set([...(existing.falsifiers ?? []), ...(item.falsifiers ?? [])])),
      downside: existing.downside ?? item.downside ?? null,
      recovery_capacity: existing.recovery_capacity ?? item.recovery_capacity ?? null,
      score: Math.max(existing.score ?? 0, item.score ?? 0),
    };
    byKey.set(key, merged);
  }
  return Array.from(byKey.values());
}

function renderMarketSnapshot(markets: Market[], limit = 12): string {
  const sorted = [...markets].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  const slice = sorted.slice(0, limit);
  return JSON.stringify(
    slice.map((market) => ({
      id: market.id,
      question: market.question,
      category: market.category ?? null,
      volume: market.volume ?? null,
      liquidity: market.liquidity ?? null,
      prices: market.prices,
      endDate: market.endDate ?? null,
      negRisk: market.negRisk ?? null,
    })),
    null,
    2
  );
}

function renderIntelSnapshot(intel: { title: string; source: string; timestamp: string }[], limit = 12): string {
  return JSON.stringify(intel.slice(0, limit), null, 2);
}

function buildMentatPrompt(
  system: string,
  signalsSummary: Record<string, unknown>,
  markets: Market[],
  intel: { title: string; source: string; timestamp: string }[],
  now: string,
  roleInstruction?: string
): string {
  return [
    `You are running the mentat fragility scan for system: ${system}.`,
    roleInstruction ? `Role focus: ${roleInstruction}` : '',
    '',
    'Return JSON only. No commentary. Use this shape:',
    '{',
    '  "system_map": { "nodes": ["..."], "edges": [{"from":"...","to":"...","relation":"..."}] },',
    '  "assumptions": [{"statement":"...","dependencies":["..."],"evidence_for":["..."],"evidence_against":["..."],"stress_score":0.0,"last_tested":"ISO"}],',
    '  "mechanisms": [{"name":"...","causal_chain":["..."],"trigger_class":"...","propagation_path":["..."]}],',
    '  "fragility_cards": [{"mechanism":"...","exposure_surface":"...","convexity":"...","early_signals":["..."],"falsifiers":["..."],"downside":"...","recovery_capacity":"...","score":0.0}],',
    '  "irreversibility": 0.0',
    '}',
    '',
    `Current time: ${now}`,
    '',
    'Signals summary:',
    JSON.stringify(signalsSummary, null, 2),
    '',
    'Market snapshot (top by volume):',
    renderMarketSnapshot(markets),
    '',
    'Recent intel snapshot:',
    renderIntelSnapshot(intel),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function collectMentatSignals(options: {
  system: string;
  marketClient: PolymarketMarketClient;
  marketIds?: string[];
  marketQuery?: string;
  limit?: number;
  intelLimit?: number;
}): Promise<MentatSignals> {
  const limit = Math.max(1, Math.min(Number(options.limit ?? 25), 200));
  let markets: Market[] = [];

  if (options.marketIds && options.marketIds.length > 0) {
    const fetched: Market[] = [];
    for (const id of options.marketIds) {
      try {
        fetched.push(await options.marketClient.getMarket(id));
      } catch {
        // Skip missing markets
      }
    }
    markets = fetched;
  } else if (options.marketQuery) {
    markets = await options.marketClient.searchMarkets(options.marketQuery, limit);
  } else {
    markets = await options.marketClient.listMarkets(limit);
  }

  const intelLimit = Math.max(1, Math.min(Number(options.intelLimit ?? 40), 200));
  const intel = listRecentIntel(intelLimit);

  return {
    system: options.system,
    markets,
    intel,
    generatedAt: new Date().toISOString(),
  };
}

export async function runMentatScan(options: MentatScanOptions): Promise<MentatScanOutput> {
  const now = new Date().toISOString();
  const signals = await collectMentatSignals({
    system: options.system,
    marketClient: options.marketClient,
    marketIds: options.marketIds,
    marketQuery: options.marketQuery,
    limit: options.limit,
    intelLimit: options.intelLimit,
  });

  const signalsSummary = summarizeSignals(signals.markets, signals.intel);
  const detectors = computeDetectorBundle(signals);

  const rolePrompts = [
    {
      role: 'Cartographer',
      focus: 'Map the system structure and dependencies. Emphasize system map, key nodes, and coupling paths.',
    },
    {
      role: 'Skeptic',
      focus: 'Stress-test assumptions. Highlight weak evidence, missing falsifiers, and fragility in beliefs.',
    },
    {
      role: 'Risk Officer',
      focus: 'Focus on exposure surfaces, convexity, downside, recovery capacity, and fragility scores.',
    },
  ];

  const roleOutputs: Array<{
    systemMap: SystemMap;
    assumptions: MentatAssumptionInput[];
    mechanisms: MentatMechanismInput[];
    fragilityCards: MentatFragilityCardInput[];
  }> = [];

  for (const role of rolePrompts) {
    const prompt = buildMentatPrompt(
      options.system,
      signalsSummary,
      signals.markets,
      signals.intel.map((item) => ({
        title: item.title,
        source: item.source,
        timestamp: item.timestamp,
      })),
      now,
      role.focus
    );

    const response = await options.llm.complete(
      [
        { role: 'system', content: `You are the ${role.role} in a mentat team. Provide structured JSON only.` },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.2 }
    );

    const parsed = parseJsonBlock(response.content) ?? {};
    roleOutputs.push({
      systemMap: normalizeSystemMap(parsed.system_map),
      assumptions: normalizeAssumptions(parsed.assumptions, now),
      mechanisms: normalizeMechanisms(parsed.mechanisms),
      fragilityCards: normalizeFragilityCards(parsed.fragility_cards),
    });
  }

  const systemMap = mergeSystemMaps(roleOutputs.map((o) => o.systemMap));
  const assumptions = mergeAssumptions(roleOutputs.flatMap((o) => o.assumptions));
  const mechanisms = mergeMechanisms(roleOutputs.flatMap((o) => o.mechanisms));
  const fragilityCards = mergeFragilityCards(roleOutputs.flatMap((o) => o.fragilityCards));

  const storedAssumptions: string[] = [];
  const storedMechanisms: string[] = [];
  const storedCards: string[] = [];

  const storeEnabled = options.store !== false;
  const mechanismIdByName = new Map<string, string>();

  if (storeEnabled) {
    for (const mechanism of mechanisms) {
      const id = upsertMechanism({
        system: options.system,
        name: mechanism.name,
        causalChain: mechanism.causal_chain ?? null,
        triggerClass: mechanism.trigger_class ?? null,
        propagationPath: mechanism.propagation_path ?? null,
      });
      storedMechanisms.push(id);
      mechanismIdByName.set(mechanism.name.toLowerCase(), id);
    }

    for (const assumption of assumptions) {
      const id = upsertAssumption({
        system: options.system,
        statement: assumption.statement,
        dependencies: assumption.dependencies ?? null,
        evidenceFor: assumption.evidence_for ?? null,
        evidenceAgainst: assumption.evidence_against ?? null,
        stressScore: assumption.stress_score ?? null,
        lastTested: assumption.last_tested ?? null,
      });
      storedAssumptions.push(id);
    }

    for (const card of fragilityCards) {
      const mechanismId = mechanismIdByName.get(card.mechanism.toLowerCase()) ?? null;
      const id = upsertFragilityCard({
        system: options.system,
        mechanismId,
        exposureSurface: card.exposure_surface,
        convexity: card.convexity ?? null,
        earlySignals: card.early_signals ?? null,
        falsifiers: card.falsifiers ?? null,
        downside: card.downside ?? null,
        recoveryCapacity: card.recovery_capacity ?? null,
        score: card.score ?? null,
      });
      storedCards.push(id);
    }
  }

  return {
    system: options.system,
    generatedAt: now,
    signalsSummary,
    detectors,
    systemMap,
    assumptions,
    mechanisms,
    fragilityCards,
    stored: {
      assumptions: storedAssumptions,
      mechanisms: storedMechanisms,
      fragilityCards: storedCards,
    },
  };
}

/**
 * Quick fragility scan for pre-trade analysis.
 * Lightweight version focused on a specific market.
 */
export interface QuickFragilityScan {
  marketId: string;
  fragilityScore: number;
  riskSignals: string[];
  fragilityCards: Array<{
    mechanism: string;
    exposure: string;
    score: number | null;
    downside: string | null;
  }>;
  stressedAssumptions: Array<{
    statement: string;
    stressScore: number | null;
  }>;
  falsifiers: string[];
  detectors: {
    leverage: number;
    coupling: number;
    illiquidity: number;
    consensus: number;
    irreversibility: number;
  };
  generatedAt: string;
}

interface QuickFragilityScanOptions {
  marketId: string;
  marketClient: PolymarketMarketClient;
  llm: LlmClient;
  intelLimit?: number;
}

/**
 * Run a quick fragility scan for a specific market before trade execution.
 * This is a lightweight version of the full mentat scan.
 */
export async function runQuickFragilityScan(
  options: QuickFragilityScanOptions
): Promise<QuickFragilityScan> {
  const now = new Date().toISOString();

  // Fetch the specific market
  let market: Market;
  try {
    market = await options.marketClient.getMarket(options.marketId);
  } catch (error) {
    // Return minimal scan if market fetch fails
    return {
      marketId: options.marketId,
      fragilityScore: 0.5,
      riskSignals: ['Unable to fetch market data for fragility analysis'],
      fragilityCards: [],
      stressedAssumptions: [],
      falsifiers: ['Market data unavailable - proceed with caution'],
      detectors: {
        leverage: 0.5,
        coupling: 0.5,
        illiquidity: 0.5,
        consensus: 0.5,
        irreversibility: 0.5,
      },
      generatedAt: now,
    };
  }

  // Get recent intel (limited for speed)
  const intelLimit = options.intelLimit ?? 10;
  const intel = listRecentIntel(intelLimit);

  // Compute detector bundle for single market
  const signals: MentatSignals = {
    system: market.question ?? options.marketId,
    markets: [market],
    intel,
    generatedAt: now,
  };
  const detectors = computeDetectorBundle(signals);

  // Build a focused prompt for this specific market
  const prompt = buildQuickFragilityPrompt(market, intel, now);

  // Run LLM analysis (single pass for speed)
  let llmResult: {
    assumptions: MentatAssumptionInput[];
    fragilityCards: MentatFragilityCardInput[];
    falsifiers: string[];
    riskSignals: string[];
  } = {
    assumptions: [],
    fragilityCards: [],
    falsifiers: [],
    riskSignals: [],
  };

  try {
    const response = await options.llm.complete(
      [
        {
          role: 'system',
          content:
            'You are a mentat analyzing fragility before a trade. Provide structured JSON only. Be concise.',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.2 }
    );

    const parsed = parseQuickFragilityResponse(response.content, now);
    if (parsed) {
      llmResult = parsed;
    }
  } catch {
    // Continue with detector-only analysis on LLM failure
    llmResult.riskSignals.push('LLM analysis unavailable - using detector signals only');
  }

  // Combine detector signals with LLM-identified risks
  const allRiskSignals = [
    ...llmResult.riskSignals,
    ...detectors.leverage.signals,
    ...detectors.coupling.signals,
    ...detectors.illiquidity.signals,
    ...detectors.consensus.signals,
    ...detectors.irreversibility.signals,
  ].slice(0, 10);

  return {
    marketId: options.marketId,
    fragilityScore: detectors.overall,
    riskSignals: allRiskSignals,
    fragilityCards: llmResult.fragilityCards.map((card) => ({
      mechanism: card.mechanism,
      exposure: card.exposure_surface,
      score: card.score ?? null,
      downside: card.downside ?? null,
    })),
    stressedAssumptions: llmResult.assumptions
      .filter((a) => (a.stress_score ?? 0) > 0.5)
      .map((a) => ({
        statement: a.statement,
        stressScore: a.stress_score ?? null,
      })),
    falsifiers: llmResult.falsifiers,
    detectors: {
      leverage: detectors.leverage.score,
      coupling: detectors.coupling.score,
      illiquidity: detectors.illiquidity.score,
      consensus: detectors.consensus.score,
      irreversibility: detectors.irreversibility.score,
    },
    generatedAt: now,
  };
}

function buildQuickFragilityPrompt(
  market: Market,
  intel: { title: string; source: string; timestamp: string }[],
  now: string
): string {
  return `Analyze fragility for this trade decision.

Market: ${market.question}
Category: ${market.category ?? 'unknown'}
Prices: YES ${((market.prices['Yes'] ?? market.prices['YES'] ?? market.prices[0] ?? 0) * 100).toFixed(0)}% / NO ${((market.prices['No'] ?? market.prices['NO'] ?? market.prices[1] ?? 0) * 100).toFixed(0)}%
Volume: $${(market.volume ?? 0).toLocaleString()}
Liquidity: $${(market.liquidity ?? 0).toLocaleString()}

Recent intel (${intel.length} items):
${intel.slice(0, 5).map((item) => `- ${item.title} (${item.source})`).join('\n')}

Current time: ${now}

Return JSON only:
{
  "assumptions": [{"statement": "...", "stress_score": 0.0}],
  "fragility_cards": [{"mechanism": "...", "exposure_surface": "...", "score": 0.0, "downside": "..."}],
  "falsifiers": ["what could prove this trade wrong"],
  "risk_signals": ["key risks to consider"]
}

Focus on:
1. What assumptions does this trade depend on?
2. What could cause sudden price movement against the position?
3. What early warning signs should trigger exit?
4. What systemic risks exist (leverage, correlation, illiquidity)?`;
}

function parseQuickFragilityResponse(
  content: string,
  now: string
): {
  assumptions: MentatAssumptionInput[];
  fragilityCards: MentatFragilityCardInput[];
  falsifiers: string[];
  riskSignals: string[];
} | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]) as {
      assumptions?: Array<{ statement?: string; stress_score?: number }>;
      fragility_cards?: Array<{
        mechanism?: string;
        exposure_surface?: string;
        score?: number;
        downside?: string;
      }>;
      falsifiers?: string[];
      risk_signals?: string[];
    };

    return {
      assumptions: (parsed.assumptions ?? [])
        .filter((a) => a.statement)
        .map((a) => ({
          statement: String(a.statement ?? '').trim(),
          stress_score: typeof a.stress_score === 'number' ? clamp(a.stress_score) : null,
          last_tested: now,
        })),
      fragilityCards: (parsed.fragility_cards ?? [])
        .filter((c) => c.mechanism && c.exposure_surface)
        .map((c) => ({
          mechanism: String(c.mechanism ?? '').trim(),
          exposure_surface: String(c.exposure_surface ?? '').trim(),
          score: typeof c.score === 'number' ? clamp(c.score) : null,
          downside: c.downside ? String(c.downside) : null,
        })),
      falsifiers: (parsed.falsifiers ?? []).map((f) => String(f).trim()).filter(Boolean),
      riskSignals: (parsed.risk_signals ?? []).map((r) => String(r).trim()).filter(Boolean),
    };
  } catch {
    return null;
  }
}

export function formatMentatScan(scan: MentatScanOutput): string {
  const lines: string[] = [];
  lines.push(`🧠 Mentat Scan: ${scan.system}`);
  lines.push(`Generated: ${scan.generatedAt}`);
  lines.push('─'.repeat(60));
  lines.push(`Markets: ${scan.signalsSummary.marketCount ?? 0} | Intel: ${scan.signalsSummary.intelCount ?? 0}`);
  lines.push(`Fragility Score: ${(scan.detectors.overall * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('Detector Scores');
  lines.push(`- Leverage: ${(scan.detectors.leverage.score * 100).toFixed(0)}%`);
  lines.push(`- Coupling: ${(scan.detectors.coupling.score * 100).toFixed(0)}%`);
  lines.push(`- Illiquidity: ${(scan.detectors.illiquidity.score * 100).toFixed(0)}%`);
  lines.push(`- Consensus: ${(scan.detectors.consensus.score * 100).toFixed(0)}%`);
  lines.push(`- Irreversibility: ${(scan.detectors.irreversibility.score * 100).toFixed(0)}%`);
  lines.push('');

  if (scan.assumptions.length > 0) {
    lines.push('Assumptions (top)');
    for (const assumption of scan.assumptions.slice(0, 5)) {
      const score = assumption.stress_score != null ? ` (stress ${(assumption.stress_score * 100).toFixed(0)}%)` : '';
      lines.push(`- ${assumption.statement}${score}`);
    }
    lines.push('');
  }

  if (scan.fragilityCards.length > 0) {
    lines.push('Fragility Cards (top)');
    for (const card of scan.fragilityCards.slice(0, 5)) {
      const score = card.score != null ? ` (score ${(card.score * 100).toFixed(0)}%)` : '';
      lines.push(`- ${card.mechanism}: ${card.exposure_surface}${score}`);
    }
    lines.push('');
  }

  lines.push('Stored');
  lines.push(`- Assumptions: ${scan.stored.assumptions.length}`);
  lines.push(`- Mechanisms: ${scan.stored.mechanisms.length}`);
  lines.push(`- Fragility Cards: ${scan.stored.fragilityCards.length}`);

  return lines.join('\n');
}
