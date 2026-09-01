import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { requireRow } from "../http/errors.ts";
import { recordBodyweight } from "../record/bodyweight.ts";
import { loadTrend } from "../record/nutrition_read.ts";
import {
  body,
  idParam,
  number,
  optionalText,
  optionalTimestamp,
  query,
} from "../http/schema.ts";

export const bodyweight = new OpenAPIHono();

const Measurement = z.object({
  id: z.int(),
  value_kg: z.number(),
  measured_at: z.string(),
  source: z.string(),
});

type MeasurementRow = z.infer<typeof Measurement>;

const TrendPoint = z.object({
  day: z.string(),
  // The two fields the EMA needs to state its own gaps: the day's raw or
  // interpolated weight, and which of the two it is. A point nobody weighed
  // is a different fact from one they did, and the chart wants to mark it.
  // rules/expenditure.ts defines the shape; this declares what was always
  // served — the schema promised less than the SQL returned.
  weight_kg: z.number(),
  interpolated: z.boolean(),
  trend_kg: z.number(),
});

bodyweight.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Tracking"],
    summary: "Raw weigh-ins and the trend, in one call",
    request: { query: query({}) },
    responses: {
      200: {
        description:
          "Two series: `bodyweight` holds raw instants, `trend` one point per day. The bodyweight chart's single read.",
        content: {
          "application/json": {
            schema: z.object({
              bodyweight: z.array(Measurement),
              trend: z.array(TrendPoint),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const rows = await sql<MeasurementRow[]>`
    select id, value_kg::float8, measured_at, source
    from bodyweight order by measured_at`;
    // The trend rides along as its own series, not as a column on the raw rows.
    // It cannot be a column: an interpolated day has no raw row to carry it, so
    // a per-row trend would gap exactly where the EMA earns its keep — and the
    // trend is a per-day fact while rows are instants, two different things
    // that would conflate on any day with a second weigh-in. One call now
    // yields both series the bodyweight chart needs; the chart rules forbid
    // computing a trend client-side, and for a long while nothing served one.
    return c.json({
      bodyweight: rows,
      trend: await loadTrend(),
    });
  },
);

// Nothing but request shaping: the defaults belong to the HTTP call, and every
// rule about what makes a measurement believable lives in recordBodyweight,
// where the Withings sync reaches it too.
bodyweight.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Tracking"],
    summary: "Record a weigh-in",
    request: {
      query: query({}),
      body: {
        content: {
          "application/json": {
            schema: body({
              value_kg: number(),
              measured_at: optionalTimestamp(),
              source: optionalText(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The measurement that was recorded.",
        content: {
          "application/json": {
            schema: z.object({ bodyweight: Measurement }),
          },
        },
      },
      200: {
        description:
          "A measurement for this instant already existed with this value; the row is returned unchanged.",
        content: {
          "application/json": {
            schema: z.object({ bodyweight: Measurement }),
          },
        },
      },
    },
  }),
  async (c) => {
    const b = c.req.valid("json");
    const { row, created } = await recordBodyweight({
      valueKg: b.value_kg,
      source: b.source ?? "manual",
      measuredAt: b.measured_at ?? new Date().toISOString(),
    });
    return created
      ? c.json({ bodyweight: row as MeasurementRow }, 201)
      : c.json({ bodyweight: row as MeasurementRow }, 200);
  },
);

// A mistyped weigh-in used to be a cosmetic blemish on a chart. It now feeds
// the trend, the trend feeds the expenditure estimate, and the estimate sets
// the calorie target — an 8 kg typo would read as a fortnight of catastrophic
// loss and hand back a target hundreds of calories wrong. A measurement that
// was never taken is a mistake, and mistakes come out.
bodyweight.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Tracking"],
    summary: "Delete a weigh-in",
    request: {
      params: z.object({ id: idParam("bodyweight") }),
      query: query({}),
    },
    responses: {
      200: {
        description: "The measurement that was deleted.",
        content: {
          "application/json": {
            schema: z.object({ deleted: Measurement.omit({ id: true }) }),
          },
        },
      },
      404: { description: "No measurement carries that id." },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const row = requireRow(
      await sql<Array<Omit<MeasurementRow, "id">>>`
    delete from bodyweight where id = ${id}
    returning value_kg::float8, measured_at, source`,
      `No bodyweight measurement with id ${id}.`,
    );
    return c.json({ deleted: row });
  },
);
