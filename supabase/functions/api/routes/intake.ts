import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql, type Tx } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import {
  foodMacros,
  gramsEaten,
  scaleFood,
  sumMacros,
} from "../lib/nutrition.ts";
import { resolveFoodId, resolveMealId } from "../lib/resolve.ts";
import { requireNotFuture } from "../lib/validate.ts";
import {
  body,
  dayParam,
  idParam,
  macroTotals,
  oneOf,
  optionalDate,
  optionalNumber,
  optionalText,
  requestId,
} from "../lib/schema.ts";

// What was actually eaten. Three ways in — a saved meal, a single food, or an
// ad-hoc estimate — and one way out: rows carrying their own numbers.
//
// The row's shape is its kind. food_id + grams is a food; neither is ad-hoc.
// Logging a meal writes one row per item, all sharing meal_id, so a day's
// total is one sum over one uniform table and "the usual breakfast but double
// yogurt" is an ordinary extra row rather than a special case.
//
// Every row's macros are copied from the food at the moment of logging. That
// is deliberate and it is the whole design: a meal's recipe evolves, and the
// breakfast logged in March must stay the breakfast that was eaten in March.
// The cost, accepted knowingly: correcting a mistyped food does not fix past
// entries — those rows are corrected explicitly when it matters.

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

const Totals = macroTotals();

const DayView = z.object({
  day: z.string(),
  entries: z.array(Entry),
  totals: Totals,
  flags: z.array(z.string()),
});

// A food or meal reference: an id, a name, or an alias, so deliberately either
// a number or a string.
const reference = () => z.union([z.string().min(1), z.number()]);

async function romeToday(): Promise<string> {
  const [row] = await sql`
    select (now() at time zone 'Europe/Rome')::date as today`;
  return row.today;
}

async function dayView(day: string) {
  const entries = await sql<z.infer<typeof Entry>[]>`
    select i.id, i.day, i.grams::float8, i.kcal::float8,
      i.protein_g::float8, i.carbs_g::float8, i.fat_g::float8,
      i.fiber_g::float8, i.note, i.created_at,
      i.food_id, f.name as food, i.meal_id, m.name as meal
    from intake_entries i
    left join foods f on f.id = i.food_id
    left join meals m on m.id = i.meal_id
    where i.day = ${day}
    order by i.created_at, i.id`;
  const flags = await sql<{ flag: string }[]>`
    select flag from day_flags where day = ${day} order by flag`;
  return {
    day,
    entries,
    totals: sumMacros(entries),
    flags: flags.map((f) => f.flag),
  };
}

// The one place intake rows are written. Everything above it decides what to
// log; this decides nothing and invents nothing.
async function insertEntry(
  tx: Tx,
  day: string,
  requestIdValue: string | null,
  row: {
    foodId: number | null;
    grams: number | null;
    mealId: number | null;
    kcal: number;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    note: string | null;
  },
) {
  await tx`
    insert into intake_entries
      (day, food_id, grams, meal_id, kcal, protein_g, carbs_g, fat_g, fiber_g,
       note, request_id)
    values
      (${day}, ${row.foodId}, ${row.grams}, ${row.mealId}, ${row.kcal},
       ${row.protein_g}, ${row.carbs_g}, ${row.fat_g}, ${row.fiber_g},
       ${row.note}, ${requestIdValue})`;
}

// Past this, a "portion" is a mistyped decimal. See the check below.
const MAX_SCALE = 10;

