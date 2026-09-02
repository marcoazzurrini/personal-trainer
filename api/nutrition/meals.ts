// Meals are routines, not history. "il mio solito yogurt" is a name, a list of
// foods and their amounts — saved so that logging it costs seconds.
//
// A meal never reaches anything already logged. Logging a meal copies its
// foods' numbers onto intake rows, so editing the recipe changes what future
// logs write and nothing else. Same rule sets follow: a set copies its target
// instead of pointing at one.

import { sql } from "../db.ts";
import { ApiError } from "../shared/errors.ts";
import {
  foodMacros,
  type MacroTotals,
  type ScaledMacros,
  scaleFood,
  sumMacros,
} from "./rules.ts";
import { writeOnce } from "../shared/idempotency.ts";
import {
  assertMealAliasesFree,
  resolveFoodId,
  resolveMealId,
} from "./resolve.ts";

export interface MealItem extends ScaledMacros {
  food_id: number;
  food: string;
  brand: string | null;
  grams: number;
}

export interface MealDetail {
  id: number;
  name: string;
  created_at: string;
  aliases: string[];
  items: MealItem[];
  totals: MacroTotals;
}

export interface MealSummary {
  id: number;
  name: string;
  created_at: string;
  items: number;
  aliases: string[];
}

/** A food named by id, name, or alias, with how much of it the routine holds. */
export interface ItemInput {
  food: string | number;
  grams: number;
}

// Totals are computed here, never stored — a meal's macros are a sum over its
// items, and a sum that lives in a column is a sum that can go stale.
export async function mealDetail(id: number): Promise<MealDetail> {
  const [meal] = await sql<
    Array<Pick<MealDetail, "id" | "name" | "created_at" | "aliases">>
  >`
    select m.id, m.name, m.created_at,
      coalesce(
        (select array_agg(a.alias order by a.alias)
         from meal_aliases a where a.meal_id = m.id),
        '{}'
      ) as aliases
    from meals m where m.id = ${id}`;

  const items = await sql`
    select mi.id, mi.grams::float8, f.id as food_id, f.name as food,
      f.brand, f.kcal_100g::float8, f.protein_100g::float8,
      f.carbs_100g::float8, f.fat_100g::float8, f.fiber_100g::float8
    from meal_items mi
    join foods f on f.id = mi.food_id
    where mi.meal_id = ${id}
    order by f.name`;

  const detailed = items.map((i) => ({
    food_id: i.food_id,
    food: i.food,
    brand: i.brand,
    grams: i.grams,
    ...scaleFood(foodMacros(i), i.grams),
  }));

  return {
    ...meal,
    items: detailed as MealItem[],
    totals: sumMacros(detailed),
  };
}

export async function mealByRef(ref: string): Promise<MealDetail> {
  return await mealDetail(await resolveMealId(ref));
}

/** Every meal with its aliases and item count, by name. */
export async function listMeals(): Promise<MealSummary[]> {
  return await sql<MealSummary[]>`
    select m.id, m.name, m.created_at,
      (select count(*)::int from meal_items mi where mi.meal_id = m.id) as items,
      coalesce(
        (select array_agg(a.alias order by a.alias)
         from meal_aliases a where a.meal_id = m.id),
        '{}'
      ) as aliases
    from meals m order by m.name`;
}

// Foods resolve before any transaction opens, so an unknown one fails with a
// useful message instead of rolling back a half-written meal.
async function resolveItems(
  entries: ReadonlyArray<ItemInput>,
): Promise<{ foodId: number; grams: number }[]> {
  const items: { foodId: number; grams: number }[] = [];
  for (const entry of entries) {
    items.push({
      foodId: await resolveFoodId(entry.food),
      grams: entry.grams,
    });
  }
  return items;
}

/** Saves a meal — complete or not at all — or replays the one this id saved. */
export async function saveMeal(b: {
  name: string;
  items: ItemInput[];
  aliases?: string[] | null;
  request_id: string;
}): Promise<{ meal: MealDetail; created: boolean }> {
  const { body: meal, status } = await writeOnce<
    { id: number },
    MealDetail,
    MealDetail
  >({
    table: "meals",
    requestId: b.request_id,
    select: sql`id`,
    replay: (seen) => mealDetail(seen.id),
    write: async () => {
      const aliases = b.aliases ?? [];
      await assertMealAliasesFree(aliases);
      const items = await resolveItems(b.items);

      // One call, one transaction: a meal arrives complete or not at all.
      const id = await sql.begin(async (tx) => {
        const [created] = await tx`
          insert into meals (name, request_id) values (${b.name}, ${b.request_id})
          returning id`;
        for (const alias of aliases) {
          await tx`
            insert into meal_aliases (meal_id, alias)
            values (${created.id}, ${alias})`;
        }
        for (const { foodId, grams } of items) {
          await tx`
            insert into meal_items (meal_id, food_id, grams)
            values (${created.id}, ${foodId}, ${grams})`;
        }
        return created.id as number;
      });

      return await mealDetail(id);
    },
  });
  return { meal, created: status === 201 };
}

/**
 * Edits a routine.
 *
 * `items`, when sent, is the complete replacement list — not a patch — because
 * a partial edit of a recipe is ambiguous about what was meant to survive.
 *
 * This changes future logs only. Everything already logged keeps the numbers
 * it was logged with, and nothing here can reach it: intake rows carry their
 * own macros and do not consult meal_items. That is the guarantee the whole
 * snapshot design exists to provide, and it holds by construction rather than
 * by this function remembering to be careful.
 */
export async function editMeal(ref: string, b: {
  name?: string;
  items?: ItemInput[];
  aliases?: string[] | null;
}): Promise<{ meal: MealDetail; note: string }> {
  const id = await resolveMealId(ref);

  const name = b.name ?? null;
  const aliases = b.aliases ?? [];
  const hasItems = b.items !== undefined;

  if (name === null && !hasItems && b.aliases === undefined) {
    throw new ApiError(
      422,
      'Send at least one of "name", "aliases" (added, not replaced), or "items" (the complete replacement list).',
    );
  }

  const items = hasItems ? await resolveItems(b.items!) : [];
  await assertMealAliasesFree(aliases);

  await sql.begin(async (tx) => {
    if (name !== null) {
      await tx`update meals set name = ${name} where id = ${id}`;
    }
    for (const alias of aliases) {
      await tx`insert into meal_aliases (meal_id, alias) values (${id}, ${alias})`;
    }
    if (hasItems) {
      await tx`delete from meal_items where meal_id = ${id}`;
      for (const { foodId, grams } of items) {
        await tx`
          insert into meal_items (meal_id, food_id, grams)
          values (${id}, ${foodId}, ${grams})`;
      }
    }
  });

  return {
    meal: await mealDetail(id),
    note:
      "Future logs of this meal use the new items. Everything already logged is untouched — intake entries carry the numbers they were logged with.",
  };
}
