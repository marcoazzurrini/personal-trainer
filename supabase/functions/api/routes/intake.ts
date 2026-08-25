import { Hono } from "@hono/hono";
import { sql, type Tx } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import {
  foodMacros,
  gramsEaten,
  scaleFood,
  sumMacros,
} from "../lib/nutrition.ts";
import { resolveFoodId, resolveMealId } from "../lib/resolve.ts";
import {
  optionalDate,
  optionalNumber,
  optionalString,
  readJson,
  requireIdParam,
  requireNotFuture,
  requireNumber,
  requireOneOf,
  requireUuid,
} from "../lib/validate.ts";

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

export const intake = new Hono();

// A day arrives in the path rather than the body, so validate.ts's body
// helpers don't fit.
function requireDayParam(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ApiError(
      422,
      `"${value}" is not a calendar date. Use YYYY-MM-DD, e.g. 2026-08-07.`,
    );
  }
  return value;
}

async function romeToday(): Promise<string> {
  const [row] = await sql`
    select (now() at time zone 'Europe/Rome')::date as today`;
  return row.today;
}

async function dayView(day: string) {
  const entries = await sql`
    select i.id, i.day, i.grams::float8, i.kcal::float8,
      i.protein_g::float8, i.carbs_g::float8, i.fat_g::float8,
      i.fiber_g::float8, i.note, i.created_at,
      i.food_id, f.name as food, i.meal_id, m.name as meal
    from intake_entries i
    left join foods f on f.id = i.food_id
    left join meals m on m.id = i.meal_id
    where i.day = ${day}
    order by i.created_at, i.id`;
  const flags = await sql`
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
  requestId: string | null,
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
       ${row.note}, ${requestId})`;
}

// Past this, a "portion" is a mistyped decimal. See the check below.
const MAX_SCALE = 10;

intake.get("/", async (c) => {
  const day = c.req.query("day") ?? await romeToday();
  return c.json(await dayView(day));
});

intake.post("/", async (c) => {
  const body = await readJson(c, [
    "day",
    "meal",
    "scale",
    "food",
    "grams",
    "units",
    "adhoc_kcal",
    "adhoc_protein_g",
    "note",
  ]);
  const requestId = requireUuid(body, "request_id");
  const today = await romeToday();
  const day = requireNotFuture(
    optionalDate(body, "day") ?? today,
    today,
    "day",
  );
  const note = optionalString(body, "note");

  if (requestId) {
    const [existing] = await sql`
      select 1 from intake_entries where request_id = ${requestId} limit 1`;
    if (existing) return c.json(await dayView(day));
  }

  const wants = ["meal", "food", "adhoc_kcal"].filter((k) =>
    body[k] !== undefined && body[k] !== null
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
  const scale = optionalNumber(body, "scale");
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

  if (body.adhoc_kcal !== undefined && body.adhoc_kcal !== null) {
    // A number, always. An "unknown" would be counted as zero by the intake
    // mean that feeds the expenditure back-solve; a day genuinely beyond
    // estimating is flagged incomplete instead, which excludes it entirely.
    const kcal = requireNumber(body, "adhoc_kcal");
    if (kcal < 0) {
      throw new ApiError(422, '"adhoc_kcal" must be zero or more.');
    }
    const protein = optionalNumber(body, "adhoc_protein_g", { min: 0 });
    await sql.begin((tx) =>
      insertEntry(tx, day, requestId, {
        foodId: null,
        grams: null,
        mealId: null,
        kcal,
        protein_g: protein,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        note,
      })
    );
    return c.json(await dayView(day), 201);
  }

  if (body.food !== undefined && body.food !== null) {
    const foodId = await resolveFoodId(body.food);
    const [food] = await sql`select * from foods where id = ${foodId}`;
    const grams = gramsEaten(
      optionalNumber(body, "grams", { min: 0 }),
      optionalNumber(body, "units", { min: 0 }),
      food.grams_per_unit === null ? null : Number(food.grams_per_unit),
      food.name,
    );
    await sql.begin((tx) =>
      insertEntry(tx, day, requestId, {
        foodId,
        grams,
        mealId: null,
        ...scaleFood(foodMacros(food), grams),
        note,
      })
    );
    return c.json(await dayView(day), 201);
  }

  const mealId = await resolveMealId(body.meal);
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
      await insertEntry(tx, day, requestId, {
        foodId: item.food_id,
        grams,
        mealId,
        ...scaleFood(foodMacros(item), grams),
        note,
      });
    }
  });
  return c.json(await dayView(day), 201);
});

