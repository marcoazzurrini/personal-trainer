import type { CLIP_REASONS } from "./constants.ts";
import type {
  ExpenditureStatus,
  Goal,
  ProteinComputation,
} from "./expenditure.ts";

export type ClipReason = (typeof CLIP_REASONS)[number];

export interface TargetRow {
  id: number;
  effective_from: string;
  goal: Goal;
  rate_pct_bw_week: number;
  kcal_target: number;
  protein_g_target: number;
  decision: string;
  clipped: boolean;
  clipped_reasons: ClipReason[];
  tdee_at_creation: number | null;
  created_at: string;
}

/** The arithmetic, returned so the coach can quote it rather than redo it. */
export interface Computation {
  tdee_kcal: number;
  band_kcal: number | null;
  expenditure_status: ExpenditureStatus;
  trend_weight_kg: number;
  energy_density_kcal_per_kg: number;
  rate_requested: number;
  rate_used: number;
  desired_slope_kg_per_day: number;
  implied_deficit_kcal: number;
  clipped: boolean;
  clipped_reasons: ClipReason[];
}

export interface CreatedTarget {
  target: TargetRow;
  computation: Computation | null;
  protein_computation: ProteinComputation | null;
  phase_switch_registered: boolean;
}

export interface SetTargetInput {
  goal: Goal;
  effective_from?: string | null;
  kcal_target?: number | null;
  protein_g_target?: number | null;
  protein_g_per_kg_ffm?: number | null;
  protein_g_per_kg_bw?: number | null;
  rate_pct_bw_week: number;
  decision: string;
  request_id: string;
}

export type TargetWritten =
  | { created: true; body: CreatedTarget }
  | { created: false; body: { target: TargetRow } };
