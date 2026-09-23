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
import { checkEnergy, checkMacroMass } from "./rules.ts";
import {
  beginNutritionWrite,
  finishNutritionWrite,
  nutritionResolver,
  nutritionRows,
} from "./resolve.ts";
import type {
  CorrectedFood,
  CorrectFoodInput,
  FoodRow,
  SaveFoodInput,
} from "./foods.types.ts";

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
const columns = `f.id, f.name, f.brand, ${
  macros.map((k) => `f.${k} / 10.0 AS ${k}`).join(", ")
},
 f.grams_per_unit / 10.0 AS grams_per_unit, f.source, f.source_note,
 substr(f.created_at, 1, 23) || 'Z' AS created_at,
 (SELECT json_group_array(alias) FROM (SELECT alias FROM food_aliases WHERE food_id = f.id ORDER BY alias)) AS aliases`;
type StoredFood = Omit<FoodRow, "aliases"> & { aliases: string };
const decode = (r: StoredFood): FoodRow => ({
  ...r,
  aliases: JSON.parse(r.aliases),
});

export function foodStore(db: Database, clock: Clock = systemClock) {
  const resolver = nutritionResolver(db);
  const select = (where = "", ...values: Parameter[]) =>
    statement(
      db,
      `SELECT ${columns} FROM foods f ${where} ORDER BY f.name`,
      ...values,
    );
  const readResult = (result: Result): FoodRow =>
    decode(
      requireRow(
        result.results as unknown as StoredFood[],
        "The food could not be read after saving.",
      ),
    );
  async function foodById(id: number): Promise<FoodRow> {
    return decode(
      requireRow(
        (await select("WHERE f.id = ?", id).all<StoredFood>()).results,
        `No food with id ${id}. GET /foods?q=<search> lists them.`,
      ),
    );
  }
  async function foodByRef(ref: string) {
    return await foodById(await resolver.resolveFoodId(ref));
  }
  async function searchFoods(q?: string): Promise<FoodRow[]> {
    const term = q?.trim();
    // SQLite LIKE cannot fold Unicode. Names and aliases already carry Unicode keys;
    // brand matching is done in JS so its casing follows the same contract.
    const all = (await select().all<StoredFood>()).results.map(decode);
    if (!term) return all;
    const pattern = new RegExp(
      caseKey(term)
        .split("")
        .map((c) =>
          c === "%"
            ? ".*"
            : c === "_"
            ? "."
            : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        )
        .join(""),
      "su",
    );
    return all.filter((f) =>
      [f.name, f.brand, ...f.aliases].some(
        (v) => v !== null && pattern.test(caseKey(v)),
      )
    );
  }
  function aliases(key: Parameter, values: string[], byRequest = false) {
    return jsonChunks(
      values.map((alias) => ({ alias, key: caseKey(alias) })),
    ).flatMap((chunk) => [
      statement(
        db,
        `INSERT INTO food_aliases (food_id, alias, alias_key)
       SELECT f.id, json_extract(v.value, '$.alias'), json_extract(v.value, '$.key')
       FROM json_each(?) v CROSS JOIN foods f WHERE f.${
          byRequest ? "request_id" : "id"
        } = ? ORDER BY CAST(v.key AS INTEGER)`,
        chunk.json,
        key,
      ),
      nutritionRows(db, chunk.count),
    ]);
  }
  async function seen(uuid: string) {
    const found = (
      await select("WHERE f.request_id = ?", uuid).all<StoredFood>()
    ).results;
    return found[0] ? decode(found[0]) : undefined;
  }
  async function saveFood(
    b: SaveFoodInput,
  ): Promise<{ row: FoodRow; created: boolean }> {
    const uuid = requestId(b.request_id);
    const replay = await seen(uuid);
    if (replay) return { row: replay, created: false };
    try {
      await resolver.assertFoodAliasesFree(b.aliases ?? []);
      checkMacroMass(b.protein_100g, b.carbs_100g, b.fat_100g);
      checkEnergy(
        b.kcal_100g,
        b.protein_100g,
        b.carbs_100g,
        b.fat_100g,
        b.energy_check === "override",
        b.source_note ?? null,
      );
      const result = await batch(db, [
        beginNutritionWrite(db),
        statement(
          db,
          `INSERT INTO foods (name, name_key, brand, kcal_100g, protein_100g, carbs_100g, fat_100g, fiber_100g, grams_per_unit, source, source_note, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          b.name,
          caseKey(b.name),
          b.brand ?? null,
          decimal(b.kcal_100g, 6, 1),
          decimal(b.protein_100g, 5, 1),
          decimal(b.carbs_100g, 5, 1),
          decimal(b.fat_100g, 5, 1),
          decimal(b.fiber_100g ?? null, 5, 1),
          decimal(b.grams_per_unit ?? null, 6, 1),
          b.source,
          b.source_note ?? null,
          uuid,
          instant(clock().toISOString()),
        ),
        nutritionRows(db, 1),
        ...aliases(uuid, b.aliases ?? [], true),
        select("WHERE f.request_id = ?", uuid),
        finishNutritionWrite(db),
      ]);
      return { row: readResult(result.at(-2)!), created: true };
    } catch (error) {
      const replay = await seen(uuid);
      if (replay) return { row: replay, created: false };
      throw databaseError(error);
    }
  }
  async function correctFood(
    ref: string,
    b: CorrectFoodInput,
  ): Promise<CorrectedFood> {
    const id = await resolver.resolveFoodId(ref);
    const before = requireRow(
      await rows<FoodRow & { macro_revision: number }>(
        db,
        `SELECT ${columns}, f.macro_revision FROM foods f WHERE f.id = ?`,
        id,
      ),
      `No food with id ${id}.`,
    );
    const keys = fields.filter((k) => b[k] !== undefined);
    if (!keys.length) {
      throw new ApiError(
        422,
        "Send at least one of: name, brand, kcal_100g, protein_100g, carbs_100g, fat_100g, fiber_100g, grams_per_unit, source, source_note. A different product is not an edit — save it as a new food with POST /foods.",
      );
    }
    const merged = {
      ...before,
      ...Object.fromEntries(keys.map((k) => [k, b[k]])),
    };
    checkMacroMass(
      Number(merged.protein_100g),
      Number(merged.carbs_100g),
      Number(merged.fat_100g),
    );
    checkEnergy(
      Number(merged.kcal_100g),
      Number(merged.protein_100g),
      Number(merged.carbs_100g),
      Number(merged.fat_100g),
      b.energy_check === "override",
      merged.source_note,
    );
    const encoded = (k: (typeof fields)[number]): Parameter => {
      const v = b[k]!;
      return macros.includes(k as (typeof macros)[number]) ||
          k === "grams_per_unit"
        ? decimal(
          v as number | null,
          k === "kcal_100g" || k === "grams_per_unit" ? 6 : 5,
          1,
        )
        : v;
    };
    const changed = keys.filter((k) =>
      macros.includes(k as (typeof macros)[number])
    );
    const changeSQL = changed.map((k) => `${k} IS NOT ?`).join(" OR ") || "0";
    const result = await batch(db, [
      beginNutritionWrite(db),
      statement(
        db,
        `UPDATE foods SET ${keys.map((k) => `${k} = ?`).join(", ")}${
          b.name !== undefined ? ", name_key = ?" : ""
        },
       macro_revision = macro_revision + CASE WHEN ${changeSQL} THEN 1 ELSE 0 END
       WHERE id = ? AND macro_revision = ? RETURNING macro_revision`,
        ...keys.map(encoded),
        ...(b.name !== undefined ? [caseKey(b.name)] : []),
        ...changed.map(encoded),
        id,
        before.macro_revision,
      ),
      nutritionRows(db, 1),
      select("WHERE f.id = ?", id),
      statement(
        db,
        `SELECT count(*) AS count, min(day) AS "from", max(day) AS "to" FROM intake_entries WHERE food_id = ? AND EXISTS (SELECT 1 FROM foods WHERE id = ? AND macro_revision <> ?)`,
        id,
        id,
        before.macro_revision,
      ),
      finishNutritionWrite(db),
    ]).catch((error) => {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.message.includes("record changed")
      ) {
        throw new ApiError(
          409,
          "That food changed while this correction was being checked. Read GET /foods/:ref again, then resend the correction against its current values.",
        );
      }
      throw error;
    });
    const macrosChanged =
      (result[1].results[0].macro_revision as number) !== before.macro_revision;
    const affected = result.at(-2)!
      .results[0] as unknown as CorrectedFood["corrected_entries"];
    return {
      food: readResult(result.at(-3)!),
      corrected_entries: affected,
      note: macrosChanged
        ? `Corrected ${affected.count} logged ${
          affected.count === 1 ? "entry" : "entries"
        }: their totals now use the corrected food values, without changing what was eaten. Meals containing this food update on their own — their totals are computed, never stored.`
        : "No macros changed, so nothing logged was affected.",
    };
  }
  async function deleteFood(ref: string): Promise<string> {
    const id = await resolver.resolveFoodId(ref);
    const [{ entries, items }] = await rows<{ entries: number; items: number }>(
      db,
      `SELECT
      (SELECT count(*) FROM intake_entries WHERE food_id = ?) AS entries,
      (SELECT count(*) FROM meal_items WHERE food_id = ?) AS items`,
      id,
      id,
    );
    if (entries || items) {
      throw new ApiError(
        409,
        `That food is in use — ${entries} logged ${
          entries === 1 ? "entry" : "entries"
        } and ${items} meal ${
          items === 1 ? "item" : "items"
        } — so deleting it would orphan the record. If its numbers are wrong, PATCH /foods/:ref fixes them and every entry logged against them. If it is a duplicate, move its aliases to the food you are keeping.`,
      );
    }
    return requireRow(
      await rows<{ name: string }>(
        db,
        "DELETE FROM foods WHERE id = ? RETURNING name",
        id,
      ),
      `No food with id ${id}.`,
    ).name;
  }
  return {
    foodById,
    foodByRef,
    searchFoods,
    saveFood,
    correctFood,
    deleteFood,
  };
}
