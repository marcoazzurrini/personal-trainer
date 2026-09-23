import {
  batch,
  type Clock,
  type Database,
  databaseError,
  date,
  decimal,
  instant,
  type Parameter,
  requestId,
  type Result,
  romeDate,
  rows,
  statement,
  systemClock,
} from "../shared/d1.ts";
import { requireNotFuture } from "../shared/dates.ts";
import { ApiError, requireRow } from "../shared/errors.ts";
import { gramsEaten, sumMacros } from "./rules.ts";
import type {
  CorrectInput,
  DayView,
  IntakeEntry,
  LogInput,
} from "./intake.types.ts";
import {
  beginNutritionWrite,
  finishNutritionWrite,
  nutritionCheck,
  nutritionResolver,
  nutritionRows,
} from "./resolve.ts";

const MAX_SCALE = 10;
const MACROS = ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const;
const per100g = {
  kcal: "kcal_100g",
  protein_g: "protein_100g",
  carbs_g: "carbs_100g",
  fat_g: "fat_100g",
  fiber_g: "fiber_100g",
};

export function intakeStore(db: Database, clock: Clock = systemClock) {
  const resolver = nutritionResolver(db);
  const today = () => romeDate(instant(clock().toISOString()));
  function dayReads(day: string, byEntry = false) {
    const on = byEntry ? "(SELECT day FROM intake_entries WHERE id = ?)" : "?";
    return [
      statement(
        db,
        `SELECT i.id, i.day, i.grams, i.kcal, i.protein_g, i.carbs_g, i.fat_g, i.fiber_g, i.note,
      substr(i.created_at, 1, 23) || 'Z' AS created_at, i.food_id, f.name AS food, i.meal_id, m.name AS meal
      FROM intake_values i LEFT JOIN foods f ON f.id = i.food_id LEFT JOIN meals m ON m.id = i.meal_id
      WHERE i.day = ${on} ORDER BY i.created_at, i.id`,
        day,
      ),
      statement(
        db,
        `SELECT flag FROM day_flags WHERE day = ${on} ORDER BY flag`,
        day,
      ),
    ];
  }
  function view(day: string, result: Result[]): DayView {
    const entries = result[0].results as unknown as IntakeEntry[];
    return {
      day,
      entries,
      totals: sumMacros(entries),
      flags: result[1].results.map((r) => r.flag as string),
    };
  }
  async function viewDay(day?: string | null): Promise<DayView> {
    const on = date(day ?? today());
    return view(on, await batch(db, dayReads(on)));
  }
  async function seen(uuid: string) {
    const [entry] = await rows<{ day: string }>(
      db,
      "SELECT day FROM intake_entries WHERE request_id = ? ORDER BY id LIMIT 1",
      uuid,
    );
    return entry ? await viewDay(entry.day) : undefined;
  }
  async function logIntake(
    b: LogInput,
  ): Promise<{ view: DayView; created: boolean }> {
    const uuid = requestId(b.request_id);
    const replay = await seen(uuid);
    if (replay) return { view: replay, created: false };
    try {
      const day = requireNotFuture(date(b.day ?? today()), today(), "day");
      const note = b.note ?? null;
      const wants = (["meal", "food", "adhoc_kcal"] as const).filter(
        (k) => b[k] !== undefined && b[k] !== null,
      );
      if (wants.length !== 1) {
        throw new ApiError(
          422,
          wants.length === 0
            ? 'An intake entry is one of three things: "meal" (a saved meal by id, name, or alias), "food" plus "grams" or "units", or "adhoc_kcal" for an estimated entry. Send exactly one.'
            : `Send exactly one of "meal", "food", "adhoc_kcal" — got ${
              wants.join(
                " and ",
              )
            }. A meal plus an extra food is two calls, which is also how a variation on a routine gets logged.`,
        );
      }

      for (const field of ["grams", "units"] as const) {
        if (b[field] != null && wants[0] !== "food") {
          throw new ApiError(
            422,
            `"${field}" goes with "food". For a saved meal send "scale"; for an estimate send "adhoc_kcal" at the number you mean.`,
          );
        }
      }
      if (b.adhoc_protein_g != null && wants[0] !== "adhoc_kcal") {
        throw new ApiError(
          422,
          '"adhoc_protein_g" goes with "adhoc_kcal". Food and meal protein is computed from the saved food and quantity; omit the ad-hoc protein field.',
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

      const writes = [
        beginNutritionWrite(db),
        nutritionCheck(
          db,
          "NOT EXISTS (SELECT 1 FROM intake_entries WHERE request_id = ?)",
          uuid,
        ),
      ];
      const now = instant(clock().toISOString());
      if (b.adhoc_kcal != null) {
        if (b.adhoc_kcal < 0) {
          throw new ApiError(422, '"adhoc_kcal" must be zero or more.');
        }
        writes.push(
          statement(
            db,
            `INSERT INTO intake_entries (day, kcal, protein_g, note, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            day,
            decimal(b.adhoc_kcal, 7, 1),
            decimal(b.adhoc_protein_g ?? null, 6, 1),
            note,
            uuid,
            now,
          ),
          nutritionRows(db, 1),
        );
      } else if (b.food != null) {
        const foodId = await resolver.resolveFoodId(b.food);
        const food = requireRow(
          await rows<{ name: string; grams_per_unit: number | null }>(
            db,
            "SELECT name, grams_per_unit / 10.0 AS grams_per_unit FROM foods WHERE id = ?",
            foodId,
          ),
          `No food with id ${foodId}.`,
        );
        const grams = gramsEaten(
          b.grams ?? null,
          b.units ?? null,
          food.grams_per_unit,
          food.name,
        );
        if (b.units != null) {
          writes.push(
            nutritionCheck(
              db,
              "EXISTS (SELECT 1 FROM foods WHERE id = ? AND grams_per_unit IS ?)",
              foodId,
              decimal(food.grams_per_unit, 6, 1),
            ),
          );
        }
        writes.push(
          statement(
            db,
            `INSERT INTO intake_entries (day, food_id, grams, note, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            day,
            foodId,
            decimal(grams, 7, 1),
            note,
            uuid,
            now,
          ),
          nutritionRows(db, 1),
        );
      } else {
        const mealId = await resolver.resolveMealId(b.meal);
        const [meal] = await rows<{ name: string; items: number }>(
          db,
          "SELECT name, (SELECT count(*) FROM meal_items WHERE meal_id = m.id) AS items FROM meals m WHERE id = ?",
          mealId,
        );
        if (!meal?.items) {
          throw new ApiError(
            422,
            `"${meal?.name}" has no foods in it, so there is nothing to log. Add its items first.`,
          );
        }
        // Copy the current recipe inside the batch, not a recipe read before it.
        // Preserve the public Math.round(grams * scale * 10) operation order,
        // including binary floating-point ties, without reading recipes outside the batch.
        writes.push(
          statement(
            db,
            `WITH portions AS (
          SELECT id, food_id, meal_id, grams / 10.0 * ? * 10 AS amount FROM meal_items WHERE meal_id = ?
        ) INSERT INTO intake_entries (day, food_id, grams, meal_id, note, request_id, created_at)
          SELECT ?, food_id, CAST(amount AS INTEGER) + (amount - CAST(amount AS INTEGER) >= 0.5), meal_id, ?, ?, ?
          FROM portions ORDER BY id`,
            scale ?? 1,
            mealId,
            day,
            note,
            uuid,
            now,
          ),
          nutritionCheck(db, "changes() > 0"),
        );
      }
      const result = await batch(db, [
        ...writes,
        ...dayReads(day),
        finishNutritionWrite(db),
      ]);
      return { view: view(day, result.slice(-3, -1)), created: true };
    } catch (error) {
      const replay = await seen(uuid);
      if (replay) return { view: replay, created: false };
      throw databaseError(error);
    }
  }
  async function correctEntry(
    id: number,
    b: CorrectInput,
  ): Promise<{ view: DayView; movedFrom: string | null }> {
    const entry = requireRow(
      await rows<{ day: string; food_id: number | null }>(
        db,
        "SELECT day, food_id FROM intake_entries WHERE id = ?",
        id,
      ),
      `No intake entry with id ${id}. GET /intake?day=YYYY-MM-DD lists a day's entries with their ids.`,
    );
    const note = b.note !== undefined ? b.note : undefined;

    // The date was wrong; the food was not. Logging after midnight, or
    // reconstructing a day from memory, puts entries on the day either side of
    // the one meant. Without this the only repair was to delete each row and log
    // it again, which retypes every ad-hoc number by hand — and a typo made
    // while repairing looks exactly like a correct value.
    //
    // Only the day moves. Ingredients, quantities and overrides stay untouched;
    // no recipe is re-read and no override is replaced by derived values.
    const rawDay = b.day ?? null;
    const day = rawDay === null
      ? null
      : requireNotFuture(date(rawDay), today(), "day");
    const grams = b.grams == null ? null : gramsEaten(b.grams, null, null, "");

    // "grams" answers every macro question by re-scaling from the food; a
    // direct macro is a second answer to one of them. Accepting both wrote a
    // row whose macros described the grams while the overridden field said
    // something else — the same contradiction checkEnergy refuses at food
    // creation, so it is refused here too.
    const overridden = (
      ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const
    ).filter((k) => b[k] !== undefined && b[k] !== null);
    if (grams !== null && overridden.length > 0) {
      throw new ApiError(
        422,
        `"grams" recomputes kcal and the macros from the food, so it cannot be combined with ${
          overridden
            .map((k) => `"${k}"`)
            .join(
              ", ",
            )
        }. Send "grams" alone to re-scale, or the numbers alone to override them.`,
      );
    }

    if (grams !== null && entry.food_id === null) {
      throw new ApiError(
        422,
        'This is an ad-hoc entry, so it has no food to re-scale from. Correct it with "kcal" (and optionally "protein_g") directly.',
      );
    }

    const updates: string[] = [];
    const values: Parameter[] = [];
    const set = (key: string, value: Parameter) => {
      updates.push(`${key} = ?`);
      values.push(value);
    };
    if (note !== undefined) set("note", note);
    if (day !== null) set("day", day);
    if (grams !== null) {
      set("grams", decimal(grams, 7, 1));
      updates.push(
        "food_macro_revision = NULL",
        ...MACROS.map((m) => `${m} = NULL`),
      );
    }
    for (const macro of MACROS) {
      if (b[macro] != null) {
        set(macro, decimal(b[macro]!, macro === "kcal" ? 7 : 6, 1));
      } else if (entry.food_id !== null && overridden.length) {
        updates.push(`${macro} = CASE
        WHEN i.food_macro_revision = (SELECT macro_revision FROM foods WHERE id = i.food_id) THEN i.${macro}
        ELSE (SELECT (${
          per100g[macro]
        } * i.grams + 500) / 1000 FROM foods WHERE id = i.food_id) END`);
      }
    }
    if (entry.food_id !== null && overridden.length) {
      updates.push(
        "food_macro_revision = (SELECT macro_revision FROM foods WHERE id = i.food_id)",
      );
    }
    if (!updates.length) {
      throw new ApiError(
        422,
        'Send at least one of "day" (moves the entry to another date, numbers untouched), "grams" (re-scales from the food as it is now), "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", or "note". To remove an entry entirely, DELETE it.',
      );
    }
    const result = await batch(db, [
      beginNutritionWrite(db),
      statement(db, "SELECT day FROM intake_entries WHERE id = ?", id),
      statement(
        db,
        `UPDATE intake_entries AS i SET ${
          updates.join(", ")
        } WHERE id = ? RETURNING day`,
        ...values,
        id,
      ),
      nutritionRows(db, 1),
      ...dayReads(String(id), true),
      finishNutritionWrite(db),
    ]);
    const previous = result[1].results[0].day as string;
    const landed = result[2].results[0].day as string;
    return {
      view: view(landed, result.slice(-3, -1)),
      movedFrom: landed !== previous ? previous : null,
    };
  }
  async function removeEntry(id: number): Promise<DayView> {
    const entry = requireRow(
      await rows<{ day: string }>(
        db,
        "DELETE FROM intake_entries WHERE id = ? RETURNING day",
        id,
      ),
      `No intake entry with id ${id}.`,
    );
    return await viewDay(entry.day);
  }
  async function flagDay(day: string, flag: string): Promise<DayView> {
    const on = requireNotFuture(date(day), today(), "day");
    const result = await batch(db, [
      statement(
        db,
        "INSERT INTO day_flags (day, flag, created_at) VALUES (?, ?, ?) ON CONFLICT (day, flag) DO NOTHING",
        on,
        flag,
        instant(clock().toISOString()),
      ),
      ...dayReads(on),
    ]);
    return view(on, result.slice(-2));
  }
  async function unflagDay(day: string, flag: string): Promise<DayView> {
    const on = date(day);
    const result = await batch(db, [
      statement(
        db,
        "DELETE FROM day_flags WHERE day = ? AND flag = ? RETURNING id",
        on,
        flag,
      ),
      ...dayReads(on),
    ]);
    requireRow(result[0].results, `${day} is not flagged "${flag}".`);
    return view(on, result.slice(-2));
  }
  return { viewDay, logIntake, correctEntry, removeEntry, flagDay, unflagDay };
}
