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

export const foods = sqliteTable(
  "foods",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    brand: text("brand"),
    kcal_100g: integer("kcal_100g").notNull(),
    protein_100g: integer("protein_100g").notNull(),
    carbs_100g: integer("carbs_100g").notNull(),
    fat_100g: integer("fat_100g").notNull(),
    fiber_100g: integer("fiber_100g"),
    grams_per_unit: integer("grams_per_unit"),
    source: text("source").notNull(),
    source_note: text("source_note"),
    request_id: text("request_id"),
    created_at: text("created_at").notNull().default(utcNow),
    macro_revision: integer("macro_revision").notNull().default(0),
    name_key: text("name_key").notNull(),
  },
  (table) => [
    check("foods_kcal_100g_check", sql`kcal_100g BETWEEN -999999 AND 999999`),
    check(
      "foods_protein_100g_check",
      sql`protein_100g BETWEEN -99999 AND 99999`
    ),
    check("foods_carbs_100g_check", sql`carbs_100g BETWEEN -99999 AND 99999`),
    check("foods_fat_100g_check", sql`fat_100g BETWEEN -99999 AND 99999`),
    check("foods_fiber_100g_check", sql`fiber_100g BETWEEN -99999 AND 99999`),
    check(
      "foods_grams_per_unit_check",
      sql`grams_per_unit BETWEEN -999999 AND 999999`
    ),
    check("foods_macro_revision_check", sql`macro_revision >= 0`),
    check(
      "foods_source_check",
      sql`source IN ('label', 'crea', 'usda', 'off', 'estimate')`
    ),
    check("foods_kcal_not_negative", sql`kcal_100g >= 0`),
    check("foods_protein_not_negative", sql`protein_100g >= 0`),
    check("foods_carbs_not_negative", sql`carbs_100g >= 0`),
    check("foods_fat_not_negative", sql`fat_100g >= 0`),
    check(
      "foods_fiber_not_negative",
      sql`fiber_100g IS NULL OR fiber_100g >= 0`
    ),
    check(
      "foods_grams_per_unit_positive",
      sql`grams_per_unit IS NULL OR grams_per_unit > 0`
    ),
    unique("foods_request_id_key").on(table.request_id),
    utcCheck("foods_created_at_utc", table.created_at),
    uuidCheck("foods_request_id_uuid", table.request_id),
    uniqueIndex("foods_name_key").on(table.name_key),
  ]
);

export const food_aliases = sqliteTable(
  "food_aliases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    food_id: integer("food_id").notNull(),
    alias: text("alias").notNull(),
    alias_key: text("alias_key").notNull(),
  },
  (table) => [
    foreignKey({
      name: "food_aliases_food_id_fkey",
      columns: [table.food_id],
      foreignColumns: [foods.id],
    }).onDelete("cascade"),
    uniqueIndex("food_aliases_alias_key").on(table.alias_key),
    index("food_aliases_food_id_idx").on(table.food_id),
  ]
);

export const meals = sqliteTable(
  "meals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    request_id: text("request_id"),
    created_at: text("created_at").notNull().default(utcNow),
    name_key: text("name_key").notNull(),
  },
  (table) => [
    unique("meals_request_id_key").on(table.request_id),
    utcCheck("meals_created_at_utc", table.created_at),
    uuidCheck("meals_request_id_uuid", table.request_id),
    uniqueIndex("meals_name_key").on(table.name_key),
  ]
);

export const meal_aliases = sqliteTable(
  "meal_aliases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    meal_id: integer("meal_id")
      .notNull()
      .references(() => meals.id),
    alias: text("alias").notNull(),
    alias_key: text("alias_key").notNull(),
  },
  (table) => [
    uniqueIndex("meal_aliases_alias_key").on(table.alias_key),
    index("meal_aliases_meal_id_idx").on(table.meal_id),
  ]
);

