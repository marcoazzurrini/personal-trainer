import type {
  MealsRepository,
  MealRecord,
} from "@trainer/db/repositories/nutrition/meals.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import { Invalid, requireRow } from "../shared/refusals.ts";
import type {
  Conflict,
  DatabaseFailure,
  NotFound,
} from "../shared/refusals.ts";
import { decimal, now, requestId, wireInstant } from "../shared/values.ts";
import type { ItemInput, MealDetail, MealSummary } from "./meals.types.ts";
import type { NutritionResolver } from "./resolve.ts";
import { foodMacros, scaleFood, sumMacros } from "./rules.ts";

function detail(result: MealRecord): Effect.Effect<MealDetail, NotFound> {
  return requireRow(
    result.headers,
    "The meal could not be read after saving."
  ).pipe(
    Effect.map((h) => {
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
    })
  );
}

export function mealStore(rows: MealsRepository, resolver: NutritionResolver) {
  const repository = effectful(rows);

  const mealDetail = Effect.fn("meals.mealDetail")(function* (
    id: number
  ): Effect.fn.Return<MealDetail, NotFound | DatabaseFailure> {
    return yield* detail(yield* repository.detail(id));
  });

  const mealByRef = Effect.fn("meals.mealByRef")(function* (
    ref: string
  ): Effect.fn.Return<MealDetail, Invalid | NotFound | DatabaseFailure> {
    return yield* mealDetail(yield* resolver.resolveMealId(ref));
  });

  const listMeals = Effect.fn("meals.listMeals")(function* (): Effect.fn.Return<
    MealSummary[],
    DatabaseFailure
  > {
    return (yield* repository.list()).map((h) => ({
      ...h,
      created_at: wireInstant(h.created_at),
    }));
  });

  const prepare = Effect.fnUntraced(function* (
    entries: readonly ItemInput[]
  ): Effect.fn.Return<
    { foodId: number; grams: number }[],
    Invalid | DatabaseFailure
  > {
    const ids = yield* resolver.resolveFoodIds(entries.map((e) => e.food));
    const items: { foodId: number; grams: number }[] = [];
    for (const [i, e] of entries.entries()) {
      yield* decimal(e.grams, 7, 1);
      items.push({ foodId: ids[i], grams: e.grams });
    }
    return items;
  });

  const seen = Effect.fnUntraced(function* (
    uuid: string
  ): Effect.fn.Return<MealDetail | undefined, NotFound | DatabaseFailure> {
    const result = yield* repository.byRequest(uuid);
    return result.headers.length ? yield* detail(result) : undefined;
  });

  const saveMeal = Effect.fn("meals.saveMeal")(function* (b: {
    name: string;
    items: ItemInput[];
    aliases?: string[] | null;
    request_id: string;
  }): Effect.fn.Return<
    { meal: MealDetail; created: boolean },
    Invalid | NotFound | Conflict | DatabaseFailure
  > {
    const uuid = yield* requestId(b.request_id);
    const replay = yield* seen(uuid);
    if (replay) {
      return { meal: replay, created: false };
    }
    return yield* Effect.gen(function* () {
      yield* resolver.assertMealAliasesFree(b.aliases ?? []);
      const items = yield* prepare(b.items);
      const result = yield* repository.save({
        name: b.name,
        items,
        aliases: b.aliases ?? [],
        requestId: uuid,
        createdAt: yield* now,
      });
      return { meal: yield* detail(result), created: true };
    }).pipe(
      // Any failure, defects included, may be a concurrent retry that saved
      // this request first; otherwise it fails as it was.
      Effect.catchCause((cause) =>
        seen(uuid).pipe(
          Effect.flatMap((recovered) =>
            recovered
              ? Effect.succeed({ meal: recovered, created: false })
              : Effect.failCause(cause)
          )
        )
      )
    );
  });

  const editMeal = Effect.fn("meals.editMeal")(function* (
    ref: string,
    b: { name?: string; items?: ItemInput[]; aliases?: string[] | null }
  ): Effect.fn.Return<
    { meal: MealDetail; note: string },
    Invalid | NotFound | Conflict | DatabaseFailure
  > {
    const id = yield* resolver.resolveMealId(ref);
    const name = b.name ?? null;
    if (name === null && b.items === undefined && b.aliases === undefined) {
      return yield* new Invalid({
        message:
          'Send at least one of "name", "aliases" (added, not replaced), or "items" (the complete replacement list).',
      });
    }
    const items = b.items === undefined ? [] : yield* prepare(b.items);
    yield* resolver.assertMealAliasesFree(b.aliases ?? []);
    const result = yield* repository.edit(id, {
      name,
      items: b.items === undefined ? undefined : items,
      aliases: b.aliases ?? [],
    });
    return {
      meal: yield* detail(result),
      note: "Future logs of this meal use the new items. Everything already logged is untouched — intake entries carry the numbers they were logged with.",
    };
  });

  return { mealDetail, mealByRef, listMeals, saveMeal, editMeal };
}

export type MealService = ReturnType<typeof mealStore>;
