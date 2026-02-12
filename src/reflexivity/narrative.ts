import { createHash } from 'node:crypto';

import type { ThufirConfig } from '../core/config.js';
import { createLlmClient, createTrivialTaskClient, type ChatMessage, type LlmClient } from '../core/llm.js';
import { findReusableArtifact, storeDecisionArtifact } from '../memory/decision_artifacts.js';
import { listRecentIntel, type StoredIntel } from '../intel/store.js';

import type { NarrativeSnapshotV1 } from './types.js';

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function nowUtc(): string {
  return new Date().toISOString();
}

function normalizeBaseSymbol(symbol: string): string {
  const [base] = symbol.split('/');
  return (base ?? symbol).toUpperCase();
}

function buildSymbolKeywords(symbol: string): string[] {
  const base = normalizeBaseSymbol(symbol);
  if (base === 'BTC') return ['btc', 'bitcoin'];
  if (base === 'ETH') return ['eth', 'ethereum'];
  return [base.toLowerCase()];
}

const MOMENTUM_TOKENS = [
  'up only',
  'send',
  'moon',
  'ath',
  'breakout',
  'number go up',
  'ngmi',
  'pump',
  'inevitable',
  'it is going up',
  'its going up',
  'because it is going up',
  'because it\'s going up',
];

const POSITIVE = new Set([
  'beat', 'beats', 'beating', 'surge', 'surges', 'surged', 'rally', 'rallies', 'rallied',
  'win', 'wins', 'won', 'strong', 'growth', 'record', 'up', 'upgrade', 'upgrades',
  'boom', 'positive', 'bullish', 'soar', 'soars', 'soared',
]);
const NEGATIVE = new Set([
  'miss', 'misses', 'missed', 'fall', 'falls', 'fell', 'drop', 'drops', 'dropped',
  'crash', 'crashes', 'crashed', 'loss', 'losses', 'weak', 'decline', 'declines',
  'declined', 'down', 'downgrade', 'downgrades', 'bust', 'negative', 'bearish',
  'plunge', 'plunges', 'plunged',
]);

function scoreSentiment(text: string): number {
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    if (POSITIVE.has(token)) score += 1;
    if (NEGATIVE.has(token)) score -= 1;
  }
  if (tokens.length === 0) return 0;
  return score / Math.min(tokens.length, 50);
}

function detectMomentumLanguage(text: string): number {
  const t = text.toLowerCase();
  let hits = 0;
  for (const token of MOMENTUM_TOKENS) {
    if (t.includes(token)) hits += 1;
  }
  return hits;
}

function hashInputs(params: {
  symbol: string;
  intel: StoredIntel[];
  maxIntelItems: number;
}): string {
  const hash = createHash('sha256');
  hash.update(normalizeBaseSymbol(params.symbol));
  hash.update(String(params.maxIntelItems));
  for (const item of params.intel) {
    hash.update(item.id);
    hash.update(item.timestamp);
  }
  return hash.digest('hex');
}

function coerceSnapshot(value: unknown, fallback: NarrativeSnapshotV1): NarrativeSnapshotV1 {
  if (!value || typeof value !== 'object') return fallback;
  const obj = value as Record<string, unknown>;
  const schemaVersion = obj.schemaVersion === '1' ? '1' : '1';
  const unanimityScore = clamp01(Number(obj.unanimityScore));
  const exhaustionScore = clamp01(Number(obj.exhaustionScore));

  const evidenceIntelIds =
    Array.isArray(obj.evidenceIntelIds) ? (obj.evidenceIntelIds.filter((x) => typeof x === 'string') as string[]) : [];

  return {
    schemaVersion,
    symbol: typeof obj.symbol === 'string' ? obj.symbol : fallback.symbol,
    asofUtc: typeof obj.asofUtc === 'string' ? obj.asofUtc : fallback.asofUtc,
    consensusNarrative: typeof obj.consensusNarrative === 'string' ? obj.consensusNarrative : fallback.consensusNarrative,
    consensusClaims: Array.isArray(obj.consensusClaims)
      ? (obj.consensusClaims.filter((x) => typeof x === 'string') as string[])
      : fallback.consensusClaims,
    impliedAssumptions: Array.isArray(obj.impliedAssumptions)
      ? (obj.impliedAssumptions.filter((x) => typeof x === 'string') as string[])
      : fallback.impliedAssumptions,
    dissentingViews: Array.isArray(obj.dissentingViews)
      ? (obj.dissentingViews.filter((x) => typeof x === 'string') as string[])
      : fallback.dissentingViews,
    unanimityScore,
    exhaustionScore,
    evidenceIntelIds,
    notes: typeof obj.notes === 'string' ? obj.notes : undefined,
  };
}

