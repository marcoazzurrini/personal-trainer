import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  correctFood,
  deleteFood,
  foodById,
  foodByRef,
  saveFood,
  searchFoods,
  SOURCES,
} from "./foods.ts";
import { assertFoodAliasesFree, resolveFoodId } from "./resolve.ts";
import {
  aliasList,
  body,
  number,
  oneOf,
  optionalNumber,
  optionalText,
  query,
  requestId,
  text,
} from "../http/schema.ts";
import { addAliasRoute, releaseAliasRoute } from "../shared/aliases.routes.ts";

export const foods = new OpenAPIHono();

const Food = z.object({
  id: z.int(),
  name: z.string(),
  brand: z.string().nullable(),
  kcal_100g: z.number(),
  protein_100g: z.number(),
  carbs_100g: z.number(),
  fat_100g: z.number(),
  fiber_100g: z.number().nullable(),
  grams_per_unit: z.number().nullable(),
  source: z.enum(SOURCES),
  source_note: z.string().nullable(),
  created_at: z.string(),
  aliases: z.array(z.string()),
});

// Resolves by id, name, or alias, case-insensitively — so it is a string here
// rather than an id, and the resolver decides what it meant.
const ref = () =>
  z.string().min(1).meta({
    description: "A food id, its name, or any of its aliases.",
    example: "greek yogurt 0%",
  });

// "override" or nothing. A boolean would invite true/false and a false would
// read as "I considered this", which is not what the flag means.
const energyCheck = () =>
  z.literal("override", {
    error:
      '"energy_check" takes only the value "override", and only when the food carries energy its macros do not name.',
  }).optional().meta({
    description:
      "Send only when the food carries energy its macros do not name — alcohol, polyols. Requires a source_note saying what.",
  });

