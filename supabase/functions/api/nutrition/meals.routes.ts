import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  editMeal,
  listMeals,
  mealByRef,
  mealDetail,
  saveMeal,
} from "./meals.ts";
import { resolveMealId } from "./resolve.ts";
import {
  aliasList,
  body,
  macroTotals,
  number,
  query,
  requestId,
  text,
} from "../http/schema.ts";
import { releaseAliasRoute } from "../shared/aliases.routes.ts";

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

meals.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Nutrition"],
    summary: "Saved meals",
    request: { query: query({}) },
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
  async (c) => c.json({ meals: await listMeals() }),
);

meals.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Nutrition"],
    summary: "Save a meal",
    request: {
      query: query({}),
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
    const { meal, created } = await saveMeal(c.req.valid("json"));
    return created ? c.json({ meal }, 201) : c.json({ meal }, 200);
  },
);

meals.openapi(
  createRoute({
    method: "get",
    path: "/{ref}",
    tags: ["Nutrition"],
    summary: "One meal, by id, name or alias",
    request: { params: z.object({ ref: ref() }), query: query({}) },
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
  async (c) => c.json({ meal: await mealByRef(c.req.valid("param").ref) }),
);

meals.openapi(
  createRoute({
    method: "patch",
    path: "/{ref}",
    tags: ["Nutrition"],
    summary: "Edit a routine",
    description:
      "`items`, when sent, is the complete replacement list rather than a patch — a partial edit of a recipe is ambiguous about what was meant to survive. Aliases are added, not replaced. Nothing already logged is touched.",
    request: {
      query: query({}),
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
  async (c) =>
    c.json(await editMeal(c.req.valid("param").ref, c.req.valid("json"))),
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