function buildDeterministicSnapshot(params: {
  symbol: string;
  matched: StoredIntel[];
}): NarrativeSnapshotV1 {
  const base = normalizeBaseSymbol(params.symbol);
  const scored = params.matched.slice(0, 20).map((item) => {
    const text = `${item.title ?? ''} ${item.content ?? ''}`.trim();
    const s = scoreSentiment(text);
    const m = detectMomentumLanguage(text);
    return { id: item.id, score: s, momentumHits: m, text };
  });

  const counts = {
    pos: scored.filter((x) => x.score > 0).length,
    neg: scored.filter((x) => x.score < 0).length,
    neu: scored.filter((x) => x.score === 0).length,
  };
  const dominantSign =
    counts.pos > counts.neg ? 1 : counts.neg > counts.pos ? -1 : 0;
  const total = scored.length || 1;
  const dominantCount =
    dominantSign === 1 ? counts.pos : dominantSign === -1 ? counts.neg : counts.neu;

  const coverage = clamp01(scored.length / 10);
  const unanimity = clamp01((dominantCount / total) * coverage);
  const exhaustion = clamp01(
    (scored.reduce((sum, x) => sum + (x.momentumHits > 0 ? 1 : 0), 0) / total) * coverage
  );

  const directionWord =
    dominantSign === 1 ? 'bullish' : dominantSign === -1 ? 'bearish' : 'mixed';
  const consensusNarrative =
    scored.length === 0
      ? `No strong ${base} narrative detected in recent intel.`
      : `${base} narrative appears ${directionWord} across recent intel.`;

  const evidenceIntelIds = scored.map((x) => x.id);

  return {
    schemaVersion: '1',
    symbol: base,
    asofUtc: nowUtc(),
    consensusNarrative,
    consensusClaims: scored.length ? [`Recent intel skews ${directionWord} on ${base}.`] : [],
    impliedAssumptions: scored.length ? [`Positioning will remain aligned with the ${directionWord} narrative.`] : [],
    dissentingViews: [],
    unanimityScore: unanimity,
    exhaustionScore: exhaustion,
    evidenceIntelIds,
  };
}

function pickNarrativeClient(config: ThufirConfig): LlmClient {
  const useTrivial = (config as any)?.reflexivity?.narrative?.llm?.useTrivial ?? true;
  return (useTrivial ? createTrivialTaskClient(config) : null) ?? createLlmClient(config);
}

async function llmSnapshot(params: {
  config: ThufirConfig;
  symbol: string;
  matched: StoredIntel[];
  fallback: NarrativeSnapshotV1;
}): Promise<NarrativeSnapshotV1> {
  const client = pickNarrativeClient(params.config);
  const intel = params.matched.slice(0, 12).map((item) => ({
    id: item.id,
    title: item.title,
    source: item.source,
    timestamp: item.timestamp,
    content: item.content ?? '',
  }));

  const system = [
    'You extract a narrative snapshot for a crypto perp symbol.',
    'Output ONLY strict JSON. No markdown. No commentary.',
    'Do not invent intel IDs; evidenceIntelIds must be a subset of provided intel IDs.',
    'Scores must be numbers between 0 and 1.',
  ].join('\n');

  const user = JSON.stringify(
    {
      schemaVersion: '1',
      symbol: normalizeBaseSymbol(params.symbol),
      asofUtc: nowUtc(),
      instructions: {
        produce: [
          'consensusNarrative',
          'consensusClaims',
          'impliedAssumptions',
          'dissentingViews',
          'unanimityScore',
          'exhaustionScore',
          'evidenceIntelIds',
        ],
      },
      intel,
    },
    null,
    2
  );

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let raw = '';
  try {
    raw = (await client.complete(messages, { maxTokens: 512, temperature: 0.2 })).content ?? '';
  } catch {
    return params.fallback;
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return params.fallback;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return coerceSnapshot(parsed, params.fallback);
  } catch {
    return params.fallback;
  }
}

export async function getNarrativeSnapshot(params: {
  config: ThufirConfig;
  symbol: string;
}): Promise<NarrativeSnapshotV1> {
  const cfg = (params.config as any)?.reflexivity?.narrative ?? {};
  const maxIntelItems = Number(cfg.maxIntelItems ?? 50);
  const cacheTtlSeconds = Number(cfg.cacheTtlSeconds ?? 1800);
  const llmEnabled = Boolean(cfg.llm?.enabled ?? false);

  const keywords = buildSymbolKeywords(params.symbol);
  const recent = listRecentIntel(Math.max(1, maxIntelItems));
  const matched = recent.filter((item) => {
    const text = `${item.title ?? ''} ${item.content ?? ''}`.toLowerCase();
    return keywords.some((k) => text.includes(k));
  });

  const fingerprint = hashInputs({ symbol: params.symbol, intel: matched, maxIntelItems });
  const reusable = findReusableArtifact({
    kind: 'reflexivity_narrative_v1',
    marketId: normalizeBaseSymbol(params.symbol),
    fingerprint,
    maxAgeMs: cacheTtlSeconds * 1000,
    requireNotExpired: true,
  });
  if (reusable?.payload) {
    const fallback = buildDeterministicSnapshot({ symbol: params.symbol, matched });
    return coerceSnapshot(reusable.payload, fallback);
  }

  const fallback = buildDeterministicSnapshot({ symbol: params.symbol, matched });
  const snapshot = llmEnabled
    ? await llmSnapshot({ config: params.config, symbol: params.symbol, matched, fallback })
    : fallback;

  storeDecisionArtifact({
    source: 'reflexivity',
    kind: 'reflexivity_narrative_v1',
    marketId: normalizeBaseSymbol(params.symbol),
    fingerprint,
    payload: snapshot,
    confidence: snapshot.unanimityScore,
    expiresAt: new Date(Date.now() + cacheTtlSeconds * 1000).toISOString(),
    notes: {
      matchedItems: matched.length,
      llmEnabled,
    },
  });

  return snapshot;
}

