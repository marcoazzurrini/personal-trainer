// Trend weight and the expenditure back-solve.
//
// The identity: over a window, TDEE ~= mean(intake) - dE_stored/dt, with the
// stored-energy term inferred from the bodyweight trend. Validated against
// doubly-labeled water in CALERIE (Sanghvi et al., Am J Clin Nutr 2015,
// n=140, 2 years): group mean within ~40 kcal/day, individual RMS deviation
// ~215 kcal/day, three-quarters of estimates within 250 kcal/day.
//
// Two consequences run through everything below. The estimate is a range, not
// a number — so it is reported with a band and the coach is told never to
// chase a difference inside it. And it self-corrects for a *stable* logging
// bias: if Marco under-logs by a steady fraction, the expenditure estimate and
// the target come out in the same under-logged units and the loop still steers
// weight at the intended rate. What breaks it is a *change* in logging habit,
// which is why that is a registrable event.
//
// Pure functions on purpose: no database, no clock. All of this is testable
// without a stack, and it is the only arithmetic in the system where being
// quietly wrong would be invisible for weeks.

import { addDays, daysBetween } from "./dates.ts";

export const DEFAULT_ALPHA = 0.10; // ~19-day-equivalent window
export const MIN_WINDOW_DAYS = 14;
export const DEFAULT_WINDOW_DAYS = 21;
export const MIN_WEIGH_INS_PER_WEEK = 3;

// Forbes. Fat-free mass is mostly water and costs far less per kg than fat;
// the split between them depends on how lean the person already is.
const RHO_FM = 9440; // kcal/kg, fat mass
const RHO_FFM = 1020; // kcal/kg, fat-free mass
const FORBES_C = 10.4; // kg

// A flat 7,700 kcal/kg is the composition-weighted density of a *specific*
// body composition, not a constant. At Marco's leanness p is larger, each kg
// of change is cheaper in kcal, and using 7,700 would bias the expenditure
// estimate upward throughout a cut — the estimate would drift high exactly
// when the target most needs to be right. Fine as a conversational
// explanation, never as the arithmetic.
export function energyDensity(fatMassKg: number): number {
  const p = FORBES_C / (FORBES_C + fatMassKg); // dFFM/dBW
  return p * RHO_FFM + (1 - p) * RHO_FM;
}

export function fatMassKg(weightKg: number, bodyfatPercent: number): number {
  return weightKg * bodyfatPercent / 100;
}

// The basis for a protein target in a deficit: muscle retention is the point,
// and it scales with the mass being retained, not with the fat being lost.
export function fatFreeMassKg(
  weightKg: number,
  bodyfatPercent: number,
): number {
  return weightKg * (1 - bodyfatPercent / 100);
}

// --- Trend weight ----------------------------------------------------------

export interface DailyWeight {
  day: string; // YYYY-MM-DD
  value_kg: number;
}

export interface TrendPoint {
  day: string;
  weight_kg: number; // real or interpolated
  interpolated: boolean;
  trend_kg: number;
}

// Re-exported: daysBetween has always been part of this module's public
// face, and its callers should not care that the arithmetic moved to
// lib/dates.ts when the week functions joined it.
export { daysBetween } from "./dates.ts";

