import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { body, optionalDate, text } from "../http/schema.ts";

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

export const weekSchedule = new OpenAPIHono();

const WeekSchedule = z.object({
  week_start: z.string(),
  week_end: z.string(),
  schedule: z.string(),
  written_at: z.string(),
});

weekSchedule.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Planning"],
    summary: "Write or replace a week's shape",
    request: {
      body: {
        content: {
          "application/json": {
            schema: body({
              week_start: optionalDate(),
              schedule: text(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description:
          "The week that was written. `note` appears only when week_start was defaulted on a Saturday or Sunday, where the default is the week now ending rather than the one coming.",
        content: {
          "application/json": {
            schema: z.object({
              week_schedule: WeekSchedule,
              note: z.string().optional(),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const b = c.req.valid("json");
    const weekStart = b.week_start ?? null;

    const [row] = await sql`
    insert into week_schedules (week_start, schedule)
    values (
      ${
      weekStart ??
        sql`date_trunc('week', now() at time zone 'Europe/Rome')::date`
    },
      ${b.schedule})
    on conflict (week_start) do update
      set schedule = excluded.schedule, written_at = now()
    returning week_start, (week_start + 6) as week_end, schedule, written_at`;

    // "This Monday" is the Monday of the week containing today — on a Sunday
    // that is six days ago, not tomorrow. A coach writing next week's plan on
    // the weekend who omits week_start therefore upserts over the week that is
    // ending, and gets a 201 for it. The write goes through — schedules are
    // usually written on Mondays and a refusal would break that flow — but the
    // default is echoed loudly enough to be caught in the same breath.
    let note: string | null = null;
    if (weekStart === null) {
      const [clock] = await sql`
      select extract(isodow from now() at time zone 'Europe/Rome')::int as dow,
        (date_trunc('week', now() at time zone 'Europe/Rome')::date + 7)
          as next_monday`;
      if (clock.dow >= 6) {
        note =
          `week_start defaulted to ${row.week_start} — the Monday of the week now ending, not next week. If this schedule was meant for the coming week, resend it with "week_start": "${clock.next_monday}".`;
      }
    }

    return c.json({
      week_schedule: row as z.infer<typeof WeekSchedule>,
      ...(note ? { note } : {}),
    }, 201);
  },
);
