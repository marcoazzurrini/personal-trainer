import { sql } from "drizzle-orm";
import { check } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// Statement time, with milliseconds padded to six fractional digits. Explicit
// timestamp values stay TEXT and retain their original microsecond precision.
export const utcNow = sql`(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z')`;

export function utcCheck(name: string, column: AnySQLiteColumn) {
  return check(
    name,
    sql`${column} IS NULL OR (
    length(cast(${column} as blob)) = 27 AND substr(${column}, 1, 4) >= '0001'
    AND strftime('%Y-%m-%dT%H:%M:%S', substr(${column}, 1, 19), '+0 seconds') IS substr(${column}, 1, 19)
    AND substr(${column}, 20) GLOB '.[0-9][0-9][0-9][0-9][0-9][0-9]Z'
  )`
  );
}

export function dateCheck(name: string, column: AnySQLiteColumn) {
  return check(
    name,
    sql`${column} IS NULL OR (
    length(cast(${column} as blob)) = 10 AND substr(${column}, 1, 4) >= '0001'
    AND date(${column}, '+0 days') IS ${column}
  )`
  );
}

export function uuidCheck(name: string, column: AnySQLiteColumn) {
  return check(
    name,
    sql`${column} IS NULL OR (
    length(cast(${column} as blob)) = 36 AND substr(${column}, 9, 1) = '-' AND substr(${column}, 14, 1) = '-'
    AND substr(${column}, 19, 1) = '-' AND substr(${column}, 24, 1) = '-'
    AND length(replace(${column}, '-', '')) = 32 AND replace(${column}, '-', '') NOT GLOB '*[^0-9a-f]*'
  )`
  );
}
