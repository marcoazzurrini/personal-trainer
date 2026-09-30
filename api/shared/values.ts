import {
  canonicalDate,
  canonicalInstant,
  canonicalUuid,
  romeDate as canonicalRomeDate,
  scaledInteger,
} from "../../db/storage.ts";
import { ApiError } from "./errors.ts";

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

export { caseKey } from "../../db/storage.ts";

/** The clock is injectable only at construction, not supplied by API callers. */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
