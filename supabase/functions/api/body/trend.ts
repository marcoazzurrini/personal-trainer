// Trend weight: the exponentially weighted line through a scatter of weigh-ins.
//
// It sits in body/ rather than with the expenditure arithmetic that reads it,
// because it is a fact about the body and not about nutrition. Two callers
// want it for different reasons — the bodyweight chart draws it, and the
// back-solve differentiates it to infer stored energy — and neither owns it.
//
// Pure on purpose: no database, no clock. That is not decoration here, it is
// load-bearing. rules/expenditure.ts imports TrendPoint from this file, and
// rules_purity_test.ts walks imports transitively, so a database reached from
// anywhere below this line would make the back-solve untestable without a
// stack. It is why the read that feeds this — loadTrend, over the
// daily_bodyweight view — stays in bodyweight.ts with the table it reads.

import { addDays, daysBetween } from "../rules/dates.ts";

export const DEFAULT_ALPHA = 0.10; // ~19-day-equivalent window

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
