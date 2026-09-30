import type {
  MealsRepository,
  MealRecord,
} from "../../db/repositories/nutrition/meals.ts";
import { ApiError, databaseError, requireRow } from "../shared/errors.ts";
import {
  decimal,
  instant,
  requestId,
  systemClock,
  wireInstant,
} from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import type { ItemInput, MealDetail, MealSummary } from "./meals.types.ts";
import type { NutritionResolver } from "./resolve.ts";
import { foodMacros, scaleFood, sumMacros } from "./rules.ts";

function detail(result: MealRecord): MealDetail {
  const h = requireRow(
    result.headers,
    "The meal could not be read after saving."
  );
  const { ingredients } = result;
  const items = ingredients.map((i) => ({
    food_id: i.food_id,
    food: i.food,
    brand: i.brand,
    grams: i.grams,
    ...scaleFood(foodMacros(i), i.grams),
  }));
  return {
    ...h,
    created_at: wireInstant(h.created_at),
    items,
    totals: sumMacros(items),
  };
}

export function mealStore(
  repository: MealsRepository,
  resolver: NutritionResolver,
  clock: Clock = systemClock
) {
  async function mealDetail(id: number): Promise<MealDetail> {
    return detail(await repository.detail(id));
  }
  async function mealByRef(ref: string) {
    return await mealDetail(await resolver.resolveMealId(ref));
  }
  async function listMeals(): Promise<MealSummary[]> {
    return (await repository.list()).map((h) => ({
      ...h,
      created_at: wireInstant(h.created_at),
    }));
  }
  async function prepare(entries: readonly ItemInput[]) {
    const ids = await resolver.resolveFoodIds(entries.map((e) => e.food));
    return entries.map((e, i) => ({
      foodId: ids[i],
      grams: (decimal(e.grams, 7, 1), e.grams),
    }));
  }
  async function seen(uuid: string) {
    const result = await repository.byRequest(uuid);
    return result.headers.length ? detail(result) : undefined;
  }
  async function saveMeal(b: {
    name: string;
    items: ItemInput[];
    aliases?: string[] | null;
    request_id: string;
  }): Promise<{ meal: MealDetail; created: boolean }> {
    const uuid = requestId(b.request_id);
    const replay = await seen(uuid);
    if (replay) {
      return { meal: replay, created: false };
    }
    try {
      await resolver.assertMealAliasesFree(b.aliases ?? []);
      const items = await prepare(b.items);
      const result = await repository.save({
        name: b.name,
        items,
        aliases: b.aliases ?? [],
        requestId: uuid,
        createdAt: instant(clock().toISOString()),
      });
      return { meal: detail(result), created: true };
    } catch (error) {
      const recovered = await seen(uuid);
      if (recovered) {
        return { meal: recovered, created: false };
      }
      throw databaseError(error);
    }
  }
  async function editMeal(
    ref: string,
    b: { name?: string; items?: ItemInput[]; aliases?: string[] | null }
  ): Promise<{ meal: MealDetail; note: string }> {
    const id = await resolver.resolveMealId(ref);
    const name = b.name ?? null;
    if (name === null && b.items === undefined && b.aliases === undefined) {
      throw new ApiError(
        422,
        'Send at least one of "name", "aliases" (added, not replaced), or "items" (the complete replacement list).'
      );
    }
    const items = b.items === undefined ? [] : await prepare(b.items);
    await resolver.assertMealAliasesFree(b.aliases ?? []);
    const result = await repository
      .edit(id, {
        name,
        items: b.items === undefined ? undefined : items,
        aliases: b.aliases ?? [],
      })
      .catch((error) => {
        throw databaseError(error);
      });
    return {
      meal: detail(result),
      note: "Future logs of this meal use the new items. Everything already logged is untouched — intake entries carry the numbers they were logged with.",
    };
  }
  return { mealDetail, mealByRef, listMeals, saveMeal, editMeal };
}

export type MealService = ReturnType<typeof mealStore>;
