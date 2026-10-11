import type { StateRepository } from "@trainer/db/repositories/nutrition/state.ts";
import { Effect } from "effect";

import type { BodyfatService } from "../body/bodyfat.ts";
import type { BodyweightService } from "../body/bodyweight.ts";
import { effectful } from "../shared/database.ts";
import { addDays } from "../shared/dates.ts";
import type { DatabaseFailure, Invalid } from "../shared/refusals.ts";
import {
  atOneInstant,
  currentTime,
  today as romeToday,
  wireInstant,
} from "../shared/values.ts";
import { expenditureStore, slopePctBwWeek } from "./read.ts";
import { sumMacros } from "./rules.ts";
import type { NutritionState } from "./state.types.ts";
import { targetStore } from "./targets.ts";

export function nutritionStateStore(
  rows: StateRepository,
  bodyweight: BodyweightService,
  bodyfat: BodyfatService
) {
  const repository = effectful(rows);
  const expenditures = expenditureStore(rows.expenditure, bodyfat);
  const targets = targetStore(rows.targets, bodyweight, bodyfat);

  const nutritionState = Effect.fn("nutritionState.nutritionState")(
    function* (): Effect.fn.Return<NutritionState, Invalid | DatabaseFailure> {
      const instant = yield* currentTime;
      const today = yield* romeToday;
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

      // These reads do not depend on one another, so they wait on D1
      // together: the state costs its slowest read rather than the sum of
      // nine. They were separate queries before too, never one snapshot; the
      // clock, read once above, is what keeps them about the same day.
      const reads = yield* Effect.all(
        {
          entries: repository.entries(today),
          // The legacy state reports thirteen completed days, not today's
          // partial intake. Only entry counts and flag bits get defaults;
          // unknown is not zero.
          recent: repository.recentDays(
            addDays(today, -13),
            addDays(today, -1)
          ),
          adherence: repository.adherence({
            today,
            loggedFrom7: addDays(today, -7),
            loggedFrom21: addDays(today, -21),
            weighedFrom7: addDays(today, -6),
            weighedFrom21: addDays(today, -20),
          }),
          flags: repository.flags(addDays(today, -21)),
          trend: bodyweight.loadTrend(),
          target: targets.activeTarget(today),
          transients: expenditures.activeTransients(today),
          latestBodyfat: bodyfat.latestBodyfat(),
        },
        { concurrency: "unbounded" }
      );
      const { recent, adherence, flags, trend, target, transients } = reads;
      // Keep this small projection aligned with intakeStore.viewDay. The view,
      // not stored snapshots, owns corrected labels and override invalidation.
      const entries = reads.entries.map((entry) => ({
        ...entry,
        created_at: wireInstant(entry.created_at),
      }));
      const totals = sumMacros(entries);
      const latest = trend.length ? trend.at(-1) : null;
      // The one read that needs another's answer.
      const expenditure = yield* expenditures.currentExpenditure(trend);
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
        latest_bodyfat: reads.latestBodyfat,
        recent_flags: flags,
      };
    },
    // All nested reads see the same instant, including across Rome midnight.
    atOneInstant
  );
  return { nutritionState };
}

export type NutritionStateService = ReturnType<typeof nutritionStateStore>;
