import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import { checkEnergy, checkMacroMass } from "../lib/nutrition.ts";
import { resolveFoodId } from "../lib/resolve.ts";
import {
  optionalNumber,
  optionalString,
  readJson,
  requireNumber,
  requireOneOf,
  requireString,
  requireUuid,
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
  const body = await readJson(c, [
    "name",
    "brand",
    "kcal_100g",
    "protein_100g",
    "carbs_100g",
    "fat_100g",
    "fiber_100g",
    "grams_per_unit",
    "source",
    "source_note",
    "energy_check",
    "aliases",
  ]);
  const requestId = requireUuid(body, "request_id");
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
  checkMacroMass(protein, carbs, fat);
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

// Correcting a food, retroactively.
//
// A food's numbers are a fact about the world, not a choice that evolves. If
// white rice was recorded at 130 kcal and it is 350, every entry ever logged
// against it was wrong at the moment it was written — that is an error, not
// history, and fixing it fixes the past too. This is the opposite of a meal,
// where a changed recipe means Marco genuinely started eating differently and
// the old entries must stand.
//
// So: **editing a food only ever means fixing a mistake.** A different product
// — another brand, a reformulated recipe — is a new food, never an edit. That
// rule is what makes blanket retroactivity safe, and it is stated in the
// reference and logging docs because the coach is the one who will be tempted
// to "just update the yogurt".
//
// Nothing happens silently: the response says how many entries were rewritten
// and over what dates.
foods.patch("/:ref", async (c) => {
  const id = await resolveFoodId(c.req.param("ref"));
  const [before] = await sql`select * from foods where id = ${id}`;
  const body = await readJson(c, [
    "name",
    "brand",
    "kcal_100g",
    "protein_100g",
    "carbs_100g",
    "fat_100g",
    "fiber_100g",
    "grams_per_unit",
    "source",
    "source_note",
    "energy_check",
  ]);

  const fields: Record<string, unknown> = {};
  for (
    const [key, column] of [
      ["kcal_100g", "kcal_100g"],
      ["protein_100g", "protein_100g"],
      ["carbs_100g", "carbs_100g"],
      ["fat_100g", "fat_100g"],
      ["fiber_100g", "fiber_100g"],
      ["grams_per_unit", "grams_per_unit"],
    ] as const
  ) {
    if (key in body) fields[column] = optionalNumber(body, key, { min: 0 });
  }
  if ("name" in body) fields.name = requireString(body, "name");
  if ("brand" in body) fields.brand = optionalString(body, "brand");
  if ("source" in body) fields.source = requireOneOf(body, "source", SOURCES);
  if ("source_note" in body) {
    fields.source_note = optionalString(body, "source_note");
  }

  if (Object.keys(fields).length === 0) {
    throw new ApiError(
      422,
      "Send at least one of: name, brand, kcal_100g, protein_100g, carbs_100g, fat_100g, fiber_100g, grams_per_unit, source, source_note. A different product is not an edit — save it as a new food with POST /foods.",
    );
  }

  const merged = { ...before, ...fields };
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
    body.energy_check === "override",
    merged.source_note as string | null,
  );

  // Compared as numbers, not as text. Postgres hands back numeric as a string
  // carrying its scale ("130.0"), while the incoming field is a JS number
  // (130) — so a string comparison called every resend a change, rewrote every
  // entry logged against the food, and reported "Corrected 3 logged entries"
  // when nothing had moved. On an API whose contract with the coach is that it
  // never overstates what it did, that is the worst kind of wrong.
  const MACRO_COLUMNS = [
    "kcal_100g",
    "protein_100g",
    "carbs_100g",
    "fat_100g",
    "fiber_100g",
  ];
  const sameValue = (a: unknown, b: unknown) =>
    a === null || b === null ? a === b : Number(a) === Number(b);
  const macrosChanged = MACRO_COLUMNS.some(
    (k) => k in fields && !sameValue(fields[k], before[k]),
  );

  const rewritten: { day: string }[] = await sql.begin(async (tx) => {
    await tx`update foods set ${tx(fields)} where id = ${id}`;
    if (!macrosChanged) return [];
    // Recomputed in one statement from each entry's own grams, so a row that
    // recorded 200 g still records 200 g — only what 200 g means changes.
    return await tx`
      update intake_entries i set
        kcal = round(f.kcal_100g * i.grams / 100, 1),
        protein_g = round(f.protein_100g * i.grams / 100, 1),
        carbs_g = round(f.carbs_100g * i.grams / 100, 1),
        fat_g = round(f.fat_100g * i.grams / 100, 1),
        fiber_g = round(f.fiber_100g * i.grams / 100, 1)
      from foods f
      where f.id = i.food_id and i.food_id = ${id}
      returning i.id, i.day` as unknown as { day: string }[];
  });

  const days = rewritten.map((r) => r.day).sort();
  return c.json({
    food: await foodById(id),
    corrected_entries: {
      count: rewritten.length,
      from: days[0] ?? null,
      to: days[days.length - 1] ?? null,
    },
    note: macrosChanged
      ? `Corrected ${rewritten.length} logged ${
        rewritten.length === 1 ? "entry" : "entries"
      }: those numbers were wrong when they were written, so the record now says what was actually eaten. Meals containing this food update on their own — their totals are computed, never stored.`
      : "No macros changed, so nothing logged was affected.",
  });
});

