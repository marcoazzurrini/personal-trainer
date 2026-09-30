// Narrow structural types for Cloudflare's native binding. No SQL translation,
// connection pool, transaction emulation, or process-global database handle.
import { ApiError, constraintMessages } from "./errors.ts";
import {
  canonicalDate,
  canonicalInstant,
  canonicalUuid,
  romeDate as canonicalRomeDate,
  scaledInteger,
} from "./storage.ts";

export type Parameter = string | number | null;
export interface StoredRow {
  [column: string]: Parameter | ArrayBuffer;
}
export interface Statement {
  bind: (...values: Parameter[]) => Statement;
  all: <T = StoredRow>() => Promise<Result<T>>;
}
export interface Result<T = StoredRow> {
  results: T[];
  success: boolean;
}
export interface Database {
  prepare: (query: string) => Statement;
  batch: <T = StoredRow>(statements: Statement[]) => Promise<Result<T>[]>;
}

export function statement(
  db: Database,
  text: string,
  ...values: Parameter[]
): Statement {
  return db.prepare(text).bind(...values);
}

export async function rows<T>(
  db: Database,
  text: string,
  ...values: Parameter[]
): Promise<T[]> {
  try {
    return (await statement(db, text, ...values).all<T>()).results;
  } catch (error) {
    throw databaseError(error);
  }
}

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

// D1 limits each SQL string/blob value to 2 MB. Normalized set objects can be
// larger than the accepted HTTP body; leave headroom and split array bindings.
const MAX_JSON_BIND_BYTES = 1536 * 1024;
export function jsonChunks(
  values: readonly unknown[]
): { json: string; count: number; offset: number }[] {
  const chunks: { json: string; count: number; offset: number }[] = [];
  const encoder = new TextEncoder();
  let parts: string[] = [];
  let bytes = 2;
  let offset = 0;
  const flush = () => {
    chunks.push({ json: `[${parts.join(",")}]`, count: parts.length, offset });
    offset += parts.length;
    parts = [];
    bytes = 2;
  };
  for (const value of values) {
    const part = JSON.stringify(value);
    if (part === undefined) {
      throw new Error("Cannot encode an undefined write item.");
    }
    const size = encoder.encode(part).byteLength;
    if (size + 2 > MAX_JSON_BIND_BYTES) {
      throw new ApiError(
        413,
        "One entry exceeds the database value limit. Shorten its text before retrying. Nothing was written."
      );
    }
    if (parts.length && bytes + size + 1 > MAX_JSON_BIND_BYTES) {
      flush();
    }
    bytes += size + (parts.length ? 1 : 0);
    parts.push(part);
  }
  if (parts.length || chunks.length === 0) {
    flush();
  }
  return chunks;
}

function hasKey<T extends object>(value: T, key: PropertyKey): key is keyof T {
  return Object.hasOwn(value, key);
}

