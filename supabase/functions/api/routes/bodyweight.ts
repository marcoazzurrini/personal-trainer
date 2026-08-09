import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import { recordBodyweight } from "../lib/bodyweight.ts";
import { loadTrend } from "../lib/nutrition_read.ts";
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
  // The trend rides along as its own series, not as a column on the raw rows.
  // It cannot be a column: an interpolated day has no raw row to carry it, so
  // a per-row trend would gap exactly where the EMA earns its keep — and the
  // trend is a per-day fact while rows are instants, two different things
  // that would conflate on any day with a second weigh-in. One call now
  // yields both series the bodyweight chart needs; the chart rules forbid
  // computing a trend client-side, and for a long while nothing served one.
  return c.json({ bodyweight: rows, trend: await loadTrend() });
});

// Nothing but request shaping: the defaults belong to the HTTP call, and every
// rule about what makes a measurement believable lives in recordBodyweight,
// where the Withings sync reaches it too.
bodyweight.post("/", async (c) => {
  const body = await readJson(c);
  const { row, created } = await recordBodyweight({
    valueKg: requireNumber(body, "value_kg"),
    source: optionalString(body, "source") ?? "manual",
    measuredAt: optionalTimestamp(body, "measured_at") ??
      new Date().toISOString(),
  });
  return created
    ? c.json({ bodyweight: row }, 201)
    : c.json({ bodyweight: row });
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
