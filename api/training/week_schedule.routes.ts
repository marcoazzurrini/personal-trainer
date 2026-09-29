import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import { body, optionalDate, query, text } from "../shared/schema.ts";
import { services } from "../shared/services.ts";
import type { AppEnv } from "../shared/services.ts";

export const weekSchedule = new OpenAPIHono<AppEnv>();

const WeekSchedule = z.object({
  week_start: z.string(),
  week_end: z.string(),
  schedule: z.string(),
  written_at: z.string(),
});

interface WrittenSchedule {
  week_schedule: z.infer<typeof WeekSchedule>;
  note?: string;
}

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
    const { row, note } = await services(c).schedule.writeWeekSchedule(
      c.req.valid("json")
    );
    const response: WrittenSchedule = {
      week_schedule: row,
    };
    if (note) {
      response.note = note;
    }
    return c.json(response, 201);
  }
);
