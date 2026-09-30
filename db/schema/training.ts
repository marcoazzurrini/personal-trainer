import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { dateCheck, utcCheck, utcNow, uuidCheck } from "./checks.ts";

export const muscles = sqliteTable(
  "muscles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
  },
  (table) => [unique("muscles_name_key").on(table.name)]
);

export const exercises = sqliteTable(
  "exercises",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    equipment: text("equipment"),
    pattern: text("pattern"),
    stimulus_type: text("stimulus_type").notNull().default("strength"),
    notes: text("notes"),
    systemic_fatigue: text("systemic_fatigue").notNull().default("normal"),
    measure: text("measure").notNull().default("load_reps"),
    name_key: text("name_key").notNull(),
  },
  (table) => [
    check(
      "exercises_stimulus_type_check",
      sql`stimulus_type IN ('strength', 'power', 'conditioning')`
    ),
    check(
      "exercises_systemic_fatigue_check",
      sql`systemic_fatigue IN ('normal', 'high')`
    ),
    check(
      "exercises_measure_check",
      sql`measure IN ('load_reps', 'reps', 'distance', 'duration', 'distance_duration')`
    ),
    uniqueIndex("exercises_name_key").on(table.name_key),
  ]
);

export const exercise_aliases = sqliteTable(
  "exercise_aliases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    exercise_id: integer("exercise_id").notNull(),
    alias: text("alias").notNull(),
    alias_key: text("alias_key").notNull(),
  },
  (table) => [
    foreignKey({
      name: "exercise_aliases_exercise_id_fkey",
      columns: [table.exercise_id],
      foreignColumns: [exercises.id],
    }).onDelete("cascade"),
    uniqueIndex("exercise_aliases_alias_key").on(table.alias_key),
    index("exercise_aliases_exercise_id_idx").on(table.exercise_id),
  ]
);

export const exercise_muscles = sqliteTable(
  "exercise_muscles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    exercise_id: integer("exercise_id").notNull(),
    muscle_id: integer("muscle_id")
      .notNull()
      .references(() => muscles.id),
    volume_factor: integer("volume_factor").notNull(),
  },
  (table) => [
    check(
      "exercise_muscles_volume_factor_storage_check",
      sql`volume_factor BETWEEN -99 AND 99`
    ),
    foreignKey({
      name: "exercise_muscles_exercise_id_fkey",
      columns: [table.exercise_id],
      foreignColumns: [exercises.id],
    }).onDelete("cascade"),
    unique("exercise_muscles_exercise_muscle_key").on(
      table.exercise_id,
      table.muscle_id
    ),
    check(
      "exercise_muscles_volume_factor_check",
      sql`volume_factor IN (0, 5, 10)`
    ),
    index("exercise_muscles_muscle_id_idx").on(table.muscle_id),
  ]
);

export const blocks = sqliteTable(
  "blocks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    goal: text("goal").notNull(),
    started_on: text("started_on").notNull(),
    ended_on: text("ended_on"),
    request_id: text("request_id"),
  },
  (table) => [
    check(
      "blocks_dates_ordered",
      sql`ended_on IS NULL OR ended_on >= started_on`
    ),
    unique("blocks_request_id_key").on(table.request_id),
    dateCheck("blocks_started_on_date", table.started_on),
    dateCheck("blocks_ended_on_date", table.ended_on),
    uuidCheck("blocks_request_id_uuid", table.request_id),
  ]
);

export const mesocycles = sqliteTable(
  "mesocycles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    block_id: integer("block_id")
      .notNull()
      .references(() => blocks.id),
    name: text("name").notNull(),
    intent: text("intent").notNull(),
    planned_weeks: integer("planned_weeks").notNull(),
    sessions_per_week: integer("sessions_per_week").notNull(),
    started_on: text("started_on").notNull(),
    ended_on: text("ended_on"),
    request_id: text("request_id"),
    track: text("track").notNull(),
  },
  (table) => [
    check(
      "mesocycles_planned_weeks_check",
      sql`planned_weeks BETWEEN -2147483648 AND 2147483647`
    ),
    check(
      "mesocycles_sessions_per_week_check",
      sql`sessions_per_week BETWEEN -2147483648 AND 2147483647`
    ),
    check("mesocycles_planned_weeks_positive", sql`planned_weeks > 0`),
    check("mesocycles_sessions_per_week_positive", sql`sessions_per_week > 0`),
    check("mesocycles_starts_on_monday", sql`strftime('%w', started_on) = '1'`),
    check(
      "mesocycles_dates_ordered",
      sql`ended_on IS NULL OR ended_on >= started_on`
    ),
    unique("mesocycles_request_id_key").on(table.request_id),
    check(
      "mesocycles_track_check",
      sql`track IN ('hypertrophy', 'strength', 'speed', 'endurance')`
    ),
    dateCheck("mesocycles_started_on_date", table.started_on),
    dateCheck("mesocycles_ended_on_date", table.ended_on),
    uuidCheck("mesocycles_request_id_uuid", table.request_id),
    index("mesocycles_block_id_idx").on(table.block_id),
    uniqueIndex("mesocycles_one_active_per_track")
      .on(table.track)
      .where(sql`ended_on is null`),
  ]
);

