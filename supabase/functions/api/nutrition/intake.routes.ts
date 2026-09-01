import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  correctEntry,
  flagDay,
  FLAGS,
  logIntake,
  removeEntry,
  unflagDay,
  viewDay,
} from "./intake.ts";
import {
  body,
  dayParam,
  idParam,
  macroTotals,
  oneOf,
  optionalDate,
  optionalNumber,
  optionalText,
  query,
  requestId,
} from "../http/schema.ts";

export const intake = new OpenAPIHono();

const Entry = z.object({
  id: z.int(),
  day: z.string(),
  grams: z.number().nullable(),
  kcal: z.number(),
  protein_g: z.number().nullable(),
  carbs_g: z.number().nullable(),
  fat_g: z.number().nullable(),
  fiber_g: z.number().nullable(),
  note: z.string().nullable(),
  created_at: z.string(),
  food_id: z.int().nullable(),
  food: z.string().nullable(),
  meal_id: z.int().nullable(),
  meal: z.string().nullable(),
});

const DayView = z.object({
  day: z.string(),
  entries: z.array(Entry),
  totals: macroTotals(),
  flags: z.array(z.string()),
});

// A food or meal reference: an id, a name, or an alias, so deliberately either
// a number or a string.
const reference = () => z.union([z.string().min(1), z.number()]);

intake.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Nutrition"],
    summary: "A day's entries, totals and flags",
    request: {
      query: query({
        day: dayParam().optional().meta({
          description: "YYYY-MM-DD. Defaults to today in Europe/Rome.",
        }),
      }),
    },
    responses: {
      200: {
        description: "Everything logged on that day, with the day's totals.",
        content: { "application/json": { schema: DayView } },
      },
    },
  }),
  async (c) => c.json(await viewDay(c.req.valid("query").day)),
);

intake.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Nutrition"],
    summary: "Log something eaten",
    description:
      'Exactly one of "meal", "food" or "adhoc_kcal". A meal writes one row per item, each carrying the food\'s numbers as they are now — the snapshot that keeps March\'s breakfast the breakfast that was eaten in March.',
    request: {
      query: query({}),
      body: {
        content: {
          "application/json": {
            schema: body({
              day: optionalDate(),
              meal: reference().optional(),
              scale: optionalNumber(),
              food: reference().optional(),
              grams: optionalNumber({ min: 0 }),
              units: optionalNumber({ min: 0 }),
              adhoc_kcal: optionalNumber(),
              adhoc_protein_g: optionalNumber({ min: 0 }),
              note: optionalText(),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The day as it now stands, including what was just added.",
        content: { "application/json": { schema: DayView } },
      },
      200: {
        description:
          "This request_id has already logged. A retry, answered with the day unchanged.",
        content: { "application/json": { schema: DayView } },
      },
      422: {
        description:
          "Not exactly one of meal/food/adhoc_kcal, a scale outside its bounds, or a day in the future.",
      },
    },
  }),
  async (c) => {
    const { view, created } = await logIntake(c.req.valid("json"));
    return created ? c.json(view, 201) : c.json(view, 200);
  },
);

intake.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Nutrition"],
    summary: "Correct a logged entry",
    description:
      '"grams" re-scales from the food as it is now; the macro fields override outright. The two cannot be combined. "day" moves the entry to another date without touching its numbers.',
    request: {
      params: z.object({ id: idParam("intake entry") }),
      query: query({}),
      body: {
        content: {
          "application/json": {
            schema: body({
              day: optionalDate(),
              grams: optionalNumber({ min: 0 }),
              kcal: optionalNumber({ min: 0 }),
              protein_g: optionalNumber({ min: 0 }),
              carbs_g: optionalNumber({ min: 0 }),
              fat_g: optionalNumber({ min: 0 }),
              fiber_g: optionalNumber({ min: 0 }),
              note: optionalText(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "The day the entry now lives on. `moved_from` names the day it left, when it left one.",
        content: {
          "application/json": {
            schema: DayView.extend({ moved_from: z.string().optional() }),
          },
        },
      },
      404: { description: "No entry carries that id." },
      422: {
        description:
          "grams combined with a macro override, grams on an ad-hoc entry, nothing sent, or a day in the future.",
      },
    },
  }),
  async (c) => {
    const { view, movedFrom } = await correctEntry(
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    return c.json(
      movedFrom === null ? view : { ...view, moved_from: movedFrom },
    );
  },
);

intake.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Nutrition"],
    summary: "Remove a logged entry",
    request: {
      params: z.object({ id: idParam("intake entry") }),
      query: query({}),
    },
    responses: {
      200: {
        description: "The day it was removed from, as it now stands.",
        content: { "application/json": { schema: DayView } },
      },
      404: { description: "No entry carries that id." },
    },
  }),
  async (c) => c.json(await removeEntry(c.req.valid("param").id)),
);

// ---------------------------------------------------------------------------
// Day flags
// ---------------------------------------------------------------------------

export const days = new OpenAPIHono();

days.openapi(
  createRoute({
    method: "post",
    path: "/{day}/flags",
    tags: ["Nutrition"],
    summary: "Flag a day",
    description:
      "`incomplete` takes the day out of the expenditure window entirely, rather than letting it enter as zero intake and drag the mean.",
    request: {
      params: z.object({ day: dayParam() }),
      query: query({}),
      body: {
        content: {
          "application/json": { schema: body({ flag: oneOf(FLAGS) }) },
        },
      },
    },
    responses: {
      201: {
        description: "The day, now carrying the flag.",
        content: { "application/json": { schema: DayView } },
      },
      422: { description: "A day in the future, or an unknown flag." },
    },
  }),
  async (c) =>
    c.json(
      await flagDay(c.req.valid("param").day, c.req.valid("json").flag),
      201,
    ),
);

days.openapi(
  createRoute({
    method: "delete",
    path: "/{day}/flags/{flag}",
    tags: ["Nutrition"],
    summary: "Unflag a day",
    request: {
      params: z.object({ day: dayParam(), flag: z.string().min(1) }),
      query: query({}),
    },
    responses: {
      200: {
        description: "The day, without the flag.",
        content: { "application/json": { schema: DayView } },
      },
      404: { description: "The day does not carry that flag." },
    },
  }),
  async (c) => {
    const { day, flag } = c.req.valid("param");
    return c.json(await unflagDay(day, flag));
  },
);
