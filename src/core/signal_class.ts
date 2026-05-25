function toOptionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const CANONICAL_SIGNAL_CLASSES = new Set([
  'momentum_breakout',
  'mean_reversion',
  'news_event',
  'liquidation_cascade',
  'unknown',
]);

export function toCanonicalSignalClass(value: string | null | undefined): string | null {
  if (!value) return null;
  return CANONICAL_SIGNAL_CLASSES.has(value) ? value : null;
}

export function inferSignalClassFromSetupKey(setupKey: string | null): string | null {
  if (!setupKey) return null;
  const normalized = setupKey.trim();
  const colonIndex = normalized.indexOf(':');
  if (colonIndex < 0 || colonIndex >= normalized.length - 1) {
    return null;
  }
  const candidate = normalized.slice(colonIndex + 1).trim();
  return candidate.length > 0 ? candidate : null;
}

export function inferSignalClassFromHypothesisId(hypothesisId: string | null): string | null {
  if (!hypothesisId) return null;
  const token = hypothesisId.toLowerCase();
  if (token.includes('_revert') || token.includes('mean_reversion')) return 'mean_reversion';
  if (token.includes('_trend') || token.includes('breakout') || token.includes('momentum')) {
    return 'momentum_breakout';
  }
  if (token.includes('_reflex') || token.includes('liquidation') || token.includes('cascade')) {
    return 'liquidation_cascade';
  }
  if (token.includes('news')) return 'news_event';
  return null;
}

export function inferSignalClass(params: {
  explicitSignalClass: string | null;
  toolInput: Record<string, unknown>;
  planContext: Record<string, unknown> | null;
  hypothesisId: string | null;
  entryTrigger: 'news' | 'technical' | 'hybrid' | null;
}): string | null {
  const explicitCanonical = toCanonicalSignalClass(params.explicitSignalClass);
  if (explicitCanonical) return explicitCanonical;

  const planContextRaw =
    toOptionalNonEmptyString(params.planContext?.signal_class) ??
    toOptionalNonEmptyString(params.planContext?.signalClass);
  const planContextCanonical = toCanonicalSignalClass(planContextRaw);
  if (planContextCanonical) return planContextCanonical;

  const setupKeyRaw =
    inferSignalClassFromSetupKey(toOptionalNonEmptyString(params.toolInput.setup_key)) ??
    inferSignalClassFromSetupKey(toOptionalNonEmptyString(params.toolInput.setupKey)) ??
    inferSignalClassFromSetupKey(toOptionalNonEmptyString(params.planContext?.setup_key)) ??
    inferSignalClassFromSetupKey(toOptionalNonEmptyString(params.planContext?.setupKey));
  const setupKeyCanonical = toCanonicalSignalClass(setupKeyRaw);
  if (setupKeyCanonical) return setupKeyCanonical;

  const inferredFromHypothesis = inferSignalClassFromHypothesisId(params.hypothesisId);
  if (inferredFromHypothesis) return inferredFromHypothesis;

  if (params.entryTrigger === 'news') return 'news_event';
  return null;
}
