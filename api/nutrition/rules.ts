import { ApiError } from "../shared/errors.ts";

// The arithmetic the coach is not allowed to do in its head. Two jobs:
// scaling a food's per-100g values to an amount eaten, and refusing numbers
// that cannot be true.

// Columns are numeric(_, 1); rounding here rather than letting Postgres do it
// means the value written and the value read back are the same number.
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export interface FoodMacros {
  kcal_100g: number;
  protein_100g: number;
  carbs_100g: number;
  fat_100g: number;
  fiber_100g: number | null;
}

export interface ScaledMacros {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number | null;
}

// What gets snapshotted onto an intake row. Fiber stays null when the source
// food has none: unknown is not zero, and averaging zeros into a fiber total
// would quietly understate it.
export function scaleFood(food: FoodMacros, grams: number): ScaledMacros {
  const factor = grams / 100;
  return {
    kcal: round1(food.kcal_100g * factor),
    protein_g: round1(food.protein_100g * factor),
    carbs_g: round1(food.carbs_100g * factor),
    fat_g: round1(food.fat_100g * factor),
    fiber_g: food.fiber_100g === null ? null : round1(food.fiber_100g * factor),
  };
}

// Postgres rows arrive untyped. This is the one place that assumption is
// written down, so a renamed column breaks here rather than silently scaling
// undefined into NaN.
// deno-lint-ignore no-explicit-any
export function foodMacros(row: any): FoodMacros {
  return {
    kcal_100g: row.kcal_100g,
    protein_100g: row.protein_100g,
    carbs_100g: row.carbs_100g,
    fat_100g: row.fat_100g,
    fiber_100g: row.fiber_100g,
  };
}

// The fields sumMacros reads off an intake row. Callers pass rows straight
// from Postgres, which types them as Record<string, any> and so satisfies no
// interface structurally — hence Partial below rather than a cast at every
// call site.
export interface Logged {
  kcal: number;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
}

const MACROS = ["protein_g", "carbs_g", "fat_g", "fiber_g"] as const;
type Macro = typeof MACROS[number];

export interface MacroTotals {
  kcal: number;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  // What the totals above do not cover, per macro. A macro summed over rows
  // that don't all carry it is not a total — it is a floor. Protein is the
  // one macro with a hard target, so a coach reading 110 g needs to know
  // whether 1200 kcal of the day were silent about it before concluding
  // Marco fell short.
  //
  // Per macro rather than per entry, because the gaps have different
  // meanings: an ad-hoc estimate is silent about everything, while an
  // ordinary food is routinely silent about fibre alone. Rolling those
  // together would flag a perfectly logged day. Only macros with a gap
  // appear, so an empty object means the totals are complete.
  unaccounted: Partial<Record<Macro, { entries: number; kcal: number }>>;
}

