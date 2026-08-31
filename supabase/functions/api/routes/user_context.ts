import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { writeOnce } from "../record/idempotency.ts";
import { body, requestId, text } from "../http/schema.ts";

export const userContext = new OpenAPIHono();

const Entry = z.object({
  id: z.int(),
  topic: z.string(),
  content: z.string(),
  written_at: z.string(),
});

type EntryRow = z.infer<typeof Entry>;

// All current entries together (latest row per topic), never a filtered
// subset: a coach's picture of a person is coherent.
// ?history=true returns every row ever written, in order.
userContext.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Tracking"],
    summary: "What is known about Marco",
    request: {
      query: z.object({
        history: z.string().optional().meta({
          description:
            'Send "true" for every row ever written, in order, rather than the latest per topic.',
        }),
      }),
    },
    responses: {
      200: {
        description:
          "The latest row per topic under `context`, or every row under `history`. Which key answers depends on the query.",
        content: {
          "application/json": {
            schema: z.union([
              z.object({ context: z.array(Entry) }),
              z.object({ history: z.array(Entry) }),
            ]),
          },
        },
      },
    },
  }),
  async (c) => {
    if (c.req.query("history") === "true") {
      const rows = await sql<EntryRow[]>`
      select id, topic, content, written_at
      from user_context
      order by written_at, id`;
      return c.json({ history: rows });
    }
    const rows = await sql<EntryRow[]>`
    select distinct on (topic) id, topic, content, written_at
    from user_context
    order by topic, written_at desc, id desc`;
    return c.json({ context: rows });
  },
);

// Append only. Correcting or retiring a fact means writing a new row on the
// same topic; reuse the existing topic string (see the logging doc).
userContext.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Tracking"],
    summary: "Write down a fact about Marco",
    request: {
      body: {
        content: {
          "application/json": {
            schema: body({
              topic: text(),
              content: text(),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The entry that was appended.",
        content: {
          "application/json": { schema: z.object({ entry: Entry }) },
        },
      },
      200: {
        description:
          "The entry this request_id already appended. A retry, answered with the original result.",
        content: {
          "application/json": { schema: z.object({ entry: Entry }) },
        },
      },
    },
  }),
  async (c) => {
    const b = c.req.valid("json");

    // Append-only, so nothing else would ever collide: two identical rows on the
    // same topic are indistinguishable from having written the fact twice.
    const { body: answer, status } = await writeOnce({
      table: "user_context",
      requestId: b.request_id,
      select: sql`id, topic, content, written_at`,
      replay: (existing: EntryRow) => ({ entry: existing }),
      write: async () => {
        const [row] = await sql<EntryRow[]>`
        insert into user_context (topic, content, request_id)
        values (${b.topic}, ${b.content}, ${b.request_id})
        returning id, topic, content, written_at`;
        return { entry: row };
      },
    });
    return c.json(answer, status);
  },
);
