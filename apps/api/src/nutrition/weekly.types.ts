export interface WeekEvent {
  day: string;
  kind: string;
  note: string | null;
}

export interface WeekTarget {
  kcal: number;
  protein_g: number;
  goal: string;
  rate_pct_bw_week: number;
  effective_from: string;
  changed_during_week: boolean;
}

export interface Week {
  week_start: string;
  week_end: string;
  days_logged: number;
  days_flagged: number;
  weigh_ins: number;
  mean_kcal: number | null;
  mean_protein_g: number | null;
  protein_coverage: {
    days_in_mean: number;
    entries: number;
    unknown_entries: number;
  };
  trend_start_kg: number | null;
  trend_end_kg: number | null;
  trend_delta_kg: number | null;
  rate_pct_bw_week: number | null;
  implied_tdee_kcal: number | null;
  target: WeekTarget | null;
  events: WeekEvent[];
}
