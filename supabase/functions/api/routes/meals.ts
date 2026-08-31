import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { ApiError } from "../http/errors.ts";
import { foodMacros, scaleFood, sumMacros } from "../rules/nutrition.ts";
import { resolveFoodId, resolveMealId } from "../record/resolve.ts";
import {
  aliasList,
  body,
  macroTotals,
  number,
  requestId,
  text,
} from "../http/schema.ts";
import { releaseAliasRoute } from "./aliases.ts";

// Meals are routines, not history. "il mio solito yogurt" is a name, a list of
// foods and their amounts — saved so that logging it costs seconds.
//
// A meal never reaches anything already logged. Logging a meal copies its
// foods' numbers onto intake rows, so editing the recipe changes what future
// logs write and nothing else. Same rule sets follow: a set copies its target
// instead of pointing at one.

export const meals = new OpenAPIHono();

const Macros = z.object({
  kcal: z.number(),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
  fiber_g: z.number().nullable(),
});

const MealItem = z.object({
  food_id: z.int(),
  food: z.string(),
  brand: z.string().nullable(),
  grams: z.number(),
}).extend(Macros.shape);

const MealDetail = z.object({
  id: z.int(),
  name: z.string(),
  created_at: z.string(),
  aliases: z.array(z.string()),
  items: z.array(MealItem),
  // Computed on every read, never stored — a sum that lives in a column is a
  // sum that can go stale. Carries `unaccounted`, so a meal whose foods are
  // silent about fibre says so rather than reporting a floor as a total.
  totals: macroTotals(),
});

const MealSummary = z.object({
  id: z.int(),
  name: z.string(),
  created_at: z.string(),
  items: z.int(),
  aliases: z.array(z.string()),
});

const ref = () =>
  z.string().min(1).meta({
    description: "A meal id, its name, or any of its aliases.",
    example: "colazione",
  });

// food is an id, a name, or an alias, so it is deliberately either a number or
// a string here and the resolver decides what it meant.
const itemSchema = () =>
  body({
    food: z.union([z.string().min(1), z.number()]),
    grams: number(),
  }, 'an entry in "items"');

const itemList = (message: string) =>
  z.array(itemSchema(), { error: () => message }).min(1, {
    error: () => message,
  });

// Totals are computed here, never stored — a meal's macros are a sum over its
// items, and a sum that lives in a column is a sum that can go stale.
async function mealDetail(id: number) {
  const [meal] = await sql<
    Array<
      Pick<z.infer<typeof MealDetail>, "id" | "name" | "created_at" | "aliases">
    >
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
    items: detailed as z.infer<typeof MealItem>[],
    totals: sumMacros(detailed),
  };
}

// Foods resolve before any transaction opens, so an unknown one fails with a
// useful message instead of rolling back a half-written meal.
async function resolveItems(
  entries: ReadonlyArray<{ food: string | number; grams: number }>,
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

meals.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Nutrition"],
    summary: "Saved meals",
    responses: {
      200: {
        description: "Every meal with its aliases and item count, by name.",
        content: {
          "application/json": {
            schema: z.object({ meals: z.array(MealSummary) }),
          },
        },
      },
    },
  }),
  async (c) => {
    const rows = await sql<z.infer<typeof MealSummary>[]>`
    select m.id, m.name, m.created_at,
      (select count(*)::int from meal_items mi where mi.meal_id = m.id) as items,
      coalesce(
        (select array_agg(a.alias order by a.alias)
         from meal_aliases a where a.meal_id = m.id),
        '{}'
      ) as aliases
    from meals m order by m.name`;
    return c.json({ meals: rows });
  },
);

