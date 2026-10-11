export type Measure =
  | "load_reps"
  | "reps"
  | "distance"
  | "duration"
  | "distance_duration";
export type StimulusType = "strength" | "power" | "conditioning";
export type SystemicFatigue = "normal" | "high";
export type Track = "hypertrophy" | "strength" | "speed" | "endurance";
export type Role = "main" | "accessory" | "rehab";
export type DoseUnit = "sets" | "minutes" | "km";

export interface ExerciseReference {
  id: number;
  name: string;
  measure: Measure;
  stimulus_type: StimulusType;
}
export interface PlanReference {
  id: number;
  track: string;
}
export interface ExerciseLookup {
  key: string | null;
  id: number | null;
}
export interface ExerciseRecord extends ExerciseReference {
  equipment: string | null;
  pattern: string | null;
  systemic_fatigue: SystemicFatigue;
  notes: string | null;
  aliases: string[];
  muscles: { muscle: string; volume_factor: number }[];
}
export interface MuscleRecord {
  id: number;
  name: string;
}
export interface MuscleAssignment {
  muscle_id: number;
  /** Unscaled decimal; persistence owns the stored integer. */
  volume_factor: number;
}
export interface ExerciseChanges {
  name?: string;
  equipment?: string | null;
  pattern?: string | null;
  notes?: string | null;
  measure?: Measure;
  stimulus_type?: StimulusType;
  systemic_fatigue?: SystemicFatigue;
}
export interface NewExercise {
  name: string;
  equipment: string | null;
  pattern: string | null;
  notes: string | null;
  measure: Measure;
  stimulus_type: StimulusType;
  systemic_fatigue: SystemicFatigue;
  aliases: readonly string[];
  muscles: readonly MuscleAssignment[];
}
export interface ExerciseHistorySet {
  date: string;
  weight_kg: number | null;
  reps: number | null;
  distance_m: number | null;
  duration_s: number | null;
  effort: string | null;
  notes: string | null;
  session_id: number;
}
export interface BlockRecord {
  id: number;
  name: string;
  goal: string;
  started_on: string;
  ended_on: string | null;
}
export type NewBlock = Omit<BlockRecord, "id"> & { request_id: string };

export interface PlanExerciseRecord {
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
export interface MesocycleHeader {
  id: number;
  block_id: number;
  name: string;
  track: Track;
  intent: string;
  planned_weeks: number;
  sessions_per_week: number;
  started_on: string;
  ended_on: string | null;
}
export interface PlanSnapshot {
  headers: MesocycleHeader[];
  exercises: PlanExerciseRecord[];
}
export interface PlanAddition {
  exerciseId: number;
  role: Role;
  priority: number;
  /** Unscaled decimal; persistence owns the stored integer. */
  weeklyDose: number;
  weeklyDoseUnit: DoseUnit;
  notes: string | null;
}
export interface PlanRedose {
  exerciseId: number;
  dose: number;
  unit: DoseUnit;
}
export interface NewMesocycle extends Omit<MesocycleHeader, "id" | "ended_on"> {
  request_id: string;
  exercises: PlanAddition[];
  now: string;
  today: string;
}
export interface RecordedDecision {
  id: number;
  mesocycle_id: number;
  made_at: string;
  what_changed: string;
  why: string;
}
export type DecisionRecord = Omit<RecordedDecision, "mesocycle_id"> & {
  prior_intent: string | null;
};
export interface PlanDecision {
  mesocycle_id: number;
  request_id: string;
  what_changed: string;
  why: string;
  intent: string | null;
  changeEndedOn: boolean;
  ended_on: string | null;
  remove: number[];
  add: PlanAddition[];
  redose: PlanRedose[];
  now: string;
  today: string;
}

export type Kind = "warmup" | "working";
export type Effort = "easy" | "hard" | "failure";
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

export type Header = SessionHeaderRow & { write_version: number };
export type SetSnapshot = SessionSetRow & {
  session_id: number;
  stimulus_type: string;
  request_id: string | null;
};
export interface Snapshot {
  header: Header;
  sets: SetSnapshot[];
}

export interface SessionSnapshot {
  headers: Header[];
  sets: SetSnapshot[];
}
export type WriteFields = Partial<
  Pick<
    SessionSetRow,
    | "exercise_id"
    | "mesocycle_id"
    | "kind"
    | "target_weight_kg"
    | "target_reps"
    | "target_distance_m"
    | "target_duration_s"
    | "weight_kg"
    | "reps"
    | "distance_m"
    | "duration_s"
    | "effort"
    | "performed_at"
    | "notes"
  > &
    Pick<
      SessionHeaderRow,
      "notes" | "overall_feel" | "rationale" | "started_at" | "completed_at"
    > & {
      expected_measure: string;
      expected_stimulus_type: string;
    }
>;

export interface WeekScheduleEntry {
  week_start: string;
  schedule: string;
  written_at: string;
}
export interface PlanExercise {
  exercise: string;
  measure: string;
  role: string;
  priority: number;
  notes: string | null;
  dose: number;
  dose_unit: string;
  sets_done: number;
  distance_m: number | null;
  duration_s: number | null;
  days_since_trained: number | null;
}
export interface RecentWeek {
  working_sets_done: number;
  sessions_done: number;
}
export interface RecentDecision {
  id: number;
  made_at: string;
  what_changed: string;
  why: string;
}
export interface SessionExercise {
  exercise: string;
  mesocycle_id: number | null;
  working_sets: number;
  top_weight_kg: number | null;
  top_reps: number | null;
  top_distance_m: number | null;
  top_duration_s: number | null;
  top_effort: string | null;
}
export interface RecentSession {
  id: number;
  date: string;
  rationale: string | null;
  notes: string | null;
  overall_feel: string | null;
}
export interface Plan {
  id: number;
  name: string;
  track: Track;
  intent: string;
  planned_weeks: number;
  sessions_per_week: number;
  started_on: string;
}
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
}
export interface ContextEntry {
  id: number;
  topic: string;
  content: string;
  written_at: string;
}
export interface WeekScheduleRow {
  week_start: string;
  week_end: string;
  schedule: string;
  written_at: string;
}
