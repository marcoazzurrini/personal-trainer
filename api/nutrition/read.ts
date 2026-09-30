import type { ExpenditureRepository } from "../../db/repositories/nutrition/expenditure.ts";
import type { ReadRepository } from "../../db/repositories/nutrition/read.ts";
import type { BodyfatService } from "../body/bodyfat.ts";
import type { TrendPoint } from "../body/trend.ts";
import { addDays, daysBetween } from "../shared/dates.ts";
import {
  date,
  instant,
  romeDate,
  systemClock,
  wireInstant,
} from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import type { ActiveTransient } from "./events.types.ts";
import { backSolve, damp, DEFAULT_WINDOW_DAYS } from "./expenditure.ts";
import type { Expenditure } from "./expenditure.ts";
import type { ActiveTarget, ExpenditureRead } from "./read.types.ts";

const MAX_STALE_WEEKS = 4;

function windowDays(to: string, length: number): string[] {
  const days: string[] = [];
  for (let i = length - 1; i >= 0; i--) {
    days.push(addDays(to, -i));
  }
  return days;
}

export function expenditureStore(
  repository: ExpenditureRepository,
  bodyfat: BodyfatService,
  clock: Clock = systemClock
) {
  async function activeTransients(asOf: string): Promise<ActiveTransient[]> {
    const day = date(asOf);
    return await repository.transients(addDays(day, -14), day);
  }

  async function solveWindow(
    to: string,
    trend: readonly TrendPoint[],
    bodyfatPercent: number | null
  ): Promise<Expenditure> {
    const days = windowDays(to, DEFAULT_WINDOW_DAYS);
    // A missing calorie observation is not a zero-calorie day.
    const entries = await repository.intakeDays(days[0], to);
    const intakeByDay = new Map<string, number>();
    const excludedDays = new Set<string>();
    for (const row of entries) {
      if (row.kcal !== null) {
        intakeByDay.set(row.day, row.kcal);
      }
      if (row.incomplete) {
        excludedDays.add(row.day);
      }
    }
    return backSolve({
      days,
      intakeByDay,
      excludedDays,
      trend,
      bodyfatPercent,
    });
  }

  async function currentExpenditure(
    trend: readonly TrendPoint[]
  ): Promise<ExpenditureRead> {
    const today = romeDate(instant(clock().toISOString()));
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
    const to = addDays(today, -weekday);
    const bodyfatPercent = (await bodyfat.latestBodyfat())?.percent ?? null;
    let current = await solveWindow(to, trend, bodyfatPercent);

    // Acknowledge observations outside the finished window without using
    // unfinished weeks in the back-solve.
    if (current.status !== "ok") {
      const sinceClose = trend.filter(
        (p) => !p.interpolated && daysBetween(to, p.day) > 0
      ).length;
      if (
        sinceClose > 0 &&
        current.blockers.some((b) => b.includes("weigh-in day"))
      ) {
        const blockers = current.blockers.map((b) =>
          b.includes("weigh-in day")
            ? `${b} ${sinceClose} weigh-in day${
                sinceClose === 1 ? "" : "s"
              } since the window closed — counted when the current week finishes.`
            : b
        );
        current = { ...current, blockers, reason: blockers.join(" ") };
      }
    }

    if (current.status === "ok") {
      const previous = await solveWindow(
        addDays(to, -7),
        trend,
        bodyfatPercent
      );
      const transients = await activeTransients(to);
      const damped = damp(
        current,
        previous.tdee_kcal,
        transients.length > 0
          ? { kind: transients[0].kind, day: transients[0].day }
          : null
      );
      return { ...damped, as_of: to };
    }

    // Hold the last qualifying estimate instead of extrapolating missing data.
    for (let back = 1; back <= MAX_STALE_WEEKS; back++) {
      const earlier = addDays(to, -7 * back);
      const held = await solveWindow(earlier, trend, bodyfatPercent);
      if (held.status === "ok") {
        return {
          ...held,
          status: "stale",
          as_of: earlier,
          reason: `Held from the window ending ${earlier} (${back} week${
            back === 1 ? "" : "s"
          } ago). The current window no longer qualifies: ${current.reason} The estimate is frozen, not extrapolated — say what is missing rather than guessing a number.`,
        };
      }
    }
    return { ...current, as_of: null };
  }

  return { currentExpenditure, activeTransients };
}

export type ExpenditureService = ReturnType<typeof expenditureStore>;

/** Trend slope over the last n days, in kg/week — the rate to compare a target against. */
export function slopePctBwWeek(
  trend: readonly TrendPoint[],
  days: number
): { kg_per_week: number; pct_bw_week: number } | null {
  if (trend.length < 2) {
    return null;
  }
  // SAFETY: fewer than two trend points return above.
  const last = trend.at(-1) as TrendPoint;
  const cutoff = addDays(last.day, -days);
  const start = trend.find((p) => daysBetween(cutoff, p.day) >= 0);
  if (!start || start.day === last.day) {
    return null;
  }
  const span = daysBetween(start.day, last.day);
  const kgPerWeek = ((last.trend_kg - start.trend_kg) / span) * 7;
  return {
    kg_per_week: Math.round(kgPerWeek * 1000) / 1000,
    pct_bw_week: Math.round((kgPerWeek / last.trend_kg) * 10_000) / 100,
  };
}

export function nutritionReadStore(
  repository: ReadRepository,
  bodyfat: BodyfatService,
  clock: Clock = systemClock
) {
  const { currentExpenditure } = expenditureStore(
    repository.expenditure,
    bodyfat,
    clock
  );
  async function activeTarget(asOf: string): Promise<ActiveTarget | null> {
    const row = await repository.activeTarget(date(asOf));
    return row ? { ...row, created_at: wireInstant(row.created_at) } : null;
  }
  return { currentExpenditure, activeTarget, slopePctBwWeek };
}
export const nutritionReader = nutritionReadStore;
export type NutritionReader = ReturnType<typeof nutritionReadStore>;