export const meal_items = sqliteTable(
  "meal_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    meal_id: integer("meal_id")
      .notNull()
      .references(() => meals.id),
    food_id: integer("food_id")
      .notNull()
      .references(() => foods.id),
    grams: integer("grams").notNull(),
  },
  (table) => [
    check("meal_items_grams_check", sql`grams BETWEEN -9999999 AND 9999999`),
    check("meal_items_grams_positive", sql`grams > 0`),
    unique("meal_items_meal_food_key").on(table.meal_id, table.food_id),
    index("meal_items_food_id_idx").on(table.food_id),
  ]
);

export const intake_entries = sqliteTable(
  "intake_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(),
    food_id: integer("food_id").references(() => foods.id),
    grams: integer("grams"),
    meal_id: integer("meal_id").references(() => meals.id),
    kcal: integer("kcal"),
    protein_g: integer("protein_g"),
    carbs_g: integer("carbs_g"),
    fat_g: integer("fat_g"),
    fiber_g: integer("fiber_g"),
    note: text("note"),
    request_id: text("request_id"),
    created_at: text("created_at").notNull().default(utcNow),
    food_macro_revision: integer("food_macro_revision"),
  },
  (table) => [
    check(
      "intake_entries_grams_check",
      sql`grams BETWEEN -9999999 AND 9999999`
    ),
    check("intake_entries_kcal_check", sql`kcal BETWEEN -9999999 AND 9999999`),
    check(
      "intake_entries_protein_g_check",
      sql`protein_g BETWEEN -999999 AND 999999`
    ),
    check(
      "intake_entries_carbs_g_check",
      sql`carbs_g BETWEEN -999999 AND 999999`
    ),
    check("intake_entries_fat_g_check", sql`fat_g BETWEEN -999999 AND 999999`),
    check(
      "intake_entries_fiber_g_check",
      sql`fiber_g BETWEEN -999999 AND 999999`
    ),
    check(
      "intake_entries_food_macro_revision_check",
      sql`food_macro_revision >= 0`
    ),
    check("intake_entries_grams_positive", sql`grams IS NULL OR grams > 0`),
    check("intake_entries_kcal_not_negative", sql`kcal >= 0`),
    check(
      "intake_entries_protein_not_negative",
      sql`protein_g IS NULL OR protein_g >= 0`
    ),
    check(
      "intake_entries_carbs_not_negative",
      sql`carbs_g IS NULL OR carbs_g >= 0`
    ),
    check("intake_entries_fat_not_negative", sql`fat_g IS NULL OR fat_g >= 0`),
    check(
      "intake_entries_fiber_not_negative",
      sql`fiber_g IS NULL OR fiber_g >= 0`
    ),
    check(
      "intake_entries_food_grams_pair",
      sql`(food_id IS NULL) = (grams IS NULL)`
    ),
    check(
      "intake_entries_macro_shape",
      sql`(food_id IS NULL AND kcal IS NOT NULL AND food_macro_revision IS NULL) OR (food_id IS NOT NULL AND ( (food_macro_revision IS NULL AND kcal IS NULL AND protein_g IS NULL AND carbs_g IS NULL AND fat_g IS NULL AND fiber_g IS NULL) OR (food_macro_revision IS NOT NULL AND kcal IS NOT NULL AND protein_g IS NOT NULL AND carbs_g IS NOT NULL AND fat_g IS NOT NULL) ))`
    ),
    dateCheck("intake_entries_day_date", table.day),
    utcCheck("intake_entries_created_at_utc", table.created_at),
    uuidCheck("intake_entries_request_id_uuid", table.request_id),
    uniqueIndex("intake_entries_request_food_key")
      .on(table.request_id, table.food_id)
      .where(sql`request_id is not null and food_id is not null`),
    uniqueIndex("intake_entries_request_adhoc_key")
      .on(table.request_id)
      .where(sql`request_id is not null and food_id is null`),
    index("intake_entries_day_idx").on(table.day),
    index("intake_entries_food_id_idx").on(table.food_id),
    index("intake_entries_meal_id_idx").on(table.meal_id),
  ]
);

