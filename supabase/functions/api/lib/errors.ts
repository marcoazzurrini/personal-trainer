import type { Context } from "@hono/hono";
import type { ContentfulStatusCode } from "@hono/hono/utils/http-status";

// Thrown anywhere in a route; the app-level onError turns it into JSON.
// The client is an LLM: every message states what was wrong and what a
// correct call looks like.
export class ApiError extends Error {
  constructor(public status: ContentfulStatusCode, message: string) {
    super(message);
  }
}

// Human messages for constraint violations that a well-formed request can
// still trigger. Everything else falls through to a generic message that
// quotes the constraint name.
//
// Exported for the tripwire in tests/constraints_test.ts, which checks every
// name here against the live catalog — a constraint renamed in a migration
// would otherwise demote its message to the generic fallback with nothing
// going red.
export const constraintMessages: Record<string, string> = {
  exercises_name_key:
    "An exercise with that name already exists (names are case-insensitive). Fetch GET /exercises to see it.",
  exercise_aliases_alias_key:
    "That alias already points at an exercise (aliases are case-insensitive). Fetch GET /exercises to see which.",
  muscles_name_key: "That muscle already exists.",
  mesocycles_one_active_per_track:
    'A mesocycle is already active on that track. End it first (PATCH /mesocycles/current:<track> with {"ended_on": "YYYY-MM-DD"}) or revise it instead of creating a new one. Plans on other tracks run alongside it and are not in the way.',
  mesocycles_track_check:
    'track must be one of: hypertrophy, strength, speed, endurance. It also names the method document the coach reads (GET /docs/method/<track>). Rehab is not a track — it is a role an exercise plays inside a plan, so send "role": "rehab" on the exercise instead.',
  mesocycles_starts_on_monday:
    '"started_on" must be a Monday: mesocycles run whole weeks, Monday to Sunday.',
  mesocycle_exercises_mesocycle_exercise_key:
    "That exercise is already in the mesocycle's plan.",
  mesocycle_exercises_role_check:
    "role must be one of: main, accessory, rehab.",
  mesocycle_exercises_weekly_dose_unit_check:
    "weekly_dose_unit must be one of: sets, minutes, km.",
  mesocycle_exercises_weekly_dose_positive:
    "weekly_dose must be greater than 0. An exercise that should not be trained this week either leaves the plan (a revision) or is backed off by a decision saying for how long — a dose of 0 would read as a plan asking for nothing, forever.",
  sets_weight_accompanies_a_measure:
    "weight_kg cannot stand on its own: a load is a modifier on a measurement, not a measurement. Send it with reps, distance_m, or duration_s.",
  sets_target_weight_accompanies_a_measure:
    "target_weight_kg cannot stand on its own. Send it with target_reps, target_distance_m, or target_duration_s.",
  sets_effort_working_only: "Warmup sets do not carry effort.",
  sets_position_key: "That position in the session is already taken.",
  exercises_measure_check:
    "measure must be one of: load_reps, reps, distance, duration, distance_duration.",
  week_schedules_starts_on_monday:
    '"week_start" must be a Monday: weeks run Monday to Sunday, Europe/Rome.',
  week_schedules_week_start_key:
    "That week already has a schedule. Writing again replaces it — this collision means the write was not sent as a replacement.",
  foods_name_key:
    "A food with that name already exists (names are case-insensitive). Fetch GET /foods?q=<part of the name> to see it — a second row for the same food splits its history the way a duplicate exercise splits a lift's. A synonym belongs in POST /foods/:ref/aliases.",
  food_aliases_alias_key:
    "That alias already points at a food (aliases are case-insensitive). GET /foods?q=<the alias> shows which.",
  meals_name_key:
    "A meal with that name already exists (names are case-insensitive). GET /meals lists them.",
  meal_aliases_alias_key:
    "That alias already points at a meal (aliases are case-insensitive). GET /meals shows which.",
  meal_items_meal_food_key:
    "That food is already in the meal. A second helping is more grams on the existing item, not a second row.",
  intake_entries_food_grams_pair:
    "food and grams arrive together: send both (a food entry) or neither (an ad-hoc entry with adhoc_kcal).",
  intake_entries_food_macros_complete:
    "A food entry stores the food's full macros as they were when logged. This one is missing protein, carbs, or fat — the food itself is probably incomplete.",
  intake_entries_request_food_key:
    "That request_id has already logged this food. Retrying with the same id is safe and did nothing; use a fresh id for a genuinely new entry.",
  day_flags_day_flag_key: "That day already carries that flag.",
  bodyfat_estimates_day_method_key:
    "An estimate from that method is already recorded for that day.",
  foods_source_check:
    'source must be one of: label, crea, usda, off, estimate. Use "estimate" honestly rather than dressing a guess as a lookup — a disclosed estimate is fine, an invented number is not.',
};

export function errorResponse(err: unknown, c: Context): Response {
  if (err instanceof ApiError) {
    return c.json({ error: err.message }, err.status);
  }
  // postgres.js surfaces Postgres errors with code + constraint_name.
  const pg = err as {
    code?: string;
    constraint_name?: string;
    column_name?: string;
    message?: string;
    detail?: string;
  };
  if (pg.code === "23505") {
    const message = constraintMessages[pg.constraint_name ?? ""] ??
      `That would duplicate an existing row (unique constraint "${pg.constraint_name}").`;
    return c.json({ error: message }, 409);
  }
  if (pg.code === "23514") {
    const message = constraintMessages[pg.constraint_name ?? ""] ??
      `The database rejected a value (check constraint "${pg.constraint_name}"). Fix the offending field and retry.`;
    return c.json({ error: message }, 422);
  }
  if (pg.code === "23503") {
    return c.json({
      error:
        `A referenced row does not exist (foreign key "${pg.constraint_name}").`,
    }, 422);
  }
  // Numeric field overflow. Every measured column is a bounded numeric, so a
  // decimal point in the wrong place lands here — and without this it lands as
  // a 500, which tells the caller nothing it can act on. The same reasoning as
  // requireIdParam: a malformed number deserves a prompt, not an internal
  // error. Postgres carries no constraint name here, but its detail names the
  // precision and scale, which is exactly what the caller needs.
  // A null written into a column that cannot hold one. Reaching Postgres at
  // all means a validator accepted an explicit null for a required field —
  // PATCH /foods with {"kcal_100g": null} was the live case. The caller still
  // deserves a prompt naming the field, not an internal error.
  if (pg.code === "23502") {
    return c.json({
      error: `"${pg.column_name}" is required and cannot be null. Omit the ` +
        "field to leave it unchanged, or send a real value.",
    }, 422);
  }
  if (pg.code === "22003") {
    return c.json({
      error: `A number is too large for the column it was written to.${
        pg.detail ? ` ${pg.detail}` : ""
      } Check for a misplaced decimal point, or per-serving values sent as per-100 g.`,
    }, 422);
  }
  console.error(err);
  return c.json({ error: "Internal error. See function logs." }, 500);
}
