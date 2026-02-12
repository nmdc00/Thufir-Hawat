import type { ThufirConfig } from '../core/config.js';
import { HyperliquidClient } from '../execution/hyperliquid/client.js';
import { findReusableArtifact, storeDecisionArtifact } from '../memory/decision_artifacts.js';

import { computeCatalystProximityScore, listUpcomingCatalysts } from './catalysts.js';
import { getNarrativeSnapshot } from './narrative.js';
import type { NarrativeSnapshotV1, ReflexivitySetupV1, ReflexivityScores } from './types.js';

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function toNumber(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeHyperliquidSymbol(symbol: string): { baseSymbol: string; fullSymbol: string } {
  const fullSymbol = symbol.includes('/') ? symbol : `${symbol}/USDT`;
  const [base] = fullSymbol.split('/');
  return { baseSymbol: (base ?? fullSymbol).toUpperCase(), fullSymbol };
}

function percentileRank(values: number[], value: number): number {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!finite.length) return 0.5;
  let idx = 0;
  while (idx < finite.length && finite[idx]! <= value) idx += 1;
  return finite.length <= 1 ? 0.5 : idx / finite.length;
}

function scoreCrowding(params: {
  fundingRate: number;
  fundingPct: number;
  oiZ: number;
  oiShare: number;
}): number {
  const fundingExtreme = clamp01(Math.abs(params.fundingPct - 0.5) * 2); // 0..1
  const oiExtreme = clamp01(Math.max(0, params.oiZ)); // only reward elevated OI
  const oiShare = clamp01(params.oiShare * 10); // rough scaling: 10% share => 1.0
  return clamp01(fundingExtreme * 0.55 + oiExtreme * 0.30 + oiShare * 0.15);
}

function scoreFragility(params: {
  orderflowImbalance: number;
  depthImbalance: number;
  spreadBps: number;
  narrative: NarrativeSnapshotV1;
  fundingRate: number;
}): { score: number; drivers: string[] } {
  const drivers: string[] = [];
  const flow = clamp01(Math.abs(params.orderflowImbalance) * 2);
  if (flow > 0.4) drivers.push(`One-sided orderflow (imbalance ${(params.orderflowImbalance * 100).toFixed(1)}%)`);
  const depth = clamp01(Math.abs(params.depthImbalance) * 1.5);
  if (depth > 0.4) drivers.push(`Book depth skew (imbalance ${(params.depthImbalance * 100).toFixed(1)}%)`);
  const spread = clamp01(params.spreadBps / 25); // 25 bps -> 1.0
  if (spread > 0.4) drivers.push(`Wider spreads (${params.spreadBps.toFixed(1)} bps)`);

  const unanimity = clamp01(params.narrative.unanimityScore);
  if (unanimity > 0.6) drivers.push(`Narrative unanimity (${(unanimity * 100).toFixed(0)}%)`);
  const exhaustion = clamp01(params.narrative.exhaustionScore);
  if (exhaustion > 0.4) drivers.push(`Narrative exhaustion (${(exhaustion * 100).toFixed(0)}%)`);

  const fundingMag = clamp01(Math.abs(params.fundingRate) * 100); // HL rates are usually small decimals
  if (fundingMag > 0.4) drivers.push(`High carry (funding ${params.fundingRate.toFixed(5)})`);

  const score = clamp01(
    flow * 0.25 +
      depth * 0.25 +
      spread * 0.10 +
      unanimity * 0.25 +
      exhaustion * 0.15
  );
  return { score, drivers };
}

function pickTimeHorizon(horizonSeconds: number): 'minutes' | 'hours' | 'days' {
  if (horizonSeconds <= 3600) return 'minutes';
  if (horizonSeconds <= 48 * 3600) return 'hours';
  return 'days';
}

function computeScores(params: {
  config: ThufirConfig;
  crowding: number;
  fragility: number;
  catalyst: number;
}): ReflexivityScores {
  const weights = (params.config as any)?.reflexivity?.weights ?? {};
  const wCrowding = Number(weights.crowding ?? 0.4);
  const wFragility = Number(weights.fragility ?? 0.4);
  const wCatalyst = Number(weights.catalyst ?? 0.2);
  const denom = wCrowding + wFragility + wCatalyst || 1;
  const setupScore = clamp01(
    (params.crowding * wCrowding + params.fragility * wFragility + params.catalyst * wCatalyst) /
      denom
  );
  return {
    crowdingScore: clamp01(params.crowding),
    fragilityScore: clamp01(params.fragility),
    catalystProximityScore: clamp01(params.catalyst),
    setupScore,
  };
}

