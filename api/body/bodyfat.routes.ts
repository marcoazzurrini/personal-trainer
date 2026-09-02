import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  listBodyfat,
  METHODS,
  recordBodyfat,
  removeBodyfat,
} from "./bodyfat.ts";
import {
  body,
  idParam,
  number,
  oneOf,
  optionalDate,
  optionalText,
  query,
  requestId,
} from "../shared/schema.ts";

export const bodyfat = new OpenAPIHono();

const Estimate = z.object({
  id: z.int(),
  day: z.string(),
  percent: z.number(),
  method: z.enum(METHODS),
  note: z.string().nullable(),
  created_at: z.string(),
});

bodyfat.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Tracking"],
    summary: "Every body-fat estimate",
    request: { query: query({}) },
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
  async (c) => c.json({ bodyfat_estimates: await listBodyfat() }),
);

bodyfat.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Tracking"],
    summary: "Record a body-fat estimate",
    request: {
      query: query({}),
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
    const { row, created } = await recordBodyfat({
      percent: b.percent,
      method: b.method,
      day: b.day,
      note: b.note,
      requestId: b.request_id,
    });
    return created
      ? c.json({ bodyfat_estimate: row }, 201)
      : c.json({ bodyfat_estimate: row }, 200);
  },
);

bodyfat.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Tracking"],
    summary: "Delete a body-fat estimate",
    request: {
      params: z.object({ id: idParam("body-fat estimate") }),
      query: query({}),
    },
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
    return c.json({ deleted: await removeBodyfat(id) });
  },
);
