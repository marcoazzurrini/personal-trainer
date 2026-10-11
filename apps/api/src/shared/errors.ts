import {
  classifyDatabaseFailure,
  DatabaseFailureError,
} from "@trainer/db/errors.ts";
import type { Context } from "hono";

import {
  Conflict,
  DatabaseFailure,
  Invalid,
  isRefusal,
  TooLarge,
} from "./refusals.ts";
import type { Refusal } from "./refusals.ts";

// Human messages for constraint violations that a well-formed request can
// still trigger. Everything else falls through to a generic message that
// quotes the constraint name.
//
// Exported for the tripwire in api/tests/constraints_test.ts, which checks every
// name here against the live catalog — a constraint renamed in a migration
// would otherwise demote its message to the generic fallback with nothing
// going red.
export const constraintMessages = {
  exercises_name_key:
    "An exercise with that name already exists (names are case-insensitive). Fetch GET /exercises to see it.",
  exercise_aliases_alias_key:
    "That alias already points at an exercise (aliases are case-insensitive). Fetch GET /exercises to see which.",
  muscles_name_key: "That muscle already exists.",
  mesocycles_one_active_per_track:
    'A mesocycle is already active on that track. End it first (POST /mesocycles/current:<track>/decisions with {"ended_on": "YYYY-MM-DD"} and the reason) or change it instead of creating a new one. Plans on other tracks run alongside it and are not in the way.',
  mesocycle_decisions_request_id_key:
    "That request_id was already spent on a different plan's decision. A retry replays the call it was issued for; a new call needs a fresh uuid.",
  mesocycles_track_check:
    'track must be one of: hypertrophy, strength, speed, endurance. It also names the method document the coach reads (`method/<track>`). Rehab is not a track — it is a role an exercise plays inside a plan, so send "role": "rehab" on the exercise instead.',
  mesocycles_starts_on_monday:
    '"started_on" must be a Monday: mesocycles run whole weeks, Monday to Sunday.',
  mesocycle_exercises_mesocycle_exercise_key:
    "That exercise is already in the mesocycle's plan.",
  mesocycle_exercises_role_check:
    "role must be one of: main, accessory, rehab.",
  mesocycle_exercises_weekly_dose_unit_check:
    "weekly_dose_unit must be one of: sets, minutes, km.",
  mesocycle_exercises_weekly_dose_positive:
    'weekly_dose must be greater than 0. An exercise that should not be trained this week either leaves the plan ("remove") or is backed off by a decision saying for how long — a dose of 0 would read as a plan asking for nothing, forever.',
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
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- This is the database constraint name, not a local structural label.
  intake_entries_macro_shape:
    "A food entry derives macros from its food and grams. An explicit override must carry complete macros and its food revision; an ad-hoc estimate must carry kcal.",
  intake_entries_request_food_key:
    "That request_id has already logged this food. Retrying with the same id is safe and did nothing; use a fresh id for a genuinely new entry.",
  day_flags_day_flag_key: "That day already carries that flag.",
  bodyfat_estimates_day_method_key:
    "An estimate from that method is already recorded for that day.",
  foods_source_check:
    'source must be one of: label, crea, usda, off, estimate. Use "estimate" honestly rather than dressing a guess as a lookup — a disclosed estimate is fine, an invented number is not.',
};

// SQLite identifies UNIQUE failures by physical columns, not constraint names.
const uniqueConstraints = {
  "exercises.name_key": "exercises_name_key",
  "exercise_aliases.alias_key": "exercise_aliases_alias_key",
  "muscles.name": "muscles_name_key",
  "mesocycles.track": "mesocycles_one_active_per_track",
  "mesocycle_decisions.request_id": "mesocycle_decisions_request_id_key",
  "mesocycle_exercises.mesocycle_id, mesocycle_exercises.exercise_id":
    "mesocycle_exercises_mesocycle_exercise_key",
  "sets.session_id, sets.position": "sets_position_key",
  "foods.name_key": "foods_name_key",
  "food_aliases.alias_key": "food_aliases_alias_key",
  "meals.name_key": "meals_name_key",
  "meal_aliases.alias_key": "meal_aliases_alias_key",
  "meal_items.meal_id, meal_items.food_id": "meal_items_meal_food_key",
  "intake_entries.request_id, intake_entries.food_id":
    "intake_entries_request_food_key",
  "intake_entries.request_id": "intake_entries_request_food_key",
  "day_flags.day, day_flags.flag": "day_flags_day_flag_key",
  "bodyfat_estimates.day, bodyfat_estimates.method":
    "bodyfat_estimates_day_method_key",
  "week_schedules.week_start": "week_schedules_week_start_key",
};

function hasKey<T extends object>(value: T, key: PropertyKey): key is keyof T {
  return Object.hasOwn(value, key);
}

