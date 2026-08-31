import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { romeDate } from "../record/calendar.ts";
import {
  activeTarget,
  activeTransients,
  currentExpenditure,
  loadTrend,
  slopePctBwWeek,
} from "../record/nutrition_read.ts";
import { sumMacros } from "../rules/nutrition.ts";
import { macroTotals } from "../http/schema.ts";

// The nutrition analogue of /training-state: everything true about eating as
// of now, fetched at the start of any nutrition conversation. Separate from
// /training-state on purpose — different conversations, different fetch
// reflex, and no reason for every training question to pay for these queries.
//
// Two things this payload is deliberately shaped around. Trend weight is
// presented before raw weight, because raw scale weight is water and gut
// content and the coach's first job when Marco reacts to a number is to
// translate it back to the trend. And adherence sits alongside the estimate
// rather than under it: diet logging decays fastest of all tracked
// behaviours, disengagement is visible in the frequency by week 2–3, and a
// beautiful expenditure estimate over a collapsing logging habit is a
// misleading picture.

export const nutritionState = new OpenAPIHono();

const Entry = z.object({
  id: z.int(),
  grams: z.number().nullable(),
  kcal: z.number(),
  protein_g: z.number().nullable(),
  carbs_g: z.number().nullable(),
  fat_g: z.number().nullable(),
  fiber_g: z.number().nullable(),
  note: z.string().nullable(),
  created_at: z.string(),
  food_id: z.int().nullable(),
  food: z.string().nullable(),
  meal_id: z.int().nullable(),
  meal: z.string().nullable(),
});

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

