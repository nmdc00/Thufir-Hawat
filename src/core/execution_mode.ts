import { createHash } from 'node:crypto';

import type { ThufirConfig } from './config.js';
import type { ExecutionContext, ExecutionMode } from './llm_infra.js';
import { isCooling } from './llm_infra.js';
import { getExecutionState, upsertExecutionState } from '../memory/execution_state.js';

export type ExecutionSelection = ExecutionContext & {
  changed: boolean;
  previousFingerprint: string | null;
};

export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`);
  return `{${entries.join(',')}}`;
}

export function computeFingerprint(value: unknown): string {
  const payload = stableStringify(value);
  return createHash('sha256').update(payload).digest('hex');
}

function resolveProvider(config: ThufirConfig, providerOverride?: string): string {
  if (providerOverride) return providerOverride;
  return config.agent?.provider ?? 'anthropic';
}

function resolveModel(config: ThufirConfig, modelOverride?: string): string {
  if (modelOverride) return modelOverride;
  return config.agent?.model ?? 'unknown';
}

export function selectExecutionContext(params: {
  config: ThufirConfig;
  source: string;
  reason: string;
  fingerprint: string;
  preferredMode: ExecutionMode;
  critical?: boolean;
  providerOverride?: string;
  modelOverride?: string;
}): ExecutionSelection {
  const { config, source, reason, fingerprint, preferredMode } = params;
  const critical = params.critical ?? false;

  const previous = getExecutionState(source);
  const previousFingerprint = previous?.fingerprint ?? null;
  const changed = !previousFingerprint || previousFingerprint !== fingerprint;

  let mode: ExecutionMode = preferredMode;
  let recordedReason = reason;
  if (!changed && !critical) {
    mode = 'MONITOR_ONLY';
    recordedReason = `${reason}:no_change`;
  }

  const provider = resolveProvider(config, params.providerOverride);
  const model = resolveModel(config, params.modelOverride);
  const cooldown = isCooling(provider, model);
  if (cooldown && !critical) {
    mode = 'MONITOR_ONLY';
    recordedReason = `${reason}:cooldown`;
  }

  const context: ExecutionSelection = {
    mode,
    critical,
    reason,
    source,
    changed,
    previousFingerprint,
  };

  upsertExecutionState({
    source,
    fingerprint,
    lastMode: mode,
    lastReason: recordedReason,
  });

  return context;
}
