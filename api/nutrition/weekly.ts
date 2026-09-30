import type { WeeklyRepository } from "../../db/repositories/nutrition/weekly.ts";
import type { BodyfatService } from "../body/bodyfat.ts";
import type { BodyweightService } from "../body/bodyweight.ts";
import { addDays, lastFinishedSunday, mondayOf } from "../shared/dates.ts";
import { databaseError } from "../shared/errors.ts";
import { romeDate, systemClock } from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import { energyDensity, fatMassKg, weeklyTrendChange } from "./expenditure.ts";
import type { Week, WeekEvent } from "./weekly.types.ts";

const NOTE =
  "Finished weeks only. Each week carries what was eaten and the target in force at its end, so intake, protein and rate of change can each be read against what was actually asked for. A single week's implied_tdee_kcal is noisy — read the run, not the point, and never react to one week's movement inside the estimate's band. Where days_logged is low, mean_kcal is an average over few days and not a description of the week. Protein coverage excludes flagged days: days_in_mean is the mean's denominator (days with any known protein), entries counts all eligible entries, and unknown_entries counts those without protein. Partial protein is a known-protein floor over those days, not evidence of a target shortfall; wholly unknown days are not zeros.";

export function nutritionWeeklyStore(
  repository: WeeklyRepository,
  bodyweight: BodyweightService,
  bodyfat: BodyfatService,
  clock: Clock = systemClock
) {
  async function finishedWeeks(
    weeks: number
  ): Promise<{ weeks: Week[]; note: string }> {
    try {
      const end = lastFinishedSunday(romeDate(clock().toISOString()));
      const from = addDays(end, 1 - weeks * 7);
      const trend = await bodyweight.loadTrend();
      const bodyfatPercent = (await bodyfat.latestBodyfat())?.percent ?? null;

      // Four reads even at the public maximum of 104 weeks. Never issue a
      // persistence call per week, or pass a growing list of dates/target ids.
      const data = await repository.finishedWeeks(end, weeks);
      const events = await repository.events(from, end);
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
        const density =
          trendEnd === null || bodyfatPercent === null
            ? null
            : energyDensity(fatMassKg(trendEnd, bodyfatPercent));
        return {
          week_start: row.week_start,
          week_end: row.week_end,
          days_logged: row.days_logged,
          days_flagged: row.days_flagged,
          weigh_ins: row.weigh_ins,
          mean_kcal: row.mean_kcal === null ? null : Math.round(row.mean_kcal),
          mean_protein_g:
            row.mean_protein_g === null ? null : Math.round(row.mean_protein_g),
          protein_coverage: {
            days_in_mean: row.protein_days,
            entries: row.protein_entries,
            unknown_entries: row.unknown_protein_entries,
          },
          trend_start_kg: start?.trend_kg ?? null,
          trend_end_kg: trendEnd,
          ...weeklyTrendChange(start, finish, row.mean_kcal, density),
          target:
            row.kcal_target === null
              ? null
              : {
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
    } catch (error) {
      throw databaseError(error);
    }
  }
  return { finishedWeeks };
}

export type WeeklyService = ReturnType<typeof nutritionWeeklyStore>;
