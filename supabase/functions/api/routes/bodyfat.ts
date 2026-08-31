import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { romeDate } from "../record/calendar.ts";
import { writeOnce } from "../record/idempotency.ts";
import { requireNotFuture } from "../rules/dates.ts";
import { ApiError, requireRow } from "../http/errors.ts";
import {
  body,
  idParam,
  number,
  oneOf,
  optionalDate,
  optionalText,
  requestId,
} from "../http/schema.ts";

// Body fat exists here for one reason: the energy density of a weight change
// is composition-weighted, not a flat 7,700 kcal/kg. Forbes gives
// p = C / (C + FM) with C = 10.4 kg, and FM comes from this series. Precision
// is not the point — the result is only modestly sensitive to FM error — but
// it has to be a number the server can read, and it has to have history,
// because the estimate gets re-anchored as a phase runs on.

const METHODS = ["bia", "dxa", "caliper", "visual", "other"] as const;

export const bodyfat = new OpenAPIHono();

const Estimate = z.object({
  id: z.int(),
  day: z.string(),
  percent: z.number(),
  method: z.enum(METHODS),
  note: z.string().nullable(),
  created_at: z.string(),
});

type EstimateRow = z.infer<typeof Estimate>;

bodyfat.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Tracking"],
    summary: "Every body-fat estimate",
    responses: {
      200: {
        description: "All estimates, by day then method.",
        content: {
          "application/json": {
            schema: z.object({ bodyfat_estimates: z.array(Estimate) }),
          },
        },
      },
    },
  }),
  async (c) => {
    const rows = await sql<EstimateRow[]>`
    select id, day, percent::float8, method, note, created_at
    from bodyfat_estimates order by day, method`;
    return c.json({ bodyfat_estimates: rows });
  },
);

// Deduped on (day, method), like bodyweight on (measured_at, source):
// resending is a no-op, and a genuinely different value for the same day and
// method is a conflict worth asking about rather than silently overwriting.
//
// That key alone cannot keep the request_id promise, because it is not the
// same question. It asks whether the record already holds an estimate for a
// day; the request_id asks whether this call has already been answered. They
// part company when day moves under a retry — it defaults to Rome's today, so
// a call retried after midnight lands on a free (day, method) and writes a
// second estimate of the same reading a day late.
bodyfat.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Tracking"],
    summary: "Record a body-fat estimate",
    request: {
      body: {
        content: {
          "application/json": {
            schema: body({
              percent: number(),
              method: oneOf(METHODS),
              day: optionalDate(),
              note: optionalText(),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The estimate that was recorded.",
        content: {
          "application/json": {
            schema: z.object({ bodyfat_estimate: Estimate }),
          },
        },
      },
      200: {
        description:
          "The estimate was already recorded — either the same value for that day and method, or this request_id answered before. The existing row, unchanged.",
        content: {
          "application/json": {
            schema: z.object({ bodyfat_estimate: Estimate }),
          },
        },
      },
      409: {
        description:
          "A different estimate already exists for that day and method. An estimate is a measurement, not a running opinion.",
      },
    },
  }),
  async (c) => {
    const b = c.req.valid("json");
    const [clock] = await sql`
    select ${romeDate()} as today`;
    // Rome's today comes from Postgres, so the rule cannot be expressed in the
    // schema: it is a comparison against a value the schema never sees.
    const day = requireNotFuture(
      b.day ?? clock.today,
      clock.today,
      "day",
    );

    // The natural key is settled before the request_id, because it asks about
    // the record rather than about this call: an estimate for this day and
    // method either exists or it does not, whoever sent it. Asking the other
    // way round would answer a retry that arrived carrying a changed reading
    // with the reading it replaced.
    const [existing] = await sql<EstimateRow[]>`
    select id, day, percent::float8, method, note, created_at
    from bodyfat_estimates where day = ${day} and method = ${b.method}`;
    if (existing !== undefined) {
      if (existing.percent === b.percent) {
        return c.json({ bodyfat_estimate: existing }, 200); // idempotent retry
      }
      throw new ApiError(
        409,
        `A different estimate (${existing.percent}%) is already recorded for ${day} from method "${b.method}". Record the new reading under its own method, or on the day it was actually taken — an estimate is a measurement, not a running opinion.`,
      );
    }

    const { body: answer, status } = await writeOnce({
      table: "bodyfat_estimates",
      requestId: b.request_id,
      select: sql`id, day, percent::float8, method, note, created_at`,
      // The original estimate, on the day it was recorded against — which is
      // the point of replaying rather than writing: a retry after midnight
      // gets back the day it meant, not the day it arrived on.
      replay: (found: EstimateRow) => ({ bodyfat_estimate: found }),
      write: async () => {
        // No on-conflict clause: the select above has already established that
        // this day and method are free, so the only way the natural key can
        // still fire is a concurrent write between the two, and that is a
        // refusal rather than something to swallow.
        const [row] = await sql<EstimateRow[]>`
        insert into bodyfat_estimates (day, percent, method, note, request_id)
        values (${day}, ${b.percent}, ${b.method}, ${
          b.note ?? null
        }, ${b.request_id})
        returning id, day, percent::float8, method, note, created_at`;
        return { bodyfat_estimate: row };
      },
    });
    return c.json(answer, status);
  },
);

// A mistyped estimate is a mistake, not a measurement. 41% instead of 14%
// changes fat mass by 22 kg, which changes the energy density of every kg of
// weight change, which moves the calorie target — and the natural key means it
// cannot simply be overwritten. Removing it is the way out.
bodyfat.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Tracking"],
    summary: "Delete a body-fat estimate",
    request: { params: z.object({ id: idParam("body-fat estimate") }) },
    responses: {
      200: {
        description: "The estimate that was deleted.",
        content: {
          "application/json": {
            schema: z.object({
              deleted: Estimate.pick({
                day: true,
                percent: true,
                method: true,
              }),
            }),
          },
        },
      },
      404: { description: "No estimate carries that id." },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const row = requireRow(
      await sql<
        Array<Pick<EstimateRow, "day" | "percent" | "method">>
      >`
    delete from bodyfat_estimates where id = ${id}
    returning day, percent::float8, method`,
      `No body-fat estimate with id ${id}.`,
    );
    return c.json({ deleted: row });
  },
);
