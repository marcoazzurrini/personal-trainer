import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { nutritionState as readState } from "./state.ts";
import { Entry } from "./intake.routes.ts";
import { Target } from "./targets.routes.ts";
import { clock, macroTotals, query } from "../http/schema.ts";

// The declaration only; state.ts holds what it answers with.

export const nutritionState = new OpenAPIHono();

// Every unmet condition, not just the first — three separate things can block
// an estimate, and reporting them one at a time means the coach fixes logging
// for a fortnight and is then ambushed by the body-fat requirement.
const Expenditure = z.object({
  status: z.enum(["ok", "damped", "stale", "insufficient_data"]),
  reason: z.string(),
  blockers: z.array(z.string()),
  tdee_kcal: z.int().nullable(),
  band_kcal: z.int().nullable(),
  // Populated under insufficient_data too: stripping the dates exactly when
  // the reader needs to reconcile "0 weigh-in days" with this morning's
  // weigh-in is how a working sync gets reported as broken.
  window: z.object({
    from: z.string(),
    to: z.string(),
    days: z.int(),
    usable_days: z.int(),
    weigh_in_days: z.int(),
  }).nullable(),
  inputs: z.object({
    mean_intake_kcal: z.number(),
    trend_from_kg: z.number(),
    trend_to_kg: z.number(),
    slope_kg_per_day: z.number(),
    energy_density_kcal_per_kg: z.number(),
    fat_mass_kg: z.number(),
  }).nullable(),
  // Which window the estimate belongs to. Null under insufficient_data,
  // because a date beside a null tdee reads as "current as of".
  as_of: z.string().nullable(),
});

// No coalesce anywhere here: a day with no entries reports null, not 0.
// Unknown is not zero — a floor of zeros under a hasty average reads as
// fasting. `entries: 0` already marks the day unlogged.
const RecentDay = z.object({
  day: z.string(),
  kcal: z.number().nullable(),
  protein_g: z.number().nullable(),
  entries: z.int(),
  incomplete: z.boolean(),
  weight_kg: z.number().nullable(),
});

const Adherence = z.object({
  days_logged_last_7: z.int(),
  days_logged_last_21: z.int(),
  weigh_ins_last_7: z.int(),
  weigh_ins_last_21: z.int(),
  last_logged_day: z.string().nullable(),
  last_weigh_in: z.string().nullable(),
});

// The estimate as body/ stores it. It used to be four hand-picked columns
// over a second copy of the "latest, tie-broken by id" ordering; it is now
// the row that ordering returns, and the two extra fields are declared rather
// than dropped.
const Bodyfat = z.object({
  id: z.int(),
  day: z.string(),
  percent: z.number(),
  method: z.string(),
  note: z.string().nullable(),
  created_at: z.string(),
});

// A rate of change in weight, stated both ways it gets used: absolute and as a
// share of bodyweight. read.ts's slopePctBwWeek is the
// definition.
const Slope = z.object({
  kg_per_week: z.number(),
  pct_bw_week: z.number(),
});

// First key, and it carries the hour rather than only the date. A relative
// day — "ieri", "stasera", "this morning" — is interpreted against this and
// never against a timestamp left over from an earlier turn: a stale client
// clock read at 14:58 on one day and applied on the next moves everything
// logged in that conversation to the wrong date, and the record cannot tell
// afterwards that it happened.
const NutritionState = z.object({
  now: clock(),
  today_so_far: z.object({
    entries: z.array(Entry),
    totals: macroTotals(),
    // Against the target, not against the estimate.
    vs_target: z.object({
      kcal_target: z.int(),
      kcal_remaining: z.number(),
      protein_g_target: z.int(),
      protein_g_remaining: z.number().nullable(),
    }).nullable(),
  }),
  // Presented before raw weight on purpose: raw scale weight is water and gut
  // content, and translating a number back to the trend is the coach's first
  // job when Marco reacts to one.
  trend_weight: z.object({
    day: z.string(),
    trend_kg: z.number(),
    // The earliest reading of that day, which is the most fasted one
    // available and so the most comparable across days.
    earliest_scale_kg: z.number(),
    interpolated: z.boolean(),
    // A slope is stated both ways it gets used: absolute, and as a share of
    // bodyweight — the number a cut is judged by is the percentage. The
    // computation (read.ts) has always returned both; the
    // schema here promised only the first.
    slope_7d: Slope.nullable(),
    slope_21d: Slope.nullable(),
  }).nullable(),
  expenditure: Expenditure,
  target: Target.nullable(),
  active_transients: z.array(z.object({
    id: z.int(),
    day: z.string(),
    kind: z.string(),
    note: z.string().nullable(),
  })),
  recent_days: z.array(RecentDay),
  // Alongside the estimate rather than under it: a beautiful estimate over a
  // collapsing logging habit is a misleading picture.
  adherence: Adherence,
  latest_bodyfat: Bodyfat.nullable(),
  recent_flags: z.array(z.object({ day: z.string(), flag: z.string() })),
});

nutritionState.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Nutrition"],
    summary: "Everything true about eating, as of now",
    description:
      "The read that opens a nutrition conversation. Today's entries and totals against the active target, trend weight and its slopes, the expenditure estimate with its band and status, the active target and transients, the last thirteen finished days, and logging and weigh-in adherence.",
    request: { query: query({}) },
    responses: {
      200: {
        description: "The complete current nutrition picture.",
        content: { "application/json": { schema: NutritionState } },
      },
    },
  }),
  async (c) => c.json(await readState()),
);