export const mesocycle_exercises = sqliteTable(
  "mesocycle_exercises",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mesocycle_id: integer("mesocycle_id")
      .notNull()
      .references(() => mesocycles.id),
    exercise_id: integer("exercise_id")
      .notNull()
      .references(() => exercises.id),
    role: text("role").notNull(),
    priority: integer("priority").notNull(),
    notes: text("notes"),
  },
  (table) => [
    check(
      "mesocycle_exercises_priority_check",
      sql`priority BETWEEN -2147483648 AND 2147483647`
    ),
    check(
      "mesocycle_exercises_role_check",
      sql`role IN ('main', 'accessory', 'rehab')`
    ),
    unique("mesocycle_exercises_mesocycle_exercise_key").on(
      table.mesocycle_id,
      table.exercise_id
    ),
    index("mesocycle_exercises_exercise_id_idx").on(table.exercise_id),
  ]
);

export const mesocycle_decisions = sqliteTable(
  "mesocycle_decisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mesocycle_id: integer("mesocycle_id")
      .notNull()
      .references(() => mesocycles.id),
    made_at: text("made_at").notNull().default(utcNow),
    what_changed: text("what_changed").notNull(),
    why: text("why").notNull(),
    request_id: text("request_id"),
    prior_intent: text("prior_intent"),
  },
  (table) => [
    unique("mesocycle_decisions_request_id_key").on(table.request_id),
    utcCheck("mesocycle_decisions_made_at_utc", table.made_at),
    uuidCheck("mesocycle_decisions_request_id_uuid", table.request_id),
    index("mesocycle_decisions_mesocycle_id_idx").on(table.mesocycle_id),
  ]
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    rationale: text("rationale").notNull(),
    notes: text("notes"),
    overall_feel: text("overall_feel"),
    started_at: text("started_at"),
    completed_at: text("completed_at"),
    request_id: text("request_id"),
    write_version: integer("write_version").notNull().default(0),
  },
  (table) => [
    check(
      "sessions_write_version_check",
      sql`write_version BETWEEN 0 AND 9007199254740991`
    ),
    unique("sessions_request_id_key").on(table.request_id),
    check(
      "sessions_times_ordered",
      sql`started_at IS NULL OR completed_at IS NULL OR completed_at >= started_at`
    ),
    dateCheck("sessions_date_date", table.date),
    utcCheck("sessions_started_at_utc", table.started_at),
    utcCheck("sessions_completed_at_utc", table.completed_at),
    uuidCheck("sessions_request_id_uuid", table.request_id),
    index("sessions_date_idx").on(table.date),
  ]
);

