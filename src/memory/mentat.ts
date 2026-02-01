import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

export interface AssumptionRecord {
  id?: string;
  system?: string | null;
  statement: string;
  dependencies?: string[] | null;
  evidenceFor?: string[] | null;
  evidenceAgainst?: string[] | null;
  stressScore?: number | null;
  lastTested?: string | null;
}

export interface AssumptionRow extends AssumptionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface MechanismRecord {
  id?: string;
  system?: string | null;
  name: string;
  causalChain?: string[] | null;
  triggerClass?: string | null;
  propagationPath?: string[] | null;
}

export interface MechanismRow extends MechanismRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface FragilityCardRecord {
  id?: string;
  system?: string | null;
  mechanismId?: string | null;
  exposureSurface?: string | null;
  convexity?: string | null;
  earlySignals?: string[] | null;
  falsifiers?: string[] | null;
  downside?: string | null;
  recoveryCapacity?: string | null;
  score?: number | null;
}

export interface FragilityCardRow extends FragilityCardRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssumptionDeltaRow {
  id: number;
  assumptionId: string;
  changedAt: string;
  previousSnapshot: Record<string, unknown>;
  currentSnapshot: Record<string, unknown>;
  stressDelta: number | null;
  fieldsChanged: string[];
}

export interface MechanismDeltaRow {
  id: number;
  mechanismId: string;
  changedAt: string;
  previousSnapshot: Record<string, unknown>;
  currentSnapshot: Record<string, unknown>;
  fieldsChanged: string[];
}

export interface FragilityCardDeltaRow {
  id: number;
  cardId: string;
  changedAt: string;
  previousScore: number | null;
  currentScore: number | null;
  scoreDelta: number | null;
  previousSnapshot: Record<string, unknown>;
  currentSnapshot: Record<string, unknown>;
  fieldsChanged: string[];
}

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseSnapshot(value: string | null): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(value) ?? {};
}

function parseStringArray(value: string | null): string[] {
  return parseJson<string[]>(value) ?? [];
}

function normalizeLimit(limit?: number, fallback = 50): number {
  if (!limit) return fallback;
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.floor(limit), 1), 500);
}

function normalizeSystem(system?: string | null): string | null {
  if (!system) return null;
  const trimmed = system.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function listAssumptions(options?: {
  system?: string;
  limit?: number;
  orderBy?: 'stress' | 'updated';
}): AssumptionRow[] {
  const db = openDatabase();
  const system = normalizeSystem(options?.system);
  const limit = normalizeLimit(options?.limit, 50);
  const orderBy = options?.orderBy === 'stress' ? 'stress_score DESC' : 'updated_at DESC';

  const rows = system
    ? db
        .prepare(
          `
          SELECT
            id,
            system,
            statement,
            dependencies,
            evidence_for as evidenceFor,
            evidence_against as evidenceAgainst,
            stress_score as stressScore,
            last_tested as lastTested,
            created_at as createdAt,
            updated_at as updatedAt
          FROM assumptions
          WHERE system = ?
          ORDER BY ${orderBy}
          LIMIT ?
        `
        )
        .all(system, limit)
    : db
        .prepare(
          `
          SELECT
            id,
            system,
            statement,
            dependencies,
            evidence_for as evidenceFor,
            evidence_against as evidenceAgainst,
            stress_score as stressScore,
            last_tested as lastTested,
            created_at as createdAt,
            updated_at as updatedAt
          FROM assumptions
          ORDER BY ${orderBy}
          LIMIT ?
        `
        )
        .all(limit);

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    system: (row.system as string) ?? null,
    statement: String(row.statement),
    dependencies: parseJson<string[]>(row.dependencies as string | null),
    evidenceFor: parseJson<string[]>(row.evidenceFor as string | null),
    evidenceAgainst: parseJson<string[]>(row.evidenceAgainst as string | null),
    stressScore: row.stressScore as number | null,
    lastTested: (row.lastTested as string) ?? null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  }));
}

