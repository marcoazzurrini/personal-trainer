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

import { sql } from "../db.ts";
import { romeClock } from "../shared/calendar.ts";
import { loadTrend } from "../body/bodyweight.ts";
import { type BodyfatRow, latestBodyfat } from "../body/bodyfat.ts";
import type { MacroTotals } from "./rules.ts";
import { type ExpenditureRead } from "./read.ts";
import { currentExpenditure, slopePctBwWeek } from "./read.ts";
import { type ActiveTransient, activeTransients } from "./events.ts";
import { activeTarget, type TargetRow } from "./targets.ts";
import { type IntakeEntry, viewDay } from "./intake.ts";

// No coalesce anywhere here: a day with no entries reports null, not 0.
// Unknown is not zero — a floor of zeros under a hasty average reads as
// fasting. `entries: 0` already marks the day unlogged.
export interface RecentDay {
  day: string;
  kcal: number | null;
  protein_g: number | null;
  entries: number;
  incomplete: boolean;
  weight_kg: number | null;
}

export interface Adherence {
  days_logged_last_7: number;
  days_logged_last_21: number;
  weigh_ins_last_7: number;
  weigh_ins_last_21: number;
  last_logged_day: string | null;
  last_weigh_in: string | null;
}

export interface Slope {
  kg_per_week: number;
  pct_bw_week: number;
}

export interface NutritionState {
  now: { date: string; time: string; weekday: string; tz: string };
  today_so_far: {
    entries: IntakeEntry[];
    totals: MacroTotals;
    vs_target: {
      kcal_target: number;
      kcal_remaining: number;
      protein_g_target: number;
      protein_g_remaining: number | null;
    } | null;
  };
  trend_weight: {
    day: string;
    trend_kg: number;
    earliest_scale_kg: number;
    interpolated: boolean;
    slope_7d: Slope | null;
    slope_21d: Slope | null;
  } | null;
  expenditure: ExpenditureRead;
  target: TargetRow | null;
  active_transients: ActiveTransient[];
  recent_days: RecentDay[];
  adherence: Adherence;
  latest_bodyfat: BodyfatRow | null;
  recent_flags: { day: string; flag: string }[];
}

export async function nutritionState(): Promise<NutritionState> {
  const now = await romeClock();
  const today = now.date;

  // The same day view GET /intake answers with, rather than a second query
  // that happened to say the same thing. The two drifted apart by one column
  // and one schema for a long while, both of them calling sumMacros on rows
  // selected by two hand-kept column lists.
  const { entries, totals } = await viewDay(today);

  // d.day is cast back to date: generate_series with an interval step yields
  // timestamp (oid 1114), which slips past db.ts's date parser (oid 1082) and
  // serializes as "2026-07-26T00:00:00.000Z" while every other day field in
  // the API is a bare "2026-07-26". A coach reading that as an instant and
  // formatting it locally gets the wrong day either side of midnight.
  const recentDays = await sql<RecentDay[]>`
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

  const [adherence] = await sql<Adherence[]>`
    -- A logged day is a day daily_intake reports entries on, which is the
    -- definition the weekly review already used. This block counted distinct
    -- days off intake_entries instead — the same answer by a second route,
    -- and two vocabularies for one word in the payload that reports on it.
    select
      (select count(*)::int from daily_intake d
       where d.day >= ${today}::date - 7 and d.day < ${today}::date
         and d.entries > 0)
        as days_logged_last_7,
      (select count(*)::int from daily_intake d
       where d.day >= ${today}::date - 21 and d.day < ${today}::date
         and d.entries > 0)
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
      (select max(d.day) from daily_intake d
       where d.day < ${today}::date and d.entries > 0)
        as last_logged_day,
      (select max(w.day) from daily_bodyweight w) as last_weigh_in`;

  const flags = await sql<{ day: string; flag: string }[]>`
    select day, flag from day_flags
    where day >= ${today}::date - 21 order by day`;

  const trend = await loadTrend();
  const latest = trend.length > 0 ? trend[trend.length - 1] : null;
  const expenditure = await currentExpenditure(trend);
  const target = await activeTarget(today);
  const transients = await activeTransients(today);

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

  return {
    now,
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
    latest_bodyfat: await latestBodyfat(),
    recent_flags: flags,
  };
}