function constraintMessage(name: string | undefined): string | undefined {
  return name !== undefined && hasKey(constraintMessages, name)
    ? constraintMessages[name]
    : undefined;
}

export function databaseRefusal(failure: DatabaseFailure): Refusal {
  if (failure.kind === "too_large") {
    return new TooLarge({
      message:
        "One entry exceeds the database value limit. Shorten its text before retrying. Nothing was written.",
    });
  }
  if (failure.kind === "unique") {
    const name = hasKey(uniqueConstraints, failure.subject)
      ? uniqueConstraints[failure.subject]
      : undefined;
    return new Conflict({
      message:
        constraintMessage(name) ??
        "That would duplicate an existing record. Read the existing record; reuse the original request_id only when retrying the same operation.",
    });
  }
  if (failure.kind === "check" && failure.subject === "api_incomplete_write") {
    return new Conflict({
      message:
        "The record changed while saving it. Nothing was saved. Read the record before retrying.",
    });
  }
  if (failure.kind === "check") {
    return new Invalid({
      message:
        constraintMessage(failure.subject) ??
        `The database rejected a value (check constraint "${
          failure.subject
        }"). Fix the offending field and retry.`,
    });
  }
  if (failure.kind === "required") {
    return new Invalid({
      message: `"${
        failure.subject
      }" is required and cannot be null. Omit the field to leave it unchanged, or send a real value.`,
    });
  }
  return new Invalid({
    message:
      "A referenced row does not exist. Read the referenced record and use its current id.",
  });
}

// What a caller is told for an expected failure: a refusal as it is, a
// classified constraint violation in the sentence written for it. Anything
// else is not expected and has no refusal.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Exception boundary: anything thrown or failed can arrive here.
export function refusalOf(error: unknown): Refusal | undefined {
  if (isRefusal(error)) {
    return error;
  }
  if (error instanceof DatabaseFailure) {
    return databaseRefusal(error);
  }
  // Drizzle embeds SQL and parameters in its outer message; only the native
  // cause can identify a constraint. A failure that bypassed the repository
  // boundary is still answered with its constraint's sentence.
  const classified = classifyDatabaseFailure(error);
  return classified instanceof DatabaseFailureError
    ? databaseRefusal(
        new DatabaseFailure({
          kind: classified.kind,
          subject: classified.subject,
        })
      )
    : undefined;
}

// Where a schema refusal becomes the envelope every other refusal uses.
//
// Zod hands back a list of issues; the contract is exactly { "error": "<a
// sentence>" }, one key, checked on every call the test suite makes. So the
// list is collapsed into one string rather than surfaced as an array — a
// caller that has to decide what to do next reads prose, not a tree.
//
// Every issue is named, not just the first. A body with three wrong fields
// fixed one round-trip at a time is three round-trips, and the client paying
// for them is a model with a conversation to get through.
//
// 422 because that is what validate.ts threw: the request parsed, and was
// refused on what it said.
export function validationHook(
  result:
    | { success: true }
    | { success: false; error: { issues: { message: string }[] } },
  c: Context
): Response | undefined {
  if (result.success) {
    return undefined;
  }
  const message = result.error.issues
    .map((i: { message: string }) => i.message)
    .join(" ");
  return c.json({ error: message }, 422);
}

export interface Diagnostic {
  id: string;
  route: string;
  error?: "unexpected";
}

export function internalError(diagnostic: Diagnostic, method: string): string {
  diagnostic.error = "unexpected";
  return `Internal error. Diagnostic ID: ${diagnostic.id}. ${
    method === "GET" || method === "HEAD"
      ? "Try this read again later."
      : "Write outcome is uncertain. Read the affected record first; keep the original write request_id for the same operation. Reconcile GitHub issues or comments before repeating an external write."
  }`;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Exception boundary: arbitrary thrown values must reach the safe diagnostic envelope.
export function errorResponse(err: unknown, c: Context): Response {
  const refusal = refusalOf(err);
  if (refusal !== undefined) {
    return c.json({ error: refusal.message }, refusal.status);
  }
  // Unknown failures are diagnostics, never raw SQL or bound parameters.
  const diagnostic: Diagnostic = c.get("diagnostic") ?? {
    id: crypto.randomUUID(),
    route: c.req.routePath ?? "unmatched",
  };
  const error = internalError(diagnostic, c.req.method);
  c.header("X-Request-ID", diagnostic.id);
  // No raw exception messages, details, causes or stacks: database/provider
  // errors can embed credentials and personal input. The outer request logger
  // owns the record; standalone routers used in tests get the same safe fallback.
  if (!c.get("diagnostic")) {
    console.error(JSON.stringify(diagnostic));
  }
  return c.json({ error }, 500);
}
