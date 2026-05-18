import { openDatabase } from './db.js';
import type { SignalWeights } from './learning.js';

export interface LearningSignalAuditInput {
  learningEventId?: number | null;
  domain: string;
  signalScores: SignalWeights;
  baselineWeights: SignalWeights;
  decisionWeights: SignalWeights;
  activeWeightsBefore: SignalWeights;
  activeWeightsAfter: SignalWeights;
  weightDelta: SignalWeights;
  outcomeValue: 0 | 1;
}

export interface LearningSignalAuditRecord extends LearningSignalAuditInput {
  id: number;
  baselineScore: number;
  decisionScore: number;
  activeScoreBefore: number;
  activeScoreAfter: number;
  changed: boolean;
  createdAt: string;
}

type CanonicalLearningSignalAuditRow = {
  id: number;
  learningEventId: number | null;
  domain: string;
  signalScores: string;
  baselineWeights: string;
  decisionWeights: string;
  activeWeightsBefore: string;
  activeWeightsAfter: string;
  weightDelta: string;
  baselineScore: number;
  decisionScore: number;
  activeScoreBefore: number;
  activeScoreAfter: number;
  outcomeValue: number;
  changed: number;
  createdAt: string;
};

type LegacyLearningSignalAuditRow = {
  id: number;
  learningEventId: number | null;
  domain: string;
  signalScores: string;
  baselineWeights: string;
  decisionWeights: string;
  activeWeightsBefore: string;
  activeWeightsAfter: string;
  baselineScore: number;
  decisionScore: number;
  activeScoreBefore: number;
  activeScoreAfter: number;
  changed: number;
  createdAt: string;
};

function serialize(value: SignalWeights): string {
  return JSON.stringify(value);
}

function scoreSignal(weights: SignalWeights, scores: SignalWeights): number {
  return (
    weights.technical * scores.technical +
    weights.news * scores.news +
    weights.onChain * scores.onChain
  );
}

function parseSignalWeights(value: string): SignalWeights {
  const parsed = JSON.parse(value) as Partial<SignalWeights>;
  return {
    technical: Number(parsed.technical ?? 0),
    news: Number(parsed.news ?? 0),
    onChain: Number(parsed.onChain ?? 0),
  };
}

function zeroSignalWeights(): SignalWeights {
  return {
    technical: 0,
    news: 0,
    onChain: 0,
  };
}

function getLearningSignalAuditColumns(): Set<string> {
  const db = openDatabase();
  const rows = db.prepare("PRAGMA table_info('learning_signal_audits')").all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => String(row.name ?? '')));
}

function deriveLegacyDirection(score: number): string {
  return score >= 0.5 ? 'bullish' : 'bearish';
}

export function recordLearningSignalAudit(input: LearningSignalAuditInput): number {
  const db = openDatabase();
  const baselineScore = scoreSignal(input.baselineWeights, input.signalScores);
  const decisionScore = scoreSignal(input.decisionWeights, input.signalScores);
  const activeScoreBefore = scoreSignal(input.activeWeightsBefore, input.signalScores);
  const activeScoreAfter = scoreSignal(input.activeWeightsAfter, input.signalScores);
  const changed =
    Math.abs(input.weightDelta.technical) > 1e-9 ||
    Math.abs(input.weightDelta.news) > 1e-9 ||
    Math.abs(input.weightDelta.onChain) > 1e-9;
  const columns = getLearningSignalAuditColumns();
  const canonicalSchema = columns.has('baseline_weights');
  const result = canonicalSchema
    ? db
        .prepare(
          `
            INSERT INTO learning_signal_audits (
              learning_event_id,
              domain,
              signal_scores,
              baseline_weights,
              decision_weights,
              active_weights_before,
              active_weights_after,
              weight_delta,
              baseline_score,
              decision_score,
              active_score_before,
              active_score_after,
              outcome_value,
              changed
            ) VALUES (
              @learningEventId,
              @domain,
              @signalScores,
              @baselineWeights,
              @decisionWeights,
              @activeWeightsBefore,
              @activeWeightsAfter,
              @weightDelta,
              @baselineScore,
              @decisionScore,
              @activeScoreBefore,
              @activeScoreAfter,
              @outcomeValue,
              @changed
            )
          `
        )
        .run({
          learningEventId: input.learningEventId ?? null,
          domain: input.domain,
          signalScores: serialize(input.signalScores),
          baselineWeights: serialize(input.baselineWeights),
          decisionWeights: serialize(input.decisionWeights),
          activeWeightsBefore: serialize(input.activeWeightsBefore),
          activeWeightsAfter: serialize(input.activeWeightsAfter),
          weightDelta: serialize(input.weightDelta),
          baselineScore,
          decisionScore,
          activeScoreBefore,
          activeScoreAfter,
          outcomeValue: input.outcomeValue,
          changed: changed ? 1 : 0,
        })
    : db
        .prepare(
          `
            INSERT INTO learning_signal_audits (
              learning_event_id,
              prediction_id,
              domain,
              run_id,
              policy_version,
              signal_scores,
              default_weights,
              decision_weights,
              active_weights_before,
              active_weights_after,
              baseline_direction,
              decision_direction,
              active_direction_before,
              active_direction_after,
              baseline_confidence,
              decision_confidence,
              active_confidence_before,
              active_confidence_after,
              baseline_score,
              decision_score,
              active_score_before,
              active_score_after,
              changed_vs_default,
              changed_after_update
            ) VALUES (
              @learningEventId,
              NULL,
              @domain,
              @runId,
              @policyVersion,
              @signalScores,
              @baselineWeights,
              @decisionWeights,
              @activeWeightsBefore,
              @activeWeightsAfter,
              @baselineDirection,
              @decisionDirection,
              @activeDirectionBefore,
              @activeDirectionAfter,
              @baselineConfidence,
              @decisionConfidence,
              @activeConfidenceBefore,
              @activeConfidenceAfter,
              @baselineScore,
              @decisionScore,
              @activeScoreBefore,
              @activeScoreAfter,
              @changed,
              @changed
            )
          `
        )
        .run({
          learningEventId: input.learningEventId ?? null,
          domain: input.domain,
          runId: 'legacy-compat',
          policyVersion: 'v2.3',
          signalScores: serialize(input.signalScores),
          baselineWeights: serialize(input.baselineWeights),
          decisionWeights: serialize(input.decisionWeights),
          activeWeightsBefore: serialize(input.activeWeightsBefore),
          activeWeightsAfter: serialize(input.activeWeightsAfter),
          baselineDirection: deriveLegacyDirection(baselineScore),
          decisionDirection: deriveLegacyDirection(decisionScore),
          activeDirectionBefore: deriveLegacyDirection(activeScoreBefore),
          activeDirectionAfter: deriveLegacyDirection(activeScoreAfter),
          baselineConfidence: baselineScore,
          decisionConfidence: decisionScore,
          activeConfidenceBefore: activeScoreBefore,
          activeConfidenceAfter: activeScoreAfter,
          baselineScore,
          decisionScore,
          activeScoreBefore,
          activeScoreAfter,
          changed: changed ? 1 : 0,
        });
  return Number(result.lastInsertRowid ?? 0);
}