intake.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Nutrition"],
    summary: "A day's entries, totals and flags",
    request: {
      query: z.object({
        day: z.string().optional().meta({
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
  async (c) => {
    const day = c.req.query("day") ?? await romeToday();
    return c.json(await dayView(day));
  },
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
    const b = c.req.valid("json");
    const today = await romeToday();
    const day = requireNotFuture(b.day ?? today, today, "day");
    const note = b.note ?? null;

    const [seen] = await sql`
      select 1 from intake_entries where request_id = ${b.request_id} limit 1`;
    if (seen) return c.json(await dayView(day), 200);

    const wants = (["meal", "food", "adhoc_kcal"] as const).filter((k) =>
      b[k] !== undefined && b[k] !== null
    );
    if (wants.length !== 1) {
      throw new ApiError(
        422,
        wants.length === 0
          ? 'An intake entry is one of three things: "meal" (a saved meal by id, name, or alias), "food" plus "grams" or "units", or "adhoc_kcal" for an estimated entry. Send exactly one.'
          : `Send exactly one of "meal", "food", "adhoc_kcal" — got ${
            wants.join(" and ")
          }. A meal plus an extra food is two calls, which is also how a variation on a routine gets logged.`,
      );
    }

    // A portion of a saved meal. Bounded on both sides: a scale of 0 logs
    // nothing while answering 201, and anything past 10x a routine portion is a
    // misplaced decimal rather than an appetite — the same reasoning that makes
    // a future date a typo instead of a fact.
    const scale = b.scale ?? null;
    if (scale !== null) {
      if (wants[0] !== "meal") {
        throw new ApiError(
          422,
          '"scale" is a portion of a saved meal, so it goes with "meal". A part of a single food is that food at fewer grams; an estimate is "adhoc_kcal" at the number you mean.',
        );
      }
      if (scale <= 0 || scale > MAX_SCALE) {
        throw new ApiError(
          422,
          `"scale" must be greater than 0 and at most ${MAX_SCALE} — 0.5 for half the usual portion, 2 for a double. A meal not eaten is not logged, and past ${MAX_SCALE}x the decimal point is usually in the wrong place.`,
        );
      }
    }

    if (b.adhoc_kcal !== undefined && b.adhoc_kcal !== null) {
      // A number, always. An "unknown" would be counted as zero by the intake
      // mean that feeds the expenditure back-solve; a day genuinely beyond
      // estimating is flagged incomplete instead, which excludes it entirely.
      const kcal = b.adhoc_kcal;
      if (kcal < 0) {
        throw new ApiError(422, '"adhoc_kcal" must be zero or more.');
      }
      await sql.begin((tx) =>
        insertEntry(tx, day, b.request_id, {
          foodId: null,
          grams: null,
          mealId: null,
          kcal,
          protein_g: b.adhoc_protein_g ?? null,
          carbs_g: null,
          fat_g: null,
          fiber_g: null,
          note,
        })
      );
      return c.json(await dayView(day), 201);
    }

    if (b.food !== undefined && b.food !== null) {
      const foodId = await resolveFoodId(b.food);
      const [food] = await sql`select * from foods where id = ${foodId}`;
      const grams = gramsEaten(
        b.grams ?? null,
        b.units ?? null,
        food.grams_per_unit === null ? null : Number(food.grams_per_unit),
        food.name,
      );
      await sql.begin((tx) =>
        insertEntry(tx, day, b.request_id, {
          foodId,
          grams,
          mealId: null,
          ...scaleFood(foodMacros(food), grams),
          note,
        })
      );
      return c.json(await dayView(day), 201);
    }

    const mealId = await resolveMealId(b.meal);
    const items = await sql`
    select mi.grams::float8, f.id as food_id, f.name,
      f.kcal_100g::float8, f.protein_100g::float8, f.carbs_100g::float8,
      f.fat_100g::float8, f.fiber_100g::float8
    from meal_items mi
    join foods f on f.id = mi.food_id
    where mi.meal_id = ${mealId}`;
    if (items.length === 0) {
      const [meal] = await sql`select name from meals where id = ${mealId}`;
      throw new ApiError(
        422,
        `"${meal.name}" has no foods in it, so there is nothing to log. Add its items first.`,
      );
    }

    // The snapshot, taken here: every item's numbers are copied onto its row.
    // One transaction — a half-logged meal would understate the day silently.
    await sql.begin(async (tx) => {
      for (const item of items) {
        // Rounded to the tenth the column stores, then the macros are taken
        // from that number rather than from the unrounded one — otherwise a
        // row's macros describe grams it does not claim to hold.
        const grams = Math.round(item.grams * (scale ?? 1) * 10) / 10;
        await insertEntry(tx, day, b.request_id, {
          foodId: item.food_id,
          grams,
          mealId,
          ...scaleFood(foodMacros(item), grams),
          note,
        });
      }
    });
    return c.json(await dayView(day), 201);
  },
);

// Correcting a past entry. The snapshot is the default, not a prison: when a
// food's numbers turn out to have been wrong, or the amount was misheard, the
// affected rows are fixed explicitly. Explicitly is the point — nothing here
// happens as a side effect of editing a food.
//
// Re-resolving from the food is the common case ("that yogurt was mislabelled,
// fix this week"), so sending only new grams re-scales from the food's numbers
// as they are *now*. Sending macros directly overrides them outright, which is
// what an ad-hoc correction needs.
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
    const id = c.req.valid("param").id;
    const [entry] = await sql`
    select * from intake_entries where id = ${id}`;
    if (!entry) {
      throw new ApiError(
        404,
        `No intake entry with id ${id}. GET /intake?day=YYYY-MM-DD lists a day's entries with their ids.`,
      );
    }

    const b = c.req.valid("json");
    const note = b.note !== undefined ? b.note : undefined;

    // The date was wrong; the food was not. Logging after midnight, or
    // reconstructing a day from memory, puts entries on the day either side of
    // the one meant. Without this the only repair was to delete each row and log
    // it again, which retypes every ad-hoc number by hand — and a typo made
    // while repairing looks exactly like a correct value.
    //
    // Only the day moves. Macros are not recomputed: this is the same food on a
    // different date, not a fresh log, and re-reading the food (or a meal's
    // recipe) would quietly write numbers that were never eaten.
    const rawDay = b.day ?? null;
    const day = rawDay === null
      ? null
      : requireNotFuture(rawDay, await romeToday(), "day");
    const grams = b.grams ?? null;
    const kcal = b.kcal ?? null;

    // "grams" answers every macro question by re-scaling from the food; a
    // direct macro is a second answer to one of them. Accepting both wrote a
    // row whose macros described the grams while the overridden field said
    // something else — the same contradiction checkEnergy refuses at food
    // creation, so it is refused here too.
    const overridden =
      (["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const)
        .filter((k) => b[k] !== undefined && b[k] !== null);
    if (grams !== null && overridden.length > 0) {
      throw new ApiError(
        422,
        `"grams" recomputes kcal and the macros from the food, so it cannot be combined with ${
          overridden.map((k) => `"${k}"`).join(", ")
        }. Send "grams" alone to re-scale, or the numbers alone to override them.`,
      );
    }

    if (grams !== null && entry.food_id === null) {
      throw new ApiError(
        422,
        'This is an ad-hoc entry, so it has no food to re-scale from. Correct it with "kcal" (and optionally "protein_g") directly.',
      );
    }

    const fields: Record<string, unknown> = {};
    if (note !== undefined) fields.note = note;
    if (day !== null) fields.day = day;

    if (grams !== null) {
      const [food] = await sql`select * from foods where id = ${entry.food_id}`;
      Object.assign(fields, { grams, ...scaleFood(foodMacros(food), grams) });
    }
    if (kcal !== null) fields.kcal = kcal;
    for (const macro of ["protein_g", "carbs_g", "fat_g", "fiber_g"] as const) {
      const value = b[macro] ?? null;
      if (value !== null) fields[macro] = value;
    }

    if (Object.keys(fields).length === 0) {
      throw new ApiError(
        422,
        'Send at least one of "day" (moves the entry to another date, numbers untouched), "grams" (re-scales from the food as it is now), "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", or "note". To remove an entry entirely, DELETE it.',
      );
    }

    await sql`update intake_entries set ${sql(fields)} where id = ${id}`;

    // The day the entry now lives on, not the one it left. Returning the old day
    // would show a view the entry is no longer in, which reads as a failed write.
    // moved_from names the other day when there is one: it also changed, and an
    // emptied day leaves the expenditure window entirely.
    const landedOn = day ?? entry.day;
    const view = await dayView(landedOn);
    return c.json(
      day !== null && day !== entry.day
        ? { ...view, moved_from: entry.day as string }
        : view,
    );
  },
);

// A mis-log ("I logged that twice") is removed, not zeroed: a zero-kcal row
// would count as a logged entry and quietly inflate adherence.
intake.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Nutrition"],
    summary: "Remove a logged entry",
    request: { params: z.object({ id: idParam("intake entry") }) },
    responses: {
      200: {
        description: "The day it was removed from, as it now stands.",
        content: { "application/json": { schema: DayView } },
      },
      404: { description: "No entry carries that id." },
    },
  }),
  async (c) => {
    const id = c.req.valid("param").id;
    const [entry] = await sql`
    delete from intake_entries where id = ${id} returning day`;
    if (!entry) throw new ApiError(404, `No intake entry with id ${id}.`);
    return c.json(await dayView(entry.day));
  },
);

