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

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    height_cm: integer("height_cm"),
  },
  () => [check("users_height_cm_check", sql`height_cm BETWEEN -9999 AND 9999`)]
);

export const user_context = sqliteTable(
  "user_context",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topic: text("topic").notNull(),
    content: text("content").notNull(),
    written_at: text("written_at").notNull().default(utcNow),
    request_id: text("request_id"),
  },
  (table) => [
    unique("user_context_request_id_key").on(table.request_id),
    utcCheck("user_context_written_at_utc", table.written_at),
    uuidCheck("user_context_request_id_uuid", table.request_id),
    index("user_context_topic_written_at_idx").on(
      table.topic,
      sql`${table.written_at} desc`
    ),
  ]
);

export const week_schedules = sqliteTable(
  "week_schedules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    week_start: text("week_start").notNull(),
    schedule: text("schedule").notNull(),
    written_at: text("written_at").notNull().default(utcNow),
  },
  (table) => [
    unique("week_schedules_week_start_key").on(table.week_start),
    check(
      "week_schedules_starts_on_monday",
      sql`strftime('%w', week_start) = '1'`
    ),
    dateCheck("week_schedules_week_start_date", table.week_start),
    utcCheck("week_schedules_written_at_utc", table.written_at),
  ]
);
