// The register of things that make bodyweight move for reasons that are not
// fat or muscle. Registering one tells the expenditure back-solve to damp its
// updates while the water settles, instead of reading it as metabolism.

import { sql } from "../db.ts";
import { requireRow } from "../http/errors.ts";
import { writeOnce } from "../record/idempotency.ts";
import { romeToday } from "../record/calendar.ts";
import { addDays } from "../rules/dates.ts";

export const KINDS = [
  "creatine_start",
  "phase_switch",
  "program_change",
  "logging_change",
  "other",
] as const;
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

// How long after a registered transient its damping applies. Glycogen and
// water settle over one to two weeks; two is the honest outer bound.
const TRANSIENT_WINDOW_DAYS = 14;

function eventColumns() {
  return sql`id, day, kind, note, created_at`;
}

/** Every event ever registered, newest first. */
export async function listEvents(): Promise<EventRow[]> {
  return await sql<EventRow[]>`
    select ${eventColumns()}
    from nutrition_events order by day desc, id desc`;
}

/** Those still inside the damping window on the given day. */
export async function activeTransients(
  asOf: string,
): Promise<ActiveTransient[]> {
  return await sql<ActiveTransient[]>`
    select id, day, kind, note from nutrition_events
    where day >= ${addDays(asOf, -TRANSIENT_WINDOW_DAYS)} and day <= ${asOf}
    order by day desc, id desc`;
}

export async function registerEvent(b: {
  day?: string | null;
  kind: Kind;
  note?: string | null;
  request_id: string;
}): Promise<{ row: EventRow; created: boolean }> {
  const { body: row, status } = await writeOnce<EventRow, EventRow, EventRow>({
    table: "nutrition_events",
    requestId: b.request_id,
    select: eventColumns(),
    replay: (existing) => existing,
    write: async () => {
      const day = b.day ?? await romeToday();
      const [written] = await sql<EventRow[]>`
        insert into nutrition_events (day, kind, note, request_id)
        values (${day}, ${b.kind}, ${b.note ?? null}, ${b.request_id})
        returning ${eventColumns()}`;
      return written;
    },
  });
  return { row, created: status === 201 };
}

// An event registered on the wrong day, or that turned out not to have
// happened, actively distorts the estimate: it damps updates for two weeks
// around a transient that never occurred. Registering one is a claim, and a
// claim can be wrong.
export async function withdrawEvent(
  id: number,
): Promise<Pick<EventRow, "day" | "kind" | "note">> {
  return requireRow(
    await sql<Array<Pick<EventRow, "day" | "kind" | "note">>>`
    delete from nutrition_events where id = ${id}
    returning day, kind, note`,
    `No nutrition event with id ${id}.`,
  );
}
