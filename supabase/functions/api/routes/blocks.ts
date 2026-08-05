import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import {
  optionalDate,
  readJson,
  requireDate,
  requireString,
} from "../lib/validate.ts";

export const blocks = new Hono();

blocks.get("/", async (c) => {
  const rows = await sql`
    select id, name, goal, started_on, ended_on from blocks order by started_on`;
  return c.json({ blocks: rows });
});

blocks.post("/", async (c) => {
  const body = await readJson(c);
  const [row] = await sql`
    insert into blocks (name, goal, started_on, ended_on)
    values (
      ${requireString(body, "name")},
      ${requireString(body, "goal")},
      ${requireDate(body, "started_on")},
      ${optionalDate(body, "ended_on")}
    )
    returning id, name, goal, started_on, ended_on`;
  return c.json({ block: row }, 201);
});
