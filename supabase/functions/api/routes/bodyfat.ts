import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import {
  optionalDate,
  optionalString,
  optionalUuid,
  readJson,
  requireNumber,
  requireOneOf,
} from "../lib/validate.ts";

// Body fat exists here for one reason: the energy density of a weight change
// is composition-weighted, not a flat 7,700 kcal/kg. Forbes gives
// p = C / (C + FM) with C = 10.4 kg, and FM comes from this series. Precision
// is not the point — the result is only modestly sensitive to FM error — but
// it has to be a number the server can read, and it has to have history,
// because the estimate gets re-anchored as a phase runs on.

const METHODS = ["bia", "dxa", "caliper", "visual", "other"] as const;

export const bodyfat = new Hono();

bodyfat.get("/", async (c) => {
  const rows = await sql`
    select id, day, percent::float8, method, note, created_at
    from bodyfat_estimates order by day, method`;
  return c.json({ bodyfat_estimates: rows });
});

// Deduped on (day, method), like bodyweight on (measured_at, source):
// resending is a no-op, and a genuinely different value for the same day and
// method is a conflict worth asking about rather than silently overwriting.
bodyfat.post("/", async (c) => {
  const body = await readJson(c);
  const requestId = optionalUuid(body, "request_id");
  const percent = requireNumber(body, "percent");
  const method = requireOneOf(body, "method", METHODS);
  const note = optionalString(body, "note");
  const [clock] = await sql`
    select (now() at time zone 'Europe/Rome')::date as today`;
  const day = optionalDate(body, "day") ?? clock.today;

  const [row] = await sql`
    insert into bodyfat_estimates (day, percent, method, note, request_id)
    values (${day}, ${percent}, ${method}, ${note}, ${requestId})
    on conflict (day, method) do nothing
    returning id, day, percent::float8, method, note, created_at`;
  if (row) return c.json({ bodyfat_estimate: row }, 201);

  const [existing] = await sql`
    select id, day, percent::float8, method, note, created_at
    from bodyfat_estimates where day = ${day} and method = ${method}`;
  if (existing.percent === percent) {
    return c.json({ bodyfat_estimate: existing }); // idempotent retry
  }
  throw new ApiError(
    409,
    `A different estimate (${existing.percent}%) is already recorded for ${day} from method "${method}". Record the new reading under its own method, or on the day it was actually taken — an estimate is a measurement, not a running opinion.`,
  );
});
