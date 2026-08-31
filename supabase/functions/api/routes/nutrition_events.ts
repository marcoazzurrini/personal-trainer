import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { requireRow } from "../http/errors.ts";
import {
  body,
  idParam,
  oneOf,
  optionalDate,
  optionalText,
  requestId,
} from "../http/schema.ts";
import { romeToday } from "../record/calendar.ts";
import { activeTransients } from "../record/nutrition_read.ts";

// The register of things that make bodyweight move for reasons that are not
// fat or muscle. Registering one tells the expenditure back-solve to damp its
// updates while the water settles, instead of reading it as metabolism.

const KINDS = [
  "creatine_start",
  "phase_switch",
  "program_change",
  "logging_change",
  "other",
] as const;

export const nutritionEvents = new OpenAPIHono();

const Event = z.object({
  id: z.int(),
  day: z.string(),
  kind: z.enum(KINDS),
  note: z.string().nullable(),
  created_at: z.string(),
});

type EventRow = z.infer<typeof Event>;

// What the expenditure back-solve is actually damping on: the same rows, still
// inside the window, without the bookkeeping column.
const ActiveTransient = Event.omit({ created_at: true });

nutritionEvents.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Nutrition"],
    summary: "Registered transients, and which are still damping",
    responses: {
      200: {
        description:
          "Every event ever registered under `events`, and under `active` those still inside the damping window as of today in Europe/Rome.",
        content: {
          "application/json": {
            schema: z.object({
              events: z.array(Event),
              active: z.array(ActiveTransient),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const rows = await sql<EventRow[]>`
    select id, day, kind, note, created_at
    from nutrition_events order by day desc, id desc`;
    return c.json({
      events: rows,
      active: await activeTransients(await romeToday()) as z.infer<
        typeof ActiveTransient
      >[],
    });
  },
);

nutritionEvents.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Nutrition"],
    summary: "Register a transient",
    request: {
      body: {
        content: {
          "application/json": {
            schema: body({
              day: optionalDate(),
              kind: oneOf(KINDS),
              note: optionalText(),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The event that was registered.",
        content: {
          "application/json": { schema: z.object({ event: Event }) },
        },
      },
      200: {
        description:
          "The event this request_id already registered. A retry, answered with the original result.",
        content: {
          "application/json": { schema: z.object({ event: Event }) },
        },
      },
    },
  }),
  async (c) => {
    const b = c.req.valid("json");
    const [existing] = await sql<EventRow[]>`
      select id, day, kind, note, created_at
      from nutrition_events where request_id = ${b.request_id}`;
    if (existing) return c.json({ event: existing }, 200);

    const day = b.day ?? await romeToday();

    const [row] = await sql<EventRow[]>`
    insert into nutrition_events (day, kind, note, request_id)
    values (${day}, ${b.kind}, ${b.note ?? null}, ${b.request_id})
    returning id, day, kind, note, created_at`;
    return c.json({ event: row }, 201);
  },
);

// An event registered on the wrong day, or that turned out not to have
// happened, actively distorts the estimate: it damps updates for two weeks
// around a transient that never occurred. Registering one is a claim, and a
// claim can be wrong.
nutritionEvents.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Nutrition"],
    summary: "Withdraw a registered transient",
    request: { params: z.object({ id: idParam("nutrition event") }) },
    responses: {
      200: {
        description: "The event that was withdrawn.",
        content: {
          "application/json": {
            schema: z.object({ deleted: ActiveTransient.omit({ id: true }) }),
          },
        },
      },
      404: { description: "No event carries that id." },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const row = requireRow(
      await sql<Array<Pick<EventRow, "day" | "kind" | "note">>>`
    delete from nutrition_events where id = ${id}
    returning day, kind, note`,
      `No nutrition event with id ${id}.`,
    );
    return c.json({ deleted: row });
  },
);
