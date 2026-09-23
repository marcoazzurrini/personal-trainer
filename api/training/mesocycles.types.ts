import type { DoseUnit, Role, Track } from "./rules.ts";

export interface PlanExerciseRow {
  id: number;
  exercise_id: number;
  exercise: string;
  measure: string;
  role: Role;
  priority: number;
  weekly_dose: number;
  weekly_dose_unit: DoseUnit;
  notes: string | null;
}

export interface MesocycleDetail {
  id: number;
  block_id: number;
  name: string;
  track: Track;
  /** The plan's judgment in prose. Never arithmetic. */
  intent: string;
  planned_weeks: number;
  sessions_per_week: number;
  started_on: string;
  ended_on: string | null;
  /** Null until the plan starts. */
  week: number | null;
  exercises: PlanExerciseRow[];
}

export interface DecisionRow {
  id: number;
  made_at: string;
  what_changed: string;
  why: string;
  prior_intent: string | null;
}

/** A decision as the write answers it: named by its plan, no prior intent. */
export type RecordedRow = Omit<DecisionRow, "prior_intent"> & {
  mesocycle_id: number;
};

export interface PlanExercise {
  exerciseId: number;
  role: Role;
  priority: number;
  weeklyDose: number;
  weeklyDoseUnit: DoseUnit;
  notes: string | null;
}

/** What one entry of the exercise list may carry, retired names included. */
export interface PlanEntry {
  exercise?: string | number;
  role: Role;
  priority: number;
  weekly_dose: number;
  weekly_dose_unit: DoseUnit;
  notes?: string | null;
  weekly_sets?: unknown;
  load_target?: unknown;
}

export interface DecisionInput {
  what_changed: string;
  why: string;
  intent?: string | null;
  add?: PlanEntry[];
  remove?: Array<string | number>;
  redose?: Array<
    {
      exercise?: string | number;
      weekly_dose: number;
      weekly_dose_unit: DoseUnit;
    }
  >;
  ended_on?: string | null;
  weekly_sets?: unknown;
  load_targets?: unknown;
  request_id: string;
}

export interface CreateMesocycleInput {
  block_id: number;
  name: string;
  track: Track;
  intent: string;
  started_on: string;
  planned_weeks: number;
  sessions_per_week: number;
  exercises: PlanEntry[];
  request_id: string;
}

export interface RenameMesocycleInput {
  name: string;
  intent?: unknown;
  ended_on?: unknown;
}