export function listMechanisms(options?: {
  system?: string;
  limit?: number;
  orderBy?: 'updated' | 'name';
}): MechanismRow[] {
  const db = openDatabase();
  const system = normalizeSystem(options?.system);
  const limit = normalizeLimit(options?.limit, 50);
  const orderBy = options?.orderBy === 'name' ? 'name ASC' : 'updated_at DESC';

  const rows = system
    ? db
        .prepare(
          `
          SELECT
            id,
            system,
            name,
            causal_chain as causalChain,
            trigger_class as triggerClass,
            propagation_path as propagationPath,
            created_at as createdAt,
            updated_at as updatedAt
          FROM mechanisms
          WHERE system = ?
          ORDER BY ${orderBy}
          LIMIT ?
        `
        )
        .all(system, limit)
    : db
        .prepare(
          `
          SELECT
            id,
            system,
            name,
            causal_chain as causalChain,
            trigger_class as triggerClass,
            propagation_path as propagationPath,
            created_at as createdAt,
            updated_at as updatedAt
          FROM mechanisms
          ORDER BY ${orderBy}
          LIMIT ?
        `
        )
        .all(limit);

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    system: (row.system as string) ?? null,
    name: String(row.name),
    causalChain: parseJson<string[]>(row.causalChain as string | null),
    triggerClass: (row.triggerClass as string) ?? null,
    propagationPath: parseJson<string[]>(row.propagationPath as string | null),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  }));
}

export function listFragilityCards(options?: {
  system?: string;
  limit?: number;
  orderBy?: 'score' | 'updated';
}): FragilityCardRow[] {
  const db = openDatabase();
  const system = normalizeSystem(options?.system);
  const limit = normalizeLimit(options?.limit, 50);
  const orderBy = options?.orderBy === 'updated' ? 'updated_at DESC' : 'score DESC';

  const rows = system
    ? db
        .prepare(
          `
          SELECT
            id,
            system,
            mechanism_id as mechanismId,
            exposure_surface as exposureSurface,
            convexity,
            early_signals as earlySignals,
            falsifiers,
            downside,
            recovery_capacity as recoveryCapacity,
            score,
            created_at as createdAt,
            updated_at as updatedAt
          FROM fragility_cards
          WHERE system = ?
          ORDER BY ${orderBy}
          LIMIT ?
        `
        )
        .all(system, limit)
    : db
        .prepare(
          `
          SELECT
            id,
            system,
            mechanism_id as mechanismId,
            exposure_surface as exposureSurface,
            convexity,
            early_signals as earlySignals,
            falsifiers,
            downside,
            recovery_capacity as recoveryCapacity,
            score,
            created_at as createdAt,
            updated_at as updatedAt
          FROM fragility_cards
          ORDER BY ${orderBy}
          LIMIT ?
        `
        )
        .all(limit);

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    system: (row.system as string) ?? null,
    mechanismId: (row.mechanismId as string) ?? null,
    exposureSurface: (row.exposureSurface as string) ?? null,
    convexity: (row.convexity as string) ?? null,
    earlySignals: parseJson<string[]>(row.earlySignals as string | null),
    falsifiers: parseJson<string[]>(row.falsifiers as string | null),
    downside: (row.downside as string) ?? null,
    recoveryCapacity: (row.recoveryCapacity as string) ?? null,
    score: row.score as number | null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  }));
}

export function listAssumptionDeltas(options?: {
  assumptionId?: string;
  limit?: number;
}): AssumptionDeltaRow[] {
  const db = openDatabase();
  const limit = normalizeLimit(options?.limit, 25);
  const assumptionId = options?.assumptionId;

  const rows = assumptionId
    ? db
        .prepare(
          `
          SELECT
            id,
            assumption_id as assumptionId,
            changed_at as changedAt,
            previous_snapshot as previousSnapshot,
            current_snapshot as currentSnapshot,
            stress_delta as stressDelta,
            fields_changed as fieldsChanged
          FROM assumption_deltas
          WHERE assumption_id = ?
          ORDER BY changed_at DESC
          LIMIT ?
        `
        )
        .all(assumptionId, limit)
    : db
        .prepare(
          `
          SELECT
            id,
            assumption_id as assumptionId,
            changed_at as changedAt,
            previous_snapshot as previousSnapshot,
            current_snapshot as currentSnapshot,
            stress_delta as stressDelta,
            fields_changed as fieldsChanged
          FROM assumption_deltas
          ORDER BY changed_at DESC
          LIMIT ?
        `
        )
        .all(limit);

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    assumptionId: String(row.assumptionId),
    changedAt: String(row.changedAt),
    previousSnapshot: parseSnapshot(row.previousSnapshot as string | null),
    currentSnapshot: parseSnapshot(row.currentSnapshot as string | null),
    stressDelta: row.stressDelta as number | null,
    fieldsChanged: parseStringArray(row.fieldsChanged as string | null),
  }));
}

