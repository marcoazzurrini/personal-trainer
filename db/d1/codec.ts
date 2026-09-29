import { z } from "@hono/zod-openapi";

export const columnSchema = z.object({
  type: z.string(),
  nullable: z.boolean(),
  precision: z.number().nullable().optional(),
  scale: z.number().nullable().optional(),
});
export type Column = z.infer<typeof columnSchema>;
export type Columns = Record<string, Column>;
export const storageSchema = z.object({
  version: z.literal(1),
  tables: z.record(
    z.string(),
    z.object({
      decimals: z.record(
        z.string(),
        z.object({ precision: z.number(), scale: z.number() })
      ),
      booleans: z.array(z.string()).optional(),
      timestamps: z.array(z.string()).optional(),
      uuids: z.array(z.string()).optional(),
      arrays: z.array(z.string()).optional(),
      json: z.array(z.string()).optional(),
      caseKeys: z.record(z.string(), z.string()).optional(),
      identity: z.string().nullable().optional(),
    })
  ),
});
export type Storage = z.infer<typeof storageSchema>;
export type TableStorage = Storage["tables"][string];
export const sequenceSchema = z.object({
  last_value: z.string(),
  is_called: z.boolean(),
  increment_by: z.string(),
  cycle: z.boolean(),
  min_value: z.string(),
  max_value: z.string(),
});
export type Sequence = z.infer<typeof sequenceSchema>;
export const snapshotSchema = z.object({
  format: z.literal("personal-trainer-postgres-snapshot-v1"),
  exported_at: z.string(),
  migrations: z.array(z.string()),
  tables: z.record(
    z.string(),
    z.object({
      columns: z.record(z.string(), columnSchema),
      rows: z.array(z.record(z.string(), z.string().nullable())),
      sequence: sequenceSchema.nullable(),
    })
  ),
  views: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  completed_weeks_before: z.string(),
});
export const envelopeSchema = z.object({
  sha256: z.string(),
  snapshot: snapshotSchema,
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type StoredRow = Record<string, string | number | null>;

// Keep the original JSON property order: the checksum covers its exact serialization.
export function assertEnvelope(value: unknown): asserts value is Envelope {
  envelopeSchema.parse(value);
}

// This module has no I/O. PostgreSQL decimals arrive as text, never as floats.
// It is shared by migration tooling and the future D1 write boundary.
export function scaledInteger(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This decimal parser rejects malformed external values before numeric conversion.
  value: unknown,
  precision: number,
  scale: number
): number {
  if (
    !Number.isInteger(precision) ||
    precision < 1 ||
    precision > 15 ||
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > precision
  ) {
    throw new Error("Unsupported decimal precision or scale.");
  }
  const text = String(value);
  const match =
    /^(?<sign>[+-]?)(?<integer>\d+)(?:\.(?<fraction>\d*))?(?:[eE](?<exponent>[+-]?\d+))?$/u.exec(
      text
    );
  if (
    !match?.groups ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Exported decimal input must be text or a number, never a coercible object.
    (typeof value !== "number" && typeof value !== "string")
  ) {
    throw new Error("Expected a finite decimal number.");
  }
  const exponent = Number(match.groups.exponent ?? 0);
  if (
    !Number.isSafeInteger(exponent) ||
    Math.abs(exponent) > 1000 ||
    text.length > 1100
  ) {
    throw new Error("Decimal magnitude exceeds the supported range.");
  }
  const fraction = match.groups.fraction ?? "";
  const digits = BigInt(match.groups.integer + fraction);
  const shift = exponent - fraction.length + scale;
  let stored;
  if (shift >= 0) {
    stored = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    // PostgreSQL numeric rounds ties away from zero, including negative ties.
    stored = digits / divisor + ((digits % divisor) * 2n >= divisor ? 1n : 0n);
  }
  if (stored >= 10n ** BigInt(precision)) {
    throw new Error("Decimal exceeds the stored precision after rounding.");
  }
  return Number(match.groups.sign === "-" ? -stored : stored);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This integer parser checks syntax and precision of external values.
export function safeInteger(value: unknown): number {
  if (!/^-?\d+$/u.test(String(value))) {
    throw new Error("Expected an integer.");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new TypeError("Integer exceeds JavaScript's exact range.");
  }
  return number;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary accepts only the explicitly listed PostgreSQL boolean representations.
export function booleanInteger(value: unknown): 0 | 1 {
  if (value === true || value === "true" || value === "t" || value === 1) {
    return 1;
  }
  if (value === false || value === "false" || value === "f" || value === 0) {
    return 0;
  }
  throw new Error("Expected a PostgreSQL boolean.");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This UUID parser validates external snapshot fields.
export function canonicalUuid(value: unknown): string {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- UUIDs arrive from an external snapshot and must not be coerced.
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value
    )
  ) {
    throw new Error("Expected a canonical UUID.");
  }
  return value.toLowerCase();
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This timestamp parser validates external text and calendar precision.
export function canonicalInstant(value: unknown): string {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Snapshot instants require text with all six fractional digits.
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value)
  ) {
    throw new Error(
      "Export instants as UTC with exactly six fractional digits."
    );
  }
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== `${value.slice(0, 23)}Z`
  ) {
    throw new Error("Invalid calendar instant.");
  }
  // Date is used to validate the calendar only; return all six digits unchanged.
  return value;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This date parser rejects malformed external calendar dates.
export function canonicalDate(value: unknown): string {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Snapshot dates must be text, not values coerced by Date.
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new Error("Expected a real YYYY-MM-DD calendar date.");
  }
  return value;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- canonicalInstant validates this external value before timezone conversion.
export function romeDate(value: unknown): string {
  const instant = canonicalInstant(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(
    parts.map(({ type, value: part }) => [type, part])
  );
  return `${values.year.padStart(4, "0")}-${values.month}-${values.day}`;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This text boundary rejects non-string snapshot values before normalization.
export function caseKey(value: unknown): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- External case keys must be text before Unicode lowercasing.
  if (typeof value !== "string") {
    throw new TypeError("Expected text for a case-insensitive key.");
  }
  // No accent removal or Unicode normalization: those would merge more names
  // than case-insensitive matching alone. Export checks PostgreSQL's result too.
  return value.toLowerCase();
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser validates raw JSON text without rounding large numbers through reserialization.
export function jsonText(value: unknown): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve exported JSON bytes, including integers larger than 2^53.
  if (typeof value !== "string") {
    throw new TypeError("Export JSON as text.");
  }
  JSON.parse(value);
  // Validate without reserializing: JSON may contain numbers larger than 2^53.
  return value;
}

function expectedTypes(name: string, storage: TableStorage): string[] {
  if (storage.decimals?.[name]) {
    return ["numeric"];
  }
  const categories: [string[] | undefined, string][] = [
    [storage.booleans, "boolean"],
    [storage.timestamps, "timestamp with time zone"],
    [storage.uuids, "uuid"],
    [storage.arrays, "ARRAY"],
    [storage.json, "jsonb"],
  ];
  for (const [names, type] of categories) {
    if (names?.includes(name)) {
      return [type];
    }
  }
  return ["bigint", "integer", "smallint", "date", "text"];
}

export function validateColumns(
  table: string,
  columns: Columns,
  storage: TableStorage
): void {
  for (const [name, column] of Object.entries(columns)) {
    const decimal = storage.decimals?.[name];
    const expected = expectedTypes(name, storage);
    if (!expected.includes(column.type)) {
      throw new Error(
        `${table}.${name}: source type ${column.type} does not match reviewed ${expected.join(
          " or "
        )} storage.`
      );
    }
    if (
      decimal &&
      (decimal.precision !== column.precision || decimal.scale !== column.scale)
    ) {
      throw new Error(
        `${table}.${name}: decimal storage differs from the source.`
      );
    }
  }
}

function convertValue(
  table: string,
  name: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Each dynamic snapshot field is checked against its declared storage codec here.
  value: unknown,
  type: string,
  storage: TableStorage
): string | number {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Snapshot rows contain only text or null; refuse coercible objects and floats.
  if (typeof value !== "string") {
    throw new TypeError(
      `${table}.${name}: export values must be text or null.`
    );
  }
  if (storage.decimals?.[name]) {
    const { precision, scale } = storage.decimals[name];
    return scaledInteger(value, precision, scale);
  }
  const codecs: [string[] | undefined, (value: string) => string | number][] = [
    [storage.booleans, booleanInteger],
    [storage.timestamps, canonicalInstant],
    [storage.uuids, canonicalUuid],
    [storage.json, jsonText],
    [storage.arrays, jsonText],
  ];
  for (const [names, convert] of codecs) {
    if (names?.includes(name)) {
      return convert(value);
    }
  }
  if (["bigint", "integer", "smallint"].includes(type)) {
    return safeInteger(value);
  }
  if (type === "date") {
    return canonicalDate(value);
  }
  if (type === "text") {
    return value;
  }
  throw new Error(
    `${table}.${name}: storage conversion is not defined for ${type}.`
  );
}

export function convertRow(
  table: string,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Snapshot field names are dynamic; every value is validated against its declared column below.
  source: Record<string, unknown>,
  columns: Columns,
  storage: TableStorage
): StoredRow {
  validateColumns(table, columns, storage);
  const expected = Object.keys(columns).toSorted();
  if (
    JSON.stringify(Object.keys(source).toSorted()) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `${table}: exported row does not match its declared columns.`
    );
  }
  const row: StoredRow = {};
  for (const name of expected) {
    const value = source[name];
    if (value === null) {
      if (!columns[name].nullable) {
        throw new Error(`${table}.${name}: unexpected null.`);
      }
      row[name] = null;
      continue;
    }
    row[name] = convertValue(table, name, value, columns[name].type, storage);
  }
  for (const [key, name] of Object.entries(storage.caseKeys ?? {})) {
    row[key] = caseKey(row[name]);
  }
  if (table === "bodyweight") {
    row.measured_date = romeDate(row.measured_at);
  }
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- Dynamic SQL column names map to values produced by the validated storage codecs above.
  return row;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This identifier parser guards all dynamic SQL interpolation.
export function identifier(name: unknown): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Schema identifiers from snapshots must be validated before SQL interpolation.
  if (typeof name !== "string" || !/^[a-z_][a-z0-9_]*$/u.test(name)) {
    throw new Error("Invalid schema identifier.");
  }
  return `"${name}"`;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This SQL encoder rejects external values outside its exact supported scalar set.
export function sqlLiteral(value: unknown): string {
  if (value === null) {
    return "NULL";
  }
  if (Number.isSafeInteger(value)) {
    return String(value);
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SQL literals reject every external value except text, safe integers and null.
  if (typeof value !== "string") {
    throw new TypeError(
      "Only text, safe integers and null are supported in imports."
    );
  }
  // Hex avoids SQL injection and preserves quotes, newlines, NUL, and Unicode.
  return `CAST(X'${Buffer.from(value, "utf-8").toString("hex")}' AS TEXT)`;
}