// A synonym never becomes a second food row — that splits the food's history
// exactly the way a duplicate exercise splits a lift's.
foods.post("/:ref/aliases", async (c) => {
  const id = await resolveFoodId(c.req.param("ref"));
  const body = await readJson(c, ["alias", "aliases"]);
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

// An alias is a pointer, not a fact — removing one loses nothing and is how a
// spoken name gets moved to the food that should own it. Aliases are globally
// unique, so without this a retired food would hold "il solito yogurt"
// forever and no replacement could ever claim it.
foods.delete("/:ref/aliases/:alias", async (c) => {
  const id = await resolveFoodId(c.req.param("ref"));
  const alias = decodeURIComponent(c.req.param("alias"));
  const rows = await sql`
    delete from food_aliases
    where food_id = ${id} and lower(alias) = lower(${alias})
    returning id`;
  if (rows.length === 0) {
    throw new ApiError(
      404,
      `"${alias}" is not an alias of that food. GET /foods/${id} lists its aliases.`,
    );
  }
  return c.json({ food: await foodById(id) });
});

// Only a food nothing has ever used — a typo'd duplicate, a mis-sourced row
// caught before it was logged. Once a food is in the record, deleting it would
// orphan history, so the answer there is PATCH: fix the numbers and the past
// fixes with them.
foods.delete("/:ref", async (c) => {
  const id = await resolveFoodId(c.req.param("ref"));
  const [{ entries, items }] = await sql`
    select
      (select count(*)::int from intake_entries where food_id = ${id}) as entries,
      (select count(*)::int from meal_items where food_id = ${id}) as items`;
  if (entries > 0 || items > 0) {
    throw new ApiError(
      409,
      `That food is in use — ${entries} logged ${
        entries === 1 ? "entry" : "entries"
      } and ${items} meal ${
        items === 1 ? "item" : "items"
      } — so deleting it would orphan the record. If its numbers are wrong, PATCH /foods/:ref fixes them and every entry logged against them. If it is a duplicate, move its aliases to the food you are keeping.`,
    );
  }
  // Aliases first, and in one transaction. food_aliases references foods and
  // nothing here cascades — deleting the food first meant a food carrying any
  // alias could not be deleted at all, and the caller got a bare foreign-key
  // message about a table it never named.
  const name = await sql.begin(async (tx) => {
    await tx`delete from food_aliases where food_id = ${id}`;
    const [row] = await tx`delete from foods where id = ${id} returning name`;
    return row.name as string;
  });
  return c.json({ deleted: name });
});
