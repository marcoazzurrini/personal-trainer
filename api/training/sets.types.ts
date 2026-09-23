import type { Effort, Kind } from "./rules.ts";

export interface SetRow {
  id: number;
  session_id: number;
  exercise_id: number;
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