async function computeOrderflowImbalance(client: HyperliquidClient, coin: string): Promise<{ imbalance: number; tradeCount: number }> {
  const trades = await client.getRecentTrades(coin);
  let buyNotional = 0;
  let sellNotional = 0;
  let tradeCount = 0;
  for (const trade of trades) {
    const px = toNumber((trade as any).px);
    const sz = toNumber((trade as any).sz);
    const notional = px * sz;
    if (!Number.isFinite(notional) || notional <= 0) continue;
    const side = String((trade as any).side ?? '').toUpperCase();
    if (side === 'B' || side === 'BUY') {
      buyNotional += notional;
      tradeCount += 1;
    } else if (side === 'A' || side === 'S' || side === 'SELL') {
      sellNotional += notional;
      tradeCount += 1;
    }
  }
  const total = buyNotional + sellNotional;
  if (total <= 0 || tradeCount === 0) return { imbalance: 0, tradeCount };
  return { imbalance: (buyNotional - sellNotional) / total, tradeCount };
}

async function computeBookMicrostructure(client: HyperliquidClient, coin: string): Promise<{ depthImbalance: number; spreadBps: number }> {
  const book = await client.getL2Book(coin);
  const levels = (book as any)?.levels as Array<Array<{ px?: string | number; sz?: string | number }>> | undefined;
  const bids = Array.isArray(levels?.[0]) ? levels![0]! : [];
  const asks = Array.isArray(levels?.[1]) ? levels![1]! : [];

  const bestBid = bids.length ? toNumber(bids[0]?.px) : 0;
  const bestAsk = asks.length ? toNumber(asks[0]?.px) : 0;
  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
  const spreadBps = mid > 0 && bestAsk > 0 && bestBid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;

  const bidDepth = bids.reduce((sum, level) => sum + toNumber(level.px) * toNumber(level.sz), 0);
  const askDepth = asks.reduce((sum, level) => sum + toNumber(level.px) * toNumber(level.sz), 0);
  const totalDepth = bidDepth + askDepth;
  const depthImbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

  return { depthImbalance, spreadBps };
}

function buildImWrongIf(params: {
  baseSymbol: string;
  horizonSeconds: number;
  nextCatalystSecondsToEvent: number | null;
}): string[] {
  const out: string[] = [];
  out.push('Crowding defuses: funding and OI normalize without repricing (setupScore drops below threshold).');
  if (params.nextCatalystSecondsToEvent != null) {
    out.push('Catalyst passes with no repricing: exit on time stop after event window.');
  } else {
    out.push(`No clear catalyst within horizon (${Math.round(params.horizonSeconds / 3600)}h): avoid paying carry for timing risk.`);
  }
  out.push('Execution risk spikes: spreads widen or depth collapses beyond limits.');
  out.push('Opposite catalyst emerges: narrative regime shifts against the setup.');
  return out;
}

function computeDirectionalBias(params: { fundingRate: number; crowdingScore: number; narrative: NarrativeSnapshotV1 }): 'up' | 'down' | 'neutral' {
  // Default reflexive reversal direction: against the side paying funding when crowding is elevated.
  if (params.crowdingScore < 0.5) return 'neutral';
  if (params.fundingRate > 0) return 'down';
  if (params.fundingRate < 0) return 'up';
  // If funding is flat, lean against narrative sign only if unanimity is extreme.
  if (params.narrative.unanimityScore > 0.8 && params.narrative.exhaustionScore > 0.5) return 'down';
  return 'neutral';
}

