import type { Expenditure } from "./expenditure.ts";

export interface ExpenditureRead extends Expenditure {
  /**
   * Which window the returned estimate belongs to — today's for `ok` and
   * `damped`, an older one for `stale`. Null under `insufficient_data`,
   * because there is no estimate for it to date-stamp and a date sitting
   * beside a null tdee reads as "current as of", implying a number exists.
   */
  as_of: string | null;
}

export interface ActiveTarget {
  id: number;
  effective_from: string;
  goal: string;
  rate_pct_bw_week: number;
  kcal_target: number;
  protein_g_target: number;
  decision: string;
  clipped: boolean;
  clipped_reasons: string[];
  tdee_at_creation: number | null;
  created_at: string;
}
