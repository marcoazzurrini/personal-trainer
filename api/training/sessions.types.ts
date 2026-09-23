import type { CorrectSetInput } from "./set_correction.ts";
import type { Effort, Kind } from "./rules.ts";

export interface SessionHeaderRow {
  id: number;
  date: string;
  rationale: string | null;
  notes: string | null;
  overall_feel: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface SessionSetRow {
  id: number;
  exercise: string;
  exercise_id: number;
  measure: string;
  mesocycle_id: number | null;
  position: number;
  kind: Kind;
  target_weight_kg: number | null;
  target_reps: number | null;
  target_distance_m: number | null;
  target_duration_s: number | null;
  weight_kg: number | null;
  reps: number | null;
  distance_m: number | null;
  duration_s: number | null;
  effort: Effort | null;
  performed_at: string | null;
  notes: string | null;
}

export interface SessionDetailRow extends SessionHeaderRow {
  sets: SessionSetRow[];
}

/** The row POST /sessions/{id}/sets answers with: no targets to show. */
export type AppendedSetRow =
  & Omit<
    SessionSetRow,
    | "exercise"
    | "measure"
    | "target_weight_kg"
    | "target_reps"
    | "target_distance_m"
    | "target_duration_s"
  >
  & { session_id: number };

/** An exercise or mesocycle by id, name, or alias — the resolver decides. */
type Reference = string | number;

export interface SetEntry {
  exercise?: Reference;
  kind: Kind;
  mesocycle?: Reference;
  target_weight_kg?: number | null;
  target_reps?: number | null;
  target_distance_m?: number | null;
  target_duration_s?: number | null;
  weight_kg?: number | null;
  reps?: number | null;
  distance_m?: number | null;
  duration_s?: number | null;
  effort?: Effort | null;
  performed_at?: string | null;
  notes?: string | null;
}

export interface WriteSessionInput {
  date: string;
  rationale: string;
  sets: SetEntry[];
  request_id: string;
}

export interface CorrectSessionInput {
  started_at?: string | null;
  completed_at?: string | null;
  overall_feel?: string | null;
  notes?: string | null;
  rationale?: string;
  sets?: (CorrectSetInput & { id: number })[];
}