export async function buildReflexivitySetup(params: {
  config: ThufirConfig;
  symbol: string; // 'ETH/USDT' or 'ETH'
}): Promise<ReflexivitySetupV1 | null> {
  const enabled = Boolean((params.config as any)?.reflexivity?.enabled ?? false);
  if (!enabled) return null;

  const { baseSymbol, fullSymbol } = normalizeHyperliquidSymbol(params.symbol);
  const cfg = (params.config as any)?.reflexivity ?? {};
  const horizonSeconds = Number(cfg.horizonSeconds ?? 24 * 3600);
  const thresholds = cfg.thresholds ?? {};
  const setupScoreMin = Number(thresholds.setupScoreMin ?? 0.7);

  const nowMs = Date.now();
  const timeHorizon = pickTimeHorizon(horizonSeconds);

  const client = new HyperliquidClient(params.config);
  const [meta, assetCtxs] = await client.getMetaAndAssetCtxs();
  const idx = (meta as any)?.universe?.findIndex((item: any) => item?.name === baseSymbol) ?? -1;
  if (idx < 0 || idx >= (assetCtxs as any[]).length) return null;

  const ctx = (assetCtxs as any[])[idx] ?? {};
  const fundingRate = toNumber(ctx.funding);
  const openInterest = toNumber(ctx.openInterest);

  const allFunding = (assetCtxs as any[]).map((c) => toNumber(c?.funding)).filter(Number.isFinite);
  const fundingPct = percentileRank(allFunding, fundingRate);

  const openInterests = (assetCtxs as any[]).map((c) => toNumber(c?.openInterest)).filter(Number.isFinite);
  const meanOI = mean(openInterests);
  const totalOI = openInterests.reduce((s, v) => s + v, 0);
  const oiZ = meanOI > 0 ? (openInterest - meanOI) / meanOI : 0;
  const oiShare = totalOI > 0 ? openInterest / totalOI : 0;

  // OI acceleration from last stored state (best-effort).
  const last = findReusableArtifact({
    kind: 'reflexivity_state_v1',
    marketId: baseSymbol,
    fingerprint: 'latest',
    maxAgeMs: 7 * 24 * 3600 * 1000,
    requireNotExpired: false,
  });
  const lastOi = toNumber((last?.payload as any)?.openInterest);
  const lastTs = toNumber((last?.payload as any)?.tsMs);
  const dt = lastTs > 0 ? (nowMs - lastTs) / 1000 : 0;
  const oiAccel = dt > 0 ? (openInterest - lastOi) / dt : 0;

  storeDecisionArtifact({
    source: 'reflexivity',
    kind: 'reflexivity_state_v1',
    marketId: baseSymbol,
    fingerprint: 'latest',
    payload: { tsMs: nowMs, openInterest },
  });

  const narrative = await getNarrativeSnapshot({ config: params.config, symbol: fullSymbol });

  const upcoming = listUpcomingCatalysts({
    config: params.config,
    baseSymbol,
    nowMs,
    horizonSeconds,
  });
  const catalystProximity = computeCatalystProximityScore({ upcoming, horizonSeconds });

  const crowdingScore = scoreCrowding({ fundingRate, fundingPct, oiZ, oiShare });

  // Microstructure and flow are best-effort; thin markets can fail.
  let orderflowImbalance = 0;
  let tradeCount = 0;
  let depthImbalance = 0;
  let spreadBps = 0;
  try {
    const flow = await computeOrderflowImbalance(client, baseSymbol);
    orderflowImbalance = flow.imbalance;
    tradeCount = flow.tradeCount;
  } catch {
    // ignore
  }
  try {
    const book = await computeBookMicrostructure(client, baseSymbol);
    depthImbalance = book.depthImbalance;
    spreadBps = book.spreadBps;
  } catch {
    // ignore
  }

  const fragility = scoreFragility({
    orderflowImbalance,
    depthImbalance,
    spreadBps,
    narrative,
    fundingRate,
  });

  const scores = computeScores({
    config: params.config,
    crowding: crowdingScore,
    fragility: fragility.score,
    catalyst: catalystProximity.score,
  });

  if (scores.setupScore < setupScoreMin) {
    return null;
  }

  const directionalBias = computeDirectionalBias({ fundingRate, crowdingScore, narrative });
  const confidence = scores.setupScore;

  const catalysts = upcoming.slice(0, 3).map((c) => ({
    id: c.id,
    type: c.type,
    scheduledUtc: c.scheduledUtc,
    secondsToEvent: c.secondsToEvent ?? null,
    description: c.description,
  }));

  const fragilityDrivers = [
    `Funding percentile ${(fundingPct * 100).toFixed(0)}% (rate ${fundingRate.toFixed(5)})`,
    `OI z ${(oiZ).toFixed(2)} (share ${(oiShare * 100).toFixed(1)}%)`,
    `OI accel ${oiAccel.toFixed(2)}/s`,
    tradeCount ? `Recent trades sampled: ${tradeCount}` : 'Recent trades sampled: 0',
    ...fragility.drivers,
  ];

  const setup: ReflexivitySetupV1 = {
    schemaVersion: '1',
    symbol: fullSymbol,
    baseSymbol,
    asofUtc: new Date(nowMs).toISOString(),
    timeHorizon,

    consensusNarrative: narrative.consensusNarrative,
    keyAssumptions: narrative.impliedAssumptions,
    fragilityDrivers,
    catalysts,

    directionalBias,
    confidence,
    scores,
    metrics: {
      fundingRate,
      fundingPct,
      openInterest,
      oiZ,
      oiShare,
      oiAccel,
      orderflowImbalance,
      depthImbalance,
      spreadBps,
      unanimityScore: narrative.unanimityScore,
      exhaustionScore: narrative.exhaustionScore,
      catalystProximityScore: catalystProximity.score,
      nextCatalystSecondsToEvent: catalystProximity.nextSecondsToEvent ?? -1,
      crowdingScore: scores.crowdingScore,
      fragilityScore: scores.fragilityScore,
      setupScore: scores.setupScore,
    },

    imWrongIf: buildImWrongIf({
      baseSymbol,
      horizonSeconds,
      nextCatalystSecondsToEvent: catalystProximity.nextSecondsToEvent,
    }),
    evidenceIntelIds: narrative.evidenceIntelIds,
  };

  storeDecisionArtifact({
    source: 'reflexivity',
    kind: 'reflexivity_setup_v1',
    marketId: baseSymbol,
    fingerprint: `${baseSymbol}_${nowMs}`,
    payload: setup,
    confidence,
    expiresAt: new Date(nowMs + Math.max(60, horizonSeconds) * 1000).toISOString(),
    notes: {
      setupScoreMin,
      horizonSeconds,
    },
  });

  return setup;
}
