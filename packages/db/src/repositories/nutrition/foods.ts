import { eq } from "drizzle-orm";

import type { Client } from "../../client.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import { batch, rows, statement } from "../../native.ts";
import type { Parameter } from "../../native.ts";
import { foods } from "../../schema/index.ts";
import { caseKey, scaledInteger } from "../../storage.ts";
import { jsonChunks } from "../../write.ts";
import {
  beginNutritionWrite,
  finishNutritionWrite,
  nutritionRows,
} from "./write.ts";

export interface FoodRecord {
  id: number;
  name: string;
  brand: string | null;
  kcal_100g: number;
  protein_100g: number;
  carbs_100g: number;
  fat_100g: number;
  fiber_100g: number | null;
  grams_per_unit: number | null;
  source: "label" | "crea" | "usda" | "off" | "estimate";
  source_note: string | null;
  created_at: string;
  aliases: string[];
}
export type FoodChanges = Partial<
  Pick<
    FoodRecord,
    "name" | "brand" | "source" | "source_note" | "grams_per_unit"
  >
> & {
  kcal_100g?: number | null;
  protein_100g?: number | null;
  carbs_100g?: number | null;
  fat_100g?: number | null;
  fiber_100g?: number | null;
};
export type NewFood = Omit<FoodRecord, "id"> & { request_id: string };
const macros = [
  "kcal_100g",
  "protein_100g",
  "carbs_100g",
  "fat_100g",
  "fiber_100g",
] as const;
const fields = [
  ...macros,
  "grams_per_unit",
  "name",
  "brand",
  "source",
  "source_note",
] as const;
const columns = `f.id, f.name, f.brand, ${macros.map((k) => `f.${k} / 10.0 AS ${k}`).join(", ")},
 f.grams_per_unit / 10.0 AS grams_per_unit, f.source, f.source_note, f.created_at,
 (SELECT json_group_array(alias) FROM (SELECT alias FROM food_aliases WHERE food_id = f.id ORDER BY alias)) AS aliases`;
type StoredFood = Omit<FoodRecord, "aliases"> & { aliases: string };
const decode = (row: StoredFood): FoodRecord => ({
  ...row,
  aliases: JSON.parse(row.aliases),
});
const scaled = (value: number | null | undefined, precision: number) =>
  value === null || value === undefined
    ? null
    : scaledInteger(value, precision, 1);