export function listMechanismDeltas(options?: {
  mechanismId?: string;
  limit?: number;
}): MechanismDeltaRow[] {
  const db = openDatabase();
  const limit = normalizeLimit(options?.limit, 25);
  const mechanismId = options?.mechanismId;

  const rows = mechanismId
    ? db
        .prepare(
          `
          SELECT
            id,
            mechanism_id as mechanismId,
            changed_at as changedAt,
            previous_snapshot as previousSnapshot,
            current_snapshot as currentSnapshot,
            fields_changed as fieldsChanged
          FROM mechanism_deltas
          WHERE mechanism_id = ?
          ORDER BY changed_at DESC
          LIMIT ?
        `
        )
        .all(mechanismId, limit)
    : db
        .prepare(
          `
          SELECT
            id,
            mechanism_id as mechanismId,
            changed_at as changedAt,
            previous_snapshot as previousSnapshot,
            current_snapshot as currentSnapshot,
            fields_changed as fieldsChanged
          FROM mechanism_deltas
          ORDER BY changed_at DESC
          LIMIT ?
        `
        )
        .all(limit);

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    mechanismId: String(row.mechanismId),
    changedAt: String(row.changedAt),
    previousSnapshot: parseSnapshot(row.previousSnapshot as string | null),
    currentSnapshot: parseSnapshot(row.currentSnapshot as string | null),
    fieldsChanged: parseStringArray(row.fieldsChanged as string | null),
  }));
}

export function listFragilityCardDeltas(options?: {
  cardId?: string;
  limit?: number;
}): FragilityCardDeltaRow[] {
  const db = openDatabase();
  const limit = normalizeLimit(options?.limit, 25);
  const cardId = options?.cardId;

  const rows = cardId
    ? db
        .prepare(
          `
          SELECT
            id,
            card_id as cardId,
            changed_at as changedAt,
            previous_score as previousScore,
            current_score as currentScore,
            score_delta as scoreDelta,
            previous_snapshot as previousSnapshot,
            current_snapshot as currentSnapshot,
            fields_changed as fieldsChanged
          FROM fragility_card_deltas
          WHERE card_id = ?
          ORDER BY changed_at DESC
          LIMIT ?
        `
        )
        .all(cardId, limit)
    : db
        .prepare(
          `
          SELECT
            id,
            card_id as cardId,
            changed_at as changedAt,
            previous_score as previousScore,
            current_score as currentScore,
            score_delta as scoreDelta,
            previous_snapshot as previousSnapshot,
            current_snapshot as currentSnapshot,
            fields_changed as fieldsChanged
          FROM fragility_card_deltas
          ORDER BY changed_at DESC
          LIMIT ?
        `
        )
        .all(limit);

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    cardId: String(row.cardId),
    changedAt: String(row.changedAt),
    previousScore: row.previousScore as number | null,
    currentScore: row.currentScore as number | null,
    scoreDelta: row.scoreDelta as number | null,
    previousSnapshot: parseSnapshot(row.previousSnapshot as string | null),
    currentSnapshot: parseSnapshot(row.currentSnapshot as string | null),
    fieldsChanged: parseStringArray(row.fieldsChanged as string | null),
  }));
}

function diffFields(previous: Record<string, unknown>, current: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) {
      changed.push(key);
    }
  }
  return changed;
}

