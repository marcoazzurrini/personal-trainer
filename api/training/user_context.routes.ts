import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  appendContext,
  contextHistory,
  currentContext,
} from "./user_context.ts";
import { body, query, requestId, text } from "../shared/schema.ts";

export const userContext = new OpenAPIHono();

// Exported: training state answers with the same rows, and used to declare a
// copy of this without `id` over a second copy of the query.
export const Entry = z.object({
  id: z.int(),
  topic: z.string(),
  content: z.string(),
  written_at: z.string(),
});

userContext.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Tracking"],
    summary: "What is known about Marco",
    request: {
      query: query({
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
  async (c) =>
    c.req.valid("query").history === "true"
      ? c.json({ history: await contextHistory() })
      : c.json({ context: await currentContext() }),
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
      query: query({}),
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
    const { row, created } = await appendContext(c.req.valid("json"));
    return created ? c.json({ entry: row }, 201) : c.json({ entry: row }, 200);
  },
);
