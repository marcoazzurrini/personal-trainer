import type { ContextEntry } from "./user_context.types.ts";

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
  delivered_this_week: number;
}

export interface RecentWeek {
  week: number;
  working_sets_done: number;
  sessions_done: number;
}

export interface RecentDecision {
  id: number;
  made_at: string;
  what_changed: string;
  why: string;
}

export interface ActiveMesocycle {
  id: number;
  name: string;
  track: string;
  intent: string;
  week: number | null;
  planned_weeks: number;
  started_on: string;
  method_doc: string | null;
  method_note: string | null;
  exercises: PlanExercise[];
  this_week: { sessions_done: number; sessions_per_week: number };
  recent_weeks: RecentWeek[];
  recent_decisions: RecentDecision[];
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
  exercises: SessionExercise[];
}

export interface TrainingState {
  now: { date: string; time: string; weekday: string; tz: string };
  week_schedule: WeekScheduleEntry | null;
  mesocycles: ActiveMesocycle[];
  note?: string;
  recent_sessions?: RecentSession[];
  user_context: ContextEntry[];
}