export function upsertAssumption(record: AssumptionRecord): string {
  const db = openDatabase();
  const id = record.id ?? randomUUID();

  const existing = db
    .prepare(
      `
        SELECT
          id,
          system,
          statement,
          dependencies,
          evidence_for as evidenceFor,
          evidence_against as evidenceAgainst,
          stress_score as stressScore,
          last_tested as lastTested
        FROM assumptions
        WHERE id = ?
      `
    )
    .get(id) as Record<string, unknown> | undefined;

  const currentSnapshot = {
    id,
    system: record.system ?? null,
    statement: record.statement,
    dependencies: record.dependencies ?? null,
    evidenceFor: record.evidenceFor ?? null,
    evidenceAgainst: record.evidenceAgainst ?? null,
    stressScore: record.stressScore ?? null,
    lastTested: record.lastTested ?? null,
  };

  db.prepare(
    `
      INSERT INTO assumptions (
        id,
        system,
        statement,
        dependencies,
        evidence_for,
        evidence_against,
        stress_score,
        last_tested,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @system,
        @statement,
        @dependencies,
        @evidenceFor,
        @evidenceAgainst,
        @stressScore,
        @lastTested,
        datetime('now'),
        datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        system = excluded.system,
        statement = excluded.statement,
        dependencies = excluded.dependencies,
        evidence_for = excluded.evidence_for,
        evidence_against = excluded.evidence_against,
        stress_score = excluded.stress_score,
        last_tested = excluded.last_tested,
        updated_at = datetime('now')
    `
  ).run({
    id,
    system: record.system ?? null,
    statement: record.statement,
    dependencies: toJson(record.dependencies ?? null),
    evidenceFor: toJson(record.evidenceFor ?? null),
    evidenceAgainst: toJson(record.evidenceAgainst ?? null),
    stressScore: record.stressScore ?? null,
    lastTested: record.lastTested ?? null,
  });

  if (existing) {
    const previousSnapshot = {
      id: existing.id,
      system: existing.system ?? null,
      statement: existing.statement,
      dependencies: parseJson<string[]>(existing.dependencies as string | null),
      evidenceFor: parseJson<string[]>(existing.evidenceFor as string | null),
      evidenceAgainst: parseJson<string[]>(existing.evidenceAgainst as string | null),
      stressScore: existing.stressScore ?? null,
      lastTested: existing.lastTested ?? null,
    };

    const fieldsChanged = diffFields(previousSnapshot, currentSnapshot);
    const previousScore = typeof previousSnapshot.stressScore === 'number' ? previousSnapshot.stressScore : 0;
    const currentScore = typeof currentSnapshot.stressScore === 'number' ? currentSnapshot.stressScore : 0;

    db.prepare(
      `
        INSERT INTO assumption_deltas (
          assumption_id,
          previous_snapshot,
          current_snapshot,
          stress_delta,
          fields_changed
        ) VALUES (
          @assumptionId,
          @previousSnapshot,
          @currentSnapshot,
          @stressDelta,
          @fieldsChanged
        )
      `
    ).run({
      assumptionId: id,
      previousSnapshot: JSON.stringify(previousSnapshot),
      currentSnapshot: JSON.stringify(currentSnapshot),
      stressDelta: currentScore - previousScore,
      fieldsChanged: JSON.stringify(fieldsChanged),
    });
  }

  return id;
}

export function upsertMechanism(record: MechanismRecord): string {
  const db = openDatabase();
  const id = record.id ?? randomUUID();

  const existing = db
    .prepare(
      `
        SELECT
          id,
          system,
          name,
          causal_chain as causalChain,
          trigger_class as triggerClass,
          propagation_path as propagationPath
        FROM mechanisms
        WHERE id = ?
      `
    )
    .get(id) as Record<string, unknown> | undefined;

  const currentSnapshot = {
    id,
    system: record.system ?? null,
    name: record.name,
    causalChain: record.causalChain ?? null,
    triggerClass: record.triggerClass ?? null,
    propagationPath: record.propagationPath ?? null,
  };

  db.prepare(
    `
      INSERT INTO mechanisms (
        id,
        system,
        name,
        causal_chain,
        trigger_class,
        propagation_path,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @system,
        @name,
        @causalChain,
        @triggerClass,
        @propagationPath,
        datetime('now'),
        datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        system = excluded.system,
        name = excluded.name,
        causal_chain = excluded.causal_chain,
        trigger_class = excluded.trigger_class,
        propagation_path = excluded.propagation_path,
        updated_at = datetime('now')
    `
  ).run({
    id,
    system: record.system ?? null,
    name: record.name,
    causalChain: toJson(record.causalChain ?? null),
    triggerClass: record.triggerClass ?? null,
    propagationPath: toJson(record.propagationPath ?? null),
  });

  if (existing) {
    const previousSnapshot = {
      id: existing.id,
      system: existing.system ?? null,
      name: existing.name,
      causalChain: parseJson<string[]>(existing.causalChain as string | null),
      triggerClass: existing.triggerClass ?? null,
      propagationPath: parseJson<string[]>(existing.propagationPath as string | null),
    };

    const fieldsChanged = diffFields(previousSnapshot, currentSnapshot);

    db.prepare(
      `
        INSERT INTO mechanism_deltas (
          mechanism_id,
          previous_snapshot,
          current_snapshot,
          fields_changed
        ) VALUES (
          @mechanismId,
          @previousSnapshot,
          @currentSnapshot,
          @fieldsChanged
        )
      `
    ).run({
      mechanismId: id,
      previousSnapshot: JSON.stringify(previousSnapshot),
      currentSnapshot: JSON.stringify(currentSnapshot),
      fieldsChanged: JSON.stringify(fieldsChanged),
    });
  }

  return id;
}

