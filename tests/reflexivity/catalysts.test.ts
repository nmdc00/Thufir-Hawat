import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listUpcomingCatalysts, computeCatalystProximityScore } from '../../src/reflexivity/catalysts.js';

describe('reflexivity/catalysts', () => {
  it('loads registry and filters upcoming scheduled catalysts by horizon', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-catalysts-'));
    const path = join(dir, 'catalysts.yaml');
    writeFileSync(
      path,
      [
        'catalysts:',
        '  - id: "cpi_soon"',
        '    type: "macro"',
        '    symbols: ["BTC", "ETH"]',
        `    scheduledUtc: "${new Date(Date.now() + 30 * 60 * 1000).toISOString()}"`,
        '    description: "CPI"',
        '  - id: "cpi_late"',
        '    type: "macro"',
        '    symbols: ["ETH"]',
        `    scheduledUtc: "${new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString()}"`,
        '    description: "later"',
        '',
      ].join('\n'),
      'utf-8'
    );

    const config = {
      reflexivity: {
        catalystsFile: path,
      },
    } as any;

    const nowMs = Date.now();
    const horizonSeconds = 2 * 60 * 60;
    const upcoming = listUpcomingCatalysts({
      config,
      baseSymbol: 'ETH',
      nowMs,
      horizonSeconds,
    });

    expect(upcoming.some((c) => c.id === 'cpi_soon')).toBe(true);
    expect(upcoming.some((c) => c.id === 'cpi_late')).toBe(false);

    const prox = computeCatalystProximityScore({ upcoming, horizonSeconds });
    expect(prox.score).toBeGreaterThan(0);
    expect(prox.score).toBeLessThanOrEqual(1);
    expect(prox.nextSecondsToEvent).not.toBeNull();
  });
});

