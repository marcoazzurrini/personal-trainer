import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { body, date, optionalDate, requestId, text } from "../http/schema.ts";

export const blocks = new OpenAPIHono();

const Block = z.object({
  id: z.int(),
  name: z.string(),
  goal: z.string(),
  started_on: z.string(),
  ended_on: z.string().nullable(),
});

// The response schema doubles as the row type, so the columns a query selects
// and the columns the document promises cannot drift apart.
type BlockRow = z.infer<typeof Block>;

blocks.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Planning"],
    summary: "Every block, oldest first",
    responses: {
      200: {
        description: "All blocks in start order.",
        content: {
          "application/json": {
            schema: z.object({ blocks: z.array(Block) }),
          },
        },
      },
    },
  }),
  async (c) => {
    const rows = await sql<BlockRow[]>`
    select id, name, goal, started_on, ended_on from blocks order by started_on`;
    return c.json({ blocks: rows });
  },
);

blocks.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Planning"],
    summary: "Open a block",
    request: {
      body: {
        content: {
          "application/json": {
            schema: body({
              name: text(),
              goal: text(),
              started_on: date(),
              ended_on: optionalDate(),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The block that was created.",
        content: {
          "application/json": { schema: z.object({ block: Block }) },
        },
      },
      200: {
        description:
          "The block this request_id already created. A retry, answered with the original result rather than a second row.",
        content: {
          "application/json": { schema: z.object({ block: Block }) },
        },
      },
    },
  }),
  async (c) => {
    const b = c.req.valid("json");

    const [existing] = await sql<BlockRow[]>`
    select id, name, goal, started_on, ended_on
    from blocks where request_id = ${b.request_id}`;
    if (existing) return c.json({ block: existing }, 200);

    const [row] = await sql<BlockRow[]>`
    insert into blocks (name, goal, started_on, ended_on, request_id)
    values (
      ${b.name},
      ${b.goal},
      ${b.started_on},
      ${b.ended_on ?? null},
      ${b.request_id}
    )
    returning id, name, goal, started_on, ended_on`;
    return c.json({ block: row }, 201);
  },
);
