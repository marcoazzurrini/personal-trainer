import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import {
  activeTarget,
  activeTransients,
  currentExpenditure,
  loadTrend,
  slopePctBwWeek,
} from "../lib/nutrition_read.ts";
import { sumMacros } from "../lib/nutrition.ts";

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

export const nutritionState = new Hono();

nutritionState.get("/", async (c) => {
  const [clock] = await sql`
    select (now() at time zone 'Europe/Rome')::date as today`;
  const today = clock.today;

  const entries = await sql`
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
  const recentDays = await sql`
    select d.day::date as day,
      coalesce((select sum(i.kcal)::float8 from intake_entries i
                where i.day = d.day), 0) as kcal,
      (select sum(i.protein_g)::float8 from intake_entries i
       where i.day = d.day) as protein_g,
      (select count(*)::int from intake_entries i where i.day = d.day)
        as entries,
      exists (select 1 from day_flags fl
              where fl.day = d.day and fl.flag = 'incomplete') as incomplete,
      (select w.value_kg from daily_bodyweight w where w.day = d.day)
        as weight_kg
    from generate_series(${today}::date - 13, ${today}::date - 1, interval '1 day')
      as d(day)
    order by d.day`;

  const [adherence] = await sql`
    select
      (select count(distinct i.day)::int from intake_entries i
       where i.day >= ${today}::date - 7 and i.day < ${today}::date)
        as days_logged_last_7,
      (select count(distinct i.day)::int from intake_entries i
       where i.day >= ${today}::date - 21 and i.day < ${today}::date)
        as days_logged_last_21,
      (select count(*)::int from daily_bodyweight w
       where w.day >= ${today}::date - 7 and w.day < ${today}::date)
        as weigh_ins_last_7,
      (select count(*)::int from daily_bodyweight w
       where w.day >= ${today}::date - 21 and w.day < ${today}::date)
        as weigh_ins_last_21,
      (select max(i.day) from intake_entries i where i.day < ${today}::date)
        as last_logged_day,
      (select max(w.day) from daily_bodyweight w) as last_weigh_in`;

  const [latestBodyfat] = await sql`
    select day, percent::float8, method, note from bodyfat_estimates
    order by day desc, id desc limit 1`;

  const flags = await sql`
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
      kcal_remaining: Math.round((target.kcal_target - totals.kcal) * 10) / 10,
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
        latest_scale_kg: latest.weight_kg,
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
  });
});
