// The shape of a week, in prose, as the coach proposed it and Marco accepted
// it. Its only reader is the coach, so it has no structure to speak of: a
// Monday and a sentence.
//
// It is a default, never a contract. Session generation opens with it and
// deviates freely; what actually happened is in sessions, and next week's is
// written from scratch. Structure here — day rows, exercise links — would
// make it a template, and pre-planned sessions are the thing this system has
// refused from the start.
//
// No request_id: the write upserts on week_start, so a retry cannot duplicate
// and an id would be ceremony rather than a guarantee. A second call with
// different text is not a duplicate — it is the week being edited, which is
// what this endpoint is for.

import { sql } from "../db.ts";
import { romeIsoDow, romeWeekStart } from "../record/calendar.ts";

export interface WeekScheduleRow {
  week_start: string;
  week_end: string;
  schedule: string;
  written_at: string;
}

/**
 * Writes or replaces one week's shape.
 *
 * `note` is non-null only when week_start was defaulted on a Saturday or
 * Sunday. "This Monday" is the Monday of the week containing today — on a
 * Sunday that is six days ago, not tomorrow. A coach writing next week's plan
 * at the weekend who omits week_start therefore upserts over the week that is
 * ending. The write goes through, because schedules are usually written on
 * Mondays and a refusal would break that flow, but the default is echoed
 * loudly enough to be caught in the same breath.
 */
export async function writeWeekSchedule(b: {
  week_start?: string | null;
  schedule: string;
}): Promise<{ row: WeekScheduleRow; note: string | null }> {
  const weekStart = b.week_start ?? null;

  const [row] = await sql<WeekScheduleRow[]>`
    insert into week_schedules (week_start, schedule)
    values (
      ${weekStart ?? romeWeekStart()},
      ${b.schedule})
    on conflict (week_start) do update
      set schedule = excluded.schedule, written_at = now()
    returning week_start, (week_start + 6) as week_end, schedule, written_at`;

  let note: string | null = null;
  if (weekStart === null) {
    const [clock] = await sql`
      select ${romeIsoDow()} as dow,
        (${romeWeekStart()} + 7) as next_monday`;
    if (clock.dow >= 6) {
      note =
        `week_start defaulted to ${row.week_start} — the Monday of the week now ending, not next week. If this schedule was meant for the coming week, resend it with "week_start": "${clock.next_monday}".`;
    }
  }

  return { row, note };
}
