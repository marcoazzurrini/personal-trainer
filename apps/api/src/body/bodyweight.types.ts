export interface BodyweightRow {
  id: number;
  value_kg: number;
  measured_at: string;
  source: string;
}

export interface RecordedBodyweight {
  row: BodyweightRow;
  /** False when the row was already there and matched — an idempotent retry. */
  created: boolean;
}
