// One set, corrected after the fact.
//
// Flat, not nested under the session: a set id is unique on its own, and
// patching a known id is idempotent — a resend lands on the same row. Targets
// are immutable: once written they are the record of what was asked that day,
// so nothing here touches them.

import { sql } from "../db.ts";
import { requireRow } from "../shared/errors.ts";
import { type Effort, type Kind } from "./rules.ts";
import {
  type CorrectSetInput,
  prepareSetCorrection,
  type SetForCorrection,
} from "./set_correction.ts";

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
  const owner = requireRow(
    await sql`select session_id from sets where id = ${setId}`,
    `No set with id ${setId}.`,
  );
  return await sql.begin(async (tx) => {
    // Lock the parent before the set, like append/discard. Re-read actuals
    // under the lock so partial corrections cannot validate stale values.
    requireRow(
      await tx`select id from sessions where id = ${owner.session_id} for update`,
      `No set with id ${setId}.`,
    );
    const existing = requireRow(
      await tx<SetForCorrection[]>`
    select t.id, t.kind, t.performed_at, t.effort, t.weight_kg::float8, t.reps,
      t.distance_m::float8, t.duration_s::float8, t.notes,
      e.name as exercise, e.measure, e.stimulus_type
    from sets t join exercises e on e.id = t.exercise_id
    where t.id = ${setId}`,
      `No set with id ${setId}.`,
    );

    const fields = prepareSetCorrection(existing, b, new Date().toISOString());

    const rows = await tx<SetRow[]>`
    update sets set ${sql(fields)} where id = ${setId}
    returning id, session_id, exercise_id, mesocycle_id, position, kind,
      target_weight_kg::float8, target_reps,
      target_distance_m::float8, target_duration_s::float8,
      weight_kg::float8, reps, distance_m::float8, duration_s::float8,
      effort, performed_at, notes`;
    return requireRow(rows, `No set with id ${setId}.`);
  });
}
