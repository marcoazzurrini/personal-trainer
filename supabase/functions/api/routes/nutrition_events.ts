import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import {
  optionalDate,
  optionalString,
  readJson,
  requireIdParam,
  requireOneOf,
  requireUuid,
} from "../lib/validate.ts";
import { activeTransients, romeToday } from "../lib/nutrition_read.ts";

// The register of things that make bodyweight move for reasons that are not
// fat or muscle. Registering one tells the expenditure back-solve to damp its
// updates while the water settles, instead of reading it as metabolism.

const KINDS = [
  "creatine_start",
  "phase_switch",
  "program_change",
  "logging_change",
  "other",
] as const;

export const nutritionEvents = new Hono();

nutritionEvents.get("/", async (c) => {
  const rows = await sql`
    select id, day, kind, note, created_at
    from nutrition_events order by day desc, id desc`;
  return c.json({
    events: rows,
    active: await activeTransients(await romeToday()),
  });
});

nutritionEvents.post("/", async (c) => {
  const body = await readJson(c, ["day", "kind", "note"]);
  const requestId = requireUuid(body, "request_id");
  if (requestId) {
    const [existing] = await sql`
      select id, day, kind, note, created_at
      from nutrition_events where request_id = ${requestId}`;
    if (existing) return c.json({ event: existing });
  }

  const kind = requireOneOf(body, "kind", KINDS);
  const note = optionalString(body, "note");
  const day = optionalDate(body, "day") ?? await romeToday();

  const [row] = await sql`
    insert into nutrition_events (day, kind, note, request_id)
    values (${day}, ${kind}, ${note}, ${requestId})
    returning id, day, kind, note, created_at`;
  return c.json({ event: row }, 201);
});

// An event registered on the wrong day, or that turned out not to have
// happened, actively distorts the estimate: it damps updates for two weeks
// around a transient that never occurred. Registering one is a claim, and a
// claim can be wrong.
nutritionEvents.delete("/:id", async (c) => {
  const id = requireIdParam(c.req.param("id"), "nutrition event");
  const [row] = await sql`
    delete from nutrition_events where id = ${id}
    returning day, kind, note`;
  if (!row) throw new ApiError(404, `No nutrition event with id ${id}.`);
  return c.json({ deleted: row });
});