// Correcting a past entry. The snapshot is the default, not a prison: when a
// food's numbers turn out to have been wrong, or the amount was misheard, the
// affected rows are fixed explicitly. Explicitly is the point — nothing here
// happens as a side effect of editing a food.
//
// Re-resolving from the food is the common case ("that yogurt was mislabelled,
// fix this week"), so sending only new grams re-scales from the food's numbers
// as they are *now*. Sending macros directly overrides them outright, which is
// what an ad-hoc correction needs.
intake.patch("/:id", async (c) => {
  const id = requireIdParam(c.req.param("id"), "intake entry");
  const [entry] = await sql`
    select * from intake_entries where id = ${id}`;
  if (!entry) {
    throw new ApiError(
      404,
      `No intake entry with id ${id}. GET /intake?day=YYYY-MM-DD lists a day's entries with their ids.`,
    );
  }

  const body = await readJson(c, [
    "day",
    "grams",
    "kcal",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "note",
  ]);
  const note = "note" in body ? optionalString(body, "note") : undefined;

  // The date was wrong; the food was not. Logging after midnight, or
  // reconstructing a day from memory, puts entries on the day either side of
  // the one meant. Without this the only repair was to delete each row and log
  // it again, which retypes every ad-hoc number by hand — and a typo made
  // while repairing looks exactly like a correct value.
  //
  // Only the day moves. Macros are not recomputed: this is the same food on a
  // different date, not a fresh log, and re-reading the food (or a meal's
  // recipe) would quietly write numbers that were never eaten.
  const rawDay = optionalDate(body, "day");
  const day = rawDay === null
    ? null
    : requireNotFuture(rawDay, await romeToday(), "day");
  const grams = optionalNumber(body, "grams", { min: 0 });
  const kcal = optionalNumber(body, "kcal", { min: 0 });

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
  for (const macro of ["protein_g", "carbs_g", "fat_g", "fiber_g"]) {
    const value = optionalNumber(body, macro, { min: 0 });
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
      ? { ...view, moved_from: entry.day }
      : view,
  );
});

// A mis-log ("I logged that twice") is removed, not zeroed: a zero-kcal row
// would count as a logged entry and quietly inflate adherence.
intake.delete("/:id", async (c) => {
  const id = requireIdParam(c.req.param("id"), "intake entry");
  const [entry] = await sql`
    delete from intake_entries where id = ${id} returning day`;
  if (!entry) throw new ApiError(404, `No intake entry with id ${id}.`);
  return c.json(await dayView(entry.day));
});

// ---------------------------------------------------------------------------
// Day flags
// ---------------------------------------------------------------------------

// "I didn't track today at all." The day leaves the expenditure window rather
// than entering it as zero intake, which would drag the mean and bias the
// back-solve toward a lower expenditure. Removable: a flag is a statement
// about the record, not part of it.

const FLAGS = ["incomplete"] as const;

export const days = new Hono();

days.post("/:day/flags", async (c) => {
  const day = requireNotFuture(
    requireDayParam(c.req.param("day")),
    await romeToday(),
    "day",
  );
  const body = await readJson(c, ["flag"]);
  const flag = requireOneOf(body, "flag", FLAGS);
  await sql`
    insert into day_flags (day, flag) values (${day}, ${flag})
    on conflict (day, flag) do nothing`;
  return c.json(await dayView(day), 201);
});

days.delete("/:day/flags/:flag", async (c) => {
  const day = requireDayParam(c.req.param("day"));
  const flag = c.req.param("flag");
  const rows = await sql`
    delete from day_flags where day = ${day} and flag = ${flag} returning id`;
  if (rows.length === 0) {
    throw new ApiError(404, `${day} is not flagged "${flag}".`);
  }
  return c.json(await dayView(day));
});

days.get("/:day", async (c) => {
  return c.json(await dayView(requireDayParam(c.req.param("day"))));
});
