import type { METHODS } from "./constants.ts";

export type Method = (typeof METHODS)[number];

export interface BodyfatRow {
  id: number;
  day: string;
  percent: number;
  method: Method;
  note: string | null;
  created_at: string;
}

export interface RecordedBodyfat {
  row: BodyfatRow;
  /** False when the estimate was already on record — an idempotent retry. */
  created: boolean;
}

export interface RecordBodyfatInput {
  percent: number;
  method: Method;
  day?: string | null;
  note?: string | null;
  requestId: string;
}
