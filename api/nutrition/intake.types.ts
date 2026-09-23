import type { MacroTotals } from "./rules.ts";

export interface IntakeEntry {
  id: number;
  day: string;
  grams: number | null;
  kcal: number;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  note: string | null;
  created_at: string;
  food_id: number | null;
  food: string | null;
  meal_id: number | null;
  meal: string | null;
}

export interface DayView {
  day: string;
  entries: IntakeEntry[];
  totals: MacroTotals;
  flags: string[];
}

/** A food or meal named by id, name, or alias. */
type Reference = string | number;

export interface LogInput {
  day?: string | null;
  meal?: Reference | null;
  scale?: number | null;
  food?: Reference | null;
  grams?: number | null;
  units?: number | null;
  adhoc_kcal?: number | null;
  adhoc_protein_g?: number | null;
  note?: string | null;
  request_id: string;
}

export interface CorrectInput {
  day?: string | null;
  grams?: number | null;
  kcal?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  fiber_g?: number | null;
  note?: string | null;
}