export function sumMacros(rows: readonly Partial<Logged>[]): MacroTotals {
  const totals = { protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
  const seen = { protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
  const gaps: Record<Macro, { entries: number; kcal: number }> = {
    protein_g: { entries: 0, kcal: 0 },
    carbs_g: { entries: 0, kcal: 0 },
    fat_g: { entries: 0, kcal: 0 },
    fiber_g: { entries: 0, kcal: 0 },
  };
  let kcal = 0;

  for (const row of rows) {
    const rowKcal = Number(row.kcal ?? 0);
    kcal += rowKcal;
    for (const macro of MACROS) {
      const value = row[macro];
      if (value === null || value === undefined) {
        gaps[macro].entries += 1;
        gaps[macro].kcal += rowKcal;
        continue;
      }
      totals[macro] += Number(value);
      seen[macro] += 1;
    }
  }

  // A macro no entry carried reports null, not 0: an absent number is a
  // better answer than a confident wrong one.
  const total = (macro: Macro) =>
    seen[macro] > 0 ? Math.round(totals[macro] * 10) / 10 : null;

  const unaccounted: MacroTotals["unaccounted"] = {};
  for (const macro of MACROS) {
    if (gaps[macro].entries > 0) {
      unaccounted[macro] = {
        entries: gaps[macro].entries,
        kcal: Math.round(gaps[macro].kcal * 10) / 10,
      };
    }
  }

  return {
    kcal: Math.round(kcal * 10) / 10,
    protein_g: total("protein_g"),
    carbs_g: total("carbs_g"),
    fat_g: total("fat_g"),
    fiber_g: total("fiber_g"),
    unaccounted,
  };
}

// Atwater: protein and carbohydrate 4 kcal/g, fat 9. A food whose stated
// energy disagrees with its own macros is mis-transcribed or mis-scaled
// (per-serving values entered as per-100g is the classic one), and a wrong
// food poisons every day it is ever logged on.
const TOLERANCE = 0.15;
// Floor, so near-zero foods (black coffee, diet drinks) don't fail on a
// percentage of almost nothing.
const FLOOR_KCAL = 20;

// Both directions are checked, and both are overridable, because EU labelling
// makes both directions legitimately possible:
//
//   - Stated energy ABOVE the macros: alcohol is 7 kcal/g and appears in no
//     macro at all.
//   - Stated energy BELOW the macros: polyols (sugar alcohols) are counted
//     inside the carbohydrate figure but contribute only ~2.4 kcal/g to the
//     energy line. A sugar-free bar with 90 g of maltitol computes to ~360
//     kcal against a stated ~240 — a 50% overshoot on a perfectly correct
//     label. Treating that direction as arithmetically impossible would make
//     every sugar-free product in an Italian supermarket unloggable.
//
// The strict default stays: almost every rejection really is a mis-transcribed
// label, and the override always costs a written reason.
export function checkEnergy(
  kcal: number,
  proteinG: number,
  carbsG: number,
  fatG: number,
  override: boolean,
  sourceNote: string | null,
): void {
  const implied = 4 * proteinG + 4 * carbsG + 9 * fatG;
  const allowed = Math.max(implied * TOLERANCE, FLOOR_KCAL);
  const off = kcal - implied;
  if (Math.abs(off) <= allowed) return;

  const cause = off < 0
    ? "sugar alcohols, which sit inside the carbohydrate figure but only carry ~2.4 kcal/g"
    : "alcohol at 7 kcal/g, or fibre counted in the energy line";

  if (!override) {
    throw new ApiError(
      422,
      `Stated energy (${kcal} kcal per 100 g) and the macros disagree by more than 15%: ${proteinG} g protein, ${carbsG} g carbs and ${fatG} g fat account for ${
        Math.round(implied)
      } kcal. Usually this means a mis-transcribed or mis-scaled label — the classic case is per-serving macros against per-100 g energy, so recheck it first. If the label really does say this because the food carries energy the macros don't name (${cause}), resend with "energy_check": "override" and a "source_note" saying which.`,
    );
  }

  if (sourceNote === null) {
    throw new ApiError(
      422,
      '"energy_check": "override" requires a "source_note" naming the cause (alcohol, sugar alcohols, fibre accounting). An override without a reason is indistinguishable from a typo.',
    );
  }
}

// The other half of the sanity check, and the half the energy identity cannot
// see. checkEnergy only asks whether the macros agree with the stated energy —
// scale all four together and they agree perfectly while describing something
// impossible. 90 g protein + 50 g carbs + 30 g fat implies 830 kcal, so a food
// stating 830 passes the energy check at 170 g of macros per 100 g of food.
//
// Fibre is deliberately excluded from the sum. USDA counts it inside the
// carbohydrate figure and EU declares it separately, and `source` spans both
// (usda alongside crea and off), so adding it would double-count American
// foods and reject high-fibre ones that are perfectly correct.
//
// The ceiling has rounding headroom rather than sitting at exactly 100: pure
// fat is a real 100 g/100 g, and label rounding can nudge a legitimate food a
// gram or two past it. Nothing real reaches 105, so there is no override —
// unlike the energy check, no labelling convention makes this direction
// legitimate.
const MAX_MACRO_MASS_PER_100G = 105;

export function checkMacroMass(
  proteinG: number,
  carbsG: number,
  fatG: number,
): void {
  const mass = proteinG + carbsG + fatG;
  if (mass <= MAX_MACRO_MASS_PER_100G) return;
  throw new ApiError(
    422,
    `${proteinG} g protein, ${carbsG} g carbs and ${fatG} g fat come to ${
      Math.round(mass * 10) / 10
    } g of macros in 100 g of food, which cannot be true — 100 g of anything holds at most 100 g. The usual cause is per-serving macros entered as per-100 g. Rescale them: divide by the serving size in grams and multiply by 100.`,
  );
}

// Grams eaten, from either an explicit weight or a count of pieces. Foods
// bought and eaten in units ("1 egg", "2 slices") carry grams_per_unit so the
// coach never has to guess a weight it was not told.
export function gramsEaten(
  grams: number | null,
  units: number | null,
  gramsPerUnit: number | null,
  foodName: string,
): number {
  if (grams !== null && units !== null) {
    throw new ApiError(
      422,
      'Send either "grams" or "units", not both — they are two ways of saying the same thing.',
    );
  }
  if (grams !== null) return grams;
  if (units !== null) {
    if (gramsPerUnit === null) {
      throw new ApiError(
        422,
        `"${foodName}" has no grams_per_unit, so "units" cannot be converted to a weight. Send "grams" instead, or set grams_per_unit on the food if it is genuinely eaten in pieces.`,
      );
    }
    return round1(units * gramsPerUnit);
  }
  throw new ApiError(
    422,
    'Logging a food needs an amount: send "grams", or "units" for a food with grams_per_unit set.',
  );
}
