import type { SYSTEMIC_FATIGUE_LEVELS } from "./constants.ts";
import type { Measure, StimulusType } from "./rules.ts";

export type SystemicFatigue = typeof SYSTEMIC_FATIGUE_LEVELS[number];

export interface MuscleLink {
  muscle: string;
  volume_factor: number;
}

export interface ExerciseRow {
  id: number;
  name: string;
  equipment: string | null;
  pattern: string | null;
  stimulus_type: StimulusType;
  systemic_fatigue: SystemicFatigue;
  measure: Measure;
  notes: string | null;
  aliases: string[];
  muscles: MuscleLink[];
}

export interface MuscleRow {
  id: number;
  name: string;
}

/** What a muscle entry may carry, including the two field names that retired. */
export interface MuscleEntryInput {
  muscle: string;
  volume_factor: number;
  counts?: unknown;
  fatigue?: unknown;
}

export interface HistorySet {
  date: string;
  weight_kg: number | null;
  reps: number | null;
  distance_m: number | null;
  duration_s: number | null;
  effort: string | null;
  notes: string | null;
  session_id: number;
}

export interface AddExerciseInput {
  name: string;
  equipment?: string | null;
  pattern?: string | null;
  notes?: string | null;
  measure: Measure;
  stimulus_type: StimulusType;
  systemic_fatigue: SystemicFatigue;
  aliases?: string[] | null;
  muscles?: MuscleEntryInput[];
}

export interface CorrectExerciseInput {
  name?: string;
  equipment?: string | null;
  pattern?: string | null;
  notes?: string | null;
  measure?: Measure;
  stimulus_type?: StimulusType;
  systemic_fatigue?: SystemicFatigue;
  alias?: unknown;
  aliases?: unknown;
  muscles?: unknown;
}

export interface ExerciseHistory {
  exercise: string;
  exercise_id: number;
  measure: Measure;
  total_sets: number;
  returned: number;
  sets: HistorySet[];
}
