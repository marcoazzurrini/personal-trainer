export interface VolumeRow {
  week_start: string;
  muscle: string;
  working_sets: number;
}

export interface ExerciseWeek {
  week: number;
  exercise: string;
  exercise_id: number;
  measure: string;
  sets_done: number;
  distance_m: number | null;
  duration_s: number | null;
  dose: number | null;
  dose_unit: string | null;
  /** The dose's own unit, so adherence is a subtraction rather than a conversion. */
  delivered: number | null;
}
