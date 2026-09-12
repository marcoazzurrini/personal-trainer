// The meaning of a partial correction, shared by single-set and session writes.
// The caller supplies the current row under the session lock and one timestamp.
// No database access or clock read belongs in this rule.
import { ApiError } from "../shared/errors.ts";
import {
  assertEffort,
  assertSetMeasures,
  type Effort,
  type Kind,
} from "./rules.ts";

export const TARGET_FIELDS = [
  "target_weight_kg",
  "target_reps",
  "target_distance_m",
  "target_duration_s",
] as const;

export const ACTUAL_FIELDS = [
  "weight_kg",
  "reps",
  "distance_m",
  "duration_s",
  "effort",
  "performed_at",
  "notes",
] as const;

export interface SetActuals {
  weight_kg: number | null;
  reps: number | null;
  distance_m: number | null;
  duration_s: number | null;
  effort: Effort | null;
  performed_at: Date | string | null;
  notes: string | null;
}

export interface SetForCorrection extends SetActuals {
  id: number;
  kind: Kind;
  exercise: string;
  measure: string;
  stimulus_type: string;
}

export interface CorrectSetInput {
  weight_kg?: number | null;
  reps?: number | null;
  distance_m?: number | null;
  duration_s?: number | null;
  effort?: Effort | null;
  performed_at?: string | null;
  notes?: string | null;
  target_weight_kg?: unknown;
  target_reps?: unknown;
  target_distance_m?: unknown;
  target_duration_s?: unknown;
}

type SetChanges = Pick<CorrectSetInput, (typeof ACTUAL_FIELDS)[number]>;

export function prepareSetCorrection(
  existing: SetForCorrection,
  input: CorrectSetInput,
  performedAt: string,
): SetChanges {
  const target = TARGET_FIELDS.find((f) => input[f] !== undefined);
  if (target) {
    throw new ApiError(
      422,
      `Targets are immutable once the session exists: they are the record of what was asked that day, and "${target}" is one of them. Only actuals (weight_kg, reps, distance_m, duration_s, effort), performed_at, and notes can change. If the whole session was mis-planned and nothing has been performed yet, DELETE /sessions/:id discards the draft — then write it again.`,
    );
  }
  // Omission leaves a value untouched; explicit null clears it. Only these
  // fields are writable, even when the caller passes a row with other keys.
  const fields: SetChanges = Object.fromEntries(
    ACTUAL_FIELDS.filter((f) => input[f] !== undefined).map((
      f,
    ) => [f, input[f]]),
  );
  if (Object.keys(fields).length === 0) {
    throw new ApiError(
      422,
      'Send at least one of "weight_kg", "reps", "distance_m", "duration_s", "effort", "performed_at", "notes".',
    );
  }
  const merged = { ...existing, ...fields };
  assertSetMeasures(existing.measure, existing.exercise, "actual", {
    weightKg: merged.weight_kg,
    reps: merged.reps,
    distanceM: merged.distance_m,
    durationS: merged.duration_s,
  });
  assertEffort(
    existing.stimulus_type,
    existing.exercise,
    existing.kind,
    merged.reps,
    merged.effort,
  );

  const nowMeasured = fields.reps != null || fields.distance_m != null ||
    fields.duration_s != null;
  if (
    fields.performed_at === undefined && existing.performed_at === null &&
    nowMeasured
  ) {
    fields.performed_at = performedAt;
  }
  return fields;
}
