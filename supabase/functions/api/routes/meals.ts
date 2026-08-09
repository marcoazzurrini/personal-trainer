import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import { foodMacros, scaleFood, sumMacros } from "../lib/nutrition.ts";
import { resolveFoodId, resolveMealId } from "../lib/resolve.ts";
import {
  type Body,
  readJson,
  requireNumber,
  requireString,
  requireUuid,
} from "../lib/validate.ts";

// Meals are routines, not history. "il mio solito yogurt" is a name, a list of
// foods and their amounts — saved so that logging it costs seconds.
//
// A meal never reaches anything already logged. Logging a meal copies its
// foods' numbers onto intake rows, so editing the recipe changes what future
// logs write and nothing else. Same rule sets follow: a set copies its target
// instead of pointing at one.

// Totals are computed here, never stored — a meal's macros are a sum over its
// items, and a sum that lives in a column is a sum that can go stale.
async function mealDetail(id: number) {
  const [meal] = await sql`
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

  return { ...meal, items: detailed, totals: sumMacros(detailed) };
}

function parseAliases(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.some((a) => typeof a !== "string" || a.trim() === "")
  ) {
    throw new ApiError(422, '"aliases" must be an array of non-empty strings.');
  }
  return (value as string[]).map((a) => a.trim());
}

// Foods resolve before any transaction opens, so an unknown one fails with a
// useful message instead of rolling back a half-written meal.
async function parseItems(
  entries: unknown[],
): Promise<{ foodId: number; grams: number }[]> {
  const items: { foodId: number; grams: number }[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      throw new ApiError(422, 'Each entry in "items" must be an object.');
    }
    const item = entry as Body;
    items.push({
      foodId: await resolveFoodId(item.food),
      grams: requireNumber(item, "grams"),
    });
  }
  return items;
}

export const meals = new Hono();

meals.get("/", async (c) => {
  const rows = await sql`
    select m.id, m.name, m.created_at,
      (select count(*)::int from meal_items mi where mi.meal_id = m.id) as items,
      coalesce(
        (select array_agg(a.alias order by a.alias)
         from meal_aliases a where a.meal_id = m.id),
        '{}'
      ) as aliases
    from meals m order by m.name`;
  return c.json({ meals: rows });
});

// One call, one transaction: a meal arrives complete or not at all.
meals.post("/", async (c) => {
  const body = await readJson(c);
  const requestId = requireUuid(body, "request_id");
  if (requestId) {
    const [existing] = await sql`
      select id from meals where request_id = ${requestId}`;
    if (existing) return c.json({ meal: await mealDetail(existing.id) });
  }

  const name = requireString(body, "name");

  const aliases = parseAliases(body.aliases);

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new ApiError(
      422,
      'A meal is its items: "items" must be a non-empty array of {food, grams}, where food is a food id, name, or alias.',
    );
  }

  const items = await parseItems(body.items);

  const id = await sql.begin(async (tx) => {
    const [created] = await tx`
      insert into meals (name, request_id) values (${name}, ${requestId})
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

  return c.json({ meal: await mealDetail(id) }, 201);
});

meals.get("/:ref", async (c) => {
  const id = await resolveMealId(c.req.param("ref"));
  return c.json({ meal: await mealDetail(id) });
});

// Editing a routine. `items`, when sent, is the complete replacement list —
// not a patch — because a partial edit of a recipe is ambiguous about what
// was meant to survive.
//
// This changes future logs only. Everything already logged keeps the numbers
// it was logged with, and nothing here can reach it: intake rows carry their
// own macros and do not consult meal_items. That is the guarantee the whole
// snapshot design exists to provide, and it holds by construction rather than
// by this route remembering to be careful.
meals.patch("/:ref", async (c) => {
  const id = await resolveMealId(c.req.param("ref"));
  const body = await readJson(c);

  const name = "name" in body ? requireString(body, "name") : null;
  const aliases = parseAliases(body.aliases);
  const hasItems = body.items !== undefined;

  if (name === null && !hasItems && body.aliases === undefined) {
    throw new ApiError(
      422,
      'Send at least one of "name", "aliases" (added, not replaced), or "items" (the complete replacement list).',
    );
  }

  let items: { foodId: number; grams: number }[] = [];
  if (hasItems) {
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new ApiError(
        422,
        '"items" must be a non-empty array of {food, grams} — the complete replacement list. A meal with no foods in it is not a meal; delete it instead.',
      );
    }
    items = await parseItems(body.items);
  }

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

  return c.json({
    meal: await mealDetail(id),
    note:
      "Future logs of this meal use the new items. Everything already logged is untouched — intake entries carry the numbers they were logged with.",
  });
});

// Meals are never deleted: a logged meal is what its intake rows point at, and
// a routine abandoned is still a routine that was followed. Retiring one means
// taking its aliases away — it keeps its name and its history, and stops
// answering to the word Marco says out loud.
meals.delete("/:ref/aliases/:alias", async (c) => {
  const id = await resolveMealId(c.req.param("ref"));
  const alias = decodeURIComponent(c.req.param("alias"));
  const rows = await sql`
    delete from meal_aliases
    where meal_id = ${id} and lower(alias) = lower(${alias})
    returning id`;
  if (rows.length === 0) {
    throw new ApiError(
      404,
      `"${alias}" is not an alias of that meal. GET /meals/${id} lists its aliases.`,
    );
  }
  return c.json({ meal: await mealDetail(id) });
});
