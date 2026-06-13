export const EXIT_REASONS = [
  'thesis_invalidation',
  'thesis_time_stop',
  'exit_contract_rule',
  'llm_exit_consult',
  'liquidation_guard',
  'paper_liquidation',
  'equity_guard',
  'manual_command',
  'emergency_close',
  'legacy_trigger:pnl_shift',
  'legacy_trigger:volatility_spike',
  'legacy_trigger:time_ceiling',
  'unattributed',
] as const;

export type ExitReason = (typeof EXIT_REASONS)[number];

export type CloseAuthority = 'autonomous' | 'manual';

const EXIT_REASON_SET = new Set<string>(EXIT_REASONS);

export function isExitReason(value: unknown): value is ExitReason {
  return typeof value === 'string' && EXIT_REASON_SET.has(value);
}

function logInvalidExitReason(value: unknown, context: string | undefined): void {
  const location = context ? ` (${context})` : '';
  console.error(
    `[exit-attribution] Invalid or missing closeReason${location}; using unattributed fallback. value=${String(value)}`
  );
}

export function normalizeExitReason(
  value: unknown,
  context?: string
): { closeReason: ExitReason; fallback: boolean } {
  if (isExitReason(value)) {
    return { closeReason: value, fallback: false };
  }
  logInvalidExitReason(value, context);
  return { closeReason: 'unattributed', fallback: true };
}

export function normalizeCloseAuthority(value: unknown): CloseAuthority {
  return value === 'manual' ? 'manual' : 'autonomous';
}
