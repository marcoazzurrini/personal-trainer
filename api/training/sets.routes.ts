import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { correctSet } from "./sets.ts";
import { EFFORTS, KINDS } from "./rules.ts";
import { body, idParam, query } from "../shared/schema.ts";
import { setCorrectionShape } from "./set_correction.schema.ts";

export const sets = new OpenAPIHono();

const Set = z.object({
  id: z.int(),
  session_id: z.int(),
  exercise_id: z.int(),
  mesocycle_id: z.int().nullable(),
  position: z.int(),
  kind: z.enum(KINDS),
  target_weight_kg: z.number().nullable(),
  target_reps: z.int().nullable(),
  target_distance_m: z.number().nullable(),
  target_duration_s: z.number().nullable(),
  weight_kg: z.number().nullable(),
  reps: z.int().nullable(),
  distance_m: z.number().nullable(),
  duration_s: z.number().nullable(),
  effort: z.enum(EFFORTS).nullable(),
  performed_at: z.string().nullable(),
  notes: z.string().nullable(),
});

sets.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Training"],
    summary: "Correct a set's actuals",
    description:
      "Partial. A field left out is untouched; a field sent as null is cleared. Only actuals, performed_at and notes can change — targets are immutable.",
    request: {
      query: query({}),
      params: z.object({ id: idParam("set") }),
      body: {
        content: {
          "application/json": {
            schema: body(setCorrectionShape()),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The set as it now stands, targets beside actuals.",
        content: {
          "application/json": { schema: z.object({ set: Set }) },
        },
      },
      404: { description: "No set carries that id." },
      422: {
        description:
          "A target was sent, nothing was sent, or the result would break the exercise's measure or effort rule.",
      },
    },
  }),
  async (c) =>
    c.json({
      set: await correctSet(c.req.valid("param").id, c.req.valid("json")),
    }),
);