export const sets = sqliteTable(
  "sets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    session_id: integer("session_id")
      .notNull()
      .references(() => sessions.id),
    exercise_id: integer("exercise_id")
      .notNull()
      .references(() => exercises.id),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    target_weight_kg: integer("target_weight_kg"),
    target_reps: integer("target_reps"),
    weight_kg: integer("weight_kg"),
    reps: integer("reps"),
    effort: text("effort"),
    performed_at: text("performed_at"),
    notes: text("notes"),
    request_id: text("request_id"),
    target_distance_m: integer("target_distance_m"),
    distance_m: integer("distance_m"),
    target_duration_s: integer("target_duration_s"),
    duration_s: integer("duration_s"),
    mesocycle_id: integer("mesocycle_id").references(() => mesocycles.id),
  },
  (table) => [
    check(
      "sets_position_check",
      sql`position BETWEEN -2147483648 AND 2147483647`
    ),
    check(
      "sets_target_weight_kg_check",
      sql`target_weight_kg BETWEEN -999999 AND 999999`
    ),
    check(
      "sets_target_reps_check",
      sql`target_reps BETWEEN -2147483648 AND 2147483647`
    ),
    check("sets_weight_kg_check", sql`weight_kg BETWEEN -999999 AND 999999`),
    check("sets_reps_check", sql`reps BETWEEN -2147483648 AND 2147483647`),
    check(
      "sets_target_distance_m_check",
      sql`target_distance_m BETWEEN -9999999 AND 9999999`
    ),
    check(
      "sets_distance_m_check",
      sql`distance_m BETWEEN -9999999 AND 9999999`
    ),
    check(
      "sets_target_duration_s_check",
      sql`target_duration_s BETWEEN -99999999 AND 99999999`
    ),
    check(
      "sets_duration_s_check",
      sql`duration_s BETWEEN -99999999 AND 99999999`
    ),
    check("sets_kind_check", sql`kind IN ('warmup', 'working')`),
    check("sets_effort_check", sql`effort IN ('easy', 'hard', 'failure')`),
    check("sets_position_positive", sql`position > 0`),
    unique("sets_position_key").on(table.session_id, table.position),
    check(
      "sets_target_weight_not_negative",
      sql`target_weight_kg IS NULL OR target_weight_kg >= 0`
    ),
    check(
      "sets_target_reps_positive",
      sql`target_reps IS NULL OR target_reps > 0`
    ),
    check("sets_weight_not_negative", sql`weight_kg IS NULL OR weight_kg >= 0`),
    check("sets_reps_positive", sql`reps IS NULL OR reps > 0`),
    check("sets_effort_working_only", sql`kind = 'working' OR effort IS NULL`),
    unique("sets_request_id_key").on(table.request_id),
    check("sets_distance_positive", sql`distance_m IS NULL OR distance_m > 0`),
    check(
      "sets_target_distance_positive",
      sql`target_distance_m IS NULL OR target_distance_m > 0`
    ),
    check("sets_duration_positive", sql`duration_s IS NULL OR duration_s > 0`),
    check(
      "sets_target_duration_positive",
      sql`target_duration_s IS NULL OR target_duration_s > 0`
    ),
    check(
      "sets_weight_accompanies_a_measure",
      sql`weight_kg IS NULL OR reps IS NOT NULL OR distance_m IS NOT NULL OR duration_s IS NOT NULL`
    ),
    check(
      "sets_target_weight_accompanies_a_measure",
      sql`target_weight_kg IS NULL OR target_reps IS NOT NULL OR target_distance_m IS NOT NULL OR target_duration_s IS NOT NULL`
    ),
    utcCheck("sets_performed_at_utc", table.performed_at),
    uuidCheck("sets_request_id_uuid", table.request_id),
    index("sets_session_id_idx").on(table.session_id),
    index("sets_exercise_id_performed_at_idx").on(
      table.exercise_id,
      table.performed_at
    ),
    index("sets_mesocycle_id_idx").on(table.mesocycle_id),
  ]
);

export const mesocycle_exercise_doses = sqliteTable(
  "mesocycle_exercise_doses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mesocycle_id: integer("mesocycle_id")
      .notNull()
      .references(() => mesocycles.id),
    exercise_id: integer("exercise_id")
      .notNull()
      .references(() => exercises.id),
    weekly_dose: integer("weekly_dose").notNull(),
    weekly_dose_unit: text("weekly_dose_unit").notNull(),
    effective_from: text("effective_from").notNull(),
    created_at: text("created_at").notNull().default(utcNow),
  },
  (table) => [
    check(
      "mesocycle_exercise_doses_weekly_dose_check",
      sql`weekly_dose BETWEEN -999999 AND 999999`
    ),
    check("mesocycle_exercises_weekly_dose_positive", sql`weekly_dose > 0`),
    check(
      "mesocycle_exercises_weekly_dose_unit_check",
      sql`weekly_dose_unit IN ('sets', 'minutes', 'km')`
    ),
    dateCheck(
      "mesocycle_exercise_doses_effective_from_date",
      table.effective_from
    ),
    utcCheck("mesocycle_exercise_doses_created_at_utc", table.created_at),
    index("mesocycle_exercise_doses_lookup_idx").on(
      table.mesocycle_id,
      table.exercise_id,
      table.effective_from
    ),
  ]
);
