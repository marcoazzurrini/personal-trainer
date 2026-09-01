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

import { sql, type Tx } from "../db.ts";
import { requireNotFuture } from "../rules/dates.ts";
import { ApiError, requireRow } from "../http/errors.ts";
import {
  foodMacros,
  gramsEaten,
  type MacroTotals,
  scaleFood,
  sumMacros,
} from "../rules/nutrition.ts";
import { writeOnce } from "../record/idempotency.ts";
import { romeToday } from "../record/calendar.ts";
import { resolveFoodId, resolveMealId } from "../record/resolve.ts";

export interface IntakeEntry {
  id: number;
  day: string;
  grams: number | null;
  kcal: number;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  note: string | null;
  created_at: string;
  food_id: number | null;
  food: string | null;
  meal_id: number | null;
  meal: string | null;
}

export interface DayView {
  day: string;
  entries: IntakeEntry[];
  totals: MacroTotals;
  flags: string[];
}

/** "I didn't track today at all." See flagDay for what the flag buys. */
export const FLAGS = ["incomplete"] as const;

// Past this, a "portion" is a mistyped decimal. See the check in logIntake.
const MAX_SCALE = 10;

/**
 * A day's entries, totals and flags.
 *
 * Omit the day for today in Europe/Rome. That default cannot live in the
 * request schema, because which day it is now is a question for Postgres and
 * not for the caller — it is the whole reason GET /intake answers without
 * being told a date.
 */
export async function viewDay(day?: string | null): Promise<DayView> {
  return await dayView(day ?? await romeToday());
}

async function dayView(day: string): Promise<DayView> {
  const entries = await sql<IntakeEntry[]>`
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

/** A food or meal named by id, name, or alias. */
type Reference = string | number;

export interface LogInput {
  day?: string | null;
  meal?: Reference | null;
  scale?: number | null;
  food?: Reference | null;
  grams?: number | null;
  units?: number | null;
  adhoc_kcal?: number | null;
  adhoc_protein_g?: number | null;
  note?: string | null;
  request_id: string;
}

/**
 * Logs one of a meal, a food, or an ad-hoc estimate, and answers with the day.
 *
 * `created` is false when this request_id has already logged — the retry is
 * answered with the day unchanged rather than logging it twice.
 */
export async function logIntake(
  b: LogInput,
): Promise<{ view: DayView; created: boolean }> {
  const today = await romeToday();
  const day = requireNotFuture(b.day ?? today, today, "day");
  const note = b.note ?? null;

  const { body: view, status } = await writeOnce<
    { logged: number },
    DayView,
    DayView
  >({
    table: "intake_entries",
    requestId: b.request_id,
    // The entry's own columns are never needed: a logged day is answered
    // with the whole day, which gets read again either way.
    select: sql`1 as logged`,
    replay: () => dayView(day),
    write: async () => {
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
        return await dayView(day);
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
        return await dayView(day);
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
      return await dayView(day);
    },
  });
  return { view, created: status === 201 };
}

export interface CorrectInput {
  day?: string | null;
  grams?: number | null;
  kcal?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
  fiber_g?: number | null;
  note?: string | null;
}

/**
 * Corrects one logged entry, and answers with the day it now lives on.
 *
 * The snapshot is the default, not a prison: when a food's numbers turn out to
 * have been wrong, or the amount was misheard, the affected rows are fixed
 * explicitly. Explicitly is the point — nothing here happens as a side effect
 * of editing a food.
 *
 * Re-resolving from the food is the common case ("that yogurt was mislabelled,
 * fix this week"), so sending only new grams re-scales from the food's numbers
 * as they are *now*. Sending macros directly overrides them outright, which is
 * what an ad-hoc correction needs.
 *
 * `movedFrom` names the day the entry left, when it left one.
 */
export async function correctEntry(
  id: number,
  b: CorrectInput,
): Promise<{ view: DayView; movedFrom: string | null }> {
  const entry = requireRow(
    await sql`
    select * from intake_entries where id = ${id}`,
    `No intake entry with id ${id}. GET /intake?day=YYYY-MM-DD lists a day's entries with their ids.`,
  );

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
  return {
    view: await dayView(landedOn),
    movedFrom: day !== null && day !== entry.day ? entry.day as string : null,
  };
}

// A mis-log ("I logged that twice") is removed, not zeroed: a zero-kcal row
// would count as a logged entry and quietly inflate adherence.
export async function removeEntry(id: number): Promise<DayView> {
  const entry = requireRow(
    await sql`
    delete from intake_entries where id = ${id} returning day`,
    `No intake entry with id ${id}.`,
  );
  return await dayView(entry.day);
}

/**
 * Flags a day.
 *
 * `incomplete` takes the day out of the expenditure window rather than letting
 * it enter as zero intake, which would drag the mean and bias the back-solve
 * toward a lower expenditure. Removable: a flag is a statement about the
 * record, not part of it.
 */
export async function flagDay(day: string, flag: string): Promise<DayView> {
  const on = requireNotFuture(day, await romeToday(), "day");
  await sql`
    insert into day_flags (day, flag) values (${on}, ${flag})
    on conflict (day, flag) do nothing`;
  return await dayView(on);
}

export async function unflagDay(day: string, flag: string): Promise<DayView> {
  requireRow(
    await sql`
    delete from day_flags where day = ${day} and flag = ${flag} returning id`,
    `${day} is not flagged "${flag}".`,
  );
  return await dayView(day);
}
