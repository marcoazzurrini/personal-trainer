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
const constraintMessages: Record<string, string> = {
  exercises_name_key:
    "An exercise with that name already exists (names are case-insensitive). Fetch GET /api/exercises to see it.",
  exercise_aliases_alias_key:
    "That alias already points at an exercise (aliases are case-insensitive). Fetch GET /api/exercises to see which.",
  muscles_name_key: "That muscle already exists.",
  mesocycles_one_active:
    'A mesocycle is already active. End it first (PATCH /api/mesocycles/current with {"ended_on": "YYYY-MM-DD"}) or revise it instead of creating a new one.',
  mesocycles_starts_on_monday:
    '"started_on" must be a Monday: mesocycles run whole weeks, Monday to Sunday.',
  mesocycle_exercises_mesocycle_exercise_key:
    "That exercise is already in the mesocycle's plan.",
  sets_effort_required:
    "effort is required on a performed working set; send easy, hard, or failure.",
  sets_actuals_pair:
    "weight_kg and reps arrive together: send both (a performed set) or neither (not done).",
  sets_targets_pair:
    "target_weight_kg and target_reps arrive together: send both or neither.",
  sets_effort_working_only: "Warmup sets do not carry effort.",
  sets_position_key: "That position in the session is already taken.",
  foods_name_key:
    "A food with that name already exists (names are case-insensitive). Fetch GET /api/foods?q=<part of the name> to see it — a second row for the same food splits its history the way a duplicate exercise splits a lift's. A synonym belongs in POST /api/foods/:ref/aliases.",
  food_aliases_alias_key:
    "That alias already points at a food (aliases are case-insensitive). GET /api/foods?q=<the alias> shows which.",
  meals_name_key:
    "A meal with that name already exists (names are case-insensitive). GET /api/meals lists them.",
  meal_aliases_alias_key:
    "That alias already points at a meal (aliases are case-insensitive). GET /api/meals shows which.",
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
    message?: string;
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
  console.error(err);
  return c.json({ error: "Internal error. See function logs." }, 500);
}