function constraintMessage(name: string | undefined): string | undefined {
  return name !== undefined && hasKey(constraintMessages, name)
    ? constraintMessages[name]
    : undefined;
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- D1 exception boundary: map recognized constraints and pass every other thrown value unchanged to the diagnostic handler. */
export function databaseError(error: unknown): unknown {
  if (error instanceof ApiError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "";
  const unique =
    /UNIQUE constraint failed: (?<columns>[a-z_]+\.[a-z_]+(?:, [a-z_]+\.[a-z_]+)*)/iu.exec(
      message
    );
  if (unique) {
    const [, columns] = unique;
    const name = hasKey(uniqueConstraints, columns)
      ? uniqueConstraints[columns]
      : undefined;
    return new ApiError(
      409,
      constraintMessage(name) ??
        "That would duplicate an existing record. Read the existing record; reuse the original request_id only when retrying the same operation."
    );
  }
  const check =
    /CHECK constraint failed: (?<constraint>[a-z_][a-z_0-9]*)/iu.exec(message);
  if (check?.[1] === "api_incomplete_write") {
    return new ApiError(
      409,
      "The record changed while saving it. Nothing was saved. Read the record before retrying."
    );
  }
  if (check) {
    return new ApiError(
      422,
      constraintMessage(check[1]) ??
        `The database rejected a value (check constraint "${
          check[1]
        }"). Fix the offending field and retry.`
    );
  }
  const required =
    /NOT NULL constraint failed: [a-z_][a-z_0-9]*\.(?<column>[a-z_][a-z_0-9]*)/iu.exec(
      message
    );
  if (required) {
    return new ApiError(
      422,
      `"${
        required[1]
      }" is required and cannot be null. Omit the field to leave it unchanged, or send a real value.`
    );
  }
  if (message.includes("FOREIGN KEY constraint failed")) {
    return new ApiError(
      422,
      "A referenced row does not exist. Read the referenced record and use its current id."
    );
  }
  // Unknown failures reach the existing safe diagnostic envelope. Never expose
  // raw D1 errors, which can contain bound values, provider tokens or SQL.
  return error;
}

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening */

export async function batch<T = StoredRow>(
  db: Database,
  statements: Statement[]
): Promise<Result<T>[]> {
  try {
    return await db.batch<T>(statements);
  } catch (error) {
    throw databaseError(error);
  }
}

export function decimal(
  value: number,
  precision: number,
  scale: number
): number;
export function decimal(
  value: number | null,
  precision: number,
  scale: number
): number | null;
export function decimal(
  value: number | null,
  precision: number,
  scale: number
): number | null {
  if (value === null) {
    return null;
  }
  try {
    return scaledInteger(value, precision, scale);
  } catch {
    throw new ApiError(
      422,
      "A number is too large or is not finite. Check for a misplaced decimal point, or per-serving values sent as per-100 g."
    );
  }
}

/** Accept the API's offset-bearing instants without losing microseconds. */
export function instant(value: string): string {
  const match =
    /^(?<wallClock>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d{1,6}))?(?<offset>Z|[+-]\d{2}:\d{2})$/u.exec(
      value
    );
  if (!match) {
    throw new ApiError(
      422,
      "Send a real timestamp with a timezone and no more than six fractional digits."
    );
  }
  try {
    // Validate the wall-clock calendar before Date can normalize an impossible
    // day. Then convert the offset with Date and restore all fractional digits.
    canonicalInstant(`${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`);
    const parsed = new Date(value);
    if (
      match[1].startsWith("0000") ||
      parsed.toISOString().startsWith("0000")
    ) {
      throw new Error("Unsupported year.");
    }
    return canonicalInstant(
      `${parsed.toISOString().slice(0, 19)}.${(match[2] ?? "").padEnd(6, "0")}Z`
    );
  } catch {
    throw new ApiError(
      422,
      "Send a real timestamp with a timezone, in years 0001–9999."
    );
  }
}

// Match the PostgreSQL driver's Date JSON representation at the wire boundary,
// not in storage or validation snapshots: omitted microseconds stay untouched.
export function wireInstant(value: string): string;
export function wireInstant(value: string | null): string | null;
export function wireInstant(value: string | null): string | null {
  return value === null ? null : `${value.slice(0, 23)}Z`;
}

export function date(value: string): string {
  try {
    if (value.slice(0, 4) === "0000") {
      throw new Error("Unsupported year.");
    }
    return canonicalDate(value);
  } catch {
    throw new ApiError(
      422,
      "Send a real YYYY-MM-DD calendar date in years 0001–9999."
    );
  }
}

export function requestId(value: string): string {
  try {
    return canonicalUuid(value);
  } catch {
    throw new ApiError(
      422,
      "request_id must be a UUID. Reuse it only when retrying the same operation."
    );
  }
}

// Runtime callers also supply Date.toISOString() values. The transfer codec
// deliberately accepts only canonical export instants, so normalize here.
export function romeDate(value: string): string {
  return canonicalRomeDate(instant(value));
}

export { caseKey } from "./storage.ts";

/** The clock is injectable only at construction, not supplied by API callers. */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
