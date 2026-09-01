// Finished weeks only, like every other weekly read in this system: the
// current week is never blended in, because a Tuesday's three logged days
// would read as a collapse in intake.
//
// This is the evaluation surface for "is the cut working". Each row carries
// what was eaten, what the trend did, and the expenditure that week implies
// on its own. A single week's implied expenditure is noisy by construction —
// it is here so a run of them can be read as a direction, not so any one of
// them can be reacted to.

import { sql } from "../db.ts";
import { energyDensity, fatMassKg } from "./expenditure.ts";
import { lastFinishedDay } from "../record/calendar.ts";
import { loadTrend } from "../body/bodyweight.ts";
import { latestBodyfat } from "../body/bodyfat.ts";

export interface WeekEvent {
  day: string;
  kind: string;
  note: string | null;
}

export interface WeekTarget {
  kcal: number;
  protein_g: number;
  goal: string;
  rate_pct_bw_week: number;
  effective_from: string;
  changed_during_week: boolean;
}

export interface Week {
  week_start: string;
  week_end: string;
  days_logged: number;
  days_flagged: number;
  weigh_ins: number;
  mean_kcal: number | null;
  mean_protein_g: number | null;
  trend_start_kg: number | null;
  trend_end_kg: number | null;
  trend_delta_kg: number | null;
  rate_pct_bw_week: number | null;
  implied_tdee_kcal: number | null;
  target: WeekTarget | null;
  events: WeekEvent[];
}

const NOTE =
  "Finished weeks only. Each week carries what was eaten and the target in force at its end, so intake, protein and rate of change can each be read against what was actually asked for. A single week's implied_tdee_kcal is noisy — read the run, not the point, and never react to one week's movement inside the estimate's band. Where days_logged is low, mean_kcal is an average over few days and not a description of the week.";

export async function finishedWeeks(
  weeks: number,
): Promise<{ weeks: Week[]; note: string }> {
  const end = await lastFinishedDay();
  const trend = await loadTrend();
  const bodyfat = (await latestBodyfat())?.percent ?? null;

  const rows = await sql`
    select
      w.week_start,
      (w.week_start + 6) as week_end,
      (select count(*)::int from daily_intake d
       where d.day >= w.week_start and d.day <= w.week_start + 6
         and d.entries > 0)
        as days_logged,
      intake.mean_kcal,
      intake.mean_protein_g,
      (select count(*)::int from daily_bodyweight b
       where b.day >= w.week_start and b.day <= w.week_start + 6)
        as weigh_ins,
      (select count(*)::int from daily_intake d
       where d.day >= w.week_start and d.day <= w.week_start + 6
         and d.incomplete)
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
    -- Both means are averaged over one filtered set of days, so they cannot
    -- come to disagree about which days count. A day flagged incomplete is
    -- unusable, not unusable-for-energy: Marco has said he did not track it,
    -- so its partial protein understates the week exactly as its partial kcal
    -- does, and excluding it from one mean but not the other would report a
    -- protein shortfall that never happened.
    --
    -- avg ignores nulls, so a day carrying no protein at all leaves
    -- mean_protein_g alone rather than dragging it toward zero — the same
    -- floor-not-total rule sumMacros applies inside a single day, and the
    -- reason daily_intake does not coalesce its sums.
    left join lateral (
      select avg(d.kcal)::float8 as mean_kcal,
        avg(d.protein_g)::float8 as mean_protein_g
      from daily_intake d
      where d.day >= w.week_start and d.day <= w.week_start + 6
        and not d.incomplete
    ) intake on true
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

  const enriched: Week[] = rows.map((row) => {
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
  });

  return { weeks: enriched, note: NOTE };
}
