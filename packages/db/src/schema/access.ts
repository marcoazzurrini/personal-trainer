import { sql } from "drizzle-orm";
import { check, customType, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { utcCheck, utcNow } from "./checks.ts";

// INT deliberately does not alias rowid; integer() would change singleton allocation.
const singletonInt = customType<{ data: number; driverData: number }>({
  dataType: () => "INT",
});

export const withings_auth = sqliteTable(
  "withings_auth",
  {
    id: singletonInt("id").primaryKey().default(1),
    withings_user_id: text("withings_user_id").notNull(),
    access_token: text("access_token").notNull(),
    refresh_token: text("refresh_token").notNull(),
    access_token_expires_at: text("access_token_expires_at").notNull(),
    last_sync_at: text("last_sync_at"),
    last_sync_attempt_at: text("last_sync_attempt_at"),
    updated_at: text("updated_at").notNull().default(utcNow),
  },
  (table) => [
    check("withings_auth_single_row", sql`id = 1`),
    utcCheck(
      "withings_auth_access_token_expires_at_utc",
      table.access_token_expires_at
    ),
    utcCheck("withings_auth_last_sync_at_utc", table.last_sync_at),
    utcCheck(
      "withings_auth_last_sync_attempt_at_utc",
      table.last_sync_attempt_at
    ),
    utcCheck("withings_auth_updated_at_utc", table.updated_at),
  ]
);

export const api_tokens = sqliteTable(
  "api_tokens",
  {
    token_hash: text("token_hash").primaryKey(),
    subject: text("subject").notNull(),
    issued_at: text("issued_at").notNull().default(utcNow),
    expires_at: text("expires_at").notNull(),
  },
  (table) => [
    check("api_tokens_expires_after_issue", sql`expires_at > issued_at`),
    utcCheck("api_tokens_issued_at_utc", table.issued_at),
    utcCheck("api_tokens_expires_at_utc", table.expires_at),
  ]
);
