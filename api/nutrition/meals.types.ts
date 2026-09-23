import type { MacroTotals, ScaledMacros } from "./rules.ts";

export interface MealItem extends ScaledMacros {
  food_id: number;
  food: string;
  brand: string | null;
  grams: number;
}

export interface MealDetail {
  id: number;
  name: string;
  created_at: string;
  aliases: string[];
  items: MealItem[];
  totals: MacroTotals;
}

export interface MealSummary {
  id: number;
  name: string;
  created_at: string;
  items: number;
  aliases: string[];
}

/** A food named by id, name, or alias, with how much of it the routine holds. */
export interface ItemInput {
  food: string | number;
  grams: number;
}
