import { z } from 'zod';
import type { LlmClient } from './llm.js';
import type { ThufirConfig } from './config.js';
import type { BookEntry } from './position_book.js';
import { withExecutionContextIfMissing } from './llm_infra.js';
import { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ExitConsultDecision {
  action: 'hold' | 'reduce' | 'extend_ttl' | 'update_invalidation';
  reasoning: string;
  newTimeStopAtMs?: number;
  newInvalidationPrice?: number;
  reduceToFraction?: number;
}

// ---------------------------------------------------------------------------
// Zod schema for LLM response validation
// ---------------------------------------------------------------------------

const ExitConsultResponseSchema = z.object({
  action: z.enum(['hold', 'reduce', 'extend_ttl', 'update_invalidation']),
  reasoning: z.string(),
  newTimeStopAtMs: z.number().optional(),
  newInvalidationPrice: z.number().optional(),
  reduceToFraction: z.number().optional(),
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const ROE_THRESHOLDS = [0.03, 0.07, 0.15];        // 3%, 7%, 15%
const logger = new Logger('info');

function normalizeOptionalFieldPseudoJson(
  raw: string,
  optionalFields: string[]
): string {
  let normalized = raw;
  for (const field of optionalFields) {
    const pattern = new RegExp(`("${field}"\\s*:)\\s*undefined(?=\\s*[,}])`, 'g');
    normalized = normalized.replace(pattern, '$1 null');
  }
  return normalized;
}

function normalizeExitConsultOptionalFields(
  parsed: Record<string, unknown>
): Record<string, unknown> {
  for (const field of ['newTimeStopAtMs', 'newInvalidationPrice', 'reduceToFraction']) {
    if (parsed[field] === null) {
      delete parsed[field];
    }
  }
  return parsed;
}

function resolveFirstConsultMs(config: ThufirConfig): number {
  return Math.max(1, Number(config.heartbeat?.llmExitConsult?.firstConsultMinutes ?? 20)) * 60_000;
}

function resolveCadenceMs(config: ThufirConfig): number {
  return Math.max(1, Number(config.heartbeat?.llmExitConsult?.cadenceMinutes ?? 20)) * 60_000;
}

function resolveTtlApproachMs(config: ThufirConfig): number {
  return Math.max(0, Number(config.heartbeat?.llmExitConsult?.approachTtlMinutes ?? 15)) * 60_000;
}

function resolvePrimaryTimeoutMs(config: ThufirConfig): number {
  return Math.max(1, Number(config.heartbeat?.llmExitConsult?.primaryTimeoutMs ?? 30_000));
}

function resolveFallbackTimeoutMs(config: ThufirConfig): number {
  return Math.max(
    1,
    Number(
      config.heartbeat?.llmExitConsult?.fallbackTimeoutMs ??
      config.heartbeat?.llmExitConsult?.timeoutMs ??
      25_000
    )
  );
}

function resolveRoeThresholds(config: ThufirConfig): number[] {
  const configured = config.heartbeat?.llmExitConsult?.roeThresholds;
  if (!Array.isArray(configured) || configured.length === 0) {
    return ROE_THRESHOLDS;
  }
  return configured
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => (value > 1 ? value / 100 : value))
    .sort((a, b) => a - b);
}

function summarizeLlmError(error: unknown): { type: string; message: string } {
  if (error instanceof SyntaxError) {
    return { type: 'json_parse', message: error.message };
  }
  if (error instanceof z.ZodError) {
    return {
      type: 'schema_validation',
      message: error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { type: 'llm_call', message };
}

// ---------------------------------------------------------------------------
// LlmExitConsultant
// ---------------------------------------------------------------------------

export class LlmExitConsultant {
  constructor(
    private mainLlm: LlmClient,
    private fallbackLlm: LlmClient,
    private notify: (msg: string) => Promise<void>,
    private config: ThufirConfig,
  ) {}

  /**
   * Returns true if the position should be consulted right now.
   *
   * For structural trades (tradeType === 'structural'):
   * - Time-based cadence is suppressed (first consult at 4h, then every 4h)
   * - Positive ROE threshold crossings are suppressed — profit alone is not a reason to exit
   * - Significant drawdown (ROE ≤ −5%) triggers consultation
   * - Near-invalidation-price proximity (within 2% of hard invalidation rule) triggers consultation
   * - TTL approach trigger fires as normal
   *
   * For tactical/scalp trades:
   * - 20-min cadence, all ROE thresholds, TTL approach (unchanged behaviour)
   */
  shouldConsult(
    position: BookEntry,
    currentPrice: number,
    roe: number,
    nowMs: number,
  ): boolean {
    const isStructural = position.exitContract?.tradeType === 'structural';
    const absRoe = Math.abs(roe);
    const ttlApproachMs = resolveTtlApproachMs(this.config);

    // Time-based trigger — 4h cadence for structural, configured default otherwise
    const firstConsultMs = isStructural ? 4 * 60 * 60_000 : resolveFirstConsultMs(this.config);
    const cadenceMs = isStructural ? 4 * 60 * 60_000 : resolveCadenceMs(this.config);

    if (position.lastConsultAtMs === null) {
      // Never consulted — trigger once position is at least firstConsultMs old.
      // Use explicit entryAtMs when available; fall back to thesisExpiry - 2h proxy
      // (the historical default TTL). The proxy must never be negative: a TTL > 2h
      // would give entryAge < 0 and incorrectly trigger immediate consultation.
      const entryMs = position.entryAtMs ?? (position.thesisExpiresAtMs - 2 * 60 * 60 * 1000);
      const entryAge = nowMs - entryMs;
      if (entryAge >= firstConsultMs) {
        return true;
      }
    } else if (nowMs - position.lastConsultAtMs >= cadenceMs) {
      return true;
    }

    // ROE threshold crossing
    if (isStructural) {
      // Structural trades: only trigger on significant drawdown, never on profit
      if (roe <= -0.05) {
        return true;
      }
    } else {
      // Tactical/scalp: trigger on any threshold crossing (profit or loss)
      const roeThresholds = resolveRoeThresholds(this.config);
      let lastAbsRoe = 0;
      if (position.lastConsultDecision != null) {
        try {
          const prev = JSON.parse(position.lastConsultDecision) as { roeAtConsult?: number };
          if (typeof prev.roeAtConsult === 'number') {
            lastAbsRoe = Math.abs(prev.roeAtConsult);
          }
        } catch {
          // ignore parse errors
        }
      }
      for (const threshold of roeThresholds) {
        if (absRoe >= threshold && lastAbsRoe < threshold) {
          return true;
        }
      }
    }

    // TTL approach trigger — fires for all trade types
    const remainingMs = position.thesisExpiresAtMs - nowMs;
    if (remainingMs <= ttlApproachMs) {
      return true;
    }

    // Near-invalidation-price trigger (structural only) — consult before the hard close fires
    if (isStructural && currentPrice > 0) {
      const invalidationRule = position.exitContract?.hardRules.find(
        (r) => r.reason === 'thesis invalidation'
      );
      if (invalidationRule != null) {
        const proximity = Math.abs(currentPrice - invalidationRule.value) / currentPrice;
        if (proximity <= 0.02) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Ask the LLM for an exit decision. Falls back to fallbackLlm on timeout/error.
   * If both fail, returns safe default `hold`.
   */
  async consult(
    position: BookEntry,
    currentPrice: number,
    roe: number,
    freshContext: string,
  ): Promise<ExitConsultDecision> {
    const nowMs = Date.now();
    const timeHeldMs = nowMs - getEntryMs(position);
    const timeHeldMin = Math.max(0, Math.round(timeHeldMs / 60_000));
    const remainingMs = position.thesisExpiresAtMs - nowMs;
    const remainingMin = Math.round(remainingMs / 60_000);

    const messages = buildMessages(position, currentPrice, roe, timeHeldMin, remainingMin, freshContext);
    // Respect trivial prompt budget if configured (default 300 tokens for exit decisions).
    const maxTokens = Math.min(
      300,
      Math.floor((this.config.agent?.promptBudget?.trivial ?? 10000) / 4)
    );

    // Try main LLM — no maxTokens cap, matching AgenticOpenAiClient behaviour
    try {
      const decision = await withExecutionContextIfMissing(
        {
          mode: 'LIGHT_REASONING',
          critical: false,
          reason: 'exit_consultant_main',
          source: 'heartbeat',
        },
        () =>
          callWithTimeout(
            this.mainLlm,
            messages,
            resolvePrimaryTimeoutMs(this.config),
          )
      );
      await this.logDecision({ position, roe, nowMs, decision, usedFallback: false });
      return decision;
    } catch (error) {
      const summary = summarizeLlmError(error);
      logger.warn('Exit consultant main LLM failed; falling back', {
        provider: this.mainLlm.meta?.provider ?? 'unknown',
        model: this.mainLlm.meta?.model ?? 'unknown',
        symbol: position.symbol,
        side: position.side,
        failureType: summary.type,
        reason: summary.message,
      });
      // Fall through to fallback
    }

    // Try fallback LLM
    try {
      await this.notify('⚠️ Exit consultant: using fallback LLM — decision quality may be lower');
    } catch {
      // best-effort
    }
    try {
      const decision = await withExecutionContextIfMissing(
        {
          mode: 'LIGHT_REASONING',
          critical: false,
          reason: 'exit_consultant_fallback',
          source: 'heartbeat',
        },
        () =>
          callWithTimeout(
            this.fallbackLlm,
            messages,
            resolveFallbackTimeoutMs(this.config),
            maxTokens
          )
      );
      await this.logDecision({ position, roe, nowMs, decision, usedFallback: true });
      return decision;
    } catch (fallbackError) {
      const summary = summarizeLlmError(fallbackError);
      logger.warn('Exit consultant fallback LLM failed; using safe default', {
        provider: this.fallbackLlm.meta?.provider ?? 'unknown',
        model: this.fallbackLlm.meta?.model ?? 'unknown',
        symbol: position.symbol,
        side: position.side,
        failureType: summary.type,
        reason: summary.message,
      });
      // Fall through to safe default
    }

    // Both failed
    const safeDecision: ExitConsultDecision = {
      action: 'hold',
      reasoning: 'LLM unavailable — defaulting to hold (safe)',
    };
    await this.logDecision({ position, roe, nowMs, decision: safeDecision, usedFallback: true });
    return safeDecision;
  }

  private async logDecision(params: {
    position: BookEntry;
    roe: number;
    nowMs: number;
    decision: ExitConsultDecision;
    usedFallback: boolean;
  }): Promise<void> {
    const timeHeldMs = params.nowMs - getEntryMs(params.position);
    try {
      const { recordExitConsultDecision } = await import('../memory/llm_exit_consult_log.js');
      recordExitConsultDecision({
        symbol: params.position.symbol,
        side: params.position.side,
        roeAtConsult: params.roe,
        timeHeldMs: Math.max(0, timeHeldMs),
        action: params.decision.action,
        reasoning: params.decision.reasoning,
        newTimeStopAtMs: params.decision.newTimeStopAtMs ?? null,
        newInvalidationPrice: params.decision.newInvalidationPrice ?? null,
        reduceToFraction: params.decision.reduceToFraction ?? null,
        usedFallback: params.usedFallback ? 1 : 0,
      });
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEntryMs(position: BookEntry): number {
  return position.entryAtMs ?? (position.thesisExpiresAtMs - 2 * 60 * 60 * 1000);
}

function buildMessages(
  position: BookEntry,
  currentPrice: number,
  roe: number,
  timeHeldMin: number,
  remainingMin: number,
  freshContext: string,
): import('./llm.js').ChatMessage[] {
  const system =
    `You are Thufir, an LLM-primary trading agent reviewing an open position. ` +
    `Your default is HOLD. ` +
    `You are not a primary full-close authority. ` +
    `You may hold, reduce, extend_ttl, or update_invalidation. ` +
    `Do not emit close. ` +
    `Profit alone is NOT a reason to reduce. Slow momentum is NOT invalidation. ` +
    `A structural macro trade should be held until the thesis resolves or breaks — ` +
    `not harvested early because it has not yet repriced fully. ` +
    `Prefer extend_ttl over close when the thesis is intact but underdeveloped. ` +
    `Prefer update_invalidation when structure shifted but direction is valid.`;

  const roePct = (roe * 100).toFixed(2);
  const tradeType = position.exitContract?.tradeType ?? 'tactical';
  const user =
    `## Position state\n` +
    `symbol: ${position.symbol}\n` +
    `side: ${position.side}\n` +
    `size: ${position.size}\n` +
    `entry price: ${position.entryPrice}\n` +
    `current price: ${currentPrice}\n` +
    `ROE: ${roePct}%\n` +
    `trade type: ${tradeType}\n` +
    `time held: ${timeHeldMin} minutes\n` +
    `time remaining on thesis: ${remainingMin} minutes\n\n` +
    `## Original entry reasoning\n${position.entryReasoningText || '(none recorded)'}\n\n` +
    `## Exit contract\n${position.exitContractSummary || '(none recorded)'}\n\n` +
    `## Current market context\n${freshContext || '(none)'}\n\n` +
    `## Instruction\n` +
    `Respond ONLY with valid JSON matching this schema:\n` +
    `{"action":"hold"|"reduce"|"extend_ttl"|"update_invalidation","reasoning":"...","newTimeStopAtMs":number|undefined,"newInvalidationPrice":number|undefined,"reduceToFraction":number|undefined}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function callWithTimeout(
  llm: LlmClient,
  messages: import('./llm.js').ChatMessage[],
  timeoutMs: number,
  maxTokens?: number,
): Promise<ExitConsultDecision> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const response = await Promise.race([
      llm.complete(messages, {
        timeoutMs,
        signal: controller.signal,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`exit consultant timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);

    const text = typeof response.content === 'string' ? response.content.trim() : '';
    // Extract JSON from response (may be wrapped in markdown fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in LLM response');
    const normalized = normalizeOptionalFieldPseudoJson(
      jsonMatch[0],
      ['newTimeStopAtMs', 'newInvalidationPrice', 'reduceToFraction']
    );
    const parsed = normalizeExitConsultOptionalFields(
      JSON.parse(normalized) as Record<string, unknown>
    );
    return ExitConsultResponseSchema.parse(parsed);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