function isMacro(key: (typeof fields)[number]): key is (typeof macros)[number] {
  return macros.some((macro) => macro === key);
}
function encoded(input: FoodChanges, key: (typeof fields)[number]): Parameter {
  if (isMacro(key) || key === "grams_per_unit") {
    return scaled(
      input[key],
      key === "kcal_100g" || key === "grams_per_unit" ? 6 : 5
    );
  }
  return input[key] ?? null;
}
export function foodsRepository(db: Client) {
  const select = (where = "", ...values: Parameter[]) =>
    statement(
      db,
      `SELECT ${columns} FROM foods f ${where} ORDER BY f.name`,
      ...values
    );
  async function all() {
    return (
      await rows<StoredFood>(
        db,
        `SELECT ${columns} FROM foods f ORDER BY f.name`
      )
    ).map(decode);
  }
  async function byId(id: number) {
    return (
      await rows<StoredFood & { macro_revision: number }>(
        db,
        `SELECT ${columns}, f.macro_revision FROM foods f WHERE f.id = ?`,
        id
      )
    ).map((row) => ({ ...decode(row), macro_revision: row.macro_revision }));
  }
  async function byRequest(uuid: string) {
    const [row] = await rows<StoredFood>(
      db,
      `SELECT ${columns} FROM foods f WHERE f.request_id = ?`,
      uuid
    );
    return row ? decode(row) : undefined;
  }
  function aliases(uuid: string, values: readonly string[]) {
    return jsonChunks(
      values.map((alias) => ({ alias, key: caseKey(alias) }))
    ).flatMap((chunk) => [
      statement(
        db,
        `INSERT INTO food_aliases (food_id, alias, alias_key)
       SELECT f.id, json_extract(v.value, '$.alias'), json_extract(v.value, '$.key')
       FROM json_each(?) v CROSS JOIN foods f WHERE f.request_id = ? ORDER BY CAST(v.key AS INTEGER)`,
        chunk.json,
        uuid
      ),
      nutritionRows(db, chunk.count),
    ]);
  }
  async function save(input: NewFood) {
    const result = await batch<StoredFood>(db, [
      beginNutritionWrite(db),
      statement(
        db,
        `INSERT INTO foods (name, name_key, brand, kcal_100g, protein_100g, carbs_100g, fat_100g, fiber_100g, grams_per_unit, source, source_note, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.name,
        caseKey(input.name),
        input.brand,
        scaled(input.kcal_100g, 6),
        scaled(input.protein_100g, 5),
        scaled(input.carbs_100g, 5),
        scaled(input.fat_100g, 5),
        scaled(input.fiber_100g, 5),
        scaled(input.grams_per_unit, 6),
        input.source,
        input.source_note,
        input.request_id,
        input.created_at
      ),
      nutritionRows(db, 1),
      ...aliases(input.request_id, input.aliases),
      select("WHERE f.request_id = ?", input.request_id),
      finishNutritionWrite(db),
    ]);
    // The SELECT precedes the final assertion cleanup in every successful save.
    const selected = result.at(-2);
    if (!selected) {
      throw new Error("The food save batch returned no selection.");
    }
    return selected.results.map(decode);
  }
  async function correct(id: number, revision: number, input: FoodChanges) {
    const keys = fields.filter((key) => input[key] !== undefined);
    const changed = keys.filter(isMacro);
    const changeSQL =
      changed.map((key) => `${key} IS NOT ?`).join(" OR ") || "0";
    const result = await batch<
      | StoredFood
      | { macro_revision: number }
      | { count: number; from: string | null; to: string | null }
    >(db, [
      beginNutritionWrite(db),
      statement(
        db,
        `UPDATE foods SET ${keys.map((key) => `${key} = ?`).join(", ")}${input.name === undefined ? "" : ", name_key = ?"},
       macro_revision = macro_revision + CASE WHEN ${changeSQL} THEN 1 ELSE 0 END
       WHERE id = ? AND macro_revision = ? RETURNING macro_revision`,
        ...keys.map((key) => encoded(input, key)),
        ...(input.name === undefined ? [] : [caseKey(input.name)]),
        ...changed.map((key) => encoded(input, key)),
        id,
        revision
      ),
      nutritionRows(db, 1),
      select("WHERE f.id = ?", id),
      statement(
        db,
        `SELECT count(*) AS count, min(day) AS "from", max(day) AS "to" FROM intake_entries WHERE food_id = ? AND EXISTS (SELECT 1 FROM foods WHERE id = ? AND macro_revision <> ?)`,
        id,
        id,
        revision
      ),
      finishNutritionWrite(db),
    ]);
    // SAFETY: statement 1 returns macro_revision and its adjacent assertion requires one row.
    const updated = result[1].results as { macro_revision: number }[];
    // SAFETY: statement 3 uses the shared food projection.
    const selected = result[3].results as StoredFood[];
    // SAFETY: statement 4 selects count, from and to for affected intake entries.
    const affected = result[4].results as {
      count: number;
      from: string | null;
      to: string | null;
    }[];
    return {
      foods: selected.map(decode),
      macrosChanged: updated[0].macro_revision !== revision,
      affected: affected[0],
    };
  }
  async function usage(id: number) {
    const [record] = await rows<{ entries: number; items: number }>(
      db,
      `SELECT
      (SELECT count(*) FROM intake_entries WHERE food_id = ?) AS entries,
      (SELECT count(*) FROM meal_items WHERE food_id = ?) AS items`,
      id,
      id
    );
    return record;
  }
  async function remove(id: number) {
    try {
      return await db
        .delete(foods)
        .where(eq(foods.id, id))
        .returning({ name: foods.name });
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  return { all, byId, byRequest, save, correct, usage, remove };
}
export type FoodsRepository = ReturnType<typeof foodsRepository>;
