import type { PerpTradeJournalEntry } from '../memory/perp_trade_journal.js';
import { inferTradeSymbolClass } from './trade_similarity.js';

export type SignalPerformanceScopeLevel =
  | 'signal_class_and_symbol_class_and_regime'
  | 'signal_class_and_symbol_class'
  | 'signal_class';

export type SignalPerformanceSummary = {
  signalClass: string;
  sampleCount: number;
  observedCount: number;
  blockedCount: number;
  unresolvedCount: number;
  wins: number;
  losses: number;
  thesisCorrectRate: number;
  expectancy: number;
  variance: number;
  sharpeLike: number;
  maeProxy: number;
  mfeProxy: number;
  symbolClass?: string | null;
  marketRegime?: string | null;
  scopeLevel?: SignalPerformanceScopeLevel;
};

export type ComparableSignalPerformanceInput = {
  signalClass: string;
  symbolClass?: string | null;
  marketRegime?: string | null;
};

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function variance(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  return mean(values.map((value) => (value - m) ** 2));
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveEntrySymbolClass(entry: PerpTradeJournalEntry): string | null {
  const explicit = normalizeText(entry.symbolClass ?? null);
  if (explicit) return explicit;
  const symbol = normalizeText(entry.symbol);
  return symbol ? inferTradeSymbolClass(symbol) : null;
}

function summarizeScopedSignalPerformance(
  entries: PerpTradeJournalEntry[],
  scope: ComparableSignalPerformanceInput,
  scopeLevel: SignalPerformanceScopeLevel
): SignalPerformanceSummary {
  const signalClass = normalizeText(scope.signalClass) ?? '';
  const normalizedSymbolClass = normalizeText(scope.symbolClass);
  const normalizedMarketRegime = normalizeText(scope.marketRegime);
  const scoped = entries.filter((entry) => {
    const entryClass = normalizeText(entry.signalClass ?? null);
    if (entryClass !== signalClass) return false;
    if (normalizedSymbolClass && resolveEntrySymbolClass(entry) !== normalizedSymbolClass) {
      return false;
    }
    if (normalizedMarketRegime && normalizeText(entry.marketRegime ?? null) !== normalizedMarketRegime) {
      return false;
    }
    return true;
  });

  const blockedCount = scoped.filter((entry) => entry.outcome === 'blocked').length;
  const comparable = scoped.filter((entry) => typeof entry.thesisCorrect === 'boolean');
  const unresolvedCount = scoped.length - blockedCount - comparable.length;
  const outcomes = comparable.map((entry) => (entry.thesisCorrect === true ? 1 : -1));
  const wins = comparable.filter((entry) => entry.thesisCorrect === true).length;
  const losses = comparable.filter((entry) => entry.thesisCorrect === false).length;
  const sampleCount = comparable.length;
  const expectancy = mean(outcomes);
  const varScore = variance(outcomes);
  const stdScore = Math.sqrt(Math.max(varScore, 1e-9));
  const sharpeLike = outcomes.length >= 2 ? expectancy / stdScore : 0;
  const adverseMoves = comparable
    .map((entry) => Number(entry.maeProxy ?? NaN))
    .filter((value) => Number.isFinite(value));
  const favorableMoves = comparable
    .map((entry) => Number(entry.mfeProxy ?? NaN))
    .filter((value) => Number.isFinite(value));

  return {
    signalClass,
    sampleCount,
    observedCount: scoped.length,
    blockedCount,
    unresolvedCount,
    wins,
    losses,
    thesisCorrectRate: sampleCount > 0 ? wins / sampleCount : 0,
    expectancy,
    variance: varScore,
    sharpeLike,
    maeProxy: mean(adverseMoves),
    mfeProxy: mean(favorableMoves),
    symbolClass: normalizedSymbolClass,
    marketRegime: normalizedMarketRegime,
    scopeLevel,
  };
}

export function summarizeSignalPerformance(
  entries: PerpTradeJournalEntry[],
  signalClass: string
): SignalPerformanceSummary {
  return summarizeScopedSignalPerformance(entries, { signalClass }, 'signal_class');
}

export function summarizeComparableSignalPerformance(
  entries: PerpTradeJournalEntry[],
  input: ComparableSignalPerformanceInput
): SignalPerformanceSummary {
  const normalizedSignalClass = normalizeText(input.signalClass) ?? '';
  const normalizedSymbolClass = normalizeText(input.symbolClass);
  const normalizedMarketRegime = normalizeText(input.marketRegime);
  const candidates: Array<{ scope: ComparableSignalPerformanceInput; level: SignalPerformanceScopeLevel }> = [];

  if (normalizedSymbolClass && normalizedMarketRegime) {
    candidates.push({
      scope: {
        signalClass: normalizedSignalClass,
        symbolClass: normalizedSymbolClass,
        marketRegime: normalizedMarketRegime,
      },
      level: 'signal_class_and_symbol_class_and_regime',
    });
  }
  if (normalizedSymbolClass) {
    candidates.push({
      scope: { signalClass: normalizedSignalClass, symbolClass: normalizedSymbolClass },
      level: 'signal_class_and_symbol_class',
    });
  }
  candidates.push({
    scope: { signalClass: normalizedSignalClass },
    level: 'signal_class',
  });

  let fallback = summarizeScopedSignalPerformance(entries, { signalClass: normalizedSignalClass }, 'signal_class');
  for (const candidate of candidates) {
    const summary = summarizeScopedSignalPerformance(entries, candidate.scope, candidate.level);
    fallback = summary;
    if (summary.sampleCount > 0) {
      return summary;
    }
  }
  return fallback;
}

export function summarizeAllSignalClasses(
  entries: PerpTradeJournalEntry[]
): Record<string, SignalPerformanceSummary> {
  const classes = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.signalClass === 'string' && entry.signalClass.trim().length > 0) {
      classes.add(entry.signalClass);
    }
  }

  const out: Record<string, SignalPerformanceSummary> = {};
  for (const signalClass of classes) {
    out[signalClass] = summarizeSignalPerformance(entries, signalClass);
  }
  return out;
}
