import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  activeTransients,
  KINDS,
  listEvents,
  registerEvent,
  withdrawEvent,
} from "./events.ts";
import { romeToday } from "../shared/calendar.ts";
import {
  body,
  idParam,
  oneOf,
  optionalDate,
  optionalText,
  query,
  requestId,
} from "../http/schema.ts";

export const nutritionEvents = new OpenAPIHono();

const Event = z.object({
  id: z.int(),
  day: z.string(),
  kind: z.enum(KINDS),
  note: z.string().nullable(),
  created_at: z.string(),
});

// What the expenditure back-solve is actually damping on: the same rows, still
// inside the window, without the bookkeeping column.
const ActiveTransient = Event.omit({ created_at: true });

nutritionEvents.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Nutrition"],
    summary: "Registered transients, and which are still damping",
    request: { query: query({}) },
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
  async (c) =>
    c.json({
      events: await listEvents(),
      active: await activeTransients(await romeToday()),
    }),
);

nutritionEvents.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Nutrition"],
    summary: "Register a transient",
    request: {
      query: query({}),
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
    const { row, created } = await registerEvent(c.req.valid("json"));
    return created ? c.json({ event: row }, 201) : c.json({ event: row }, 200);
  },
);

nutritionEvents.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Nutrition"],
    summary: "Withdraw a registered transient",
    request: {
      params: z.object({ id: idParam("nutrition event") }),
      query: query({}),
    },
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
  async (c) =>
    c.json({ deleted: await withdrawEvent(c.req.valid("param").id) }),
);
