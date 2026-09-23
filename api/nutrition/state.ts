import { bodyfatStore } from "../body/bodyfat.ts";
import { bodyweightStore } from "../body/bodyweight.ts";
import {
  type Clock,
  type Database,
  romeDate,
  rows,
  systemClock,
} from "../shared/d1.ts";
import { addDays } from "../shared/dates.ts";
import { eventStore } from "./events.ts";
import type { IntakeEntry } from "./intake.types.ts";
import { nutritionReader, slopePctBwWeek } from "./read.ts";
import { sumMacros } from "./rules.ts";
import type { Adherence, NutritionState, RecentDay } from "./state.types.ts";
import { targetStore } from "./targets.ts";

export function nutritionStateStore(db: Database, clock: Clock = systemClock) {
  async function nutritionState(): Promise<NutritionState> {
    // All nested reads see the same instant, including across Rome midnight.
    const instant = clock();
    const snapshot: Clock = () => instant;
    const today = romeDate(instant.toISOString());
    const now = {
      date: today,
      time: new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Rome",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(instant),
      weekday: new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Rome",
        weekday: "long",
      }).format(instant),
      tz: "Europe/Rome",
    };

    // Keep this small projection aligned with intakeStore.viewDay. The view,
    // not stored snapshots, owns corrected labels and override invalidation.
    const entries = await rows<IntakeEntry>(
      db,
      `
      SELECT i.id, i.day, i.grams, i.kcal, i.protein_g, i.carbs_g,
        i.fat_g, i.fiber_g, i.note,
        substr(i.created_at, 1, 23) || 'Z' AS created_at,
        i.food_id, f.name AS food, i.meal_id, m.name AS meal
      FROM intake_values i
      LEFT JOIN foods f ON f.id = i.food_id
      LEFT JOIN meals m ON m.id = i.meal_id
      WHERE i.day = ? ORDER BY i.created_at, i.id`,
      today,
    );
    const totals = sumMacros(entries);

    // The legacy state reports thirteen completed days, not today's partial
    // intake. Only entry counts and flag bits get defaults; unknown is not zero.
    const recent = await rows<
      Omit<RecentDay, "incomplete"> & { incomplete: number }
    >(
      db,
      `
      WITH RECURSIVE days(day) AS (
        SELECT ? UNION ALL SELECT date(day, '+1 day') FROM days WHERE day < ?
      )
      SELECT d.day, i.kcal, i.protein_g, coalesce(i.entries, 0) AS entries,
        coalesce(i.incomplete, 0) AS incomplete, b.value_kg AS weight_kg
      FROM days d LEFT JOIN daily_intake i ON i.day = d.day
      LEFT JOIN daily_bodyweight b ON b.day = d.day ORDER BY d.day`,
      addDays(today, -13),
      addDays(today, -1),
    );
    const [adherence] = await rows<Adherence>(
      db,
      `
      SELECT
        (SELECT count(*) FROM daily_intake WHERE day >= ? AND day < ? AND entries > 0) AS days_logged_last_7,
        (SELECT count(*) FROM daily_intake WHERE day >= ? AND day < ? AND entries > 0) AS days_logged_last_21,
        (SELECT count(*) FROM daily_bodyweight WHERE day >= ? AND day <= ?) AS weigh_ins_last_7,
        (SELECT count(*) FROM daily_bodyweight WHERE day >= ? AND day <= ?) AS weigh_ins_last_21,
        (SELECT max(day) FROM daily_intake WHERE day < ? AND entries > 0) AS last_logged_day,
        (SELECT max(day) FROM daily_bodyweight) AS last_weigh_in`,
      addDays(today, -7),
      today,
      addDays(today, -21),
      today,
      addDays(today, -6),
      today,
      addDays(today, -20),
      today,
      today,
    );
    const flags = await rows<{ day: string; flag: string }>(
      db,
      "SELECT day, flag FROM day_flags WHERE day >= ? ORDER BY day",
      addDays(today, -21),
    );
    const trend = await bodyweightStore(db, snapshot).loadTrend();
    const latest = trend.length ? trend[trend.length - 1] : null;
    const expenditure = await nutritionReader(db, snapshot).currentExpenditure(
      trend,
    );
    const target = await targetStore(db, snapshot).activeTarget(today);
    const transients = await eventStore(db, snapshot).activeTransients(today);
    return {
      now,
      today_so_far: {
        entries,
        totals,
        vs_target: target
          ? {
            kcal_target: target.kcal_target,
            kcal_remaining:
              Math.round((target.kcal_target - totals.kcal) * 10) / 10,
            protein_g_target: target.protein_g_target,
            protein_g_remaining: totals.protein_g === null ? null : Math.round(
              (target.protein_g_target - totals.protein_g) * 10,
            ) / 10,
          }
          : null,
      },
      trend_weight: latest
        ? {
          day: latest.day,
          trend_kg: latest.trend_kg,
          earliest_scale_kg: latest.weight_kg,
          interpolated: latest.interpolated,
          slope_7d: slopePctBwWeek(trend, 7),
          slope_21d: slopePctBwWeek(trend, 21),
        }
        : null,
      expenditure,
      target,
      active_transients: transients,
      recent_days: recent.map((day) => ({
        ...day,
        incomplete: Boolean(day.incomplete),
      })),
      adherence,
      latest_bodyfat: await bodyfatStore(db, snapshot).latestBodyfat(),
      recent_flags: flags,
    };
  }
  return { nutritionState };
}
