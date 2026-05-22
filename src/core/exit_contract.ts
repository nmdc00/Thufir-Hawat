import { z } from 'zod';

const ExitMetricSchema = z.enum(['mark_price', 'roe_pct', 'liq_dist_pct']);
const ExitOperatorSchema = z.enum(['<', '<=', '>', '>=']);
const ExitActionSchema = z.enum(['close', 'reduce']);

export const ExitHardRuleSchema = z.object({
  metric: ExitMetricSchema,
  op: ExitOperatorSchema,
  value: z.number().finite(),
  action: ExitActionSchema,
  reason: z.string().min(1),
  reduceToFraction: z.number().min(0).max(1).optional(),
});

export const ExitContractSchema = z.object({
  thesis: z.string().min(1),
  tradeType: z.enum(['scalp', 'tactical', 'structural']).default('tactical'),
  hardRules: z.array(ExitHardRuleSchema).default([]),
  reviewGuidance: z.array(z.string().min(1)).default([]),
});

export type ExitMetric = z.infer<typeof ExitMetricSchema>;
export type ExitOperator = z.infer<typeof ExitOperatorSchema>;
export type ExitAction = z.infer<typeof ExitActionSchema>;
export type ExitHardRule = z.infer<typeof ExitHardRuleSchema>;
export type ExitContract = z.infer<typeof ExitContractSchema>;

export type ExitContractState = {
  markPrice: number | null;
  roePct: number | null;
  liqDistPct: number | null;
};

export type ExitRuleEvaluation =
  | {
      action: 'close';
      reason: string;
      rule: ExitHardRule;
    }
  | {
      action: 'reduce';
      reason: string;
      rule: ExitHardRule;
      reduceToFraction: number;
    };

function compare(left: number, op: ExitOperator, right: number): boolean {
  switch (op) {
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
  }
}

function resolveMetricValue(state: ExitContractState, metric: ExitMetric): number | null {
  switch (metric) {
    case 'mark_price':
      return state.markPrice;
    case 'roe_pct':
      return state.roePct;
    case 'liq_dist_pct':
      return state.liqDistPct;
  }
}

export function parseExitContract(raw: unknown): ExitContract | null {
  if (raw == null) return null;
  let parsedRaw = raw;
  if (typeof raw === 'string') {
    try {
      parsedRaw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = ExitContractSchema.safeParse(parsedRaw);
  return parsed.success ? parsed.data : null;
}

export function serializeExitContract(contract: ExitContract): string {
  return JSON.stringify(ExitContractSchema.parse(contract));
}

export function evaluateExitContract(
  contract: ExitContract | null,
  state: ExitContractState
): ExitRuleEvaluation | null {
  if (!contract) return null;
  for (const rule of contract.hardRules) {
    const current = resolveMetricValue(state, rule.metric);
    if (current == null) continue;
    if (!compare(current, rule.op, rule.value)) continue;
    if (rule.action === 'close') {
      return { action: 'close', reason: rule.reason, rule };
    }
    return {
      action: 'reduce',
      reason: rule.reason,
      rule,
      reduceToFraction:
        rule.reduceToFraction != null ? rule.reduceToFraction : 0.5,
    };
  }
  return null;
}

export function summarizeExitContract(contract: ExitContract | null): string {
  if (!contract) return '(none)';
  const hardRules =
    contract.hardRules.length > 0
      ? contract.hardRules
          .map((rule) =>
            `${rule.action} when ${rule.metric} ${rule.op} ${rule.value}` +
            (rule.action === 'reduce' && rule.reduceToFraction != null
              ? ` to ${rule.reduceToFraction}`
              : '') +
            ` (${rule.reason})`
          )
          .join('; ')
      : 'none';
  const reviewGuidance =
    contract.reviewGuidance.length > 0 ? contract.reviewGuidance.join('; ') : 'none';
  return `trade_type=${contract.tradeType}; thesis=${contract.thesis}; hard_rules=${hardRules}; review_guidance=${reviewGuidance}`;
}

export function buildLegacyExitContract(params: {
  thesis: string;
  invalidationPrice?: number | null;
  side: 'long' | 'short';
  tradeType?: 'scalp' | 'tactical' | 'structural';
}): ExitContract {
  const hardRules: ExitHardRule[] = [];
  if (params.invalidationPrice != null && Number.isFinite(params.invalidationPrice)) {
    hardRules.push({
      metric: 'mark_price',
      op: params.side === 'long' ? '<=' : '>=',
      value: params.invalidationPrice,
      action: 'close',
      reason: 'thesis invalidation',
    });
  }

  return {
    thesis: params.thesis.trim() || 'Trade thesis',
    tradeType: params.tradeType ?? 'tactical',
    hardRules,
    reviewGuidance: [
      'Hold as long as the original thesis narrative remains intact — slow momentum is not invalidation.',
      'Full close belongs to hard invalidation or emergency risk; otherwise prefer holding or measured de-risking.',
      'Use extend_ttl if the thesis is valid but needs more time. Use update_invalidation if structure shifted but direction holds.',
    ],
  };
}