export function upsertFragilityCard(record: FragilityCardRecord): string {
  const db = openDatabase();
  const id = record.id ?? randomUUID();

  const existing = db
    .prepare(
      `
        SELECT
          id,
          system,
          mechanism_id as mechanismId,
          exposure_surface as exposureSurface,
          convexity,
          early_signals as earlySignals,
          falsifiers,
          downside,
          recovery_capacity as recoveryCapacity,
          score
        FROM fragility_cards
        WHERE id = ?
      `
    )
    .get(id) as Record<string, unknown> | undefined;

  const currentSnapshot = {
    id,
    system: record.system ?? null,
    mechanismId: record.mechanismId ?? null,
    exposureSurface: record.exposureSurface ?? null,
    convexity: record.convexity ?? null,
    earlySignals: record.earlySignals ?? null,
    falsifiers: record.falsifiers ?? null,
    downside: record.downside ?? null,
    recoveryCapacity: record.recoveryCapacity ?? null,
    score: record.score ?? null,
  };

  db.prepare(
    `
      INSERT INTO fragility_cards (
        id,
        system,
        mechanism_id,
        exposure_surface,
        convexity,
        early_signals,
        falsifiers,
        downside,
        recovery_capacity,
        score,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @system,
        @mechanismId,
        @exposureSurface,
        @convexity,
        @earlySignals,
        @falsifiers,
        @downside,
        @recoveryCapacity,
        @score,
        datetime('now'),
        datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        system = excluded.system,
        mechanism_id = excluded.mechanism_id,
        exposure_surface = excluded.exposure_surface,
        convexity = excluded.convexity,
        early_signals = excluded.early_signals,
        falsifiers = excluded.falsifiers,
        downside = excluded.downside,
        recovery_capacity = excluded.recovery_capacity,
        score = excluded.score,
        updated_at = datetime('now')
    `
  ).run({
    id,
    system: record.system ?? null,
    mechanismId: record.mechanismId ?? null,
    exposureSurface: record.exposureSurface ?? null,
    convexity: record.convexity ?? null,
    earlySignals: toJson(record.earlySignals ?? null),
    falsifiers: toJson(record.falsifiers ?? null),
    downside: record.downside ?? null,
    recoveryCapacity: record.recoveryCapacity ?? null,
    score: record.score ?? null,
  });

  if (existing) {
    const previousSnapshot = {
      id: existing.id,
      system: existing.system ?? null,
      mechanismId: existing.mechanismId ?? null,
      exposureSurface: existing.exposureSurface ?? null,
      convexity: existing.convexity ?? null,
      earlySignals: parseJson<string[]>(existing.earlySignals as string | null),
      falsifiers: parseJson<string[]>(existing.falsifiers as string | null),
      downside: existing.downside ?? null,
      recoveryCapacity: existing.recoveryCapacity ?? null,
      score: existing.score ?? null,
    };

    const fieldsChanged = diffFields(previousSnapshot, currentSnapshot);
    const prevScore = typeof previousSnapshot.score === 'number' ? previousSnapshot.score : 0;
    const currScore = typeof currentSnapshot.score === 'number' ? currentSnapshot.score : 0;

    db.prepare(
      `
        INSERT INTO fragility_card_deltas (
          card_id,
          previous_score,
          current_score,
          score_delta,
          previous_snapshot,
          current_snapshot,
          fields_changed
        ) VALUES (
          @cardId,
          @previousScore,
          @currentScore,
          @scoreDelta,
          @previousSnapshot,
          @currentSnapshot,
          @fieldsChanged
        )
      `
    ).run({
      cardId: id,
      previousScore: prevScore,
      currentScore: currScore,
      scoreDelta: currScore - prevScore,
      previousSnapshot: JSON.stringify(previousSnapshot),
      currentSnapshot: JSON.stringify(currentSnapshot),
      fieldsChanged: JSON.stringify(fieldsChanged),
    });
  }

  return id;
}
