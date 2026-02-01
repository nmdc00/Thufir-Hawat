/**
 * Opportunity Scanner
 *
 * Proactively scans Polymarket for opportunities based on:
 * 1. Current news/intel
 * 2. Market prices vs LLM estimates
 * 3. User's calibration history
 */

import type { LlmClient } from './llm.js';
import type { ThufirConfig } from './config.js';
import type { Market, PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { listCalibrationSummaries } from '../memory/calibration.js';
import { listRecentIntel } from '../intel/store.js';
import { runOrchestrator } from '../agent/orchestrator/orchestrator.js';
import { AgentToolRegistry } from '../agent/tools/registry.js';
import { registerAllTools } from '../agent/tools/adapters/index.js';
import { loadThufirIdentity } from '../agent/identity/identity.js';
import type { AgentIdentity } from '../agent/identity/types.js';

export interface Opportunity {
  market: Market;
  myEstimate: number;
  marketPrice: number;
  edge: number;
  direction: 'LONG_YES' | 'SHORT_YES' | 'LONG_NO' | 'SHORT_NO';
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
  relevantNews: string[];
  suggestedAmount: number;
  rank: number;
}

export interface DailyReport {
  date: string;
  opportunities: Opportunity[];
  totalEdgeFound: number;
  marketsScanned: number;
  newsItemsAnalyzed: number;
  generatedAt: Date;
  mentatReport?: string;
}

export interface OrchestratorAssets {
  registry: AgentToolRegistry;
  identity: AgentIdentity;
}

const OPPORTUNITY_SYSTEM_PROMPT = `You are Thufir, an expert prediction market analyst. Your job is to find trading opportunities by comparing market prices to your probability estimates.

For each market, you will:
1. Analyze the question and current price
2. Consider any relevant news provided
3. Estimate the true probability
4. Identify if there's edge (your estimate differs from market by >5%)

Return JSON array with your analysis of each market:
[
  {
    "marketId": "string",
    "myEstimate": 0.XX (your probability for YES),
    "confidence": "low" | "medium" | "high",
    "reasoning": "Brief explanation of key factors",
    "relevantNewsIndices": [0, 2] (indices of news items that influenced this)
  }
]

Be calibrated - don't claim high confidence without strong evidence.
If you don't have enough information, estimate close to market price with low confidence.
Edge = |myEstimate - marketPrice|. Only flag opportunities where edge >= 0.05.`;

/**
 * Scan markets and find opportunities
 */
export async function scanForOpportunities(
  llm: LlmClient,
  marketClient: PolymarketMarketClient,
  config: ThufirConfig,
  maxMarkets = 50,
  options?: { orchestrator?: OrchestratorAssets }
): Promise<Opportunity[]> {
  // Fetch markets and news
  const markets = await marketClient.listMarkets(maxMarkets);
  const recentNews = listRecentIntel(30);
  const calibration = listCalibrationSummaries();

  // Build news context
  const newsContext = recentNews.map((item, i) =>
    `[${i}] ${item.title} (${item.source}, ${item.timestamp})`
  ).join('\n');

  // Build market context
  const marketContext = markets.map(m => {
    const yesPrice = getYesPrice(m);
    return `- ID: ${m.id}
  Question: ${m.question}
  YES Price: ${(yesPrice * 100).toFixed(0)}%
  Category: ${m.category ?? 'unknown'}
  Volume: $${(m.volume ?? 0).toLocaleString()}`;
  }).join('\n\n');

  // Build calibration context
  const calibrationContext = calibration.length > 0
    ? `Your historical accuracy:\n${calibration.map(c =>
        `- ${c.domain}: ${c.accuracy !== null ? (c.accuracy * 100).toFixed(0) + '%' : 'N/A'} accuracy`
      ).join('\n')}`
    : 'No calibration data yet - be conservative.';

  const prompt = `## Recent News
${newsContext || 'No recent news available.'}

## Active Markets
${marketContext}

## Your Calibration
${calibrationContext}

## Task
Analyze these markets. For each one, estimate the true probability and identify opportunities where your estimate differs from market price by ≥5%.

Focus on markets where the news gives you an informational edge.
Return a JSON array with your analysis.`;

  let responseContent: string;

  if (config.agent?.useOrchestrator) {
    const registry = options?.orchestrator?.registry ?? new AgentToolRegistry();
    if (!options?.orchestrator) {
      registerAllTools(registry);
    }
    const identity =
      options?.orchestrator?.identity ??
      loadThufirIdentity({
        workspacePath: config.agent?.workspace,
      }).identity;

    const result = await runOrchestrator(
      'Generate opportunity analysis JSON for the provided markets.',
      {
        llm,
        toolRegistry: registry,
        identity,
        toolContext: { config, marketClient },
        memorySystem: {
          getRelevantContext: async () => prompt,
        },
      },
      {
        skipPlanning: true,
        skipCritic: true,
        maxIterations: 1,
        synthesisSystemPrompt:
          'Return ONLY a JSON array matching the requested schema. No markdown, no commentary.',
      }
    );
    responseContent = result.response;
  } else {
    const response = await llm.complete(
      [
        { role: 'system', content: OPPORTUNITY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.3 }
    );
    responseContent = response.content;
  }

  // Parse response
  const analyses = parseAnalyses(responseContent);

  // Convert to opportunities
  const opportunities: Opportunity[] = [];

  for (const analysis of analyses) {
    const market = markets.find(m => m.id === analysis.marketId);
    if (!market) continue;

    const marketPrice = getYesPrice(market);
    const edge = Math.abs(analysis.myEstimate - marketPrice);

    if (edge < 0.05) continue; // Skip low-edge opportunities

    const direction = analysis.myEstimate > marketPrice ? 'LONG_YES' : 'SHORT_YES';

    // Calculate suggested amount based on edge and confidence
    const baseAmount = config.wallet?.limits?.perTrade ?? 25;
    const confidenceMultiplier =
      analysis.confidence === 'high' ? 1.0 :
      analysis.confidence === 'medium' ? 0.6 : 0.3;
    const edgeMultiplier = Math.min(edge * 5, 1); // Cap at 1x
    const suggestedAmount = Math.round(baseAmount * confidenceMultiplier * edgeMultiplier);

    opportunities.push({
      market,
      myEstimate: analysis.myEstimate,
      marketPrice,
      edge,
      direction,
      confidence: analysis.confidence,
      reasoning: analysis.reasoning,
      relevantNews: (analysis.relevantNewsIndices ?? [])
        .map((i: number) => recentNews[i]?.title)
        .filter((title): title is string => typeof title === 'string'),
      suggestedAmount: Math.max(suggestedAmount, 5), // Minimum $5
      rank: 0, // Will be set after sorting
    });
  }

  // Sort by edge * confidence score
  opportunities.sort((a, b) => {
    const scoreA = a.edge * confidenceScore(a.confidence);
    const scoreB = b.edge * confidenceScore(b.confidence);
    return scoreB - scoreA;
  });

  // Assign ranks
  opportunities.forEach((opp, i) => {
    opp.rank = i + 1;
  });

  return opportunities;
}

/**
 * Generate the Daily Top 10 report
 */
export async function generateDailyReport(
  llm: LlmClient,
  marketClient: PolymarketMarketClient,
  config: ThufirConfig,
  options?: { orchestrator?: OrchestratorAssets }
): Promise<DailyReport> {
  const opportunities = await scanForOpportunities(
    llm,
    marketClient,
    config,
    100,
    options
  );
  const top10 = opportunities.slice(0, 10);

  const totalEdge = top10.reduce((sum, o) => sum + o.edge, 0);

  let mentatReport: string | undefined;
  if (config.agent?.mentatAutoScan) {
    try {
      const { runMentatScan } = await import('../mentat/scan.js');
      const { generateMentatReport, formatMentatReport } = await import('../mentat/report.js');
      const scan = await runMentatScan({
        system: config.agent?.mentatSystem ?? 'Polymarket',
        llm,
        marketClient,
        marketQuery: config.agent?.mentatMarketQuery,
        limit: config.agent?.mentatMarketLimit,
        intelLimit: config.agent?.mentatIntelLimit,
      });
      const report = generateMentatReport({
        system: scan.system,
        detectors: scan.detectors,
      });
      mentatReport = formatMentatReport(report);
    } catch {
      mentatReport = undefined;
    }
  }

  return {
    date: new Date().toISOString().split('T')[0] ?? new Date().toISOString(),
    opportunities: top10,
    totalEdgeFound: totalEdge,
    marketsScanned: 100,
    newsItemsAnalyzed: listRecentIntel(30).length,
    generatedAt: new Date(),
    mentatReport,
  };
}

/**
 * Format the daily report for display
 */
export function formatDailyReport(report: DailyReport): string {
  const lines: string[] = [];

  lines.push(`📊 **Daily Top 10 Opportunities** (${report.date})`);
  lines.push('');
  lines.push(`Markets scanned: ${report.marketsScanned} | News analyzed: ${report.newsItemsAnalyzed}`);
  lines.push('─'.repeat(50));
  lines.push('');

  if (report.opportunities.length === 0) {
    lines.push('No significant opportunities found today.');
    lines.push('Markets appear fairly priced based on available information.');
    return lines.join('\n');
  }

  for (const opp of report.opportunities) {
    const directionEmoji = opp.direction.startsWith('LONG') ? '📈' : '📉';
    const confidenceEmoji =
      opp.confidence === 'high' ? '🟢' :
      opp.confidence === 'medium' ? '🟡' : '🔴';

    lines.push(`**${opp.rank}. ${opp.market.question}**`);
    lines.push(`   ${directionEmoji} ${opp.direction.replace('_', ' ')} | Edge: ${(opp.edge * 100).toFixed(1)}%`);
    lines.push(`   Market: ${(opp.marketPrice * 100).toFixed(0)}% → My estimate: ${(opp.myEstimate * 100).toFixed(0)}%`);
    lines.push(`   ${confidenceEmoji} Confidence: ${opp.confidence} | Suggested: $${opp.suggestedAmount}`);
    lines.push(`   💡 ${opp.reasoning}`);

    if (opp.relevantNews.length > 0) {
      lines.push(`   📰 News: ${opp.relevantNews.slice(0, 2).join('; ')}`);
    }

    lines.push(`   ID: \`${opp.market.id}\``);
    lines.push('');
  }

  lines.push('─'.repeat(50));
  lines.push(`Total edge identified: ${(report.totalEdgeFound * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('Use `/trade <id> <YES|NO> <amount>` to execute.');

  if (report.mentatReport) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(report.mentatReport);
  }

  return lines.join('\n');
}

// Helper functions

function getYesPrice(market: Market): number {
  return market.prices['Yes'] ?? market.prices['YES'] ?? market.prices[0] ?? 0.5;
}

function confidenceScore(confidence: string): number {
  switch (confidence) {
    case 'high': return 1.0;
    case 'medium': return 0.6;
    case 'low': return 0.3;
    default: return 0.3;
  }
}

interface MarketAnalysis {
  marketId: string;
  myEstimate: number;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
  relevantNewsIndices?: number[];
}

function parseAnalyses(content: string): MarketAnalysis[] {
  try {
    // Find JSON array in response
    const jsonStart = content.indexOf('[');
    const jsonEnd = content.lastIndexOf(']');

    if (jsonStart === -1 || jsonEnd === -1) {
      return [];
    }

    const jsonStr = content.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(item =>
      item.marketId &&
      typeof item.myEstimate === 'number' &&
      item.myEstimate >= 0 &&
      item.myEstimate <= 1
    );
  } catch {
    return [];
  }
}
