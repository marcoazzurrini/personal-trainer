import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import { assertEffort, assertSetMeasures } from "../lib/training.ts";
import {
  optionalInt,
  optionalNumber,
  optionalString,
  optionalTimestamp,
  readJson,
  requireIdParam,
  requireOneOf,
} from "../lib/validate.ts";

const EFFORTS = ["easy", "hard", "failure"] as const;

const TARGET_FIELDS = [
  "target_weight_kg",
  "target_reps",
  "target_distance_m",
  "target_duration_s",
] as const;

export const sets = new Hono();

// One set, sent as it's entered. Flat, not nested under the session: a set id
// is unique on its own, and patching a known id is idempotent — the log page
// resends after being offline. Targets are immutable: once written they are
// the record of what was asked, so this endpoint never touches them.
sets.patch("/:id", async (c) => {
  const setId = requireIdParam(c.req.param("id"), "set");
  const [existing] = await sql`
    select t.id, t.kind, t.performed_at, t.effort, t.weight_kg::float8, t.reps,
      t.distance_m::float8, t.duration_s::float8,
      e.name as exercise, e.measure, e.stimulus_type
    from sets t join exercises e on e.id = t.exercise_id
    where t.id = ${setId}`;
  if (!existing) throw new ApiError(404, `No set with id ${setId}.`);

  const body = await readJson(c);
  const target = TARGET_FIELDS.find((f) => f in body);
  if (target) {
    throw new ApiError(
      422,
      `Targets are immutable once the session exists: they are the record of what was asked that day, and "${target}" is one of them. Only actuals (weight_kg, reps, distance_m, duration_s, effort), performed_at, and notes can change. If the whole session was mis-planned and nothing has been performed yet, DELETE /sessions/:id discards the draft — then write it again.`,
    );
  }

  const fields: Record<string, unknown> = {};
  if ("weight_kg" in body) {
    fields.weight_kg = optionalNumber(body, "weight_kg", { min: 0 });
  }
  if ("reps" in body) fields.reps = optionalInt(body, "reps", { min: 1 });
  if ("distance_m" in body) {
    fields.distance_m = optionalNumber(body, "distance_m", { min: 0 });
  }
  if ("duration_s" in body) {
    fields.duration_s = optionalNumber(body, "duration_s", { min: 0 });
  }
  if ("effort" in body) {
    fields.effort = body.effort === null
      ? null
      : requireOneOf(body, "effort", EFFORTS);
  }
  if ("performed_at" in body) {
    fields.performed_at = optionalTimestamp(body, "performed_at");
  }
  if ("notes" in body) fields.notes = optionalString(body, "notes");
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

  const [row] = await sql`
    update sets set ${sql(fields)} where id = ${setId}
    returning id, session_id, exercise_id, mesocycle_id, position, kind,
      target_weight_kg::float8, target_reps,
      target_distance_m::float8, target_duration_s::float8,
      weight_kg::float8, reps, distance_m::float8, duration_s::float8,
      effort, performed_at, notes`;
  return c.json({ set: row });
});
