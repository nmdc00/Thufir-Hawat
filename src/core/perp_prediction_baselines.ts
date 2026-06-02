import type Database from 'better-sqlite3';

import type { ThufirConfig } from './config.js';
import { openDatabase } from '../memory/db.js';

export type PerpForecastTarget = 'positive_net_pnl_before_ttl_or_invalidation';

export type PerpPredictionBaselineInput = {
  symbol: string;
  side: 'buy' | 'sell';
  signalClass: string | null;
  marketRegime: string | null;
  triggerReason: string | null;
  symbolClass: string | null;
  session: string | null;
  volatilityBucket: string | null;
  liquidityBucket: string | null;
  forecastTarget?: PerpForecastTarget;
};

export type PerpPredictionBaseline = {
  probability: number | null;
  comparable: boolean;
  source: 'segment_history_blended' | 'global_prior' | 'missing';
  fallbackLevel: string | null;
  sampleCount: number;
  wins: number;
  priorProbability: number | null;
  priorStrength: number;
  segmentKey: string | null;
  exclusionReason: null | 'missing_comparator' | 'insufficient_samples' | 'synthetic_comparator';
};

type BaselineConfig = {
  enabled: boolean;
  priorStrength: number;
  minComparableSamples: number;
  lookbackDays: number | null;
  target: PerpForecastTarget;
};

type BaselineEvidenceRow = {
  context_payload: string | null;
  action_payload: string | null;
  outcome_payload: string | null;
};

type SegmentEvidence = {
  signalClass: string | null;
  marketRegime: string | null;
  triggerReason: string | null;
  symbolClass: string | null;
  direction: 'long' | 'short' | null;
  win: boolean;
};

type SegmentDimension = keyof Omit<SegmentEvidence, 'win'>;

type FallbackDefinition = {
  level: string;
  dimensions: SegmentDimension[];
};

type FallbackStats = {
  level: string;
  dimensions: SegmentDimension[];
  segmentKey: string;
  sampleCount: number;
  wins: number;
};

const FALLBACKS: FallbackDefinition[] = [
  {
    level: 'signal_regime_trigger_symbol_class_direction',
    dimensions: ['signalClass', 'marketRegime', 'triggerReason', 'symbolClass', 'direction'],
  },
  {
    level: 'signal_regime_trigger_symbol_class',
    dimensions: ['signalClass', 'marketRegime', 'triggerReason', 'symbolClass'],
  },
  {
    level: 'signal_regime_trigger',
    dimensions: ['signalClass', 'marketRegime', 'triggerReason'],
  },
  {
    level: 'signal_regime',
    dimensions: ['signalClass', 'marketRegime'],
  },
  {
    level: 'signal',
    dimensions: ['signalClass'],
  },
];

const DEFAULT_CONFIG: BaselineConfig = {
  enabled: true,
  priorStrength: 20,
  minComparableSamples: 5,
  lookbackDays: 90,
  target: 'positive_net_pnl_before_ttl_or_invalidation',
};

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDirection(value: unknown): 'long' | 'short' | null {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === 'long') return 'long';
  if (normalized === 'short') return 'short';
  return null;
}

function directionFromSide(side: 'buy' | 'sell'): 'long' | 'short' {
  return side === 'buy' ? 'long' : 'short';
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0.01, Math.min(0.99, value));
}

function readConfig(config: ThufirConfig): BaselineConfig {
  const raw = (config as unknown as {
    autonomy?: {
      perpPredictionBaselines?: Partial<BaselineConfig> & {
        target?: PerpForecastTarget;
      };
    };
  }).autonomy?.perpPredictionBaselines;

  return {
    enabled: raw?.enabled ?? DEFAULT_CONFIG.enabled,
    priorStrength:
      typeof raw?.priorStrength === 'number' && Number.isFinite(raw.priorStrength) && raw.priorStrength >= 0
        ? raw.priorStrength
        : DEFAULT_CONFIG.priorStrength,
    minComparableSamples:
      typeof raw?.minComparableSamples === 'number' &&
      Number.isFinite(raw.minComparableSamples) &&
      raw.minComparableSamples > 0
        ? Math.floor(raw.minComparableSamples)
        : DEFAULT_CONFIG.minComparableSamples,
    lookbackDays:
      raw?.lookbackDays === null
        ? null
        : typeof raw?.lookbackDays === 'number' && Number.isFinite(raw.lookbackDays) && raw.lookbackDays > 0
          ? raw.lookbackDays
          : DEFAULT_CONFIG.lookbackDays,
    target: raw?.target ?? DEFAULT_CONFIG.target,
  };
}

