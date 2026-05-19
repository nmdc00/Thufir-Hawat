import type { LlmClient } from '../core/llm.js';
import { withExecutionContextIfMissing } from '../core/llm_infra.js';
import type { EscalationReason, EscalationSeverity } from './escalation.js';

type FaultInjectionMode = 'none' | 'throw' | 'timeout';

export interface AlertLlmEnrichmentConfig {
  enabled?: boolean;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  maxChars?: number;
}

export interface EnrichEscalationMessageInput {
  llm: LlmClient;
  baseMessage: string;
  source: string;
  reason: EscalationReason;
  severity: EscalationSeverity;
  summary: string;
  config?: AlertLlmEnrichmentConfig;
  faultInjectionMode?: FaultInjectionMode;
  onFallback?: (error: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_MAX_TOKENS = 140;
const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_MAX_CHARS = 420;

function normalizeConfig(config: AlertLlmEnrichmentConfig | undefined): Required<AlertLlmEnrichmentConfig> {
  return {
    enabled: config?.enabled ?? false,
    timeoutMs: Math.max(50, Number(config?.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
    maxTokens: Math.max(32, Number(config?.maxTokens ?? DEFAULT_MAX_TOKENS) || DEFAULT_MAX_TOKENS),
    temperature: Number.isFinite(config?.temperature)
      ? Number(config?.temperature)
      : DEFAULT_TEMPERATURE,
    maxChars: Math.max(80, Number(config?.maxChars ?? DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS),
  };
}

function resolveFaultInjection(mode?: FaultInjectionMode): FaultInjectionMode {
  if (mode) return mode;
  const fromEnv = String(process.env.THUFIR_ALERT_ENRICHMENT_FAULT ?? '').trim().toLowerCase();
  if (fromEnv === 'throw' || fromEnv === 'timeout') {
    return fromEnv;
  }
  return 'none';
}

function compactNarrative(raw: string, maxChars: number): string {
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3).trimEnd()}...` : compact;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`alert enrichment timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export async function enrichEscalationMessage(
  input: EnrichEscalationMessageInput
): Promise<string> {
  const cfg = normalizeConfig(input.config);
  if (!cfg.enabled) {
    return input.baseMessage;
  }

  const faultMode = resolveFaultInjection(input.faultInjectionMode);

  const enrichmentTask = async (): Promise<string> => {
    if (faultMode === 'throw') {
      throw new Error('fault injection: throw');
    }
    if (faultMode === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, cfg.timeoutMs + 100));
      return '';
    }

    const response = await withExecutionContextIfMissing(
      {
        mode: 'LIGHT_REASONING',
        critical: false,
        reason: 'alert_enrichment',
        source: 'gateway',
      },
      () =>
        input.llm.complete(
          [
            {
              role: 'system',
              content:
                'You write concise alert enrichment text. Return plain text only with no markdown headings.',
            },
            {
              role: 'user',
              content:
                `Source: ${input.source}\n` +
                `Severity: ${input.severity}\n` +
                `Reason: ${input.reason}\n` +
                `Summary: ${input.summary}\n\n` +
                'Write one short operator narrative with immediate context and one suggested next check.',
            },
          ],
          {
            temperature: cfg.temperature,
            maxTokens: cfg.maxTokens,
            timeoutMs: cfg.timeoutMs,
          }
        )
    );
    return compactNarrative(response.content, cfg.maxChars);
  };

  try {
    const narrative = await withTimeout(enrichmentTask(), cfg.timeoutMs);
    if (!narrative) {
      return input.baseMessage;
    }
    return `${input.baseMessage}\n\nLLM Context: ${narrative}`;
  } catch (error) {
    input.onFallback?.(error);
    return input.baseMessage;
  }
}
