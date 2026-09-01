import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { listBlocks, openBlock } from "./blocks.ts";
import {
  body,
  date,
  optionalDate,
  query,
  requestId,
  text,
} from "../http/schema.ts";

export const blocks = new OpenAPIHono();

const Block = z.object({
  id: z.int(),
  name: z.string(),
  goal: z.string(),
  started_on: z.string(),
  ended_on: z.string().nullable(),
});

blocks.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Planning"],
    summary: "Every block, oldest first",
    request: { query: query({}) },
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
  async (c) => c.json({ blocks: await listBlocks() }),
);

blocks.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Planning"],
    summary: "Open a block",
    request: {
      query: query({}),
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
    const { row, created } = await openBlock(c.req.valid("json"));
    return created ? c.json({ block: row }, 201) : c.json({ block: row }, 200);
  },
);
