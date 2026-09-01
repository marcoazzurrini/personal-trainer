import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { GOALS } from "./expenditure.ts";
import { finishedWeeks } from "./weekly.ts";
import { query } from "../http/schema.ts";

export const nutritionWeekly = new OpenAPIHono();

const WeekEvent = z.object({
  day: z.string(),
  kind: z.string(),
  note: z.string().nullable(),
});

const WeekTarget = z.object({
  kcal: z.int(),
  protein_g: z.int(),
  goal: z.enum(GOALS),
  rate_pct_bw_week: z.number(),
  effective_from: z.string(),
  // True where one target superseded another mid-week, which is what makes
  // that week's comparison muddy rather than wrong.
  changed_during_week: z.boolean(),
});

// Null is used throughout rather than zero or an omission. A week missing its
// bookend weigh-ins cannot say anything about expenditure, and a number there
// would be manufactured.
const Week = z.object({
  week_start: z.string(),
  week_end: z.string(),
  days_logged: z.int(),
  days_flagged: z.int(),
  weigh_ins: z.int(),
  mean_kcal: z.int().nullable(),
  mean_protein_g: z.int().nullable(),
  trend_start_kg: z.number().nullable(),
  trend_end_kg: z.number().nullable(),
  trend_delta_kg: z.number().nullable(),
  rate_pct_bw_week: z.number().nullable(),
  implied_tdee_kcal: z.int().nullable(),
  target: WeekTarget.nullable(),
  events: z.array(WeekEvent),
});

// Unvalidated until now: a non-numeric ?weeks reached generate_series as NaN
// and came back a 500, which tells the caller nothing it can act on. Bounded
// as well as numeric — the read is one query per week and there is no honest
// use for a thousand of them.
const weeksError = () =>
  '"weeks" must be a whole number between 1 and 104. It is how many finished weeks to return, newest last, and defaults to 8.';
const weeksParam = z.coerce
  .number({ error: weeksError })
  .int({ error: weeksError })
  .min(1, { error: weeksError })
  .max(104, { error: weeksError })
  .default(8);

nutritionWeekly.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Nutrition"],
    summary: "Finished weeks, each against the target that governed it",
    request: {
      query: query({
        weeks: weeksParam.meta({
          description:
            "How many finished weeks to return, newest last. Default 8, maximum 104.",
          example: 8,
        }),
      }),
    },
    responses: {
      200: {
        description:
          "One row per finished week. The current week is never included: a Tuesday's three logged days would read as a collapse in intake.",
        content: {
          "application/json": {
            schema: z.object({
              weeks: z.array(Week),
              note: z.string(),
            }),
          },
        },
      },
      422: { description: "?weeks was not a whole number between 1 and 104." },
    },
  }),
  async (c) => c.json(await finishedWeeks(c.req.valid("query").weeks)),
);
