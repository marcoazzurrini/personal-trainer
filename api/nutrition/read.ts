import {
  type Clock,
  type Database,
  date,
  instant,
  romeDate,
  rows,
  systemClock,
} from "../shared/d1.ts";

import { addDays, daysBetween } from "../shared/dates.ts";
import { eventStore } from "./events.ts";
import { bodyfatStore } from "../body/bodyfat.ts";
import type { ActiveTarget, ExpenditureRead } from "./read.types.ts";
import type { TargetRow } from "./targets.types.ts";
import type { TrendPoint } from "../body/trend.ts";
import {
  backSolve,
  damp,
  DEFAULT_WINDOW_DAYS,
  type Expenditure,
} from "./expenditure.ts";

// Everything that reads the nutrition picture out of the database and hands it
// to the pure arithmetic in expenditure.ts. Kept apart from the routes because
// three of them need the same picture and it must not drift between them.

// How far back to look for a window that still qualifies before giving up.
const MAX_STALE_WEEKS = 4;

interface IntakeWindow {
  intakeByDay: Map<string, number>;
  excludedDays: Set<string>;
}

export function nutritionReadStore(db: Database, clock: Clock = systemClock) {
  const { activeTransients } = eventStore(db, clock);
  const { latestBodyfat } = bodyfatStore(db, clock);
  const lastFinishedDay = () => {
    const today = romeDate(instant(clock().toISOString()));
    const weekday = new Date(today + "T00:00:00Z").getUTCDay() || 7;
    return addDays(today, -weekday);
  };
  async function loadIntake(from: string, to: string): Promise<IntakeWindow> {
    // One read where there were two, because daily_intake already knows both
    // halves. A day it reports with a null kcal logged nothing, and stays out of
    // intakeByDay rather than entering it as a zero the back-solve would treat
    // as a fast.
    const entries = await rows<{
      day: string;
      kcal: number | null;
      incomplete: number;
    }>(
      db,
      "SELECT day, kcal, incomplete FROM daily_intake WHERE day >= ? AND day <= ?",
      from,
      to,
    );
    const intakeByDay = new Map<string, number>();
    const excludedDays = new Set<string>();
    for (const row of entries) {
      if (row.kcal !== null) intakeByDay.set(row.day, row.kcal);
      if (row.incomplete) excludedDays.add(row.day);
    }
    return { intakeByDay, excludedDays };
  }

  function windowDays(to: string, length: number): string[] {
    const days: string[] = [];
    for (let i = length - 1; i >= 0; i--) days.push(addDays(to, -i));
    return days;
  }

  async function solveWindow(
    to: string,
    trend: readonly TrendPoint[],
    bodyfatPercent: number | null,
  ): Promise<Expenditure> {
    const days = windowDays(to, DEFAULT_WINDOW_DAYS);
    const { intakeByDay, excludedDays } = await loadIntake(
      days[0],
      days[days.length - 1],
    );
    return backSolve({
      days,
      intakeByDay,
      excludedDays,
      trend,
      bodyfatPercent,
    });
  }

  // The whole estimate, with the two things that stop it lying: damping when a
  // registered transient is being absorbed, and holding the last good estimate
  // rather than extrapolating when the current window stops qualifying.
  async function currentExpenditure(
    trend: readonly TrendPoint[],
  ): Promise<ExpenditureRead> {
    const to = await lastFinishedDay();
    const bodyfat = (await latestBodyfat())?.percent ?? null;

    let current = await solveWindow(to, trend, bodyfat);

    // Weigh-ins made after the window closed are real but invisible to the
    // back-solve until their week finishes. Say so in the blocker itself, or
    // "0 weigh-in days" lands on the very morning the scale synced and the
    // coach relays a contradiction — the pure function cannot know what
    // happened after its window, so the acknowledgment is stitched in here.
    if (current.status !== "ok") {
      const sinceClose = trend.filter(
        (p) => !p.interpolated && daysBetween(to, p.day) > 0,
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
      // Compare against the window one week back; a step no metabolism makes,
      // with a transient on record, is water.
      const previous = await solveWindow(addDays(to, -7), trend, bodyfat);
      const transients = await activeTransients(to);
      const damped = damp(
        current,
        previous.tdee_kcal,
        transients.length > 0
          ? { kind: transients[0].kind, day: transients[0].day }
          : null,
      );
      return { ...damped, as_of: to };
    }

    // The current window failed. Hold the most recent one that didn't, rather
    // than extrapolating — an estimate that keeps moving on no new data is
    // worse than one that admits it is old.
    for (let back = 1; back <= MAX_STALE_WEEKS; back++) {
      const earlier = addDays(to, -7 * back);
      const held = await solveWindow(earlier, trend, bodyfat);
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

    // No estimate, so nothing to stamp.
    return { ...current, as_of: null };
  }

  async function activeTarget(asOf: string): Promise<ActiveTarget | null> {
    const [row] = await rows<StoredTarget>(
      db,
      `SELECT ${targetColumns} FROM nutrition_targets WHERE effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1`,
      date(asOf),
    );
    return row ? decodeTarget(row) : null;
  }
  return { currentExpenditure, activeTarget, slopePctBwWeek };
}

/** Trend slope over the last n days, in kg/week — the rate to compare a target against. */
export function slopePctBwWeek(
  trend: readonly TrendPoint[],
  days: number,
): { kg_per_week: number; pct_bw_week: number } | null {
  if (trend.length < 2) return null;
  const last = trend[trend.length - 1];
  const cutoff = addDays(last.day, -days);
  const start = trend.find((p) => daysBetween(cutoff, p.day) >= 0);
  if (!start || start.day === last.day) return null;
  const span = daysBetween(start.day, last.day);
  const kgPerWeek = ((last.trend_kg - start.trend_kg) / span) * 7;
  return {
    kg_per_week: Math.round(kgPerWeek * 1000) / 1000,
    pct_bw_week: Math.round((kgPerWeek / last.trend_kg) * 10000) / 100,
  };
}

export const nutritionReader = nutritionReadStore;

export const targetColumns =
  `id, effective_from, goal, rate_pct_bw_week / 100.0 AS rate_pct_bw_week, kcal_target,
 protein_g_target, decision, clipped, clipped_reasons, tdee_at_creation, substr(created_at, 1, 23) || 'Z' AS created_at`;
export type StoredTarget =
  & Omit<
    TargetRow,
    "clipped" | "clipped_reasons"
  >
  & { clipped: number; clipped_reasons: string };
export const decodeTarget = (
  row: StoredTarget,
): TargetRow => ({
  ...row,
  clipped: Boolean(row.clipped),
  clipped_reasons: JSON.parse(row.clipped_reasons),
});