export function listLearningSignalAudits(domain?: string): LearningSignalAuditRecord[] {
  const db = openDatabase();
  const columns = getLearningSignalAuditColumns();
  const canonicalSchema = columns.has('baseline_weights');
  if (canonicalSchema) {
    const rows = db
      .prepare(
        `
          SELECT
            id,
            learning_event_id AS learningEventId,
            domain,
            signal_scores AS signalScores,
            baseline_weights AS baselineWeights,
            decision_weights AS decisionWeights,
            active_weights_before AS activeWeightsBefore,
            active_weights_after AS activeWeightsAfter,
            weight_delta AS weightDelta,
            baseline_score AS baselineScore,
            decision_score AS decisionScore,
            active_score_before AS activeScoreBefore,
            active_score_after AS activeScoreAfter,
            outcome_value AS outcomeValue,
            changed,
            created_at AS createdAt
          FROM learning_signal_audits
          WHERE (? IS NULL OR domain = ?)
          ORDER BY id ASC
        `
      )
      .all(domain ?? null, domain ?? null) as CanonicalLearningSignalAuditRow[];

    return rows.map((row) => ({
      id: row.id,
      learningEventId: row.learningEventId,
      domain: row.domain,
      signalScores: parseSignalWeights(row.signalScores),
      baselineWeights: parseSignalWeights(row.baselineWeights),
      decisionWeights: parseSignalWeights(row.decisionWeights),
      activeWeightsBefore: parseSignalWeights(row.activeWeightsBefore),
      activeWeightsAfter: parseSignalWeights(row.activeWeightsAfter),
      weightDelta: parseSignalWeights(row.weightDelta),
      baselineScore: Number(row.baselineScore),
      decisionScore: Number(row.decisionScore),
      activeScoreBefore: Number(row.activeScoreBefore),
      activeScoreAfter: Number(row.activeScoreAfter),
      outcomeValue: row.outcomeValue === 1 ? 1 : 0,
      changed: row.changed === 1,
      createdAt: row.createdAt,
    }));
  }

  const rows = db
    .prepare(
      `
        SELECT
          id,
          learning_event_id AS learningEventId,
          domain,
          signal_scores AS signalScores,
          default_weights AS baselineWeights,
          decision_weights AS decisionWeights,
          active_weights_before AS activeWeightsBefore,
          active_weights_after AS activeWeightsAfter,
          baseline_score AS baselineScore,
          decision_score AS decisionScore,
          active_score_before AS activeScoreBefore,
          active_score_after AS activeScoreAfter,
          changed_after_update AS changed,
          created_at AS createdAt
        FROM learning_signal_audits
        WHERE (? IS NULL OR domain = ?)
        ORDER BY id ASC
      `
    )
    .all(domain ?? null, domain ?? null) as LegacyLearningSignalAuditRow[];

  return rows.map((row) => ({
    id: row.id,
    learningEventId: row.learningEventId,
    domain: row.domain,
    signalScores: parseSignalWeights(row.signalScores),
    baselineWeights: parseSignalWeights(row.baselineWeights),
    decisionWeights: parseSignalWeights(row.decisionWeights),
    activeWeightsBefore: parseSignalWeights(row.activeWeightsBefore),
    activeWeightsAfter: parseSignalWeights(row.activeWeightsAfter),
    weightDelta: zeroSignalWeights(),
    baselineScore: Number(row.baselineScore),
    decisionScore: Number(row.decisionScore),
    activeScoreBefore: Number(row.activeScoreBefore),
    activeScoreAfter: Number(row.activeScoreAfter),
    outcomeValue: 0,
    changed: row.changed === 1,
    createdAt: row.createdAt,
  }));
}
