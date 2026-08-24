import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import {
  optionalDate,
  readJson,
  requireDate,
  requireString,
  requireUuid,
} from "../lib/validate.ts";

export const blocks = new Hono();

blocks.get("/", async (c) => {
  const rows = await sql`
    select id, name, goal, started_on, ended_on from blocks order by started_on`;
  return c.json({ blocks: rows });
});

blocks.post("/", async (c) => {
  const body = await readJson(c, ["name", "goal", "started_on", "ended_on"]);
  const requestId = requireUuid(body, "request_id");

  const [existing] = await sql`
    select id, name, goal, started_on, ended_on
    from blocks where request_id = ${requestId}`;
  if (existing) return c.json({ block: existing });

  const [row] = await sql`
    insert into blocks (name, goal, started_on, ended_on, request_id)
    values (
      ${requireString(body, "name")},
      ${requireString(body, "goal")},
      ${requireDate(body, "started_on")},
      ${optionalDate(body, "ended_on")},
      ${requestId}
    )
    returning id, name, goal, started_on, ended_on`;
  return c.json({ block: row }, 201);
});
