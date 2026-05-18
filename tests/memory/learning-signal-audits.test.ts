import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordOutcome } from '../../src/memory/calibration.js';
import { openDatabase } from '../../src/memory/db.js';
import { getSignalWeights } from '../../src/memory/learning.js';
import { listLearningSignalAudits } from '../../src/memory/learning_observability.js';
import { createPrediction, getPrediction } from '../../src/memory/predictions.js';

function useTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-learning-signal-audits-'));
  const path = join(dir, 'thufir.sqlite');
  process.env.THUFIR_DB_PATH = path;
  return path;
}

describe('learning signal audits', () => {
  beforeEach(() => {
    useTempDb();
  });

  it('persists signal scores on perp prediction writes', () => {
    const id = createPrediction({
      marketId: 'perp:BTC',
      marketTitle: 'BTC long signal snapshot',
      predictedOutcome: 'YES',
      predictedProbability: 0.68,
      modelProbability: 0.68,
      domain: 'perp',
      executed: true,
      signalScores: {
        technical: 0.91,
        news: 0.27,
        onChain: 0.44,
      },
      signalWeightsSnapshot: {
        technical: 0.5,
        news: 0.3,
        onChain: 0.2,
      },
    });

    const prediction = getPrediction(id);
    expect(prediction?.signalScores).toEqual({
      technical: 0.91,
      news: 0.27,
      onChain: 0.44,
    });

    const db = openDatabase();
    const row = db.prepare('SELECT signal_scores AS signalScores FROM predictions WHERE id = ?').get(id) as {
      signalScores: string;
    };
    expect(JSON.parse(row.signalScores)).toEqual({
      technical: 0.91,
      news: 0.27,
      onChain: 0.44,
    });
  });

  it('creates weight updates and signal audits when a scored perp prediction resolves', () => {
    const id = createPrediction({
      marketId: 'perp:ETH',
      marketTitle: 'ETH long learning audit',
      predictedOutcome: 'YES',
      predictedProbability: 0.72,
      modelProbability: 0.72,
      domain: 'perp',
      executed: true,
      signalScores: {
        technical: 0.9,
        news: 0.25,
        onChain: 0.15,
      },
      signalWeightsSnapshot: {
        technical: 0.5,
        news: 0.3,
        onChain: 0.2,
      },
    });

    recordOutcome({ id, outcome: 'YES', outcomeBasis: 'final', pnl: 12.5 });

    const db = openDatabase();
    const weightUpdateRow = db.prepare(
      'SELECT learning_event_id AS learningEventId, domain, delta FROM weight_updates'
    ).get() as {
      learningEventId: number;
      domain: string;
      delta: string;
    };
    expect(weightUpdateRow.learningEventId).toBeGreaterThan(0);
    expect(weightUpdateRow.domain).toBe('perp');
    expect(JSON.parse(weightUpdateRow.delta)).toEqual({
      technical: expect.any(Number),
      news: expect.any(Number),
      onChain: expect.any(Number),
    });

    const audits = listLearningSignalAudits('perp');
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.learningEventId).toBe(weightUpdateRow.learningEventId);
    expect(audit.signalScores).toEqual({
      technical: 0.9,
      news: 0.25,
      onChain: 0.15,
    });
    expect(audit.decisionWeights).toEqual({
      technical: 0.5,
      news: 0.3,
      onChain: 0.2,
    });
    expect(audit.weightDelta).toEqual(JSON.parse(weightUpdateRow.delta));

    const persistedWeights = getSignalWeights('perp');
    expect(persistedWeights).toEqual(audit.activeWeightsAfter);
    expect(audit.activeWeightsAfter.technical).toBeGreaterThan(0.5);
    expect(audit.activeWeightsAfter.news).toBeLessThan(0.3);
    expect(audit.activeWeightsAfter.onChain).toBeLessThan(0.2);
  });
});