foods.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Nutrition"],
    summary: "Search the food registry",
    request: {
      query: query({
        q: z.string().optional().meta({
          description:
            "Substring of a name, brand or alias. Omit for the whole registry.",
        }),
      }),
    },
    responses: {
      200: {
        description:
          "Matching foods, by name. `query` echoes the search and is absent when the whole registry was returned.",
        content: {
          "application/json": {
            schema: z.object({
              query: z.string().optional(),
              foods: z.array(Food),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const q = c.req.valid("query").q?.trim();
    const found = await searchFoods(q);
    // `query` is absent rather than empty when the whole registry was asked
    // for: it echoes a search, and there was none.
    return c.json(q ? { query: q, foods: found } : { foods: found });
  },
);

foods.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Nutrition"],
    summary: "Save a food",
    description:
      "Values are per 100 g, always — including for foods bought by the piece. Set grams_per_unit on those and intake can then be logged in units.",
    request: {
      query: query({}),
      body: {
        content: {
          "application/json": {
            schema: body({
              name: text(),
              brand: optionalText(),
              kcal_100g: number(),
              protein_100g: number(),
              carbs_100g: number(),
              fat_100g: number(),
              fiber_100g: optionalNumber({ min: 0 }),
              grams_per_unit: optionalNumber({ min: 0 }),
              source: oneOf(SOURCES),
              source_note: optionalText(),
              energy_check: energyCheck(),
              aliases: aliasList(),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The food that was saved, with its aliases.",
        content: { "application/json": { schema: z.object({ food: Food }) } },
      },
      200: {
        description:
          "The food this request_id already saved. A retry, answered with the original result.",
        content: { "application/json": { schema: z.object({ food: Food }) } },
      },
      422: {
        description:
          "The macros do not weigh what they claim, or the energy they imply is not the energy stated.",
      },
      409: {
        description:
          "A food with that name already exists, or one of the aliases already belongs to another food — which one, and to what, is named in the error.",
      },
    },
  }),
  async (c) => {
    const { row, created } = await saveFood(c.req.valid("json"));
    return created ? c.json({ food: row }, 201) : c.json({ food: row }, 200);
  },
);

foods.openapi(
  createRoute({
    method: "get",
    path: "/{ref}",
    tags: ["Nutrition"],
    summary: "One food, by id, name or alias",
    request: { params: z.object({ ref: ref() }), query: query({}) },
    responses: {
      200: {
        description: "The food, with its aliases.",
        content: { "application/json": { schema: z.object({ food: Food }) } },
      },
      404: { description: "Nothing resolves to that reference." },
    },
  }),
  async (c) => c.json({ food: await foodByRef(c.req.valid("param").ref) }),
);

foods.openapi(
  createRoute({
    method: "patch",
    path: "/{ref}",
    tags: ["Nutrition"],
    summary: "Fix a food's numbers, and every entry logged against them",
    description:
      "Only ever for fixing a mistake. A different product — another brand, a reformulated recipe — is a new food, not an edit. Changing macros rewrites every intake entry ever logged against this food, and the response says how many and over what dates.",
    request: {
      query: query({}),
      params: z.object({ ref: ref() }),
      body: {
        content: {
          "application/json": {
            schema: body({
              name: text().optional(),
              brand: optionalText(),
              kcal_100g: optionalNumber({ min: 0 }),
              protein_100g: optionalNumber({ min: 0 }),
              carbs_100g: optionalNumber({ min: 0 }),
              fat_100g: optionalNumber({ min: 0 }),
              fiber_100g: optionalNumber({ min: 0 }),
              grams_per_unit: optionalNumber({ min: 0 }),
              source: oneOf(SOURCES).optional(),
              source_note: optionalText(),
              energy_check: energyCheck(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "The corrected food, and what the correction did to the record.",
        content: {
          "application/json": {
            schema: z.object({
              food: Food,
              corrected_entries: z.object({
                count: z.int(),
                from: z.string().nullable(),
                to: z.string().nullable(),
              }),
              note: z.string(),
            }),
          },
        },
      },
      404: { description: "Nothing resolves to that reference." },
      422: {
        description:
          "Nothing was sent, or the corrected numbers do not survive the mass and energy checks.",
      },
    },
  }),
  async (c) =>
    c.json(await correctFood(c.req.valid("param").ref, c.req.valid("json"))),
);

// A synonym never becomes a second food row — that splits the food's history
// exactly the way a duplicate exercise splits a lift's.
const aliasSurface = {
  tag: "Nutrition",
  aliasTable: "food_aliases",
  foreignKey: "food_id",
  ref,
  resolve: async (r: string) => ({ id: await resolveFoodId(r) }),
  respond: async (id: number) => ({ food: await foodById(id) }),
  responseSchema: z.object({ food: Food }),
};

addAliasRoute(foods, {
  ...aliasSurface,
  assertFree: assertFoodAliasesFree,
  created: "The food, with the alias now among its names.",
  neither: 'Send "alias" (a string) or "aliases" (an array of strings).',
});

releaseAliasRoute(foods, {
  ...aliasSurface,
  summary: "Release a synonym",
  removed: "The food, without that name.",
  notAnAliasResponse: "That alias does not point at that food.",
  notAnAlias: (alias, f) =>
    `"${alias}" is not an alias of that food. GET /foods/${f.id} lists its aliases.`,
});

foods.openapi(
  createRoute({
    method: "delete",
    path: "/{ref}",
    tags: ["Nutrition"],
    summary: "Delete an unused food",
    request: { params: z.object({ ref: ref() }), query: query({}) },
    responses: {
      200: {
        description: "The name of the food that was deleted.",
        content: {
          "application/json": { schema: z.object({ deleted: z.string() }) },
        },
      },
      409: {
        description:
          "The food is in use. Deleting it would orphan the record; PATCH fixes wrong numbers instead.",
      },
      404: { description: "Nothing resolves to that reference." },
    },
  }),
  async (c) => c.json({ deleted: await deleteFood(c.req.valid("param").ref) }),
);
