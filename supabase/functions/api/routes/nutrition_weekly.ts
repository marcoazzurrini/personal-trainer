import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { energyDensity, fatMassKg, GOALS } from "../rules/expenditure.ts";
import { lastFinishedDay } from "../record/calendar.ts";
import { latestBodyfat, loadTrend } from "../record/nutrition_read.ts";

// Finished weeks only, like every other weekly read in this system: the
// current week is never blended in, because a Tuesday's three logged days
// would read as a collapse in intake.
//
// This is the evaluation surface for "is the cut working". Each row carries
// what was eaten, what the trend did, and the expenditure that week implies
// on its own. A single week's implied expenditure is noisy by construction —
// it is here so a run of them can be read as a direction, not so any one of
// them can be reacted to.

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
      query: z.object({
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
  async (c) => {
    const end = await lastFinishedDay();
    const { weeks } = c.req.valid("query");
    const trend = await loadTrend();
    const bodyfat = await latestBodyfat();

    const rows = await sql`
    select
      w.week_start,
      (w.week_start + 6) as week_end,
      (select count(distinct i.day)::int from intake_entries i
       where i.day >= w.week_start and i.day <= w.week_start + 6)
        as days_logged,
      (select avg(d.kcal)::float8 from (
         select i.day, sum(i.kcal) as kcal from intake_entries i
         where i.day >= w.week_start and i.day <= w.week_start + 6
           and not exists (select 1 from day_flags f
                           where f.day = i.day and f.flag = 'incomplete')
         group by i.day) d)
        as mean_kcal,
      (select avg(d.protein)::float8 from (
         select i.day, sum(i.protein_g) as protein from intake_entries i
         where i.day >= w.week_start and i.day <= w.week_start + 6
         group by i.day) d)
        as mean_protein_g,
      (select count(*)::int from daily_bodyweight b
       where b.day >= w.week_start and b.day <= w.week_start + 6)
        as weigh_ins,
      (select count(*)::int from day_flags f
       where f.flag = 'incomplete'
         and f.day >= w.week_start and f.day <= w.week_start + 6)
        as days_flagged,
      coalesce((select json_agg(json_build_object(
                 'day', e.day, 'kind', e.kind, 'note', e.note) order by e.day)
                from nutrition_events e
                where e.day >= w.week_start and e.day <= w.week_start + 6),
               '[]') as events,
      -- What the week was supposed to be, alongside what it was. Without this
      -- the caller has to fetch the append-only target history and work out by
      -- date which row governed each week — date arithmetic in the client, for
      -- a comparison that is the entire point of the read.
      tg.kcal_target, tg.protein_g_target, tg.goal as target_goal,
      tg.rate_pct_bw_week::float8 as target_rate_pct_bw_week,
      tg.effective_from as target_effective_from,
      exists (select 1 from nutrition_targets t2
              where t2.effective_from > w.week_start
                and t2.effective_from <= w.week_start + 6) as target_changed
    from (
      select (${end}::date - 6 - (g * 7))::date as week_start
      from generate_series(0, ${weeks - 1}) g
    ) w
    -- The target in force at the week's end: what Marco was eating to by the
    -- time the week was over. target_changed flags the weeks where one
    -- superseded another mid-week and the comparison is therefore muddy.
    left join lateral (
      select t.kcal_target, t.protein_g_target, t.goal, t.rate_pct_bw_week,
        t.effective_from
      from nutrition_targets t
      where t.effective_from <= w.week_start + 6
      order by t.effective_from desc, t.id desc
      limit 1
    ) tg on true
    order by w.week_start`;

    const byDay = new Map(trend.map((p) => [p.day, p]));

    const enriched = rows.map((row) => {
      const start = byDay.get(row.week_start);
      const finish = byDay.get(row.week_end);
      const trendStart = start?.trend_kg ?? null;
      const trendEnd = finish?.trend_kg ?? null;

      // Implied expenditure for the week on its own, when the week has both
      // ends of a trend and a mean intake to work from. Null is the honest
      // answer otherwise — a week missing its bookend weigh-ins cannot say
      // anything about expenditure, and filling it in would manufacture a
      // trend out of nothing.
      let impliedTdee: number | null = null;
      if (
        trendStart !== null && trendEnd !== null && row.mean_kcal !== null &&
        bodyfat !== null
      ) {
        const density = energyDensity(fatMassKg(trendEnd, bodyfat));
        impliedTdee = Math.round(
          row.mean_kcal - (trendEnd - trendStart) / 7 * density,
        );
      }

      // The week's own rate of change, so "am I losing at the rate I chose" is
      // one read rather than a subtraction the caller has to know to make.
      const ratePctBwWeek = trendStart === null || trendEnd === null ||
          trendStart === 0
        ? null
        : Math.round((trendEnd - trendStart) / trendStart * 10000) / 100;

      return {
        week_start: row.week_start,
        week_end: row.week_end,
        days_logged: row.days_logged,
        days_flagged: row.days_flagged,
        weigh_ins: row.weigh_ins,
        mean_kcal: row.mean_kcal === null ? null : Math.round(row.mean_kcal),
        mean_protein_g: row.mean_protein_g === null
          ? null
          : Math.round(row.mean_protein_g),
        trend_start_kg: trendStart,
        trend_end_kg: trendEnd,
        trend_delta_kg: trendStart === null || trendEnd === null
          ? null
          : Math.round((trendEnd - trendStart) * 100) / 100,
        rate_pct_bw_week: ratePctBwWeek,
        implied_tdee_kcal: impliedTdee,
        target: row.kcal_target === null ? null : {
          kcal: row.kcal_target,
          protein_g: row.protein_g_target,
          goal: row.target_goal,
          rate_pct_bw_week: row.target_rate_pct_bw_week,
          effective_from: row.target_effective_from,
          changed_during_week: row.target_changed,
        },
        events: row.events,
      };
    }) as z.infer<typeof Week>[];

    return c.json({
      weeks: enriched,
      note:
        "Finished weeks only. Each week carries what was eaten and the target in force at its end, so intake, protein and rate of change can each be read against what was actually asked for. A single week's implied_tdee_kcal is noisy — read the run, not the point, and never react to one week's movement inside the estimate's band. Where days_logged is low, mean_kcal is an average over few days and not a description of the week.",
    });
  },
);