const Target = z.object({
  id: z.int(),
  effective_from: z.string(),
  goal: z.string(),
  rate_pct_bw_week: z.number(),
  kcal_target: z.int(),
  protein_g_target: z.int(),
  decision: z.string(),
  clipped: z.boolean(),
  clipped_reasons: z.array(z.string()),
  tdee_at_creation: z.int().nullable(),
  created_at: z.string(),
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

const Bodyfat = z.object({
  day: z.string(),
  percent: z.number(),
  method: z.string(),
  note: z.string().nullable(),
});

// A rate of change in weight, stated both ways it gets used: absolute and as a
// share of bodyweight. record/nutrition_read.ts's slopePctBwWeek is the
// definition.
const Slope = z.object({
  kg_per_week: z.number(),
  pct_bw_week: z.number(),
});

const NutritionState = z.object({
  today: z.string(),
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
    // computation (record/nutrition_read.ts) has always returned both; the
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
    responses: {
      200: {
        description: "The complete current nutrition picture.",
        content: { "application/json": { schema: NutritionState } },
      },
    },
  }),
  async (c) => {
    const [clock] = await sql`
    select ${romeDate()} as today`;
    const today = clock.today as string;

    const entries = await sql<z.infer<typeof Entry>[]>`
    select i.id, i.grams::float8, i.kcal::float8, i.protein_g::float8,
      i.carbs_g::float8, i.fat_g::float8, i.fiber_g::float8, i.note,
      i.created_at, i.food_id, f.name as food, i.meal_id, m.name as meal
    from intake_entries i
    left join foods f on f.id = i.food_id
    left join meals m on m.id = i.meal_id
    where i.day = ${today}
    order by i.created_at, i.id`;

    // d.day is cast back to date: generate_series with an interval step yields
    // timestamp (oid 1114), which slips past db.ts's date parser (oid 1082) and
    // serializes as "2026-07-26T00:00:00.000Z" while every other day field in
    // the API is a bare "2026-07-26". A coach reading that as an instant and
    // formatting it locally gets the wrong day either side of midnight.
    const recentDays = await sql<z.infer<typeof RecentDay>[]>`
    -- kcal and protein_g stay null where nothing was logged, which is
    -- daily_intake's rule rather than this query's: unknown is not zero, and
    -- entries says which of the two a null means. The coalesces apply only to
    -- the days the view has no row for at all.
    select d.day::date as day,
      di.kcal,
      di.protein_g,
      coalesce(di.entries, 0) as entries,
      coalesce(di.incomplete, false) as incomplete,
      (select w.value_kg from daily_bodyweight w where w.day = d.day)
        as weight_kg
    from generate_series(${today}::date - 13, ${today}::date - 1, interval '1 day')
      as d(day)
    left join daily_intake di on di.day = d.day::date
    order by d.day`;

    const [adherence] = await sql<z.infer<typeof Adherence>[]>`
    select
      (select count(distinct i.day)::int from intake_entries i
       where i.day >= ${today}::date - 7 and i.day < ${today}::date)
        as days_logged_last_7,
      (select count(distinct i.day)::int from intake_entries i
       where i.day >= ${today}::date - 21 and i.day < ${today}::date)
        as days_logged_last_21,
      -- Both windows are seven and twenty-one days, and the weigh-in ones end
      -- today while the intake ones end yesterday. The asymmetry is the point.
      --
      -- A day of eating is only whole once the day is over; counting it at
      -- three in the afternoon would report half a day's food as a full one and
      -- make Marco's logging look worse every afternoon of his life. A weigh-in
      -- has no such partial state — he stood on the scale or he did not, and it
      -- is finished the moment he steps off.
      --
      -- Excluding today here bought nothing and cost a contradiction: the count
      -- said nought weigh-ins in the last seven days while last_weigh_in, which
      -- has never had an upper bound, said today. A coach read the pair, could
      -- not reconcile them, and reported the sync as broken when it was working.
      (select count(*)::int from daily_bodyweight w
       where w.day >= ${today}::date - 6 and w.day <= ${today}::date)
        as weigh_ins_last_7,
      (select count(*)::int from daily_bodyweight w
       where w.day >= ${today}::date - 20 and w.day <= ${today}::date)
        as weigh_ins_last_21,
      (select max(i.day) from intake_entries i where i.day < ${today}::date)
        as last_logged_day,
      (select max(w.day) from daily_bodyweight w) as last_weigh_in`;

    const [latestBodyfat] = await sql<z.infer<typeof Bodyfat>[]>`
    select day, percent::float8, method, note from bodyfat_estimates
    order by day desc, id desc limit 1`;

    const flags = await sql<{ day: string; flag: string }[]>`
    select day, flag from day_flags
    where day >= ${today}::date - 21 order by day`;

    const trend = await loadTrend();
    const latest = trend.length > 0 ? trend[trend.length - 1] : null;
    const expenditure = await currentExpenditure(trend);
    const target = await activeTarget(today);
    const transients = await activeTransients(today);
    const totals = sumMacros(entries);

    // Against the target, not against the estimate: the target is what Marco
    // was told to eat, and it does not move when the estimate wobbles.
    const vsTarget = target
      ? {
        kcal_target: target.kcal_target,
        kcal_remaining: Math.round((target.kcal_target - totals.kcal) * 10) /
          10,
        protein_g_target: target.protein_g_target,
        protein_g_remaining: totals.protein_g === null
          ? null
          : Math.round((target.protein_g_target - totals.protein_g) * 10) / 10,
      }
      : null;

    return c.json({
      today,
      today_so_far: { entries, totals, vs_target: vsTarget },
      trend_weight: latest
        ? {
          day: latest.day,
          trend_kg: latest.trend_kg,
          // Earliest of that day, not the most recent reading — which is what
          // this was called until the scale started reporting itself and days
          // began arriving with eight readings instead of one. The name mattered
          // immediately: a coach read "latest", saw a fresher number in the
          // bodyweight list, and reported the trend as picking the wrong row.
          //
          // Earliest is deliberate (daily_bodyweight): it is the most fasted
          // reading available, so it is the one most comparable to other days.
          // Its known edge is a weigh-in just after midnight, which is the
          // *least* fasted reading of the night but the first of the calendar
          // day. Moving the day boundary to the small hours would fix that case
          // and break its mirror image — a 03:30 start before a flight would be
          // filed under yesterday. A rare error the EMA absorbs beats a rule
          // Marco has to hold in his head, so the calendar day stands.
          earliest_scale_kg: latest.weight_kg,
          interpolated: latest.interpolated,
          slope_7d: slopePctBwWeek(trend, 7),
          slope_21d: slopePctBwWeek(trend, 21),
        }
        : null,
      expenditure,
      target,
      active_transients: transients,
      recent_days: recentDays,
      adherence,
      latest_bodyfat: latestBodyfat ?? null,
      recent_flags: flags,
    } as z.infer<typeof NutritionState>);
  },
);