function emptyBaseline(
  priorStrength: number,
  exclusionReason: PerpPredictionBaseline['exclusionReason'] = 'missing_comparator'
): PerpPredictionBaseline {
  return {
    probability: null,
    comparable: false,
    source: 'missing',
    fallbackLevel: null,
    sampleCount: 0,
    wins: 0,
    priorProbability: null,
    priorStrength,
    segmentKey: null,
    exclusionReason,
  };
}

function fetchExecutionRows(db: Database.Database, lookbackDays: number | null): BaselineEvidenceRow[] {
  if (lookbackDays == null) {
    return db
      .prepare(
        `
          SELECT context_payload, action_payload, outcome_payload
          FROM learning_cases
          WHERE case_type = 'execution_quality'
            AND domain = 'perp'
            AND json_extract(outcome_payload, '$.netRealizedPnlUsd') IS NOT NULL
          ORDER BY created_at DESC
        `
      )
      .all() as BaselineEvidenceRow[];
  }

  return db
    .prepare(
      `
        SELECT context_payload, action_payload, outcome_payload
        FROM learning_cases
        WHERE case_type = 'execution_quality'
          AND domain = 'perp'
          AND json_extract(outcome_payload, '$.netRealizedPnlUsd') IS NOT NULL
          AND created_at >= datetime('now', @lookbackModifier)
        ORDER BY created_at DESC
      `
    )
    .all({ lookbackModifier: `-${lookbackDays} days` }) as BaselineEvidenceRow[];
}

function normalizeEvidence(row: BaselineEvidenceRow): SegmentEvidence | null {
  const context = parseJsonObject(row.context_payload);
  const action = parseJsonObject(row.action_payload);
  const outcome = parseJsonObject(row.outcome_payload);
  const netRealizedPnlUsd = toFiniteNumber(outcome?.netRealizedPnlUsd);
  if (netRealizedPnlUsd == null) return null;

  const actionSide = normalizeString(action?.side)?.toLowerCase();
  const actionDirection =
    actionSide === 'buy' ? 'long' : actionSide === 'sell' ? 'short' : null;

  return {
    signalClass: normalizeString(context?.signalClass),
    marketRegime: normalizeString(context?.marketRegime),
    triggerReason: normalizeString(context?.triggerReason),
    symbolClass: normalizeString(context?.symbolClass),
    direction: normalizeDirection(context?.direction) ?? actionDirection,
    win: netRealizedPnlUsd > 0,
  };
}

function toSegmentInput(input: PerpPredictionBaselineInput): Omit<SegmentEvidence, 'win'> {
  return {
    signalClass: normalizeString(input.signalClass),
    marketRegime: normalizeString(input.marketRegime),
    triggerReason: normalizeString(input.triggerReason),
    symbolClass: normalizeString(input.symbolClass),
    direction: directionFromSide(input.side),
  };
}

function segmentKeyFor(
  segment: Omit<SegmentEvidence, 'win'>,
  dimensions: SegmentDimension[]
): string | null {
  const parts: string[] = [];
  for (const dimension of dimensions) {
    const value = segment[dimension];
    if (!value) return null;
    parts.push(`${dimension}=${value}`);
  }
  return parts.join('|');
}

function evidenceMatches(
  evidence: SegmentEvidence,
  segment: Omit<SegmentEvidence, 'win'>,
  dimensions: SegmentDimension[]
): boolean {
  for (const dimension of dimensions) {
    const expected = segment[dimension];
    if (!expected || evidence[dimension] !== expected) {
      return false;
    }
  }
  return true;
}

function computeStats(
  evidence: SegmentEvidence[],
  segment: Omit<SegmentEvidence, 'win'>,
  fallback: FallbackDefinition
): FallbackStats | null {
  const segmentKey = segmentKeyFor(segment, fallback.dimensions);
  if (!segmentKey) return null;

  const matching = evidence.filter((entry) => evidenceMatches(entry, segment, fallback.dimensions));
  return {
    level: fallback.level,
    dimensions: fallback.dimensions,
    segmentKey,
    sampleCount: matching.length,
    wins: matching.filter((entry) => entry.win).length,
  };
}

