// One set, corrected after the fact.
//
// Flat, not nested under the session: a set id is unique on its own, and
// patching a known id is idempotent — a resend lands on the same row. Targets
// are immutable: once written they are the record of what was asked that day,
// so nothing here touches them.

import { sql } from "../db.ts";
import { ApiError, requireRow } from "../shared/errors.ts";
import {
  assertEffort,
  assertSetMeasures,
  type Effort,
  type Kind,
} from "./rules.ts";

export interface SetRow {
  id: number;
  session_id: number;
  exercise_id: number;
  mesocycle_id: number | null;
  position: number;
  kind: Kind;
  target_weight_kg: number | null;
  target_reps: number | null;
  target_distance_m: number | null;
  target_duration_s: number | null;
  weight_kg: number | null;
  reps: number | null;
  distance_m: number | null;
  duration_s: number | null;
  effort: Effort | null;
  performed_at: string | null;
  notes: string | null;
}

export const TARGET_FIELDS = [
  "target_weight_kg",
  "target_reps",
  "target_distance_m",
  "target_duration_s",
] as const;

const ACTUAL_FIELDS = [
  "weight_kg",
  "reps",
  "distance_m",
  "duration_s",
  "effort",
  "performed_at",
  "notes",
] as const;

export interface CorrectSetInput {
  weight_kg?: number | null;
  reps?: number | null;
  distance_m?: number | null;
  duration_s?: number | null;
  effort?: Effort | null;
  performed_at?: string | null;
  notes?: string | null;
  target_weight_kg?: unknown;
  target_reps?: unknown;
  target_distance_m?: unknown;
  target_duration_s?: unknown;
}

/**
 * Corrects a set's actuals.
 *
 * Partial: a field left out is untouched, a field sent as null is cleared.
 * Refuses 422 for a target, for an empty patch, and for a result that would
 * break the exercise's measure or effort rule.
 */
export async function correctSet(
  setId: number,
  b: CorrectSetInput,
): Promise<SetRow> {
  const existing = requireRow(
    await sql`
    select t.id, t.kind, t.performed_at, t.effort, t.weight_kg::float8, t.reps,
      t.distance_m::float8, t.duration_s::float8,
      e.name as exercise, e.measure, e.stimulus_type
    from sets t join exercises e on e.id = t.exercise_id
    where t.id = ${setId}`,
    `No set with id ${setId}.`,
  );

  const target = TARGET_FIELDS.find((f) => b[f] !== undefined);
  if (target) {
    throw new ApiError(
      422,
      `Targets are immutable once the session exists: they are the record of what was asked that day, and "${target}" is one of them. Only actuals (weight_kg, reps, distance_m, duration_s, effort), performed_at, and notes can change. If the whole session was mis-planned and nothing has been performed yet, DELETE /sessions/:id discards the draft — then write it again.`,
    );
  }

  // Absent and explicitly null are different instructions — leave it alone
  // against clear it — and the schema keeps them apart: an omitted field
  // parses to undefined, a null one to null.
  const fields: Record<string, unknown> = {};
  for (const f of ACTUAL_FIELDS) {
    if (b[f] !== undefined) fields[f] = b[f];
  }
  if (Object.keys(fields).length === 0) {
    throw new ApiError(
      422,
      'Send at least one of "weight_kg", "reps", "distance_m", "duration_s", "effort", "performed_at", "notes".',
    );
  }

  // A patch is partial, so the measure rule has to be checked against what the
  // row will be, not against what arrived. Correcting a squat's reps to null
  // and leaving its weight behind would otherwise sail through here and be
  // caught only by the constraint, which cannot explain itself as well.
  const pick = <T>(field: string, was: T) =>
    field in fields ? fields[field] as T : was;
  assertSetMeasures(existing.measure, existing.exercise, "actual", {
    weightKg: pick("weight_kg", existing.weight_kg),
    reps: pick("reps", existing.reps),
    distanceM: pick("distance_m", existing.distance_m),
    durationS: pick("duration_s", existing.duration_s),
  });
  assertEffort(
    existing.stimulus_type,
    existing.exercise,
    existing.kind,
    pick("reps", existing.reps),
    pick("effort", existing.effort),
  );

  // A set being performed right now gets its timestamp for free.
  const nowMeasured = fields.reps != null || fields.distance_m != null ||
    fields.duration_s != null;
  if (
    fields.performed_at === undefined && existing.performed_at === null &&
    nowMeasured
  ) {
    fields.performed_at = new Date().toISOString();
  }

  const [row] = await sql<SetRow[]>`
    update sets set ${sql(fields)} where id = ${setId}
    returning id, session_id, exercise_id, mesocycle_id, position, kind,
      target_weight_kg::float8, target_reps,
      target_distance_m::float8, target_duration_s::float8,
      weight_kg::float8, reps, distance_m::float8, duration_s::float8,
      effort, performed_at, notes`;
  return row;
}
