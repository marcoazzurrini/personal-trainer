import { ApiError } from "./errors.ts";

// The closed vocabularies of the training half, and the three rules that
// connect them: which fields a set of an exercise may carry, which dose units
// that exercise can be prescribed in, and how delivered work is expressed in
// the dose's own unit.
//
// They live together because they are one idea seen from three sides. The
// database can enforce each value's membership in its list, but not the
// relationships — a CHECK on sets cannot see the exercise, and a CHECK on
// mesocycle_exercises cannot either. So the relationships are enforced here,
// where the rejection can be a sentence explaining what to send instead.

export const TRACKS = [
  "hypertrophy",
  "strength",
  "speed",
  "endurance",
] as const;

export const ROLES = ["main", "accessory", "rehab"] as const;

export const MEASURES = [
  "load_reps",
  "reps",
  "distance",
  "duration",
  "distance_duration",
] as const;

export const DOSE_UNITS = ["sets", "minutes", "km"] as const;

export type Measure = typeof MEASURES[number];
export type DoseUnit = typeof DOSE_UNITS[number];

type Field = "reps" | "distance" | "duration";

interface Rule {
  // Which measurement fields this exercise records, and whether all of them
  // are needed or any one will do.
  needs: readonly Field[];
  mode: "all" | "any";
  // Whether a load is part of the measurement or merely allowed alongside it.
  // Optional everywhere except load_reps: a sled can be pushed for metres and
  // a vest can be worn for reps, but the weight is never the measurement.
  weight: "required" | "optional";
}

const RULES: Record<Measure, Rule> = {
  load_reps: { needs: ["reps"], mode: "all", weight: "required" },
  reps: { needs: ["reps"], mode: "all", weight: "optional" },
  distance: { needs: ["distance"], mode: "all", weight: "optional" },
  duration: { needs: ["duration"], mode: "all", weight: "optional" },
  distance_duration: {
    needs: ["distance", "duration"],
    mode: "any",
    weight: "optional",
  },
};

const ALL_FIELDS: readonly Field[] = ["reps", "distance", "duration"];

export interface SetMeasures {
  weightKg: number | null;
  reps: number | null;
  distanceM: number | null;
  durationS: number | null;
}

function column(field: Field | "weight", side: "target" | "actual"): string {
  const prefix = side === "target" ? "target_" : "";
  if (field === "weight") return `${prefix}weight_kg`;
  if (field === "reps") return `${prefix}reps`;
  if (field === "distance") return `${prefix}distance_m`;
  return `${prefix}duration_s`;
}

function value(v: SetMeasures, field: Field): number | null {
  if (field === "reps") return v.reps;
  if (field === "distance") return v.distanceM;
  return v.durationS;
}

// What a correct set of this exercise looks like, for the error messages.
function shape(measure: Measure, side: "target" | "actual"): string {
  const rule = RULES[measure];
  const measures = rule.needs.map((f) => column(f, side));
  const joined = rule.mode === "all"
    ? measures.join(" and ")
    : measures.join(" or ");
  return rule.weight === "required"
    ? `${column("weight", side)} with ${joined}`
    : joined;
}

