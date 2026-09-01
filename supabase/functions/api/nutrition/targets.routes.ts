import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { GOALS } from "./expenditure.ts";
import { romeToday } from "../shared/calendar.ts";
import {
  activeTarget,
  CLIP_REASONS,
  listTargets,
  setTarget,
} from "./targets.ts";
import {
  body,
  number,
  oneOf,
  optionalDate,
  optionalInt,
  optionalNumber,
  query,
  requestId,
  text,
} from "../http/schema.ts";

// The goal, expressed as a rate of bodyweight change. Append-only: the latest
// effective_from is active and the history is the record of the phase
// structure. A target is never edited — a changed mind is a new row saying why.

export const nutritionTargets = new OpenAPIHono();

// Exported because nutrition-state answers with the same row, and used to
// declare it a second time and more weakly — goal and clipped_reasons as bare
// strings — so /openapi.json described one row two ways.
export const Target = z.object({
  id: z.int(),
  effective_from: z.string(),
  goal: z.enum(GOALS),
  rate_pct_bw_week: z.number(),
  kcal_target: z.int(),
  protein_g_target: z.int(),
  decision: z.string(),
  clipped: z.boolean(),
  clipped_reasons: z.array(z.enum(CLIP_REASONS)),
  tdee_at_creation: z.int().nullable(),
  created_at: z.string(),
});

// The arithmetic, returned so the coach can quote it rather than redo it.
// Null when kcal_target was sent explicitly: nothing was computed, and an
// object of zeroes would read as though something had been.
const Computation = z.object({
  tdee_kcal: z.int(),
  band_kcal: z.int().nullable(),
  expenditure_status: z.enum(["ok", "damped", "stale", "insufficient_data"]),
  trend_weight_kg: z.number(),
  energy_density_kcal_per_kg: z.int(),
  rate_requested: z.number(),
  rate_used: z.number(),
  desired_slope_kg_per_day: z.number(),
  implied_deficit_kcal: z.number(),
  clipped: z.boolean(),
  clipped_reasons: z.array(z.enum(CLIP_REASONS)),
}).nullable();

const ProteinComputationSchema = z.object({
  protein_g_target: z.int(),
  basis: z.enum(["ffm", "bodyweight"]),
  multiplier_g_per_kg: z.number(),
  basis_mass_kg: z.number(),
}).nullable();

nutritionTargets.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Nutrition"],
    summary: "Every target ever set, and the one in force",
    request: { query: query({}) },
    responses: {
      200: {
        description:
          "The full history under `targets`, newest first, and the one governing today under `active`.",
        content: {
          "application/json": {
            schema: z.object({
              targets: z.array(Target),
              active: Target.nullable(),
            }),
          },
        },
      },
    },
  }),
  async (c) =>
    c.json({
      targets: await listTargets(),
      active: await activeTarget(await romeToday()),
    }),
);

nutritionTargets.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Nutrition"],
    summary: "Set a target",
    description:
      "Exactly one protein input is required: `protein_g_per_kg_ffm` on a deficit, `protein_g_per_kg_bw` at maintenance or in a surplus, or `protein_g_target` as a finished number when neither basis fits. kcal is computed from `rate_pct_bw_week` unless `kcal_target` is sent explicitly.",
    request: {
      query: query({}),
      body: {
        content: {
          "application/json": {
            schema: body({
              goal: oneOf(GOALS),
              effective_from: optionalDate(),
              kcal_target: optionalInt({ min: 1 }),
              protein_g_target: optionalInt({ min: 1 }),
              protein_g_per_kg_ffm: optionalNumber(),
              protein_g_per_kg_bw: optionalNumber(),
              rate_pct_bw_week: number(),
              decision: text(),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description:
          "The target that was set, the arithmetic behind it, and whether the change of goal registered a phase switch.",
        content: {
          "application/json": {
            schema: z.object({
              target: Target,
              computation: Computation,
              protein_computation: ProteinComputationSchema,
              phase_switch_registered: z.boolean(),
            }),
          },
        },
      },
      200: {
        description:
          "The target this request_id already set. A retry, answered with the original row alone.",
        content: {
          "application/json": { schema: z.object({ target: Target }) },
        },
      },
      422: {
        description:
          "The rate contradicts the goal, the protein inputs are not exactly one, or there is not enough history to compute a target.",
      },
    },
  }),
  async (c) => {
    const result = await setTarget(c.req.valid("json"));
    return result.created ? c.json(result.body, 201) : c.json(result.body, 200);
  },
);
