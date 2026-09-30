import { integer, real, sqliteView, text } from "drizzle-orm/sqlite-core";

// SQL owns these definitions, including rounding, winner selection and history.
// Unlike table storage, view decimals are already in public units. The real()
// columns pass driver numbers through; no scaling or numeric coercion occurs.
// Both weekly views include unfinished/future weeks. Readers filter Rome weeks.
export const weekly_volume = sqliteView("weekly_volume", {
  week_start: text("week_start"),
  muscle: text("muscle").notNull(),
  working_sets: real("working_sets"),
  mesocycle_id: integer("mesocycle_id"),
}).existing();

export const weekly_exercise_sets_done = sqliteView(
  "weekly_exercise_sets_done",
  {
    mesocycle_id: integer("mesocycle_id").notNull(),
    exercise_id: integer("exercise_id").notNull(),
    week: integer("week"),
    sets_done: integer("sets_done").notNull(),
    distance_m: real("distance_m"),
    duration_s: real("duration_s"),
  }
).existing();

export const daily_bodyweight = sqliteView("daily_bodyweight", {
  day: text("day").notNull(),
  value_kg: real("value_kg"),
  measured_at: text("measured_at").notNull(),
}).existing();

export const intake_values = sqliteView("intake_values", {
  id: integer("id").notNull(),
  day: text("day").notNull(),
  food_id: integer("food_id"),
  grams: real("grams"),
  meal_id: integer("meal_id"),
  kcal: real("kcal"),
  protein_g: real("protein_g"),
  carbs_g: real("carbs_g"),
  fat_g: real("fat_g"),
  fiber_g: real("fiber_g"),
  note: text("note"),
  request_id: text("request_id"),
  created_at: text("created_at").notNull(),
}).existing();

export const daily_intake = sqliteView("daily_intake", {
  day: text("day").notNull(),
  kcal: real("kcal"),
  protein_g: real("protein_g"),
  entries: integer("entries").notNull(),
  incomplete: integer("incomplete").notNull(),
  protein_entries: integer("protein_entries").notNull(),
}).existing();

export const nutrition_goal_switches = sqliteView("nutrition_goal_switches", {
  id: integer("id").notNull(),
  day: text("day").notNull(),
  kind: text("kind").notNull(),
  note: text("note"),
  created_at: text("created_at").notNull(),
}).existing();

export const nutrition_effective_events = sqliteView(
  "nutrition_effective_events",
  {
    id: integer("id").notNull(),
    day: text("day").notNull(),
    kind: text("kind").notNull(),
    note: text("note"),
    created_at: text("created_at").notNull(),
  }
).existing();
