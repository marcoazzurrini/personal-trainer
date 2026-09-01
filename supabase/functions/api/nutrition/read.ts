import { sql } from "../db.ts";
import { lastFinishedDay } from "../shared/calendar.ts";
import { addDays, daysBetween } from "../shared/dates.ts";
import { activeTransients } from "./events.ts";
import { latestBodyfat } from "../body/bodyfat.ts";
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

async function loadIntake(from: string, to: string): Promise<IntakeWindow> {
  // One read where there were two, because daily_intake already knows both
  // halves. A day it reports with a null kcal logged nothing, and stays out of
  // intakeByDay rather than entering it as a zero the back-solve would treat
  // as a fast.
  const rows = await sql<
    { day: string; kcal: number | null; incomplete: boolean }[]
  >`
    select day, kcal, incomplete from daily_intake
    where day >= ${from} and day <= ${to}`;
  const intakeByDay = new Map<string, number>();
  const excludedDays = new Set<string>();
  for (const row of rows) {
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
  return backSolve({ days, intakeByDay, excludedDays, trend, bodyfatPercent });
}

export interface ExpenditureRead extends Expenditure {
  /**
   * Which window the returned estimate belongs to — today's for `ok` and
   * `damped`, an older one for `stale`. Null under `insufficient_data`,
   * because there is no estimate for it to date-stamp and a date sitting
   * beside a null tdee reads as "current as of", implying a number exists.
   */
  as_of: string | null;
}

// The whole estimate, with the two things that stop it lying: damping when a
// registered transient is being absorbed, and holding the last good estimate
// rather than extrapolating when the current window stops qualifying.
export async function currentExpenditure(
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
    const sinceClose = trend.filter((p) =>
      !p.interpolated && daysBetween(to, p.day) > 0
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

export interface ActiveTarget {
  id: number;
  effective_from: string;
  goal: string;
  rate_pct_bw_week: number;
  kcal_target: number;
  protein_g_target: number;
  decision: string;
  clipped: boolean;
  clipped_reasons: string[];
  tdee_at_creation: number | null;
  created_at: string;
}

export async function activeTarget(
  asOf: string,
): Promise<ActiveTarget | null> {
  const [row] = await sql<ActiveTarget[]>`
    select id, effective_from, goal, rate_pct_bw_week::float8, kcal_target,
      protein_g_target, decision, clipped, clipped_reasons, tdee_at_creation,
      created_at
    from nutrition_targets
    where effective_from <= ${asOf}
    order by effective_from desc, id desc
    limit 1`;
  return row ?? null;
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
  const kgPerWeek = (last.trend_kg - start.trend_kg) / span * 7;
  return {
    kg_per_week: Math.round(kgPerWeek * 1000) / 1000,
    pct_bw_week: Math.round(kgPerWeek / last.trend_kg * 10000) / 100,
  };
}