export const day_flags = sqliteTable(
  "day_flags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(),
    flag: text("flag").notNull(),
    created_at: text("created_at").notNull().default(utcNow),
  },
  (table) => [
    check("day_flags_flag_check", sql`flag IN ('incomplete')`),
    unique("day_flags_day_flag_key").on(table.day, table.flag),
    dateCheck("day_flags_day_date", table.day),
    utcCheck("day_flags_created_at_utc", table.created_at),
  ]
);

export const nutrition_targets = sqliteTable(
  "nutrition_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    effective_from: text("effective_from").notNull(),
    goal: text("goal").notNull(),
    rate_pct_bw_week: integer("rate_pct_bw_week").notNull(),
    kcal_target: integer("kcal_target").notNull(),
    protein_g_target: integer("protein_g_target").notNull(),
    decision: text("decision").notNull(),
    tdee_at_creation: integer("tdee_at_creation"),
    clipped: integer("clipped").notNull().default(0),
    clipped_reasons: text("clipped_reasons").notNull().default("[]"),
    request_id: text("request_id"),
    created_at: text("created_at").notNull().default(utcNow),
    phase_switch_suppressed: integer("phase_switch_suppressed")
      .notNull()
      .default(0),
  },
  (table) => [
    check(
      "nutrition_targets_rate_pct_bw_week_check",
      sql`rate_pct_bw_week BETWEEN -9999 AND 9999`
    ),
    check(
      "nutrition_targets_kcal_target_check",
      sql`kcal_target BETWEEN -2147483648 AND 2147483647`
    ),
    check(
      "nutrition_targets_protein_g_target_check",
      sql`protein_g_target BETWEEN -2147483648 AND 2147483647`
    ),
    check(
      "nutrition_targets_tdee_at_creation_check",
      sql`tdee_at_creation BETWEEN -2147483648 AND 2147483647`
    ),
    check("nutrition_targets_clipped_check", sql`clipped IN (0, 1)`),
    check(
      "nutrition_targets_phase_switch_suppressed_check",
      sql`phase_switch_suppressed IN (0, 1)`
    ),
    check(
      "nutrition_targets_goal_check",
      sql`goal IN ('cut', 'maintain', 'gain', 'recomp')`
    ),
    check("nutrition_targets_kcal_positive", sql`kcal_target > 0`),
    check("nutrition_targets_protein_positive", sql`protein_g_target > 0`),
    check(
      "nutrition_targets_rate_sane",
      sql`rate_pct_bw_week > -300 AND rate_pct_bw_week < 300`
    ),
    unique("nutrition_targets_request_id_key").on(table.request_id),
    check(
      "nutrition_targets_clipped_reasons_check",
      sql`CASE WHEN json_valid(clipped_reasons) THEN json_type(clipped_reasons) = 'array' ELSE 0 END`
    ),
    check(
      "nutrition_targets_clipped_pair",
      sql`CASE WHEN json_valid(clipped_reasons) THEN clipped = (json_array_length(clipped_reasons) > 0) ELSE 0 END`
    ),
    dateCheck("nutrition_targets_effective_from_date", table.effective_from),
    utcCheck("nutrition_targets_created_at_utc", table.created_at),
    uuidCheck("nutrition_targets_request_id_uuid", table.request_id),
    index("nutrition_targets_effective_from_idx").on(
      sql`${table.effective_from} desc`
    ),
  ]
);

export const nutrition_events = sqliteTable(
  "nutrition_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(),
    kind: text("kind").notNull(),
    note: text("note"),
    request_id: text("request_id"),
    created_at: text("created_at").notNull().default(utcNow),
  },
  (table) => [
    check(
      "nutrition_events_kind_check",
      sql`kind IN ('creatine_start', 'phase_switch', 'program_change', 'logging_change', 'other')`
    ),
    unique("nutrition_events_request_id_key").on(table.request_id),
    dateCheck("nutrition_events_day_date", table.day),
    utcCheck("nutrition_events_created_at_utc", table.created_at),
    uuidCheck("nutrition_events_request_id_uuid", table.request_id),
    index("nutrition_events_day_idx").on(sql`${table.day} desc`),
  ]
);
