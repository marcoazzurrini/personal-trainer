// Storage validation has no I/O. Decimal ties retain PostgreSQL's rounding.
export function scaledInteger(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Reject malformed external values before numeric conversion.
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
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Decimal input must be text or a number, never a coercible object.
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate external UUIDs without coercion.
export function canonicalUuid(value: unknown): string {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- UUIDs must be text before validation.
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value
    )
  ) {
    throw new Error("Expected a canonical UUID.");
  }
  return value.toLowerCase();
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate external timestamp text and calendar precision.
export function canonicalInstant(value: unknown): string {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Stored instants require text with all six fractional digits.
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
  // Date validates the calendar only; return all six digits unchanged.
  return value;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Reject malformed external calendar dates.
export function canonicalDate(value: unknown): string {
  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Dates must be text, not values coerced by Date.
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new Error("Expected a real YYYY-MM-DD calendar date.");
  }
  return value;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- canonicalInstant validates the value before timezone conversion.
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Reject non-string values before normalization.
export function caseKey(value: unknown): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Case keys must be text before Unicode lowercasing.
  if (typeof value !== "string") {
    throw new TypeError("Expected text for a case-insensitive key.");
  }
  // No accent removal or Unicode normalization: those would merge more names
  // than case-insensitive matching alone.
  return value.toLowerCase();
}