function winRate(stats: { wins: number; sampleCount: number } | null): number | null {
  if (!stats || stats.sampleCount <= 0) return null;
  return stats.wins / stats.sampleCount;
}

function resolvePrior(
  candidates: FallbackStats[],
  selectedIndex: number,
  globalStats: FallbackStats
): number {
  for (let index = selectedIndex + 1; index < candidates.length; index += 1) {
    const rate = winRate(candidates[index] ?? null);
    if (rate != null) return rate;
  }
  return winRate(globalStats) ?? 0.5;
}

function smoothedProbability(stats: FallbackStats, priorStrength: number, priorProbability: number): number {
  const denominator = stats.sampleCount + priorStrength;
  if (denominator <= 0) return clampProbability(priorProbability);
  return clampProbability((stats.wins + priorStrength * priorProbability) / denominator);
}

export function resolvePerpPredictionBaseline(
  config: ThufirConfig,
  input: PerpPredictionBaselineInput,
  db: Database.Database = openDatabase()
): PerpPredictionBaseline {
  const baselineConfig = readConfig(config);
  const forecastTarget = input.forecastTarget ?? baselineConfig.target;
  if (!baselineConfig.enabled || forecastTarget !== DEFAULT_CONFIG.target) {
    return emptyBaseline(baselineConfig.priorStrength);
  }

  const evidence = fetchExecutionRows(db, baselineConfig.lookbackDays)
    .map(normalizeEvidence)
    .filter((entry): entry is SegmentEvidence => entry != null);

  if (evidence.length === 0) {
    return emptyBaseline(baselineConfig.priorStrength);
  }

  const segmentInput = toSegmentInput(input);
  const candidates = FALLBACKS.map((fallback) => computeStats(evidence, segmentInput, fallback)).filter(
    (stats): stats is FallbackStats => stats != null
  );
  const globalStats: FallbackStats = {
    level: 'global',
    dimensions: [],
    segmentKey: 'global=perp_execution_quality',
    sampleCount: evidence.length,
    wins: evidence.filter((entry) => entry.win).length,
  };

  const comparableIndex = candidates.findIndex(
    (stats) => stats.sampleCount >= baselineConfig.minComparableSamples
  );

  if (comparableIndex >= 0) {
    const selected = candidates[comparableIndex]!;
    const priorProbability = resolvePrior(candidates, comparableIndex, globalStats);
    return {
      probability: smoothedProbability(selected, baselineConfig.priorStrength, priorProbability),
      comparable: true,
      source: 'segment_history_blended',
      fallbackLevel: selected.level,
      sampleCount: selected.sampleCount,
      wins: selected.wins,
      priorProbability,
      priorStrength: baselineConfig.priorStrength,
      segmentKey: selected.segmentKey,
      exclusionReason: null,
    };
  }

  const sparseIndex = candidates.findIndex((stats) => stats.sampleCount > 0);
  if (sparseIndex >= 0) {
    const selected = candidates[sparseIndex]!;
    const priorProbability = resolvePrior(candidates, sparseIndex, globalStats);
    return {
      probability: smoothedProbability(selected, baselineConfig.priorStrength, priorProbability),
      comparable: false,
      source: 'segment_history_blended',
      fallbackLevel: selected.level,
      sampleCount: selected.sampleCount,
      wins: selected.wins,
      priorProbability,
      priorStrength: baselineConfig.priorStrength,
      segmentKey: selected.segmentKey,
      exclusionReason: 'insufficient_samples',
    };
  }

  const globalPriorProbability = 0.5;
  return {
    probability: smoothedProbability(globalStats, baselineConfig.priorStrength, globalPriorProbability),
    comparable: false,
    source: 'global_prior',
    fallbackLevel: 'global',
    sampleCount: globalStats.sampleCount,
    wins: globalStats.wins,
    priorProbability: globalPriorProbability,
    priorStrength: baselineConfig.priorStrength,
    segmentKey: globalStats.segmentKey,
    exclusionReason: 'insufficient_samples',
  };
}
