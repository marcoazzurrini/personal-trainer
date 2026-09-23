import type { BodyfatRow } from "../body/bodyfat.types.ts";
import type { MacroTotals } from "./rules.ts";
import type { ExpenditureRead } from "./read.types.ts";
import type { ActiveTransient } from "./events.types.ts";
import type { TargetRow } from "./targets.types.ts";
import type { IntakeEntry } from "./intake.types.ts";

export interface RecentDay {
  day: string;
  kcal: number | null;
  protein_g: number | null;
  entries: number;
  incomplete: boolean;
  weight_kg: number | null;
}

export interface Adherence {
  days_logged_last_7: number;
  days_logged_last_21: number;
  weigh_ins_last_7: number;
  weigh_ins_last_21: number;
  last_logged_day: string | null;
  last_weigh_in: string | null;
}

export interface Slope {
  kg_per_week: number;
  pct_bw_week: number;
}

export interface NutritionState {
  now: { date: string; time: string; weekday: string; tz: string };
  today_so_far: {
    entries: IntakeEntry[];
    totals: MacroTotals;
    vs_target: {
      kcal_target: number;
      kcal_remaining: number;
      protein_g_target: number;
      protein_g_remaining: number | null;
    } | null;
  };
  trend_weight: {
    day: string;
    trend_kg: number;
    earliest_scale_kg: number;
    interpolated: boolean;
    slope_7d: Slope | null;
    slope_21d: Slope | null;
  } | null;
  expenditure: ExpenditureRead;
  target: TargetRow | null;
  active_transients: ActiveTransient[];
  recent_days: RecentDay[];
  adherence: Adherence;
  latest_bodyfat: BodyfatRow | null;
  recent_flags: { day: string; flag: string }[];
}
