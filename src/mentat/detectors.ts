import type { Market } from '../execution/markets.js';
import type { StoredIntel } from '../intel/store.js';
import type { DetectorBundle, DetectorResult, MentatSignals } from './types.js';

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const left = sorted[mid - 1] ?? sorted[0] ?? 0;
    const right = sorted[mid] ?? sorted[sorted.length - 1] ?? left;
    return (left + right) / 2;
  }
  return sorted[mid] ?? sorted[0] ?? null;
}

function summarizeLeverage(markets: Market[]): DetectorResult {
  const ratios = markets
    .map((market) => {
      const volume = typeof market.volume === 'number' ? market.volume : null;
      const liquidity = typeof market.liquidity === 'number' ? market.liquidity : null;
      if (!volume || !liquidity || liquidity <= 0) return null;
      return volume / liquidity;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));

  const avgRatio = average(ratios) ?? 0;
  const maxRatio = ratios.length > 0 ? Math.max(...ratios) : 0;
  const score = clamp(avgRatio / 5);
  const signals: string[] = [];

  if (ratios.length === 0) {
    signals.push('No volume/liquidity data available');
  } else if (maxRatio >= 5) {
    signals.push(`High volume-to-liquidity ratio detected (max ${(maxRatio).toFixed(2)})`);
  }

  return {
    score,
    signals,
    details: {
      ratioCount: ratios.length,
      avgRatio,
      maxRatio,
    },
  };
}

function summarizeCoupling(markets: Market[]): DetectorResult {
  if (markets.length === 0) {
    return {
      score: 0.3,
      signals: ['No market data to evaluate coupling'],
      details: { total: 0 },
    };
  }

  const totals = new Map<string, number>();
  for (const market of markets) {
    const category = market.category?.trim() || 'uncategorized';
    totals.set(category, (totals.get(category) ?? 0) + 1);
  }

  const total = markets.length;
  const shares = Array.from(totals.values()).map((count) => count / total);
  const hhi = shares.reduce((sum, share) => sum + share * share, 0);
  const topShare = shares.length > 0 ? Math.max(...shares) : 0;
  const score = clamp(hhi);
  const signals: string[] = [];

  if (topShare >= 0.4) {
    signals.push(`Category concentration elevated (top share ${(topShare * 100).toFixed(0)}%)`);
  }

  return {
    score,
    signals,
    details: {
      total,
      categories: totals.size,
      hhi,
      topShare,
    },
  };
}

function summarizeIlliquidity(markets: Market[]): DetectorResult {
  const liquidities = markets
    .map((market) => (typeof market.liquidity === 'number' ? market.liquidity : null))
    .filter((value): value is number => value !== null && Number.isFinite(value));

  if (liquidities.length === 0) {
    return {
      score: 0.5,
      signals: ['No liquidity data available'],
      details: { total: 0 },
    };
  }

  const med = median(liquidities) ?? 0;
  const lowThreshold = 10_000;
  const lowCount = liquidities.filter((value) => value < lowThreshold).length;
  const lowShare = lowCount / liquidities.length;
  const score = clamp(1 - med / 100_000);
  const signals: string[] = [];

  if (lowShare >= 0.5) {
    signals.push(`More than half of markets have liquidity below $${lowThreshold.toLocaleString()}`);
  }

  return {
    score,
    signals,
    details: {
      medianLiquidity: med,
      lowShare,
      sampleSize: liquidities.length,
    },
  };
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'will', 'are', 'has', 'have',
  'about', 'into', 'over', 'under', 'after', 'before', 'your', 'their', 'they', 'them',
  'its', 'what', 'when', 'where', 'how', 'who', 'why', 'but', 'not', 'you', 'our', 'out',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function summarizeConsensus(intel: StoredIntel[]): DetectorResult {
  const tokens = intel.flatMap((item) => tokenize(item.title || item.content || ''));
  const totalTokens = tokens.length;
  const uniqueTokens = new Set(tokens).size;
  const diversityRatio = totalTokens > 0 ? uniqueTokens / totalTokens : 0.5;
  const score = clamp(1 - diversityRatio);
  const signals: string[] = [];

  if (intel.length === 0) {
    signals.push('No recent intel to assess consensus');
  } else if (diversityRatio < 0.4) {
    signals.push('Narrative diversity appears low across recent intel');
  }

  return {
    score,
    signals,
    details: {
      intelCount: intel.length,
      totalTokens,
      uniqueTokens,
      diversityRatio,
    },
  };
}

function summarizeIrreversibility(markets: Market[]): DetectorResult {
  const now = Date.now();
  const soonThresholdMs = 14 * 24 * 60 * 60 * 1000;
  const withDates = markets
    .map((market) => {
      if (!market.endDate) return null;
      const parsed =
        market.endDate instanceof Date
          ? market.endDate.getTime()
          : Date.parse(String(market.endDate));
      if (Number.isNaN(parsed)) return null;
      return parsed;
    })
    .filter((value): value is number => value !== null);

  if (withDates.length === 0) {
    return {
      score: 0.5,
      signals: ['No market end dates available; irreversibility assumed neutral'],
      details: { datedMarkets: 0 },
    };
  }

  const soonCount = withDates.filter((timestamp) => timestamp - now <= soonThresholdMs).length;
  const soonShare = withDates.length > 0 ? soonCount / withDates.length : 0;
  const score = clamp(0.4 + soonShare * 0.6);

  return {
    score,
    signals: soonShare > 0.5 ? ['Many markets near resolution; reversibility low'] : [],
    details: {
      datedMarkets: withDates.length,
      soonShare,
    },
  };
}

export function computeDetectorBundle(signals: MentatSignals): DetectorBundle {
  const leverage = summarizeLeverage(signals.markets);
  const coupling = summarizeCoupling(signals.markets);
  const illiquidity = summarizeIlliquidity(signals.markets);
  const consensus = summarizeConsensus(signals.intel);
  const irreversibility = summarizeIrreversibility(signals.markets);

  const overall = clamp(
    (average([
      leverage.score,
      coupling.score,
      illiquidity.score,
      consensus.score,
      irreversibility.score,
    ]) ?? 0)
  );

  return {
    leverage,
    coupling,
    illiquidity,
    consensus,
    irreversibility,
    overall,
  };
}

export function summarizeSignals(markets: Market[], intel: StoredIntel[]): Record<string, unknown> {
  const totalVolume = markets.reduce((sum, m) => sum + (m.volume ?? 0), 0);
  const totalLiquidity = markets.reduce((sum, m) => sum + (m.liquidity ?? 0), 0);
  const categories = new Map<string, number>();
  for (const market of markets) {
    const category = market.category?.trim() || 'uncategorized';
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }

  return {
    marketCount: markets.length,
    totalVolume,
    totalLiquidity,
    topCategories: Array.from(categories.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([category, count]) => ({ category, count })),
    intelCount: intel.length,
    intelSources: Array.from(new Set(intel.map((item) => item.source))).slice(0, 8),
  };
}