// One call, one transaction: a meal arrives complete or not at all.
meals.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Nutrition"],
    summary: "Save a meal",
    request: {
      body: {
        content: {
          "application/json": {
            schema: body({
              name: text(),
              items: itemList(
                'A meal is its items: "items" must be a non-empty array of {food, grams}, where food is a food id, name, or alias.',
              ),
              aliases: aliasList(),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The meal, with its items resolved and totals computed.",
        content: {
          "application/json": { schema: z.object({ meal: MealDetail }) },
        },
      },
      200: {
        description:
          "The meal this request_id already saved. A retry, answered with the original result.",
        content: {
          "application/json": { schema: z.object({ meal: MealDetail }) },
        },
      },
      409: { description: "A meal with that name already exists." },
    },
  }),
  async (c) => {
    const b = c.req.valid("json");
    const [seen] = await sql`
      select id from meals where request_id = ${b.request_id}`;
    if (seen) return c.json({ meal: await mealDetail(seen.id) }, 200);

    const aliases = b.aliases ?? [];
    const items = await resolveItems(b.items);

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

    return c.json({ meal: await mealDetail(id) }, 201);
  },
);

meals.openapi(
  createRoute({
    method: "get",
    path: "/{ref}",
    tags: ["Nutrition"],
    summary: "One meal, by id, name or alias",
    request: { params: z.object({ ref: ref() }) },
    responses: {
      200: {
        description: "The meal, its items with resolved foods, and its totals.",
        content: {
          "application/json": { schema: z.object({ meal: MealDetail }) },
        },
      },
      404: { description: "Nothing resolves to that reference." },
    },
  }),
  async (c) => {
    const id = await resolveMealId(c.req.valid("param").ref);
    return c.json({ meal: await mealDetail(id) });
  },
);

// Editing a routine. `items`, when sent, is the complete replacement list —
// not a patch — because a partial edit of a recipe is ambiguous about what
// was meant to survive.
//
// This changes future logs only. Everything already logged keeps the numbers
// it was logged with, and nothing here can reach it: intake rows carry their
// own macros and do not consult meal_items. That is the guarantee the whole
// snapshot design exists to provide, and it holds by construction rather than
// by this route remembering to be careful.
meals.openapi(
  createRoute({
    method: "patch",
    path: "/{ref}",
    tags: ["Nutrition"],
    summary: "Edit a routine",
    description:
      "`items`, when sent, is the complete replacement list rather than a patch — a partial edit of a recipe is ambiguous about what was meant to survive. Aliases are added, not replaced. Nothing already logged is touched.",
    request: {
      params: z.object({ ref: ref() }),
      body: {
        content: {
          "application/json": {
            schema: body({
              name: text().optional(),
              items: itemList(
                '"items" must be a non-empty array of {food, grams} — the complete replacement list. A meal with no foods in it is not a meal; delete it instead.',
              ).optional(),
              aliases: aliasList(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "The meal as it now stands, and a note that nothing logged moved.",
        content: {
          "application/json": {
            schema: z.object({ meal: MealDetail, note: z.string() }),
          },
        },
      },
      404: { description: "Nothing resolves to that reference." },
      422: { description: "Nothing was sent." },
    },
  }),
  async (c) => {
    const id = await resolveMealId(c.req.valid("param").ref);
    const b = c.req.valid("json");

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
  },
);

// Meals are never deleted: a logged meal is what its intake rows point at, and
// a routine abandoned is still a routine that was followed. Retiring one means
// taking its aliases away — it keeps its name and its history, and stops
// answering to the word Marco says out loud.
releaseAliasRoute(meals, {
  tag: "Nutrition",
  aliasTable: "meal_aliases",
  foreignKey: "meal_id",
  ref,
  resolve: async (r: string) => ({ id: await resolveMealId(r) }),
  respond: async (id: number) => ({ meal: await mealDetail(id) }),
  responseSchema: z.object({ meal: MealDetail }),
  summary: "Retire a meal's spoken name",
  description:
    "Meals are never deleted — a logged meal is what its intake rows point at. Retiring one means taking its aliases away: it keeps its name and its history and stops answering to the word said out loud.",
  removed: "The meal, without that name.",
  notAnAliasResponse: "That alias does not point at that meal.",
  notAnAlias: (alias, m) =>
    `"${alias}" is not an alias of that meal. GET /meals/${m.id} lists its aliases.`,
});
