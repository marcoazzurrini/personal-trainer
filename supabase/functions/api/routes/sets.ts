import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import {
  optionalInt,
  optionalNumber,
  optionalString,
  optionalTimestamp,
  readJson,
  requireOneOf,
} from "../lib/validate.ts";

const EFFORTS = ["easy", "hard", "failure"] as const;

export const sets = new Hono();

// One set, sent as it's entered. Flat, not nested under the session: a set id
// is unique on its own, and patching a known id is idempotent — the log page
// resends after being offline. Targets are immutable: once written they are
// the record of what was asked, so this endpoint never touches them.
sets.patch("/:id", async (c) => {
  const setId = Number(c.req.param("id"));
  const [existing] = await sql`
    select id, kind, performed_at from sets where id = ${setId}`;
  if (!existing) throw new ApiError(404, `No set with id ${setId}.`);

  const body = await readJson(c);
  if ("target_weight_kg" in body || "target_reps" in body) {
    throw new ApiError(
      422,
      "Targets are immutable once the session exists: they are the record of what was asked that day. Only actuals (weight_kg, reps, effort), performed_at, and notes can change.",
    );
  }

  const fields: Record<string, unknown> = {};
  if ("weight_kg" in body) {
    fields.weight_kg = optionalNumber(body, "weight_kg", { min: 0 });
  }
  if ("reps" in body) fields.reps = optionalInt(body, "reps", { min: 1 });
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
      'Send at least one of "weight_kg", "reps", "effort", "performed_at", "notes".',
    );
  }
  // A set being performed right now gets its timestamp for free.
  if (
    fields.performed_at === undefined && existing.performed_at === null &&
    (fields.weight_kg != null || fields.reps != null)
  ) {
    fields.performed_at = new Date().toISOString();
  }

  const [row] = await sql`
    update sets set ${sql(fields)} where id = ${setId}
    returning id, session_id, exercise_id, position, kind,
      target_weight_kg::float8, target_reps,
      weight_kg::float8, reps, effort, performed_at, notes`;
  return c.json({ set: row });
});
