// These mappings describe the existing record, not a replacement SQL history.
// Stable Drizzle does not model SQLite STRICT tables or triggers. The four SQL
// migrations remain authoritative for those features and the existing views.
// Drizzle requires names for CHECK builders: originally unnamed column checks
// use <table>_<column>_check (or _storage_check to avoid an existing name),
// without renaming any database constraint.
// Unnamed inline foreign keys likewise receive Drizzle's generated metadata name.
// All table integers stay stored integers, including scales and 0/1 flags;
// timestamps, dates and JSON stay text. There are no application-layer imports.
export { api_tokens, withings_auth } from "./access.ts";
export { user_context, users, week_schedules } from "./athlete.ts";
export { bodyfat_estimates, bodyweight } from "./body.ts";
export {
  api_write_assertions,
  nutrition_write_assertions,
} from "./internal.ts";
export {
  day_flags,
  food_aliases,
  foods,
  intake_entries,
  meal_aliases,
  meal_items,
  meals,
  nutrition_events,
  nutrition_targets,
} from "./nutrition.ts";
export {
  blocks,
  exercise_aliases,
  exercise_muscles,
  exercises,
  mesocycle_decisions,
  mesocycle_exercise_doses,
  mesocycle_exercises,
  mesocycles,
  muscles,
  sessions,
  sets,
} from "./training.ts";
export {
  daily_bodyweight,
  daily_intake,
  intake_values,
  nutrition_effective_events,
  nutrition_goal_switches,
  weekly_exercise_sets_done,
  weekly_volume,
} from "./views.ts";
