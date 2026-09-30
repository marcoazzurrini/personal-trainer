import type {
  FoodsRepository,
  FoodRecord,
} from "../../db/repositories/nutrition/foods.ts";
import { ApiError, databaseError, requireRow } from "../shared/errors.ts";
import {
  caseKey,
  decimal,
  instant,
  requestId,
  systemClock,
  wireInstant,
} from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import type {
  CorrectedFood,
  CorrectFoodInput,
  FoodRow,
  SaveFoodInput,
} from "./foods.types.ts";
import type { NutritionResolver } from "./resolve.ts";
import { checkEnergy, checkMacroMass } from "./rules.ts";

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
const wireFood = (row: FoodRecord): FoodRow => ({
  ...row,
  created_at: wireInstant(row.created_at),
});
function validateNumbers(input: CorrectFoodInput) {
  for (const key of [...macros, "grams_per_unit"] as const) {
    if (input[key] !== undefined) {
      decimal(
        input[key] ?? null,
        key === "kcal_100g" || key === "grams_per_unit" ? 6 : 5,
        1
      );
    }
  }
}
export function foodStore(
  repository: FoodsRepository,
  resolver: NutritionResolver,
  clock: Clock = systemClock
) {
  async function foodById(id: number): Promise<FoodRow> {
    const { macro_revision: _revision, ...food } = requireRow(
      await repository.byId(id),
      `No food with id ${id}. GET /foods?q=<search> lists them.`
    );
    return wireFood(food);
  }
  async function foodByRef(ref: string) {
    return await foodById(await resolver.resolveFoodId(ref));
  }
  async function searchFoods(q?: string): Promise<FoodRow[]> {
    const term = q?.trim();
    // SQLite LIKE cannot fold Unicode. Names and aliases already carry Unicode keys;
    // brand matching is done in JS so its casing follows the same contract.
    const all = (await repository.all()).map(wireFood);
    if (!term) {
      return all;
    }
    const pattern = new RegExp(
      [...caseKey(term)]
        .map((c) => {
          if (c === "%") {
            return ".*";
          }
          if (c === "_") {
            return ".";
          }
          return c.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        })
        .join(""),
      "su"
    );
    return all.filter((f) =>
      [f.name, f.brand, ...f.aliases].some(
        (v) => v !== null && pattern.test(caseKey(v))
      )
    );
  }
  async function seen(uuid: string) {
    const row = await repository.byRequest(uuid);
    return row ? wireFood(row) : undefined;
  }
  async function saveFood(
    b: SaveFoodInput
  ): Promise<{ row: FoodRow; created: boolean }> {
    const uuid = requestId(b.request_id);
    const replay = await seen(uuid);
    if (replay) {
      return { row: replay, created: false };
    }
    try {
      await resolver.assertFoodAliasesFree(b.aliases ?? []);
      checkMacroMass(b.protein_100g, b.carbs_100g, b.fat_100g);
      checkEnergy(
        b.kcal_100g,
        b.protein_100g,
        b.carbs_100g,
        b.fat_100g,
        b.energy_check === "override",
        b.source_note ?? null
      );
      validateNumbers(b);
      const selected = await repository.save({
        ...b,
        brand: b.brand ?? null,
        fiber_100g: b.fiber_100g ?? null,
        grams_per_unit: b.grams_per_unit ?? null,
        source_note: b.source_note ?? null,
        aliases: b.aliases ?? [],
        request_id: uuid,
        created_at: instant(clock().toISOString()),
      });
      return {
        row: wireFood(
          requireRow(selected, "The food could not be read after saving.")
        ),
        created: true,
      };
    } catch (error) {
      const recovered = await seen(uuid);
      if (recovered) {
        return { row: recovered, created: false };
      }
      throw databaseError(error);
    }
  }
  async function correctFood(
    ref: string,
    b: CorrectFoodInput
  ): Promise<CorrectedFood> {
    const id = await resolver.resolveFoodId(ref);
    const before = requireRow(
      await repository.byId(id),
      `No food with id ${id}.`
    );
    const keys = fields.filter((k) => b[k] !== undefined);
    if (!keys.length) {
      throw new ApiError(
        422,
        "Send at least one of: name, brand, kcal_100g, protein_100g, carbs_100g, fat_100g, fiber_100g, grams_per_unit, source, source_note. A different product is not an edit — save it as a new food with POST /foods."
      );
    }
    const merged = {
      ...before,
      ...Object.fromEntries(keys.map((k) => [k, b[k]])),
    };
    checkMacroMass(
      Number(merged.protein_100g),
      Number(merged.carbs_100g),
      Number(merged.fat_100g)
    );
    checkEnergy(
      Number(merged.kcal_100g),
      Number(merged.protein_100g),
      Number(merged.carbs_100g),
      Number(merged.fat_100g),
      b.energy_check === "override",
      merged.source_note
    );
    validateNumbers(b);
    const result = await repository
      .correct(id, before.macro_revision, b)
      .catch((error) => {
        const translated = databaseError(error);
        if (
          translated instanceof ApiError &&
          translated.status === 409 &&
          translated.message.includes("record changed")
        ) {
          throw new ApiError(
            409,
            "That food changed while this correction was being checked. Read GET /foods/:ref again, then resend the correction against its current values."
          );
        }
        throw translated;
      });
    const { macrosChanged, affected } = result;
    const food = wireFood(
      requireRow(result.foods, "The food could not be read after saving.")
    );
    return {
      food,
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
    const { entries, items } = await repository.usage(id);
    if (entries || items) {
      throw new ApiError(
        409,
        `That food is in use — ${entries} logged ${
          entries === 1 ? "entry" : "entries"
        } and ${items} meal ${
          items === 1 ? "item" : "items"
        } — so deleting it would orphan the record. If its numbers are wrong, PATCH /foods/:ref fixes them and every entry logged against them. If it is a duplicate, move its aliases to the food you are keeping.`
      );
    }
    return requireRow(
      await repository.remove(id).catch((error) => {
        throw databaseError(error);
      }),
      `No food with id ${id}.`
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

export type FoodService = ReturnType<typeof foodStore>;
