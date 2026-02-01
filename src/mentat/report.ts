import type { DetectorBundle, MentatReport } from './types.js';
import { listAssumptions, listFragilityCards, listMechanisms } from '../memory/mentat.js';

function uniq(items: string[]): string[] {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)));
}

function formatScore(score: number | null): string {
  if (score == null || !Number.isFinite(score)) return 'n/a';
  return `${(score * 100).toFixed(1)}%`;
}

export function generateMentatReport(options: {
  system: string;
  limit?: number;
  detectors?: DetectorBundle;
}): MentatReport {
  const limit = Math.max(1, Math.min(Number(options.limit ?? 10), 50));
  const assumptions = listAssumptions({ system: options.system, limit: limit * 2, orderBy: 'stress' });
  const mechanisms = listMechanisms({ system: options.system, limit: limit * 2, orderBy: 'updated' });
  const cards = listFragilityCards({ system: options.system, limit: limit * 2, orderBy: 'score' });

  const mechanismById = new Map(mechanisms.map((mech) => [mech.id, mech]));

  const topCards = cards.slice(0, limit).map((card) => {
    const mechanism = card.mechanismId ? mechanismById.get(card.mechanismId)?.name : null;
    return {
      id: card.id,
      mechanism: mechanism ?? 'unknown mechanism',
      exposureSurface: card.exposureSurface ?? null,
      score: card.score ?? null,
      downside: card.downside ?? null,
    };
  });

  const stressed = assumptions
    .filter((assumption) => (assumption.stressScore ?? 0) >= 0.6)
    .slice(0, limit);
  const assumptionsUnderStress = (stressed.length > 0 ? stressed : assumptions.slice(0, limit)).map(
    (assumption) => ({
      id: assumption.id,
      statement: assumption.statement,
      stressScore: assumption.stressScore ?? null,
      lastTested: assumption.lastTested ?? null,
    })
  );

  const mechanismItems = mechanisms.slice(0, limit).map((mech) => ({
    id: mech.id,
    name: mech.name,
    triggerClass: mech.triggerClass ?? null,
    causalChain: mech.causalChain ?? [],
  }));

  const falsifiers = uniq(cards.flatMap((card) => card.falsifiers ?? []));
  const earlySignals = uniq(cards.flatMap((card) => card.earlySignals ?? []));
  const assumptionChecks = uniq(
    assumptionsUnderStress.map((assumption) => `Re-test assumption: ${assumption.statement}`)
  );

  const monitoringChecklist = uniq([...earlySignals, ...assumptionChecks]).slice(0, limit * 2);

  const fallbackFragilityScore = topCards.length > 0
    ? (topCards.reduce((sum, card) => sum + (card.score ?? 0), 0) / topCards.length)
    : null;

  return {
    system: options.system,
    generatedAt: new Date().toISOString(),
    fragilityScore: options.detectors?.overall ?? fallbackFragilityScore,
    detectors: options.detectors,
    topFragilityCards: topCards,
    assumptionsUnderStress,
    mechanisms: mechanismItems,
    falsifiers: falsifiers.slice(0, limit * 2),
    monitoringChecklist,
  };
}

export function formatMentatReport(report: MentatReport): string {
  const lines: string[] = [];
  lines.push(`🧠 Mentat Report: ${report.system}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('─'.repeat(60));
  lines.push(`Fragility Score: ${formatScore(report.fragilityScore)}`);

  if (report.detectors) {
    lines.push('Detector Breakdown');
    lines.push(`- Leverage: ${formatScore(report.detectors.leverage.score)}`);
    lines.push(`- Coupling: ${formatScore(report.detectors.coupling.score)}`);
    lines.push(`- Illiquidity: ${formatScore(report.detectors.illiquidity.score)}`);
    lines.push(`- Consensus: ${formatScore(report.detectors.consensus.score)}`);
    lines.push(`- Irreversibility: ${formatScore(report.detectors.irreversibility.score)}`);
  }

  lines.push('');
  lines.push('Top Fragility Cards');
  if (report.topFragilityCards.length === 0) {
    lines.push('- none');
  } else {
    for (const card of report.topFragilityCards) {
      lines.push(`- ${card.mechanism}: ${card.exposureSurface ?? 'n/a'} (${formatScore(card.score)})`);
      if (card.downside) {
        lines.push(`  downside: ${card.downside}`);
      }
    }
  }

  lines.push('');
  lines.push('Assumptions Under Stress');
  if (report.assumptionsUnderStress.length === 0) {
    lines.push('- none');
  } else {
    for (const assumption of report.assumptionsUnderStress) {
      lines.push(`- ${assumption.statement} (${formatScore(assumption.stressScore)})`);
    }
  }

  lines.push('');
  lines.push('Mechanisms');
  if (report.mechanisms.length === 0) {
    lines.push('- none');
  } else {
    for (const mechanism of report.mechanisms) {
      lines.push(`- ${mechanism.name}${mechanism.triggerClass ? ` [${mechanism.triggerClass}]` : ''}`);
      if (mechanism.causalChain.length > 0) {
        lines.push(`  chain: ${mechanism.causalChain.join(' → ')}`);
      }
    }
  }

  lines.push('');
  lines.push('Falsifiers');
  if (report.falsifiers.length === 0) {
    lines.push('- none');
  } else {
    for (const falsifier of report.falsifiers) {
      lines.push(`- ${falsifier}`);
    }
  }

  lines.push('');
  lines.push('Monitoring Checklist');
  if (report.monitoringChecklist.length === 0) {
    lines.push('- none');
  } else {
    for (const item of report.monitoringChecklist) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join('\n');
}
