import type { KINDS } from "./constants.ts";

export type Kind = (typeof KINDS)[number];

export interface EventRow {
  id: number;
  day: string;
  kind: Kind;
  note: string | null;
  created_at: string;
}

/** The same rows the back-solve damps on, without the bookkeeping column. */
export type ActiveTransient = Omit<EventRow, "created_at">;