// ---------------------------------------------------------------------------
// Day flags
// ---------------------------------------------------------------------------

// "I didn't track today at all." The day leaves the expenditure window rather
// than entering it as zero intake, which would drag the mean and bias the
// back-solve toward a lower expenditure. Removable: a flag is a statement
// about the record, not part of it.

const FLAGS = ["incomplete"] as const;

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
  async (c) => {
    const day = requireNotFuture(
      c.req.valid("param").day,
      await romeToday(),
      "day",
    );
    const { flag } = c.req.valid("json");
    await sql`
    insert into day_flags (day, flag) values (${day}, ${flag})
    on conflict (day, flag) do nothing`;
    return c.json(await dayView(day), 201);
  },
);

days.openapi(
  createRoute({
    method: "delete",
    path: "/{day}/flags/{flag}",
    tags: ["Nutrition"],
    summary: "Unflag a day",
    request: {
      params: z.object({ day: dayParam(), flag: z.string().min(1) }),
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
    const rows = await sql`
    delete from day_flags where day = ${day} and flag = ${flag} returning id`;
    if (rows.length === 0) {
      throw new ApiError(404, `${day} is not flagged "${flag}".`);
    }
    return c.json(await dayView(day));
  },
);

days.openapi(
  createRoute({
    method: "get",
    path: "/{day}",
    tags: ["Nutrition"],
    summary: "One day's entries, totals and flags",
    request: { params: z.object({ day: dayParam() }) },
    responses: {
      200: {
        description: "Everything logged on that day.",
        content: { "application/json": { schema: DayView } },
      },
    },
  }),
  async (c) => {
    return c.json(await dayView(c.req.valid("param").day));
  },
);
