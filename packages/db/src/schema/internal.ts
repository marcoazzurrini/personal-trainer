import { sql } from "drizzle-orm";
import { check, integer, sqliteTable } from "drizzle-orm/sqlite-core";

export const api_write_assertions = sqliteTable(
  "api_write_assertions",
  {
    id: integer("id").primaryKey(),
    version_matches: integer("version_matches").notNull().default(1),
    rows_match: integer("rows_match").notNull().default(1),
    plan_matches: integer("plan_matches").notNull().default(1),
  },
  () => [
    check("api_write_assertions_id_check", sql`id = 1`),
    check("api_plan_membership_changed", sql`plan_matches = 1`),
    check("api_session_changed", sql`version_matches = 1`),
    check("api_incomplete_write", sql`rows_match = 1`),
  ]
);

export const nutrition_write_assertions = sqliteTable(
  "nutrition_write_assertions",
  {
    id: integer("id").primaryKey(),
    valid: integer("valid").notNull().default(1),
  },
  () => [
    check("nutrition_write_assertions_id_check", sql`id = 1`),
    check("api_incomplete_write", sql`valid = 1`),
  ]
);
