import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { optionalDate, readJson, requireString } from "../lib/validate.ts";

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

export const weekSchedule = new Hono();

weekSchedule.post("/", async (c) => {
  const body = await readJson(c);
  const schedule = requireString(body, "schedule");
  const weekStart = optionalDate(body, "week_start");

  const [row] = await sql`
    insert into week_schedules (week_start, schedule)
    values (
      ${
    weekStart ?? sql`date_trunc('week', now() at time zone 'Europe/Rome')::date`
  },
      ${schedule})
    on conflict (week_start) do update
      set schedule = excluded.schedule, written_at = now()
    returning week_start, schedule, written_at`;
  return c.json({ week_schedule: row }, 201);
});
