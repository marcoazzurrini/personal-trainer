import type { Client } from "../../client.ts";
import { batch, rows, statement } from "../../native.ts";
import type { Parameter } from "../../native.ts";
import { caseKey, scaledInteger } from "../../storage.ts";
import { jsonChunks } from "../../write.ts";
import {
  beginNutritionWrite,
  finishNutritionWrite,
  nutritionRows,
} from "./write.ts";

export interface MealHeader {
  id: number;
  name: string;
  created_at: string;
  aliases: string[];
}

export interface MealIngredient {
  food_id: number;
  food: string;
  brand: string | null;
  grams: number;
  kcal_100g: number;
  protein_100g: number;
  carbs_100g: number;
  fat_100g: number;
  fiber_100g: number | null;
}

export interface MealRecord {
  headers: MealHeader[];
  ingredients: MealIngredient[];
}

export interface MealPortion {
  foodId: number;
  grams: number;
}

type StoredHeader = Omit<MealHeader, "aliases"> & { aliases: string };
type Results = Awaited<ReturnType<typeof batch<StoredHeader | MealIngredient>>>;
const header = `m.id, m.name, m.created_at,
 (SELECT json_group_array(alias) FROM (SELECT alias FROM meal_aliases WHERE meal_id = m.id ORDER BY alias)) AS aliases`;

function mealResult(result: Results): MealRecord {
  // SAFETY: reads selects headers followed by ingredients; callers pass only that pair.
  const headers = result[0].results as StoredHeader[];
  // SAFETY: reads' second statement projects the ingredient fields.
  const ingredients = result[1].results as MealIngredient[];
  return {
    headers: headers.map((row) => ({
      ...row,
      aliases: JSON.parse(row.aliases),
    })),
    ingredients,
  };
}

export function mealsRepository(db: Client) {
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
        key
      ),
    ];
  }

  async function detail(id: number): Promise<MealRecord> {
    return mealResult(
      await batch<StoredHeader | MealIngredient>(db, reads(id))
    );
  }

  async function findRequest(uuid: string): Promise<MealRecord> {
    return mealResult(
      await batch<StoredHeader | MealIngredient>(db, reads(uuid, true))
    );
  }

  async function list(): Promise<(MealHeader & { items: number })[]> {
    return (
      await rows<StoredHeader & { items: number }>(
        db,
        `SELECT ${header}, (SELECT count(*) FROM meal_items WHERE meal_id = m.id) AS items FROM meals m ORDER BY m.name`
      )
    ).map((row) => ({ ...row, aliases: JSON.parse(row.aliases) }));
  }

  function children(
    key: Parameter,
    aliases: readonly string[],
    items: readonly MealPortion[],
    byRequest = false
  ) {
    const where = `m.${byRequest ? "request_id" : "id"} = ?`;
    return [
      ...jsonChunks(
        aliases.map((alias) => ({ alias, key: caseKey(alias) }))
      ).flatMap((chunk) => [
        statement(
          db,
          `INSERT INTO meal_aliases (meal_id, alias, alias_key) SELECT m.id, json_extract(v.value, '$.alias'), json_extract(v.value, '$.key')
       FROM json_each(?) v CROSS JOIN meals m WHERE ${where} ORDER BY CAST(v.key AS INTEGER)`,
          chunk.json,
          key
        ),
        nutritionRows(db, chunk.count),
      ]),
      ...jsonChunks(
        items.map((item) => ({
          foodId: item.foodId,
          grams: scaledInteger(item.grams, 7, 1),
        }))
      ).flatMap((chunk) => [
        statement(
          db,
          `INSERT INTO meal_items (meal_id, food_id, grams) SELECT m.id, json_extract(v.value, '$.foodId'), json_extract(v.value, '$.grams')
         FROM json_each(?) v CROSS JOIN meals m WHERE ${where} ORDER BY CAST(v.key AS INTEGER)`,
          chunk.json,
          key
        ),
        nutritionRows(db, chunk.count),
      ]),
    ];
  }

  async function save(input: {
    name: string;
    items: readonly MealPortion[];
    aliases: readonly string[];
    requestId: string;
    createdAt: string;
  }): Promise<MealRecord> {
    const result = await batch<StoredHeader | MealIngredient>(db, [
      beginNutritionWrite(db),
      statement(
        db,
        "INSERT INTO meals (name, name_key, request_id, created_at) VALUES (?, ?, ?, ?)",
        input.name,
        caseKey(input.name),
        input.requestId,
        input.createdAt
      ),
      nutritionRows(db, 1),
      ...children(input.requestId, input.aliases, input.items, true),
      ...reads(input.requestId, true),
      finishNutritionWrite(db),
    ]);
    return mealResult(result.slice(-3, -1));
  }

  async function edit(
    id: number,
    input: {
      name: string | null;
      items?: readonly MealPortion[];
      aliases: readonly string[];
    }
  ): Promise<MealRecord> {
    const result = await batch<StoredHeader | MealIngredient>(db, [
      beginNutritionWrite(db),
      statement(
        db,
        "UPDATE meals SET name = coalesce(?, name), name_key = coalesce(?, name_key) WHERE id = ?",
        input.name,
        input.name === null ? null : caseKey(input.name),
        id
      ),
      nutritionRows(db, 1),
      ...(input.items === undefined
        ? []
        : [statement(db, "DELETE FROM meal_items WHERE meal_id = ?", id)]),
      ...children(id, input.aliases, input.items ?? []),
      ...reads(id),
      finishNutritionWrite(db),
    ]);
    return mealResult(result.slice(-3, -1));
  }

  return { detail, byRequest: findRequest, list, save, edit };
}

export type MealsRepository = ReturnType<typeof mealsRepository>;
