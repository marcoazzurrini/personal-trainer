import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

import { dateCheck, utcCheck, utcNow, uuidCheck } from "./checks.ts";

export const bodyweight = sqliteTable(
  "bodyweight",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    value_kg: integer("value_kg").notNull(),
    measured_at: text("measured_at").notNull(),
    source: text("source").notNull().default("manual"),
    measured_date: text("measured_date").notNull(),
  },
  (table) => [
    check("bodyweight_value_kg_check", sql`value_kg BETWEEN -99999 AND 99999`),
    check("bodyweight_value_positive", sql`value_kg > 0`),
    unique("bodyweight_measured_at_source_key").on(
      table.measured_at,
      table.source
    ),
    dateCheck("bodyweight_measured_date_date", table.measured_date),
    utcCheck("bodyweight_measured_at_utc", table.measured_at),
    index("bodyweight_measured_date_instant_idx").on(
      table.measured_date,
      table.measured_at,
      table.id
    ),
  ]
);

export const bodyfat_estimates = sqliteTable(
  "bodyfat_estimates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(),
    percent: integer("percent").notNull(),
    method: text("method").notNull(),
    note: text("note"),
    request_id: text("request_id"),
    created_at: text("created_at").notNull().default(utcNow),
  },
  (table) => [
    check(
      "bodyfat_estimates_percent_check",
      sql`percent BETWEEN -9999 AND 9999`
    ),
    check(
      "bodyfat_estimates_method_check",
      sql`method IN ('bia', 'dxa', 'caliper', 'visual', 'other')`
    ),
    check(
      "bodyfat_estimates_percent_range",
      sql`percent > 0 AND percent < 750`
    ),
    unique("bodyfat_estimates_day_method_key").on(table.day, table.method),
    unique("bodyfat_estimates_request_id_key").on(table.request_id),
    dateCheck("bodyfat_estimates_day_date", table.day),
    utcCheck("bodyfat_estimates_created_at_utc", table.created_at),
    uuidCheck("bodyfat_estimates_request_id_uuid", table.request_id),
  ]
);
