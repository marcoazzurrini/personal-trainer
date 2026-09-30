import type { StateRepository } from "../../db/repositories/nutrition/state.ts";
import type { BodyfatService } from "../body/bodyfat.ts";
import type { BodyweightService } from "../body/bodyweight.ts";
import { addDays } from "../shared/dates.ts";
import { romeDate, systemClock, wireInstant } from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import { expenditureStore, slopePctBwWeek } from "./read.ts";
import { sumMacros } from "./rules.ts";
import type { NutritionState } from "./state.types.ts";
import { targetStore } from "./targets.ts";

export function nutritionStateStore(
  repository: StateRepository,
  bodyweight: BodyweightService,
  bodyfat: BodyfatService,
  clock: Clock = systemClock
) {
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
    const entries = (await repository.entries(today)).map((entry) => ({
      ...entry,
      created_at: wireInstant(entry.created_at),
    }));
    const totals = sumMacros(entries);

    // The legacy state reports thirteen completed days, not today's partial
    // intake. Only entry counts and flag bits get defaults; unknown is not zero.
    const recent = await repository.recentDays(
      addDays(today, -13),
      addDays(today, -1)
    );
    const adherence = await repository.adherence({
      today,
      loggedFrom7: addDays(today, -7),
      loggedFrom21: addDays(today, -21),
      weighedFrom7: addDays(today, -6),
      weighedFrom21: addDays(today, -20),
    });
    const flags = await repository.flags(addDays(today, -21));
    const trend = await bodyweight.loadTrend();
    const latest = trend.length ? trend.at(-1) : null;
    const expenditure = await expenditureStore(
      repository.expenditure,
      bodyfat,
      snapshot
    ).currentExpenditure(trend);
    const target = await targetStore(
      repository.targets,
      bodyweight,
      bodyfat,
      snapshot
    ).activeTarget(today);
    const transients = await expenditureStore(
      repository.expenditure,
      bodyfat,
      snapshot
    ).activeTransients(today);
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
              protein_g_remaining:
                totals.protein_g === null
                  ? null
                  : Math.round(
                      (target.protein_g_target - totals.protein_g) * 10
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
      latest_bodyfat: await bodyfat.latestBodyfat(),
      recent_flags: flags,
    };
  }
  return { nutritionState };
}

export type NutritionStateService = ReturnType<typeof nutritionStateStore>;
