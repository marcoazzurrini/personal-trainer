// This module has no I/O. PostgreSQL decimals arrive as text, never as floats.
// It is shared by migration tooling and the future D1 write boundary.
export function scaledInteger(value, precision, scale) {
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
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Exported decimal input must be text or a number, never a coercible object.
  if (!match || (typeof value !== "number" && typeof value !== "string")) {
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

export function safeInteger(value) {
  if (!/^-?\d+$/u.test(String(value))) {
    throw new Error("Expected an integer.");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new TypeError("Integer exceeds JavaScript's exact range.");
  }
  return number;
}

export function booleanInteger(value) {
  if (value === true || value === "true" || value === "t" || value === 1) {
    return 1;
  }
  if (value === false || value === "false" || value === "f" || value === 0) {
    return 0;
  }
  throw new Error("Expected a PostgreSQL boolean.");
}

export function canonicalUuid(value) {
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

export function canonicalInstant(value) {
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

export function canonicalDate(value) {
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

export function romeDate(instant) {
  canonicalInstant(instant);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value])
  );
  return `${values.year.padStart(4, "0")}-${values.month}-${values.day}`;
}

export function caseKey(value) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- External case keys must be text before Unicode lowercasing.
  if (typeof value !== "string") {
    throw new TypeError("Expected text for a case-insensitive key.");
  }
  // No accent removal or Unicode normalization: those would merge more names
  // than case-insensitive matching alone. Export checks PostgreSQL's result too.
  return value.toLowerCase();
}

export function jsonText(value) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve exported JSON bytes, including integers larger than 2^53.
  if (typeof value !== "string") {
    throw new TypeError("Export JSON as text.");
  }
  JSON.parse(value);
  // Validate without reserializing: JSON may contain numbers larger than 2^53.
  return value;
}

function expectedTypes(name, storage) {
  if (storage.decimals?.[name]) {
    return ["numeric"];
  }
  const categories = [
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

export function validateColumns(table, columns, storage) {
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

function convertValue(table, name, value, type, storage) {
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
  const codecs = [
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

export function convertRow(table, source, columns, storage) {
  validateColumns(table, columns, storage);
  const expected = Object.keys(columns).toSorted();
  if (
    JSON.stringify(Object.keys(source).toSorted()) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `${table}: exported row does not match its declared columns.`
    );
  }
  const row = {};
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
  return row;
}

export function identifier(name) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Schema identifiers from snapshots must be validated before SQL interpolation.
  if (typeof name !== "string" || !/^[a-z_][a-z0-9_]*$/u.test(name)) {
    throw new Error("Invalid schema identifier.");
  }
  return `"${name}"`;
}

export function sqlLiteral(value) {
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
