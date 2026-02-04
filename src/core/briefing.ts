import { listRecentIntel } from '../intel/store.js';

export function buildBriefing(limit = 10): string {
  const intel = listRecentIntel(limit);

  const lines: string[] = [];
  lines.push('Daily Briefing');
  lines.push('─'.repeat(40));
  lines.push('Perp positions: use /portfolio for details.');

  if (intel.length === 0) {
    lines.push('No intel yet. Run /intel to fetch RSS.');
    return lines.join('\n');
  }

  lines.push('Intel:');
  for (const item of intel) {
    lines.push(`- ${item.title} (${item.source})`);
  }

  return lines.join('\n');
}
