import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { writeWeekSchedule } from "./week_schedule.ts";
import { body, optionalDate, query, text } from "../shared/schema.ts";

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
      query: query({}),
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
    const { row, note } = await writeWeekSchedule(c.req.valid("json"));
    return c.json({ week_schedule: row, ...(note ? { note } : {}) }, 201);
  },
);