// One side of one set, checked against the exercise it belongs to. Both sides
// are checked independently and on the same rules: a planned sprint carries
// targets and no actuals, a retro-logged one carries actuals and no targets,
// and a planned set that was filled in carries both.
export function assertSetMeasures(
  measure: string,
  exercise: string,
  side: "target" | "actual",
  v: SetMeasures,
): void {
  const rule = RULES[measure as Measure];
  if (!rule) {
    throw new ApiError(
      422,
      `"${exercise}" has an unknown measure "${measure}". Measures are: ${
        MEASURES.join(", ")
      }.`,
    );
  }

  // Nothing on this side at all is not a violation — it is a planned row
  // before the work, or a retro-logged row that was never asked for.
  const empty = v.weightKg === null &&
    ALL_FIELDS.every((f) => value(v, f) === null);
  if (empty) return;

  const noun = side === "target" ? "asked for" : "recorded";

  for (const field of ALL_FIELDS) {
    if (rule.needs.includes(field) || value(v, field) === null) continue;
    throw new ApiError(
      422,
      `"${exercise}" is measured in ${measure}, so a set of it is ${noun} as ${
        shape(measure as Measure, side)
      } — not ${
        column(field, side)
      }. If that is wrong, the exercise's measure is what needs changing, not the set.`,
    );
  }

  if (rule.weight === "required" && v.weightKg === null) {
    throw new ApiError(
      422,
      `"${exercise}" is measured in ${measure}: send ${
        column("weight", side)
      } as well as ${
        column("reps", side)
      }. An unloaded set of a loaded exercise is 0, not absent — 0 is a real bodyweight set and absent means the set was not done.`,
    );
  }

  const present = rule.needs.filter((f) => value(v, f) !== null);
  const satisfied = rule.mode === "all"
    ? present.length === rule.needs.length
    : present.length > 0;
  if (!satisfied) {
    throw new ApiError(
      422,
      `"${exercise}" is measured in ${measure}, so a set of it is ${noun} as ${
        shape(measure as Measure, side)
      }. This one is missing ${
        rule.needs.filter((f) => value(v, f) === null).map((f) =>
          column(f, side)
        ).join(" and ")
      }.`,
    );
  }
}

// Effort is a report of how close a set came to failure, so it is information
// only where proximity to failure is what drives the adaptation. That is the
// strength stimulus: hypertrophy lives on it, and the method document turns it
// straight into the next session's load. Power and conditioning work is scored
// by output instead — a sprint by the clock, a jump by how far it went — and is
// neither taken to failure nor read against it.
//
// Required rather than optional on the sets it does apply to, because a missing
// chip and an honest one are indistinguishable afterwards, and every load
// decision downstream reads it.
export function assertEffort(
  stimulusType: string,
  exercise: string,
  kind: string,
  reps: number | null,
  effort: string | null,
): void {
  if (kind !== "working" || reps === null || effort !== null) return;
  if (stimulusType !== "strength") return;
  throw new ApiError(
    422,
    `effort is required on a working set of "${exercise}": send easy, hard, or failure. It is what the next session's load is chosen from, and a missing chip cannot be told from an honest one later. Work scored by the clock or the tape carries none.`,
  );
}

// Which units an exercise can be dosed in. Sets always work — six sprints is
// as legitimate a weekly dose as 300 metres of them — but a distance dose on
// an exercise that records no distance could never be compared against
// anything, and would read as permanently unmet.
export function assertDoseUnit(
  measure: string,
  unit: string,
  exercise: string,
): void {
  const allowed = doseUnitsFor(measure);
  if (allowed.includes(unit as DoseUnit)) return;
  throw new ApiError(
    422,
    `"${exercise}" is measured in ${measure}, so its weekly dose cannot be in ${unit} — nothing delivered would ever count towards it, and the dose would read as permanently unmet. Allowed here: ${
      allowed.join(", ")
    }.`,
  );
}

export function doseUnitsFor(measure: string): DoseUnit[] {
  const rule = RULES[measure as Measure];
  const units: DoseUnit[] = ["sets"];
  if (rule?.needs.includes("duration")) units.push("minutes");
  if (rule?.needs.includes("distance")) units.push("km");
  return units;
}

// Delivered work expressed in the dose's own unit, so that dose and delivered
// are always two numbers on one scale rather than two readings the caller has
// to reconcile. Computed at read time and never stored: metres and seconds
// are what the sets hold.
export function deliveredInDoseUnit(
  unit: string,
  setsDone: number | null,
  distanceM: number | null,
  durationS: number | null,
): number {
  if (unit === "km") return (distanceM ?? 0) / 1000;
  if (unit === "minutes") return (durationS ?? 0) / 60;
  return setsDone ?? 0;
}
