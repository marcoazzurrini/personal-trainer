import { bodyfatStore } from "../body/bodyfat.ts";
import { bodyweightStore } from "../body/bodyweight.ts";
import {
  type Clock,
  type Database,
  romeDate,
  rows,
  systemClock,
} from "../shared/d1.ts";
import { addDays, lastFinishedSunday, mondayOf } from "../shared/dates.ts";
import { energyDensity, fatMassKg, weeklyTrendChange } from "./expenditure.ts";
import type { Week, WeekEvent } from "./weekly.types.ts";

const NOTE =
  "Finished weeks only. Each week carries what was eaten and the target in force at its end, so intake, protein and rate of change can each be read against what was actually asked for. A single week's implied_tdee_kcal is noisy — read the run, not the point, and never react to one week's movement inside the estimate's band. Where days_logged is low, mean_kcal is an average over few days and not a description of the week. Protein coverage excludes flagged days: days_in_mean is the mean's denominator (days with any known protein), entries counts all eligible entries, and unknown_entries counts those without protein. Partial protein is a known-protein floor over those days, not evidence of a target shortfall; wholly unknown days are not zeros.";

interface WeekRow {
  week_start: string;
  week_end: string;
  days_logged: number;
  days_flagged: number;
  weigh_ins: number;
  mean_kcal: number | null;
  mean_protein_g: number | null;
  protein_days: number;
  protein_entries: number;
  unknown_protein_entries: number;
  kcal_target: number | null;
  protein_g_target: number;
  target_goal: string;
  target_rate_pct_bw_week: number;
  target_effective_from: string;
  target_changed: number;
}

export function nutritionWeeklyStore(db: Database, clock: Clock = systemClock) {
  async function finishedWeeks(
    weeks: number,
  ): Promise<{ weeks: Week[]; note: string }> {
    const end = lastFinishedSunday(romeDate(clock().toISOString()));
    const from = addDays(end, 1 - weeks * 7);
    const trend = await bodyweightStore(db, clock).loadTrend();
    const bodyfat = (await bodyfatStore(db, clock).latestBodyfat())?.percent ??
      null;

    // Four reads even at the public maximum of 104 weeks. Never issue a D1
    // subrequest per week, or bind a growing list of dates/target ids.
    const data = await rows<WeekRow>(
      db,
      `
      WITH RECURSIVE weeks(week_start, week_end, n) AS (
        SELECT date(?, '-6 days'), ?, 1 WHERE ? > 0
        UNION ALL
        SELECT date(week_start, '-7 days'), date(week_end, '-7 days'), n + 1
        FROM weeks WHERE n < ?
      ), intake AS (
        SELECT w.week_start,
          count(CASE WHEN d.entries > 0 THEN 1 END) AS days_logged,
          count(CASE WHEN d.incomplete THEN 1 END) AS days_flagged,
          avg(CASE WHEN NOT d.incomplete THEN d.kcal END) AS mean_kcal,
          avg(CASE WHEN NOT d.incomplete THEN d.protein_g END) AS mean_protein_g,
          count(CASE WHEN NOT d.incomplete THEN d.protein_g END) AS protein_days,
          coalesce(sum(CASE WHEN NOT d.incomplete THEN d.entries END), 0) AS protein_entries,
          coalesce(sum(CASE WHEN NOT d.incomplete THEN d.entries - d.protein_entries END), 0) AS unknown_protein_entries
        FROM weeks w LEFT JOIN daily_intake d
          ON d.day BETWEEN w.week_start AND w.week_end
        GROUP BY w.week_start
      )
      SELECT w.week_start, w.week_end, i.days_logged, i.days_flagged,
        i.mean_kcal, i.mean_protein_g, i.protein_days, i.protein_entries,
        i.unknown_protein_entries,
        (SELECT count(*) FROM daily_bodyweight b
          WHERE b.day BETWEEN w.week_start AND w.week_end) AS weigh_ins,
        t.kcal_target, t.protein_g_target, t.goal AS target_goal,
        t.rate_pct_bw_week / 100.0 AS target_rate_pct_bw_week,
        t.effective_from AS target_effective_from,
        EXISTS (SELECT 1 FROM nutrition_targets t2
          WHERE t2.effective_from > w.week_start
            AND t2.effective_from <= w.week_end) AS target_changed
      FROM weeks w JOIN intake i ON i.week_start = w.week_start
      LEFT JOIN nutrition_targets t ON t.id = (
        SELECT id FROM nutrition_targets
        WHERE effective_from <= w.week_end
        ORDER BY effective_from DESC, id DESC LIMIT 1
      ) ORDER BY w.week_start`,
      end,
      end,
      weeks,
      weeks,
    );

    // The view compares the entire winning target history before this filter.
    const events = await rows<WeekEvent>(
      db,
      `
      SELECT day, kind, note FROM nutrition_effective_events
      WHERE day >= ? AND day <= ? ORDER BY day, id`,
      from,
      end,
    );
    const eventsByWeek = new Map<string, WeekEvent[]>();
    for (const event of events) {
      const start = mondayOf(event.day);
      const group = eventsByWeek.get(start) ?? [];
      group.push(event);
      eventsByWeek.set(start, group);
    }
    const byDay = new Map(trend.map((point) => [point.day, point]));
    const enriched: Week[] = data.map((row) => {
      const start = byDay.get(row.week_start);
      const finish = byDay.get(row.week_end);
      const trendEnd = finish?.trend_kg ?? null;
      const density = trendEnd === null || bodyfat === null
        ? null
        : energyDensity(fatMassKg(trendEnd, bodyfat));
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
        protein_coverage: {
          days_in_mean: row.protein_days,
          entries: row.protein_entries,
          unknown_entries: row.unknown_protein_entries,
        },
        trend_start_kg: start?.trend_kg ?? null,
        trend_end_kg: trendEnd,
        ...weeklyTrendChange(start, finish, row.mean_kcal, density),
        target: row.kcal_target === null ? null : {
          kcal: row.kcal_target,
          protein_g: row.protein_g_target,
          goal: row.target_goal,
          rate_pct_bw_week: row.target_rate_pct_bw_week,
          effective_from: row.target_effective_from,
          changed_during_week: Boolean(row.target_changed),
        },
        events: eventsByWeek.get(row.week_start) ?? [],
      };
    });
    return { weeks: enriched, note: NOTE };
  }
  return { finishedWeeks };
}
