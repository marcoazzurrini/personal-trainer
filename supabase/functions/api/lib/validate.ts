import type { Context } from "@hono/hono";
import { ApiError } from "./errors.ts";

export type Body = Record<string, unknown>;

export async function readJson(c: Context): Promise<Body> {
  try {
    const body = await c.req.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error();
    }
    return body as Body;
  } catch {
    throw new ApiError(
      422,
      "The request body must be a JSON object. Send Content-Type: application/json.",
    );
  }
}

export function requireString(body: Body, field: string): string {
  const v = body[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ApiError(
      422,
      `"${field}" is required and must be a non-empty string.`,
    );
  }
  return v.trim();
}

export function optionalString(body: Body, field: string): string | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.trim() === "") {
    throw new ApiError(
      422,
      `"${field}" must be a non-empty string when present.`,
    );
  }
  return v.trim();
}

export function requireNumber(body: Body, field: string): number {
  const v = body[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ApiError(422, `"${field}" is required and must be a number.`);
  }
  return v;
}

// Accepts an ISO 8601 timestamp string; returns it normalized to UTC ISO.
export function optionalTimestamp(body: Body, field: string): string | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
    throw new ApiError(
      422,
      `"${field}" must be an ISO 8601 timestamp, e.g. "2026-08-05T08:30:00Z".`,
    );
  }
  return new Date(v).toISOString();
}

export function requireOneOf(
  body: Body,
  field: string,
  choices: readonly string[],
  fallback?: string,
): string {
  const v = body[field] ?? fallback;
  if (typeof v !== "string" || !choices.includes(v)) {
    throw new ApiError(
      422,
      `"${field}" must be one of: ${choices.join(", ")}.`,
    );
  }
  return v;
}

export function requireInt(
  body: Body,
  field: string,
  opts: { min?: number } = {},
): number {
  const v = body[field];
  if (
    typeof v !== "number" || !Number.isInteger(v) ||
    (opts.min !== undefined && v < opts.min)
  ) {
    throw new ApiError(
      422,
      `"${field}" is required and must be an integer${
        opts.min !== undefined ? ` >= ${opts.min}` : ""
      }.`,
    );
  }
  return v;
}

export function optionalInt(
  body: Body,
  field: string,
  opts: { min?: number } = {},
): number | null {
  if (body[field] === undefined || body[field] === null) return null;
  return requireInt(body, field, opts);
}

export function optionalNumber(
  body: Body,
  field: string,
  opts: { min?: number } = {},
): number | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (
    typeof v !== "number" || !Number.isFinite(v) ||
    (opts.min !== undefined && v < opts.min)
  ) {
    throw new ApiError(
      422,
      `"${field}" must be a number${
        opts.min !== undefined ? ` >= ${opts.min}` : ""
      } when present.`,
    );
  }
  return v;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function requireDate(body: Body, field: string): string {
  const v = body[field];
  if (
    typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))
  ) {
    throw new ApiError(
      422,
      `"${field}" is required and must be a calendar date like "2026-08-10".`,
    );
  }
  return v;
}

export function optionalDate(body: Body, field: string): string | null {
  if (body[field] === undefined || body[field] === null) return null;
  return requireDate(body, field);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ids in a path. Number("notanid") is NaN, and a NaN reaching Postgres as a
// bigint throws where the handler can only answer "internal error" — a 500 at
// exactly the moment the caller most needs a prompt telling it what to send.
export function requireIdParam(value: string, what: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new ApiError(
      422,
      `"${value}" is not a ${what} id. Ids are positive whole numbers.`,
    );
  }
  return id;
}

export function optionalUuid(body: Body, field: string): string | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !UUID_RE.test(v)) {
    throw new ApiError(
      422,
      `"${field}" must be a UUID when present (generate one per creating call).`,
    );
  }
  return v.toLowerCase();
}

// Required on any creating POST that could otherwise write the same thing
// twice. Retry safety is only a guarantee if the id is not optional: a call
// that succeeds on the server and loses its response gets retried by a client
// that has no way to know, and without the id the retry is a second row.
export function requireUuid(body: Body, field: string): string {
  const v = optionalUuid(body, field);
  if (v === null) {
    throw new ApiError(
      422,
      `"${field}" is required: a fresh UUID generated for this call. It is what makes a retry safe — resending the same id returns the original result instead of writing a second row. Reuse an id only to retry the exact same call.`,
    );
  }
  return v;
}
