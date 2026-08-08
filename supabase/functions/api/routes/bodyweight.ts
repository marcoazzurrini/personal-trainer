import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import {
  optionalString,
  optionalTimestamp,
  readJson,
  requireIdParam,
  requireNumber,
} from "../lib/validate.ts";

export const bodyweight = new Hono();

bodyweight.get("/", async (c) => {
  const rows = await sql`
    select id, value_kg::float8, measured_at, source
    from bodyweight order by measured_at`;
  return c.json({ bodyweight: rows });
});

// Deduped on (measured_at, source): resending the same measurement is a
// no-op, so retries never plant a phantom point in the trend.
bodyweight.post("/", async (c) => {
  const body = await readJson(c);
  const valueKg = requireNumber(body, "value_kg");
  const source = optionalString(body, "source") ?? "manual";
  const measuredAt = optionalTimestamp(body, "measured_at") ??
    new Date().toISOString();

  const [row] = await sql`
    insert into bodyweight (value_kg, measured_at, source)
    values (${valueKg}, ${measuredAt}, ${source})
    on conflict (measured_at, source) do nothing
    returning id, value_kg::float8, measured_at, source`;
  if (row) return c.json({ bodyweight: row }, 201);

  const [existing] = await sql`
    select id, value_kg::float8, measured_at, source
    from bodyweight
    where measured_at = ${measuredAt} and source = ${source}`;
  if (existing.value_kg === valueKg) {
    return c.json({ bodyweight: existing }); // idempotent retry
  }
  throw new ApiError(
    409,
    `A different value (${existing.value_kg} kg) is already recorded for ${measuredAt} from source "${source}". If this new value is a correction, something has gone wrong upstream — a measurement is a fact and should not change.`,
  );
});

// A mistyped weigh-in used to be a cosmetic blemish on a chart. It now feeds
// the trend, the trend feeds the expenditure estimate, and the estimate sets
// the calorie target — an 8 kg typo would read as a fortnight of catastrophic
// loss and hand back a target hundreds of calories wrong. A measurement that
// was never taken is a mistake, and mistakes come out.
bodyweight.delete("/:id", async (c) => {
  const id = requireIdParam(c.req.param("id"), "bodyweight");
  const [row] = await sql`
    delete from bodyweight where id = ${id}
    returning value_kg::float8, measured_at, source`;
  if (!row) throw new ApiError(404, `No bodyweight measurement with id ${id}.`);
  return c.json({ deleted: row });
});
