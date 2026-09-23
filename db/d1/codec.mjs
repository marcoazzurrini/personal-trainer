// This module has no I/O. PostgreSQL decimals arrive as text, never as floats.
// It is shared by migration tooling and the future D1 write boundary.
export function scaledInteger(value, precision, scale) {
  if (
    !Number.isInteger(precision) || precision < 1 || precision > 15 ||
    !Number.isInteger(scale) || scale < 0 || scale > precision
  ) {
    throw new Error("Unsupported decimal precision or scale.");
  }
  const text = String(value);
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || (typeof value !== "number" && typeof value !== "string")) {
    throw new Error("Expected a finite decimal number.");
  }
  const exponent = Number(match[4] ?? 0);
  if (
    !Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000 ||
    text.length > 1100
  ) {
    throw new Error("Decimal magnitude exceeds the supported range.");
  }
  const fraction = match[3] ?? "";
  const digits = BigInt(match[2] + fraction);
  const shift = exponent - fraction.length + scale;
  let stored;
  if (shift >= 0) {
    stored = digits * (10n ** BigInt(shift));
  } else {
    const divisor = 10n ** BigInt(-shift);
    // PostgreSQL numeric rounds ties away from zero, including negative ties.
    stored = digits / divisor + (digits % divisor * 2n >= divisor ? 1n : 0n);
  }
  if (stored >= 10n ** BigInt(precision)) {
    throw new Error("Decimal exceeds the stored precision after rounding.");
  }
  return Number(match[1] === "-" ? -stored : stored);
}

export function safeInteger(value) {
  if (!/^-?\d+$/.test(String(value))) throw new Error("Expected an integer.");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error("Integer exceeds JavaScript's exact range.");
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
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error("Expected a canonical UUID.");
  }
  return value.toLowerCase();
}

export function canonicalInstant(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
  ) {
    throw new Error(
      "Export instants as UTC with exactly six fractional digits.",
    );
  }
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== value.slice(0, 23) + "Z"
  ) {
    throw new Error("Invalid calendar instant.");
  }
  // Date is used to validate the calendar only; return all six digits unchanged.
  return value;
}

export function canonicalDate(value) {
  if (
    typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
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
    parts.map(({ type, value }) => [type, value]),
  );
  return `${values.year.padStart(4, "0")}-${values.month}-${values.day}`;
}

export function caseKey(value) {
  if (typeof value !== "string") {
    throw new Error("Expected text for a case-insensitive key.");
  }
  // No accent removal or Unicode normalization: those would merge more names
  // than case-insensitive matching alone. Export checks PostgreSQL's result too.
  return value.toLowerCase();
}

export function jsonText(value) {
  if (typeof value !== "string") throw new Error("Export JSON as text.");
  JSON.parse(value);
  // Validate without reserializing: JSON may contain numbers larger than 2^53.
  return value;
}

export function validateColumns(table, columns, storage) {
  for (const [name, column] of Object.entries(columns)) {
    const decimal = storage.decimals?.[name];
    const expected = decimal
      ? ["numeric"]
      : storage.booleans?.includes(name)
      ? ["boolean"]
      : storage.timestamps?.includes(name)
      ? ["timestamp with time zone"]
      : storage.uuids?.includes(name)
      ? ["uuid"]
      : storage.arrays?.includes(name)
      ? ["ARRAY"]
      : storage.json?.includes(name)
      ? ["jsonb"]
      : ["bigint", "integer", "smallint", "date", "text"];
    if (!expected.includes(column.type)) {
      throw new Error(
        `${table}.${name}: source type ${column.type} does not match reviewed ${
          expected.join(" or ")
        } storage.`,
      );
    }
    if (
      decimal &&
      (decimal.precision !== column.precision || decimal.scale !== column.scale)
    ) {
      throw new Error(
        `${table}.${name}: decimal storage differs from the source.`,
      );
    }
  }
}

export function convertRow(table, source, columns, storage) {
  validateColumns(table, columns, storage);
  const expected = Object.keys(columns).sort();
  if (JSON.stringify(Object.keys(source).sort()) !== JSON.stringify(expected)) {
    throw new Error(
      `${table}: exported row does not match its declared columns.`,
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
    if (typeof value !== "string") {
      throw new Error(`${table}.${name}: export values must be text or null.`);
    }
    if (storage.decimals?.[name]) {
      const { precision, scale } = storage.decimals[name];
      row[name] = scaledInteger(value, precision, scale);
    } else if (storage.booleans?.includes(name)) {
      row[name] = booleanInteger(value);
    } else if (storage.timestamps?.includes(name)) {
      row[name] = canonicalInstant(value);
    } else if (storage.uuids?.includes(name)) {
      row[name] = canonicalUuid(value);
    } else if (storage.json?.includes(name) || storage.arrays?.includes(name)) {
      row[name] = jsonText(value);
    } else if (["bigint", "integer", "smallint"].includes(columns[name].type)) {
      row[name] = safeInteger(value);
    } else if (columns[name].type === "date") {
      row[name] = canonicalDate(value);
    } else if (columns[name].type === "text") {
      row[name] = value;
    } else {
      throw new Error(
        `${table}.${name}: storage conversion is not defined for ${
          columns[name].type
        }.`,
      );
    }
  }
  for (const [key, name] of Object.entries(storage.caseKeys ?? {})) {
    row[key] = caseKey(row[name]);
  }
  if (table === "bodyweight") row.measured_date = romeDate(row.measured_at);
  return row;
}

export function identifier(name) {
  if (typeof name !== "string" || !/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error("Invalid schema identifier.");
  }
  return `"${name}"`;
}

export function sqlLiteral(value) {
  if (value === null) return "NULL";
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    throw new Error(
      "Only text, safe integers and null are supported in imports.",
    );
  }
  // Hex avoids SQL injection and preserves quotes, newlines, NUL, and Unicode.
  return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
}
