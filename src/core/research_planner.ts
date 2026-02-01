import type { LlmClient } from './llm.js';
import type { ThufirConfig } from './config.js';
import type { Market, PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { listWatchlist } from '../memory/watchlist.js';
import { listIntelByIds } from '../intel/store.js';
import { ToolRegistry } from './tools.js';

export type ResearchAction =
  | 'intel.search'
  | 'intel.semantic'
  | 'market.related'
  | 'calibration.get'
  | 'watchlist.check';

export interface ResearchStep {
  action: ResearchAction;
  query?: string;
}

export interface ResearchPlan {
  steps: ResearchStep[];
}

export interface ResearchExecution {
  plan: ResearchPlan;
  context: string;
}

const DEFAULT_STEPS: ResearchStep[] = [
  { action: 'watchlist.check' },
  { action: 'intel.semantic' },
  { action: 'intel.search' },
  { action: 'calibration.get' },
  { action: 'market.related' },
];

function normalizeSteps(steps: ResearchStep[]): ResearchStep[] {
  const allowed = new Set<ResearchAction>([
    'intel.search',
    'intel.semantic',
    'market.related',
    'calibration.get',
    'watchlist.check',
  ]);
  return steps
    .filter((step) => allowed.has(step.action))
    .map((step) => ({
      action: step.action,
      query: step.query?.trim() || undefined,
    }));
}

export async function createResearchPlan(params: {
  llm: LlmClient;
  subject: string;
  maxSteps?: number;
}): Promise<ResearchPlan> {
  const maxSteps = Math.max(2, params.maxSteps ?? 5);
  const prompt = [
    'Create a short research plan for a prediction market analysis.',
    `Return JSON with shape: {"steps":[{"action":"intel.search|intel.semantic|market.related|calibration.get|watchlist.check","query":"optional"}]}.`,
    `Use at most ${maxSteps} steps. Use "query" only when needed.`,
    `Subject: ${params.subject}`,
  ].join('\n');

  try {
    const response = await params.llm.complete(
      [
        { role: 'system', content: 'You are a precise planner that outputs JSON only.' },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.2 }
    );
    const parsed = JSON.parse(response.content) as ResearchPlan;
    if (parsed && Array.isArray(parsed.steps)) {
      const steps = normalizeSteps(parsed.steps).slice(0, maxSteps);
      if (steps.length > 0) {
        return { steps };
      }
    }
  } catch {
    // fall back
  }

  return { steps: DEFAULT_STEPS.slice(0, maxSteps) };
}

function formatCalibrationSummary(summary: {
  domain: string;
  accuracy: number | null;
  avgBrier: number | null;
  resolvedPredictions: number;
}): string {
  const accuracy =
    summary.accuracy === null ? 'N/A' : `${(summary.accuracy * 100).toFixed(1)}%`;
  const brier = summary.avgBrier === null ? 'N/A' : summary.avgBrier.toFixed(4);
  return `${summary.domain}: ${accuracy} accuracy, Brier ${brier} (${summary.resolvedPredictions} resolved)`;
}

function formatIntelList(
  items: Array<{ title: string; source: string; timestamp: string }>
): string {
  if (items.length === 0) {
    return 'No intel matches.';
  }
  const lines = items.slice(0, 5).map((item) => {
    const date = item.timestamp ? new Date(item.timestamp).toLocaleDateString() : '';
    return `- [${date}] ${item.title} (${item.source})`;
  });
  return lines.join('\n');
}

export async function runResearchPlan(params: {
  config: ThufirConfig;
  marketClient: PolymarketMarketClient;
  subject: { id?: string; question: string; category?: string };
  plan: ResearchPlan;
  tools?: ToolRegistry;
}): Promise<ResearchExecution> {
  const planLines = params.plan.steps.map(
    (step, idx) => `${idx + 1}. ${step.action}${step.query ? ` (${step.query})` : ''}`
  );

  const findings: string[] = [];
  const tools = params.tools ?? new ToolRegistry();

  for (const step of params.plan.steps) {
    switch (step.action) {
      case 'watchlist.check': {
        const watchlist = listWatchlist(200);
        const isWatchlisted = !!params.subject.id &&
          watchlist.some((item) => item.marketId === params.subject.id);
        findings.push(`Watchlist: ${isWatchlisted ? 'in watchlist' : 'not in watchlist'}.`);
        break;
      }
      case 'intel.search': {
        const query = step.query || params.subject.question;
        const result = await tools.run(
          'intel.search',
          { config: params.config, marketClient: params.marketClient },
          { query, limit: 5, fromDays: 14 }
        );
        const items = (result.items as Array<{ title: string; source: string; timestamp: string }>) ?? [];
        findings.push(`Intel search "${query}":\n${formatIntelList(items)}`);
        break;
      }
      case 'intel.semantic': {
        const result = await tools.run(
          'intel.semantic',
          { config: params.config, marketClient: params.marketClient },
          { query: params.subject.question, limit: 5 }
        );
        const hits = (result.hits as Array<{ id: string }>) ?? [];
        const items = hits.length > 0 ? listIntelByIds(hits.map((hit) => hit.id)) : [];
        findings.push(`Semantic intel matches:\n${formatIntelList(items)}`);
        break;
      }
      case 'market.related': {
        const query = step.query || params.subject.question;
        const result = await tools.run(
          'market.search',
          { config: params.config, marketClient: params.marketClient },
          { query, limit: 5 }
        );
        const markets = (result.markets as Market[]) ?? [];
        if (markets.length === 0) {
          findings.push(`Related markets: none found for "${query}".`);
        } else {
          const titles = markets.map((market) => `- ${market.question}`).join('\n');
          findings.push(`Related markets for "${query}":\n${titles}`);
        }
        break;
      }
      case 'calibration.get': {
        const result = await tools.run(
          'calibration.summary',
          { config: params.config, marketClient: params.marketClient },
          { domain: params.subject.category }
        );
        const summaries = (result.summaries as Array<{
          domain: string;
          accuracy: number | null;
          avgBrier: number | null;
          resolvedPredictions: number;
        }>) ?? [];
        const summary = summaries[0];
        const formatted = summary
          ? formatCalibrationSummary(summary)
          : 'No calibration data available.';
        findings.push(`Calibration: ${formatted}`);
        break;
      }
      default:
        break;
    }
  }

  const context = [
    '## Research Plan',
    ...planLines,
    '',
    '## Research Findings',
    ...findings,
    '',
  ].join('\n');

  return { plan: params.plan, context };
}
