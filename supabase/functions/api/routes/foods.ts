import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import { checkEnergy } from "../lib/nutrition.ts";
import { resolveFoodId } from "../lib/resolve.ts";
import {
  optionalNumber,
  optionalString,
  optionalUuid,
  readJson,
  requireNumber,
  requireOneOf,
  requireString,
} from "../lib/validate.ts";

// The registry the coach fills as it goes. A food is sourced once — from a
// label, CREA, USDA or Open Food Facts — and saved, so it is never searched
// twice and the numbers stop depending on who remembered what.

const SOURCES = ["label", "crea", "usda", "off", "estimate"] as const;

// One shape for every food read; the caller supplies only the filter.
// deno-lint-ignore no-explicit-any
function selectFoods(where: any = sql``) {
  return sql`
    select
      f.id, f.name, f.brand, f.kcal_100g::float8, f.protein_100g::float8,
      f.carbs_100g::float8, f.fat_100g::float8, f.fiber_100g::float8,
      f.grams_per_unit::float8, f.source, f.source_note, f.created_at,
      coalesce(
        (select array_agg(a.alias order by a.alias)
         from food_aliases a where a.food_id = f.id),
        '{}'
      ) as aliases
    from foods f
    ${where}
    order by f.name`;
}

async function foodById(id: number) {
  const [row] = await selectFoods(sql`where f.id = ${id}`);
  return row;
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

export const foods = new Hono();

// Substring search rather than the whole registry: the list grows without
// bound, and the question being asked is always "do I already have this?"
foods.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ foods: await selectFoods() });
  const like = `%${q}%`;
  const rows = await selectFoods(sql`
    where f.name ilike ${like}
      or f.brand ilike ${like}
      or exists (
        select 1 from food_aliases a
        where a.food_id = f.id and a.alias ilike ${like}
      )`);
  return c.json({ query: q, foods: rows });
});

foods.post("/", async (c) => {
  const body = await readJson(c);
  const requestId = optionalUuid(body, "request_id");
  if (requestId) {
    const [existing] = await sql`
      select id from foods where request_id = ${requestId}`;
    if (existing) return c.json({ food: await foodById(existing.id) });
  }

  const name = requireString(body, "name");
  const brand = optionalString(body, "brand");
  const kcal = requireNumber(body, "kcal_100g");
  const protein = requireNumber(body, "protein_100g");
  const carbs = requireNumber(body, "carbs_100g");
  const fat = requireNumber(body, "fat_100g");
  const fiber = optionalNumber(body, "fiber_100g", { min: 0 });
  const gramsPerUnit = optionalNumber(body, "grams_per_unit", { min: 0 });
  const source = requireOneOf(body, "source", SOURCES);
  const sourceNote = optionalString(body, "source_note");
  const aliases = parseAliases(body.aliases);

  if (body.energy_check !== undefined && body.energy_check !== "override") {
    throw new ApiError(
      422,
      '"energy_check" takes only the value "override", and only when the food carries energy its macros do not name.',
    );
  }
  checkEnergy(
    kcal,
    protein,
    carbs,
    fat,
    body.energy_check === "override",
    sourceNote,
  );

  const id = await sql.begin(async (tx) => {
    const [created] = await tx`
      insert into foods
        (name, brand, kcal_100g, protein_100g, carbs_100g, fat_100g,
         fiber_100g, grams_per_unit, source, source_note, request_id)
      values
        (${name}, ${brand}, ${kcal}, ${protein}, ${carbs}, ${fat},
         ${fiber}, ${gramsPerUnit}, ${source}, ${sourceNote}, ${requestId})
      returning id`;
    for (const alias of aliases) {
      await tx`
        insert into food_aliases (food_id, alias)
        values (${created.id}, ${alias})`;
    }
    return created.id as number;
  });

  return c.json({ food: await foodById(id) }, 201);
});

foods.get("/:ref", async (c) => {
  const id = await resolveFoodId(c.req.param("ref"));
  return c.json({ food: await foodById(id) });
});

// A synonym never becomes a second food row — that splits the food's history
// exactly the way a duplicate exercise splits a lift's.
foods.post("/:ref/aliases", async (c) => {
  const id = await resolveFoodId(c.req.param("ref"));
  const body = await readJson(c);
  const aliases = body.alias !== undefined
    ? [requireString(body, "alias")]
    : parseAliases(body.aliases);
  if (aliases.length === 0) {
    throw new ApiError(
      422,
      'Send "alias" (a string) or "aliases" (an array of strings).',
    );
  }
  await sql.begin(async (tx) => {
    for (const alias of aliases) {
      await tx`
        insert into food_aliases (food_id, alias) values (${id}, ${alias})`;
    }
  });
  return c.json({ food: await foodById(id) }, 201);
});
