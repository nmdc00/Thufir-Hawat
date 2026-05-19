import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export type LearningCaseType =
  | 'comparable_forecast'
  | 'execution_quality'
  | 'thesis_quality'
  | 'intervention_quality'
  | 'regret_case';

export interface LearningCasePayloadMap {
  belief?: Record<string, unknown> | null;
  baseline?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
  action?: Record<string, unknown> | null;
  outcome?: Record<string, unknown> | null;
  qualityScores?: Record<string, unknown> | null;
  policyInputs?: Record<string, unknown> | null;
}

export interface LearningCaseSourceLinks {
  sourcePredictionId?: string | null;
  sourceTradeId?: number | null;
  sourceDossierId?: string | null;
  sourceHypothesisId?: string | null;
  sourceArtifactId?: number | null;
}

export interface LearningCaseInput extends LearningCasePayloadMap, LearningCaseSourceLinks {
  id?: string;
  caseType: LearningCaseType;
  domain: string;
  entityType: string;
  entityId: string;
  comparable: boolean;
  comparatorKind?: string | null;
  exclusionReason?: string | null;
  pairedCases?: LearningCaseInput[];
}

export interface LearningCase extends LearningCasePayloadMap, LearningCaseSourceLinks {
  id: string;
  caseType: LearningCaseType;
  domain: string;
  entityType: string;
  entityId: string;
  comparable: boolean;
  comparatorKind: string | null;
  exclusionReason: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface UpdateLearningCaseOutcomeInput {
  id: string;
  outcome?: Record<string, unknown> | null;
  qualityScores?: Record<string, unknown> | null;
  policyInputs?: Record<string, unknown> | null;
  comparable?: boolean;
  comparatorKind?: string | null;
  exclusionReason?: string | null;
}

export interface ListLearningCasesFilters {
  caseType?: LearningCaseType;
  domain?: string;
  comparable?: boolean;
  entityType?: string;
  entityId?: string;
  sourcePredictionId?: string;
  sourceTradeId?: number;
  sourceDossierId?: string;
  sourceHypothesisId?: string;
  sourceArtifactId?: number;
  limit?: number;
}

export interface LearningCaseExclusionCount {
  exclusionReason: string;
  count: number;
}

export interface LearningCaseTrackSummary {
  comparableForecastCases: number;
  executionQualityCases: number;
  thesisQualityCases: number;
  interventionQualityCases: number;
  regretCases: number;
  comparableIncludedCases: number;
  excludedComparableCases: number;
  comparableByDomain: Record<string, number>;
  executionByDomain: Record<string, number>;
  thesisByDomain: Record<string, number>;
  interventionByDomain: Record<string, number>;
  regretByDomain: Record<string, number>;
}
type LearningCaseRow = {
  id: string;
  case_type: LearningCaseType;
  domain: string;
  entity_type: string;
  entity_id: string;
  comparable: number;
  comparator_kind: string | null;
  source_prediction_id: string | null;
  source_trade_id: number | null;
  source_dossier_id: string | null;
  source_hypothesis_id: string | null;
  source_artifact_id: number | null;
  belief_payload: string | null;
  baseline_payload: string | null;
  context_payload: string | null;
  action_payload: string | null;
  outcome_payload: string | null;
  quality_payload: string | null;
  policy_input_payload: string | null;
  exclusion_reason: string | null;
  created_at: string;
  updated_at: string | null;
};

function serializeJson(value: Record<string, unknown> | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  return JSON.stringify(value);
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toLearningCase(row: LearningCaseRow): LearningCase {
  return {
    id: row.id,
    caseType: row.case_type,
    domain: row.domain,
    entityType: row.entity_type,
    entityId: row.entity_id,
    comparable: row.comparable === 1,
    comparatorKind: row.comparator_kind,
    sourcePredictionId: row.source_prediction_id,
    sourceTradeId: row.source_trade_id,
    sourceDossierId: row.source_dossier_id,
    sourceHypothesisId: row.source_hypothesis_id,
    sourceArtifactId: row.source_artifact_id,
    belief: parseJson(row.belief_payload),
    baseline: parseJson(row.baseline_payload),
    context: parseJson(row.context_payload),
    action: parseJson(row.action_payload),
    outcome: parseJson(row.outcome_payload),
    qualityScores: parseJson(row.quality_payload),
    policyInputs: parseJson(row.policy_input_payload),
    exclusionReason: row.exclusion_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createLearningCaseRecord(input: LearningCaseInput): LearningCase {
  const db = openDatabase();
  const id = input.id ?? randomUUID();
  db.prepare(
    `
      INSERT INTO learning_cases (
        id,
        case_type,
        domain,
        entity_type,
        entity_id,
        comparable,
        comparator_kind,
        source_prediction_id,
        source_trade_id,
        source_dossier_id,
        source_hypothesis_id,
        source_artifact_id,
        belief_payload,
        baseline_payload,
        context_payload,
        action_payload,
        outcome_payload,
        quality_payload,
        policy_input_payload,
        exclusion_reason
      ) VALUES (
        @id,
        @caseType,
        @domain,
        @entityType,
        @entityId,
        @comparable,
        @comparatorKind,
        @sourcePredictionId,
        @sourceTradeId,
        @sourceDossierId,
        @sourceHypothesisId,
        @sourceArtifactId,
        @belief,
        @baseline,
        @context,
        @action,
        @outcome,
        @qualityScores,
        @policyInputs,
        @exclusionReason
      )
    `
  ).run({
    id,
    caseType: input.caseType,
    domain: input.domain,
    entityType: input.entityType,
    entityId: input.entityId,
    comparable: input.comparable ? 1 : 0,
    comparatorKind: input.comparatorKind ?? null,
    sourcePredictionId: input.sourcePredictionId ?? null,
    sourceTradeId: input.sourceTradeId ?? null,
    sourceDossierId: input.sourceDossierId ?? null,
    sourceHypothesisId: input.sourceHypothesisId ?? null,
    sourceArtifactId: input.sourceArtifactId ?? null,
    belief: serializeJson(input.belief),
    baseline: serializeJson(input.baseline),
    context: serializeJson(input.context),
    action: serializeJson(input.action),
    outcome: serializeJson(input.outcome),
    qualityScores: serializeJson(input.qualityScores),
    policyInputs: serializeJson(input.policyInputs),
    exclusionReason: input.exclusionReason ?? null,
  });

  return getLearningCaseById(id);
}

export function createLearningCase(input: LearningCaseInput): LearningCase {
  const db = openDatabase();
  const transaction = db.transaction((rootInput: LearningCaseInput) => {
    const primary = createLearningCaseRecord({
      ...rootInput,
      pairedCases: undefined,
    });
    for (const pairedCase of rootInput.pairedCases ?? []) {
      createLearningCaseRecord({
        ...pairedCase,
        pairedCases: undefined,
      });
    }
    return primary;
  });
  return transaction(input);
}
export function getLearningCaseById(id: string): LearningCase {
  const db = openDatabase();
  const row = db
    .prepare('SELECT * FROM learning_cases WHERE id = ?')
    .get(id) as LearningCaseRow | undefined;
  if (!row) {
    throw new Error(`Learning case not found: ${id}`);
  }
  return toLearningCase(row);
}

export function updateLearningCaseOutcome(input: UpdateLearningCaseOutcomeInput): LearningCase {
  const db = openDatabase();
  db.prepare(
    `
      UPDATE learning_cases
      SET outcome_payload = COALESCE(@outcome, outcome_payload),
          quality_payload = COALESCE(@qualityScores, quality_payload),
          policy_input_payload = COALESCE(@policyInputs, policy_input_payload),
          comparable = COALESCE(@comparable, comparable),
          comparator_kind = COALESCE(@comparatorKind, comparator_kind),
          exclusion_reason = COALESCE(@exclusionReason, exclusion_reason),
          updated_at = datetime('now')
      WHERE id = @id
    `
  ).run({
    id: input.id,
    outcome: input.outcome === undefined ? null : serializeJson(input.outcome),
    qualityScores:
      input.qualityScores === undefined ? null : serializeJson(input.qualityScores),
    qualityScores:
      input.qualityScores === undefined ? null : serializeJson(input.qualityScores),
    policyInputs: input.policyInputs === undefined ? null : serializeJson(input.policyInputs),
    comparable: input.comparable === undefined ? null : input.comparable ? 1 : 0,
    comparatorKind: input.comparatorKind === undefined ? null : input.comparatorKind,
    exclusionReason: input.exclusionReason === undefined ? null : input.exclusionReason,
  });

  return getLearningCaseById(input.id);
}

export function listLearningCases(filters: ListLearningCasesFilters = {}): LearningCase[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT *
        FROM learning_cases
        WHERE (@caseType IS NULL OR case_type = @caseType)
          AND (@domain IS NULL OR domain = @domain)
          AND (@comparable IS NULL OR comparable = @comparable)
          AND (@entityType IS NULL OR entity_type = @entityType)
          AND (@entityId IS NULL OR entity_id = @entityId)
          AND (@sourcePredictionId IS NULL OR source_prediction_id = @sourcePredictionId)
          AND (@sourceTradeId IS NULL OR source_trade_id = @sourceTradeId)
          AND (@sourceDossierId IS NULL OR source_dossier_id = @sourceDossierId)
          AND (@sourceHypothesisId IS NULL OR source_hypothesis_id = @sourceHypothesisId)
          AND (@sourceArtifactId IS NULL OR source_artifact_id = @sourceArtifactId)
        ORDER BY created_at DESC, id DESC
        LIMIT @limit
      `
    )
    .all({
      caseType: filters.caseType ?? null,
      domain: filters.domain ?? null,
      comparable: filters.comparable === undefined ? null : filters.comparable ? 1 : 0,
      entityType: filters.entityType ?? null,
      entityId: filters.entityId ?? null,
      sourcePredictionId: filters.sourcePredictionId ?? null,
      sourceTradeId: filters.sourceTradeId ?? null,
      sourceDossierId: filters.sourceDossierId ?? null,
      sourceHypothesisId: filters.sourceHypothesisId ?? null,
      sourceArtifactId: filters.sourceArtifactId ?? null,
      limit: filters.limit ?? 100,
    }) as LearningCaseRow[];

  return rows.map(toLearningCase);
}

export function countLearningCaseExclusions(): LearningCaseExclusionCount[] {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT exclusion_reason, COUNT(*) AS count
        FROM learning_cases
        WHERE comparable = 0
          AND exclusion_reason IS NOT NULL
          AND TRIM(exclusion_reason) <> ''
        GROUP BY exclusion_reason
        ORDER BY count DESC, exclusion_reason ASC
      `
    )
    .all() as Array<{ exclusion_reason: string; count: number }>;

  return rows.map((row) => ({
    exclusionReason: row.exclusion_reason,
    count: Number(row.count),
  }));
}

function summarizeDomains(caseType: LearningCaseType, comparable?: boolean): Record<string, number> {
  const db = openDatabase();
  const rows = db
    .prepare(
      `
        SELECT domain, COUNT(*) AS count
        FROM learning_cases
        WHERE case_type = @caseType
          AND (@comparable IS NULL OR comparable = @comparable)
        GROUP BY domain
        ORDER BY domain ASC
      `
    )
    .all({
      caseType,
      comparable: comparable === undefined ? null : comparable ? 1 : 0,
    }) as Array<{ domain: string; count: number }>;

  return Object.fromEntries(rows.map((row) => [row.domain, Number(row.count)]));
}

export function summarizeLearningTracks(): LearningCaseTrackSummary {
  const db = openDatabase();
  const counts = db
    .prepare(
      `
        SELECT
          SUM(CASE WHEN case_type = 'comparable_forecast' THEN 1 ELSE 0 END) AS comparable_forecast_cases,
          SUM(CASE WHEN case_type = 'execution_quality' THEN 1 ELSE 0 END) AS execution_quality_cases,
          SUM(CASE WHEN case_type = 'thesis_quality' THEN 1 ELSE 0 END) AS thesis_quality_cases,
          SUM(CASE WHEN case_type = 'intervention_quality' THEN 1 ELSE 0 END) AS intervention_quality_cases,
          SUM(CASE WHEN case_type = 'regret_case' THEN 1 ELSE 0 END) AS regret_cases,
          SUM(CASE WHEN case_type = 'comparable_forecast' AND comparable = 1 THEN 1 ELSE 0 END) AS comparable_included_cases,
          SUM(CASE WHEN case_type = 'comparable_forecast' AND comparable = 0 THEN 1 ELSE 0 END) AS excluded_comparable_cases
        FROM learning_cases
      `
    )
    .get() as
    | {
        comparable_forecast_cases: number | null;
        execution_quality_cases: number | null;
        thesis_quality_cases: number | null;
        intervention_quality_cases: number | null;
        regret_cases: number | null;
        comparable_included_cases: number | null;
        excluded_comparable_cases: number | null;
      }
    | undefined;

  return {
    comparableForecastCases: Number(counts?.comparable_forecast_cases ?? 0),
    executionQualityCases: Number(counts?.execution_quality_cases ?? 0),
    thesisQualityCases: Number(counts?.thesis_quality_cases ?? 0),
    interventionQualityCases: Number(counts?.intervention_quality_cases ?? 0),
    regretCases: Number(counts?.regret_cases ?? 0),
    comparableIncludedCases: Number(counts?.comparable_included_cases ?? 0),
    excludedComparableCases: Number(counts?.excluded_comparable_cases ?? 0),
    comparableByDomain: summarizeDomains('comparable_forecast', true),
    executionByDomain: summarizeDomains('execution_quality'),
    thesisByDomain: summarizeDomains('thesis_quality'),
    interventionByDomain: summarizeDomains('intervention_quality'),
    regretByDomain: summarizeDomains('regret_case'),
  };
}
