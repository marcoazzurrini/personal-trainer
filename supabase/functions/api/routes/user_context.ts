import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { readJson, requireString, requireUuid } from "../lib/validate.ts";

export const userContext = new Hono();

// All current entries together (latest row per topic), never a filtered
// subset: a coach's picture of a person is coherent.
// ?history=true returns every row ever written, in order.
userContext.get("/", async (c) => {
  if (c.req.query("history") === "true") {
    const rows = await sql`
      select id, topic, content, written_at
      from user_context
      order by written_at, id`;
    return c.json({ history: rows });
  }
  const rows = await sql`
    select distinct on (topic) id, topic, content, written_at
    from user_context
    order by topic, written_at desc, id desc`;
  return c.json({ context: rows });
});

// Append only. Correcting or retiring a fact means writing a new row on the
// same topic; reuse the existing topic string (see the logging doc).
userContext.post("/", async (c) => {
  const body = await readJson(c, ["topic", "content"]);
  const requestId = requireUuid(body, "request_id");
  const topic = requireString(body, "topic");
  const content = requireString(body, "content");

  // Append-only, so nothing else would ever collide: two identical rows on the
  // same topic are indistinguishable from having written the fact twice.
  const [existing] = await sql`
    select id, topic, content, written_at
    from user_context where request_id = ${requestId}`;
  if (existing) return c.json({ entry: existing });

  const [row] = await sql`
    insert into user_context (topic, content, request_id)
    values (${topic}, ${content}, ${requestId})
    returning id, topic, content, written_at`;
  return c.json({ entry: row }, 201);
});
