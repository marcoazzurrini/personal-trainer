import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { dosePerExercise, volumePerMuscle } from "./volume.ts";
import { query } from "../http/schema.ts";

export const weeklyVolume = new OpenAPIHono();

const MesocycleSelector = z.string().optional().meta({
  description:
    'A mesocycle id, "current", or "current:<track>". Defaults to "current".',
  example: "current:hypertrophy",
});

const VolumeRow = z.object({
  week_start: z.string(),
  muscle: z.string(),
  working_sets: z.number(),
});

weeklyVolume.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Training"],
    summary: "Working sets per muscle per week",
    request: {
      query: query({
        mesocycle: MesocycleSelector.meta({
          description:
            'A mesocycle id, "current", or "current:<track>". "all" re-sums across every plan, off-plan work included. Defaults to "current".',
        }),
      }),
    },
    responses: {
      200: {
        description:
          "One row per muscle per week, never a total. `mesocycle_id` is absent under `?mesocycle=all`, which is not attributed to any plan.",
        content: {
          "application/json": {
            schema: z.object({
              mesocycle_id: z.int().optional(),
              weekly_volume: z.array(VolumeRow),
            }),
          },
        },
      },
    },
  }),
  async (c) =>
    c.json(await volumePerMuscle(c.req.valid("query").mesocycle ?? "current")),
);

export const weeklyExerciseSets = new OpenAPIHono();

const ExerciseWeek = z.object({
  week: z.int(),
  exercise: z.string(),
  exercise_id: z.int(),
  measure: z.string(),
  sets_done: z.number(),
  distance_m: z.number().nullable(),
  duration_s: z.number().nullable(),
  dose: z.number().nullable(),
  dose_unit: z.string().nullable(),
  // The dose's own unit, so adherence is a subtraction rather than a
  // conversion. Null when no dose was in force that week.
  delivered: z.number().nullable(),
});

weeklyExerciseSets.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Training"],
    summary: "Dose against delivery, per exercise per week",
    request: { query: query({ mesocycle: MesocycleSelector }) },
    responses: {
      200: {
        description:
          "One row per exercise per week of the mesocycle, each carrying the dose that was in force at that week's end rather than the plan's current dose.",
        content: {
          "application/json": {
            schema: z.object({
              mesocycle_id: z.int(),
              track: z.string(),
              weekly_exercise_sets: z.array(ExerciseWeek),
            }),
          },
        },
      },
      422: {
        description:
          '"all" is refused here: these weeks are numbered from a mesocycle\'s start, so week 3 of two plans share no meaning.',
      },
    },
  }),
  async (c) =>
    c.json(await dosePerExercise(c.req.valid("query").mesocycle ?? "current")),
);
