import type { SOURCES } from "./constants.ts";

export type Source = (typeof SOURCES)[number];

export interface FoodRow {
  id: number;
  name: string;
  brand: string | null;
  kcal_100g: number;
  protein_100g: number;
  carbs_100g: number;
  fat_100g: number;
  fiber_100g: number | null;
  grams_per_unit: number | null;
  source: Source;
  source_note: string | null;
  created_at: string;
  aliases: string[];
}

export interface SaveFoodInput {
  name: string;
  brand?: string | null;
  kcal_100g: number;
  protein_100g: number;
  carbs_100g: number;
  fat_100g: number;
  fiber_100g?: number | null;
  grams_per_unit?: number | null;
  source: Source;
  source_note?: string | null;
  energy_check?: "override";
  aliases?: string[] | null;
  request_id: string;
}

export interface CorrectFoodInput {
  name?: string;
  brand?: string | null;
  kcal_100g?: number | null;
  protein_100g?: number | null;
  carbs_100g?: number | null;
  fat_100g?: number | null;
  fiber_100g?: number | null;
  grams_per_unit?: number | null;
  source?: Source;
  source_note?: string | null;
  energy_check?: "override";
}

export interface CorrectedFood {
  food: FoodRow;
  corrected_entries: { count: number; from: string | null; to: string | null };
  note: string;
}
