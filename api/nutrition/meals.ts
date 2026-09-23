import {
  batch,
  caseKey,
  type Clock,
  type Database,
  databaseError,
  decimal,
  instant,
  jsonChunks,
  type Parameter,
  requestId,
  type Result,
  rows,
  statement,
  systemClock,
} from "../shared/d1.ts";
import { ApiError, requireRow } from "../shared/errors.ts";
import { foodMacros, scaleFood, sumMacros } from "./rules.ts";
import type { FoodMacros } from "./rules.ts";
import type { ItemInput, MealDetail, MealSummary } from "./meals.types.ts";
import {
  beginNutritionWrite,
  finishNutritionWrite,
  nutritionResolver,
  nutritionRows,
} from "./resolve.ts";

type Header = Pick<MealDetail, "id" | "name" | "created_at"> & {
  aliases: string;
};
type Item = FoodMacros & {
  food_id: number;
  food: string;
  brand: string | null;
  grams: number;
};
const header = `m.id, m.name, substr(m.created_at, 1, 23) || 'Z' AS created_at,
 (SELECT json_group_array(alias) FROM (SELECT alias FROM meal_aliases WHERE meal_id = m.id ORDER BY alias)) AS aliases`;

export function mealStore(db: Database, clock: Clock = systemClock) {
  const resolver = nutritionResolver(db);
  function reads(key: Parameter, byRequest = false) {
    const where = `m.${byRequest ? "request_id" : "id"} = ?`;
    return [
      statement(db, `SELECT ${header} FROM meals m WHERE ${where}`, key),
      statement(
        db,
        `SELECT mi.grams / 10.0 AS grams, f.id AS food_id, f.name AS food, f.brand,
       f.kcal_100g / 10.0 AS kcal_100g, f.protein_100g / 10.0 AS protein_100g, f.carbs_100g / 10.0 AS carbs_100g,
       f.fat_100g / 10.0 AS fat_100g, f.fiber_100g / 10.0 AS fiber_100g
       FROM meal_items mi JOIN meals m ON m.id = mi.meal_id JOIN foods f ON f.id = mi.food_id WHERE ${where} ORDER BY f.name`,
        key,
      ),
    ];
  }
  function detail(result: Result[]): MealDetail {
    const h = requireRow(
      result[0].results as unknown as Header[],
      "The meal could not be read after saving.",
    );
    const items = (result[1].results as unknown as Item[]).map((i) => ({
      food_id: i.food_id,
      food: i.food,
      brand: i.brand,
      grams: i.grams,
      ...scaleFood(foodMacros(i), i.grams),
    }));
    return {
      ...h,
      aliases: JSON.parse(h.aliases),
      items,
      totals: sumMacros(items),
    };
  }
  async function mealDetail(id: number): Promise<MealDetail> {
    return detail(await batch(db, reads(id)));
  }
  async function mealByRef(ref: string) {
    return await mealDetail(await resolver.resolveMealId(ref));
  }
  async function listMeals(): Promise<MealSummary[]> {
    return (
      await rows<Header & { items: number }>(
        db,
        `SELECT ${header}, (SELECT count(*) FROM meal_items WHERE meal_id = m.id) AS items FROM meals m ORDER BY m.name`,
      )
    ).map((h) => ({ ...h, aliases: JSON.parse(h.aliases) }));
  }
  async function prepare(entries: readonly ItemInput[]) {
    const ids = await resolver.resolveFoodIds(entries.map((e) => e.food));
    return entries.map((e, i) => ({
      foodId: ids[i],
      grams: decimal(e.grams, 7, 1),
    }));
  }
  function children(
    key: Parameter,
    aliases: string[],
    items: Awaited<ReturnType<typeof prepare>>,
    byRequest = false,
  ) {
    const where = `m.${byRequest ? "request_id" : "id"} = ?`;
    return [
      ...jsonChunks(
        aliases.map((alias) => ({ alias, key: caseKey(alias) })),
      ).flatMap((chunk) => [
        statement(
          db,
          `INSERT INTO meal_aliases (meal_id, alias, alias_key) SELECT m.id, json_extract(v.value, '$.alias'), json_extract(v.value, '$.key')
       FROM json_each(?) v CROSS JOIN meals m WHERE ${where} ORDER BY CAST(v.key AS INTEGER)`,
          chunk.json,
          key,
        ),
        nutritionRows(db, chunk.count),
      ]),
      ...jsonChunks(items).flatMap((chunk) => [
        statement(
          db,
          `INSERT INTO meal_items (meal_id, food_id, grams) SELECT m.id, json_extract(v.value, '$.foodId'), json_extract(v.value, '$.grams')
         FROM json_each(?) v CROSS JOIN meals m WHERE ${where} ORDER BY CAST(v.key AS INTEGER)`,
          chunk.json,
          key,
        ),
        nutritionRows(db, chunk.count),
      ]),
    ];
  }
  async function seen(uuid: string) {
    const result = await batch(db, reads(uuid, true));
    return result[0].results.length ? detail(result) : undefined;
  }
  async function saveMeal(b: {
    name: string;
    items: ItemInput[];
    aliases?: string[] | null;
    request_id: string;
  }): Promise<{ meal: MealDetail; created: boolean }> {
    const uuid = requestId(b.request_id);
    const replay = await seen(uuid);
    if (replay) return { meal: replay, created: false };
    try {
      await resolver.assertMealAliasesFree(b.aliases ?? []);
      const items = await prepare(b.items);
      const result = await batch(db, [
        beginNutritionWrite(db),
        statement(
          db,
          "INSERT INTO meals (name, name_key, request_id, created_at) VALUES (?, ?, ?, ?)",
          b.name,
          caseKey(b.name),
          uuid,
          instant(clock().toISOString()),
        ),
        nutritionRows(db, 1),
        ...children(uuid, b.aliases ?? [], items, true),
        ...reads(uuid, true),
        finishNutritionWrite(db),
      ]);
      return { meal: detail(result.slice(-3, -1)), created: true };
    } catch (error) {
      const replay = await seen(uuid);
      if (replay) return { meal: replay, created: false };
      throw databaseError(error);
    }
  }
  async function editMeal(
    ref: string,
    b: { name?: string; items?: ItemInput[]; aliases?: string[] | null },
  ): Promise<{ meal: MealDetail; note: string }> {
    const id = await resolver.resolveMealId(ref);
    const name = b.name ?? null;
    if (name === null && b.items === undefined && b.aliases === undefined) {
      throw new ApiError(
        422,
        'Send at least one of "name", "aliases" (added, not replaced), or "items" (the complete replacement list).',
      );
    }
    const items = b.items !== undefined ? await prepare(b.items) : [];
    await resolver.assertMealAliasesFree(b.aliases ?? []);
    const result = await batch(db, [
      beginNutritionWrite(db),
      statement(
        db,
        "UPDATE meals SET name = coalesce(?, name), name_key = coalesce(?, name_key) WHERE id = ?",
        name,
        name === null ? null : caseKey(name),
        id,
      ),
      nutritionRows(db, 1),
      ...(b.items !== undefined
        ? [statement(db, "DELETE FROM meal_items WHERE meal_id = ?", id)]
        : []),
      ...children(id, b.aliases ?? [], items),
      ...reads(id),
      finishNutritionWrite(db),
    ]);
    return {
      meal: detail(result.slice(-3, -1)),
      note:
        "Future logs of this meal use the new items. Everything already logged is untouched — intake entries carry the numbers they were logged with.",
    };
  }
  return { mealDetail, mealByRef, listMeals, saveMeal, editMeal };
}