// Exponentially weighted moving average over the daily series, initialized at
// the first weigh-in's raw value.
//
// A single missing day is filled by interpolating its neighbours — the gap is
// shorter than the noise it sits in, and MacroFactor documents the same
// choice. Longer gaps are NOT filled: the EMA simply does not advance across
// them. Carrying a value forward through a week of silence would invent a
// flat stretch that never happened and drag the slope toward zero, which
// reads as a stalled diet.
export function trendSeries(
  weights: readonly DailyWeight[],
  alpha: number = DEFAULT_ALPHA,
): TrendPoint[] {
  if (weights.length === 0) return [];
  // Sorted here, not assumed: the SQL that feeds this orders by day, but an
  // unsorted array used to be answered with a silently truncated series —
  // wrong in exactly the invisible-for-weeks way this module exists to avoid.
  const ordered = [...weights].sort((a, b) => a.day < b.day ? -1 : 1);
  const byDay = new Map(ordered.map((w) => [w.day, Number(w.value_kg)]));
  const first = ordered[0].day;
  const last = ordered[ordered.length - 1].day;

  const points: TrendPoint[] = [];
  let trend = Number(ordered[0].value_kg);

  for (let day = first; daysBetween(day, last) >= 0; day = addDays(day, 1)) {
    let weight = byDay.get(day);
    let interpolated = false;

    if (weight === undefined) {
      const before = byDay.get(addDays(day, -1));
      const after = byDay.get(addDays(day, 1));
      if (before === undefined || after === undefined) continue; // gap > 1 day
      weight = (before + after) / 2;
      interpolated = true;
    }

    trend = day === first ? weight : alpha * weight + (1 - alpha) * trend;
    points.push({
      day,
      weight_kg: round(weight, 2),
      interpolated,
      trend_kg: round(trend, 2),
    });
  }
  return points;
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

// --- The back-solve --------------------------------------------------------

export type ExpenditureStatus =
  | "ok"
  | "damped"
  | "stale"
  | "insufficient_data";

export interface WindowInput {
  /** Whole-week-aligned window, oldest day first. */
  days: string[];
  /** Logged kcal per day, for days that have any. Flagged days are absent. */
  intakeByDay: Map<string, number>;
  /** Days excluded by an `incomplete` flag. */
  excludedDays: Set<string>;
  trend: readonly TrendPoint[];
  bodyfatPercent: number | null;
}

export interface Expenditure {
  status: ExpenditureStatus;
  reason: string;
  // Every unmet condition, not just the first one hit. Three separate things
  // can block an estimate, and reporting them one at a time means the coach
  // fixes logging for a fortnight and is then ambushed by the body-fat
  // requirement it could have asked for on day one.
  blockers: string[];
  tdee_kcal: number | null;
  band_kcal: number | null;
  // Populated under insufficient_data too. The blockers describe this window,
  // and stripping its dates exactly when the reader needs to reconcile "0
  // weigh-in days" with this morning's weigh-in is how a working sync gets
  // reported as broken. Null only when there was no window to speak of.
  window: {
    from: string;
    to: string;
    days: number;
    usable_days: number;
    weigh_in_days: number;
  } | null;
  inputs: {
    mean_intake_kcal: number;
    trend_from_kg: number;
    trend_to_kg: number;
    slope_kg_per_day: number;
    energy_density_kcal_per_kg: number;
    fat_mass_kg: number;
  } | null;
}

function insufficient(
  blockers: string[],
  window: Expenditure["window"],
): Expenditure {
  return {
    status: "insufficient_data",
    reason: blockers.join(" "),
    blockers,
    tdee_kcal: null,
    band_kcal: null,
    window,
    inputs: null,
  };
}

// The band widens as coverage thins, but it never gets narrow. The validation
// data puts individual RMS deviation at ~215 kcal/day and three-quarters of
// estimates within 250, which does not support claiming ±150 even on a
// flawless window — no amount of adherence makes this estimate precise, and a
// band that understates its own error is worse than no band, because the coach
// would start chasing differences that are noise.
const BAND_MAX = 250;
const BAND_FLOOR = 200;

function bandFor(coverage: number): number {
  const clamped = Math.max(0, Math.min(1, coverage));
  return Math.round(BAND_MAX - (BAND_MAX - BAND_FLOOR) * clamped);
}

export function backSolve(input: WindowInput): Expenditure {
  const { days, intakeByDay, excludedDays, trend, bodyfatPercent } = input;

  // The one case where window is null — there was no window to speak of.
  // Without this guard the blockers below interpolate undefined for the
  // window's dates.
  if (days.length === 0) {
    return insufficient(
      ["There is no finished day to estimate over yet."],
      null,
    );
  }

  const from = days[0];
  const to = days[days.length - 1];
  const inWindow = trend.filter((p) =>
    daysBetween(from, p.day) >= 0 && daysBetween(p.day, to) >= 0
  );
  const weighInDays = inWindow.filter((p) => !p.interpolated).length;
  const usable = days.filter((d) => !excludedDays.has(d) && intakeByDay.has(d));
  const weeks = Math.max(1, Math.round(days.length / 7));
  const windowInfo = {
    from,
    to,
    days: days.length,
    usable_days: usable.length,
    weigh_in_days: weighInDays,
  };

  // Collected, not short-circuited: the caller gets the whole list of what is
  // missing so it can say "two more weeks of logging and a body-fat number"
  // instead of discovering the second requirement after satisfying the first.
  const blockers: string[] = [];

  if (days.length < MIN_WINDOW_DAYS) {
    blockers.push(
      `The window is only ${days.length} days and the estimate needs at least ${MIN_WINDOW_DAYS}.`,
    );
  }
  if (usable.length < MIN_WINDOW_DAYS) {
    blockers.push(
      `Only ${usable.length} of the ${days.length} days in the window have logged intake, and the estimate needs ${MIN_WINDOW_DAYS} (days flagged incomplete are excluded on purpose, not counted as zero).`,
    );
  }
  if (weighInDays < MIN_WEIGH_INS_PER_WEEK * weeks) {
    // Days, dates, and unit all spelled out. This once said "0 weigh-ins
    // across 3 weeks" while the adherence block beside it counted a rolling
    // week that included today — three true numbers with unlabeled windows
    // read as a contradiction, and the coach relayed the contradiction.
    blockers.push(
      `${weighInDays} weigh-in day${
        weighInDays === 1 ? "" : "s"
      } in the estimate's window (${from} – ${to}); the trend needs at least ${MIN_WEIGH_INS_PER_WEEK} a week to carry a slope worth back-solving. Daily weighing is the one habit that keeps this working through a logging lapse.`,
    );
  }
  if (bodyfatPercent === null) {
    blockers.push(
      "No body-fat estimate on record. The energy density of a weight change depends on body composition — without it the back-solve would have to assume a flat 7,700 kcal/kg, which is biased for a lean trainee. POST /bodyfat with a rough figure (BIA, DXA, or an honest visual guess); precision is not critical, presence is.",
    );
  }
  // The bodyfatPercent half is redundant with the blocker pushed just above;
  // it is spelled out so the compiler can narrow the type for the arithmetic
  // further down, which is cheaper than asserting non-null at the use site.
  if (blockers.length > 0 || bodyfatPercent === null) {
    return insufficient(blockers, windowInfo);
  }

  if (inWindow.length < 2) {
    return insufficient([
      "Not enough trend points in the window to measure a slope.",
    ], windowInfo);
  }

  const trendFrom = inWindow[0];
  const trendTo = inWindow[inWindow.length - 1];
  const span = daysBetween(trendFrom.day, trendTo.day);
  if (span <= 0) {
    return insufficient(["The trend does not span the window."], windowInfo);
  }

  const meanIntake = usable.reduce((sum, d) => sum + intakeByDay.get(d)!, 0) /
    usable.length;
  const slope = (trendTo.trend_kg - trendFrom.trend_kg) / span; // kg/day
  const fm = fatMassKg(trendTo.trend_kg, bodyfatPercent);
  const density = energyDensity(fm);

  // Losing weight means the body spent stored energy the food did not cover,
  // so expenditure is above intake. slope is negative there and the sign
  // works out on its own.
  const tdee = meanIntake - slope * density;

  const coverage = Math.min(
    usable.length / days.length,
    weighInDays / days.length,
  );

  return {
    status: "ok",
    reason:
      `Back-solved over ${usable.length} logged days and ${weighInDays} weigh-ins in a ${days.length}-day window.`,
    blockers: [],
    tdee_kcal: Math.round(tdee),
    band_kcal: bandFor(coverage),
    window: windowInfo,
    inputs: {
      mean_intake_kcal: Math.round(meanIntake),
      trend_from_kg: trendFrom.trend_kg,
      trend_to_kg: trendTo.trend_kg,
      slope_kg_per_day: round(slope, 4),
      energy_density_kcal_per_kg: Math.round(density),
      fat_mass_kg: round(fm, 1),
    },
  };
}

// A week-over-week jump this large is a physiological impossibility; when a
// transient is on record it is water, not metabolism. Cap the step rather
// than propagate it, and say so.
export const DAMP_THRESHOLD_KCAL = 300;
export const DAMP_MAX_STEP_KCAL = 100;

export function damp(
  current: Expenditure,
  previousTdee: number | null,
  transient: { kind: string; day: string } | null,
): Expenditure {
  if (
    current.status !== "ok" || current.tdee_kcal === null ||
    previousTdee === null || transient === null
  ) {
    return current;
  }
  const step = current.tdee_kcal - previousTdee;
  if (Math.abs(step) <= DAMP_THRESHOLD_KCAL) return current;

  const capped = previousTdee +
    Math.sign(step) * DAMP_MAX_STEP_KCAL;
  return {
    ...current,
    status: "damped",
    tdee_kcal: capped,
    band_kcal: Math.max(current.band_kcal ?? 250, 250),
    reason: `The raw back-solve moved ${
      Math.round(step)
    } kcal/day week over week, which no metabolism does. A ${transient.kind} is registered on ${transient.day}, so this is water and glycogen being absorbed — the update is capped at ${DAMP_MAX_STEP_KCAL} kcal/day until it settles. Expect one to two weeks.`,
  };
}

// --- Targets ---------------------------------------------------------------

// Trained lifters lose lean mass past roughly 0.7%/week or a 500 kcal/day
// deficit, and deficits past ~500 block lean-mass gain outright (Murphy 2021;
// Garthe 2011). Both guards exist because they are not the same guard: they
// happen to coincide near Marco's current bodyweight, but a percentage and an
// absolute number diverge as weight changes, and each catches a fat-fingered
// rate the other would let through. Neither is a judgment call, so both are
// code rather than doctrine.
export const MAX_DEFICIT_KCAL = 500;
export const MAX_LOSS_RATE_PCT_BW_WEEK = 0.7;

// The gain side mirrors the cut's pair. Past +0.5%/week or ~350 kcal/day of
// surplus the extra is mostly fat in a trained lifter — the method doc has
// always said so, but for a long while only the cut had guards, so a +3%/week
// "bulk" was accepted, stored unclipped, and steered at in earnest. A ceiling
// that lives only in prose is not a ceiling.
export const MAX_SURPLUS_KCAL = 350;
export const MAX_GAIN_RATE_PCT_BW_WEEK = 0.5;

// Recomp's doctrine is written in kcal, not in %BW/week: maintenance to a
// 200 kcal/day deficit. It cannot be expressed as a rate band — the rate a
// given deficit implies moves with bodyweight, which is how the old ±0.15
// band quietly capped recomp at about half the doctrine's floor and pushed
// doctrine-compliant requests into relabelling themselves as cuts.
export const MAX_RECOMP_DEFICIT_KCAL = 200;

export const GOALS = ["cut", "maintain", "gain", "recomp"] as const;
export type Goal = (typeof GOALS)[number];

export type ClipReason =
  | "rate"
  | "deficit"
  | "recomp_deficit"
  | "surplus"
  | null;

export interface TargetComputation {
  kcal_target: number;
  clipped: boolean;
  clipped_reason: ClipReason;
  rate_requested: number;
  rate_used: number;
  desired_slope_kg_per_day: number;
  implied_deficit_kcal: number;
}

export function targetFromRate(
  tdee: number,
  ratePctBwWeek: number,
  trendWeightKg: number,
  energyDensityKcalPerKg: number,
  goal: Goal,
): TargetComputation {
  // The rate ceilings bind first: they are statements about what the body
  // will tolerate, so they should shape the target rather than be discovered
  // after the calories are already computed. Both directions have one — the
  // loss ceiling was code from the start, the gain ceiling was prose until it
  // let a +3%/week bulk through untouched.
  let reason: ClipReason = null;
  let rate = ratePctBwWeek;
  if (rate < -MAX_LOSS_RATE_PCT_BW_WEEK) {
    rate = -MAX_LOSS_RATE_PCT_BW_WEEK;
    reason = "rate";
  }
  if (rate > MAX_GAIN_RATE_PCT_BW_WEEK) {
    rate = MAX_GAIN_RATE_PCT_BW_WEEK;
    reason = "rate";
  }

  const desiredSlope = rate / 100 * trendWeightKg / 7; // kg/day
  let kcal = tdee + desiredSlope * energyDensityKcalPerKg;

  if (tdee - kcal > MAX_DEFICIT_KCAL) {
    kcal = tdee - MAX_DEFICIT_KCAL;
    reason = "deficit";
  }
  // Tighter than the cut's 500 and checked after it, so on a recomp the
  // stricter bound wins and the reason names the doctrine that bound it.
  // This is the clip that makes "maintenance to −200 kcal/day" true at any
  // bodyweight, instead of a rate band pretending to be a kcal rule.
  if (goal === "recomp" && tdee - kcal > MAX_RECOMP_DEFICIT_KCAL) {
    kcal = tdee - MAX_RECOMP_DEFICIT_KCAL;
    reason = "recomp_deficit";
  }
  if (kcal - tdee > MAX_SURPLUS_KCAL) {
    kcal = tdee + MAX_SURPLUS_KCAL;
    reason = "surplus";
  }

  return {
    kcal_target: Math.round(kcal),
    clipped: reason !== null,
    clipped_reason: reason,
    rate_requested: ratePctBwWeek,
    rate_used: rate,
    desired_slope_kg_per_day: round(desiredSlope, 4),
    implied_deficit_kcal: Math.round(tdee - kcal),
  };
}

// Protein, computed rather than handed in. The multiplier is the coach's
// judgment; turning it into grams is arithmetic, and arithmetic is the
// server's. The judgment bands are constants so the error messages and the
// docs cite one source instead of four hand-copied literals.
export const PROTEIN_G_PER_KG_FFM_RANGE = [2.3, 3.1] as const; // in a deficit
export const PROTEIN_G_PER_KG_BW_RANGE = [1.6, 2.2] as const; // otherwise

export type ProteinBasis = "ffm" | "bodyweight";

export interface ProteinComputation {
  protein_g_target: number;
  basis: ProteinBasis;
  multiplier_g_per_kg: number;
  basis_mass_kg: number;
}

export function proteinFromMultiplier(
  basis: ProteinBasis,
  multiplier: number,
  trendWeightKg: number,
  bodyfatPercent: number | null,
): ProteinComputation {
  const mass = basis === "ffm"
    ? fatFreeMassKg(trendWeightKg, bodyfatPercent!)
    : trendWeightKg;
  return {
    protein_g_target: Math.round(multiplier * mass),
    basis,
    multiplier_g_per_kg: multiplier,
    basis_mass_kg: round(mass, 1),
  };
}
