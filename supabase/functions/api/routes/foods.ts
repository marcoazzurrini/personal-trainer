import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { ApiError } from "../http/errors.ts";
import { checkEnergy, checkMacroMass } from "../rules/nutrition.ts";
import { resolveFoodId } from "../record/resolve.ts";
import {
  body,
  number,
  oneOf,
  optionalNumber,
  optionalText,
  requestId,
  text,
} from "../http/schema.ts";

// The registry the coach fills as it goes. A food is sourced once — from a
// label, CREA, USDA or Open Food Facts — and saved, so it is never searched
// twice and the numbers stop depending on who remembered what.

const SOURCES = ["label", "crea", "usda", "off", "estimate"] as const;

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

type FoodRow = z.infer<typeof Food>;

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

const aliasesError = () => '"aliases" must be an array of non-empty strings.';
const aliasList = () =>
  z.array(
    z.string({ error: aliasesError }).trim().min(1, { error: aliasesError }),
    { error: aliasesError },
  ).optional();

// One shape for every food read; the caller supplies only the filter.
// deno-lint-ignore no-explicit-any
function selectFoods(where: any = sql``) {
  return sql<FoodRow[]>`
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

// Substring search rather than the whole registry: the list grows without
// bound, and the question being asked is always "do I already have this?"
foods.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Nutrition"],
    summary: "Search the food registry",
    request: {
      query: z.object({
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
      409: { description: "A food with that name already exists." },
    },
  }),
  async (c) => {
    const b = c.req.valid("json");
    const [seen] = await sql`
      select id from foods where request_id = ${b.request_id}`;
    if (seen) return c.json({ food: await foodById(seen.id) }, 200);

    const aliases = b.aliases ?? [];

    checkMacroMass(b.protein_100g, b.carbs_100g, b.fat_100g);
    checkEnergy(
      b.kcal_100g,
      b.protein_100g,
      b.carbs_100g,
      b.fat_100g,
      b.energy_check === "override",
      b.source_note ?? null,
    );

    const id = await sql.begin(async (tx) => {
      const [created] = await tx`
      insert into foods
        (name, brand, kcal_100g, protein_100g, carbs_100g, fat_100g,
         fiber_100g, grams_per_unit, source, source_note, request_id)
      values
        (${b.name}, ${b.brand ?? null}, ${b.kcal_100g}, ${b.protein_100g},
         ${b.carbs_100g}, ${b.fat_100g}, ${b.fiber_100g ?? null},
         ${b.grams_per_unit ?? null}, ${b.source}, ${b.source_note ?? null},
         ${b.request_id})
      returning id`;
      for (const alias of aliases) {
        await tx`
        insert into food_aliases (food_id, alias)
        values (${created.id}, ${alias})`;
      }
      return created.id as number;
    });

    return c.json({ food: await foodById(id) }, 201);
  },
);

foods.openapi(
  createRoute({
    method: "get",
    path: "/{ref}",
    tags: ["Nutrition"],
    summary: "One food, by id, name or alias",
    request: { params: z.object({ ref: ref() }) },
    responses: {
      200: {
        description: "The food, with its aliases.",
        content: { "application/json": { schema: z.object({ food: Food }) } },
      },
      404: { description: "Nothing resolves to that reference." },
    },
  }),
  async (c) => {
    const id = await resolveFoodId(c.req.valid("param").ref);
    return c.json({ food: await foodById(id) });
  },
);

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
foods.openapi(
  createRoute({
    method: "patch",
    path: "/{ref}",
    tags: ["Nutrition"],
    summary: "Fix a food's numbers, and every entry logged against them",
    description:
      "Only ever for fixing a mistake. A different product — another brand, a reformulated recipe — is a new food, not an edit. Changing macros rewrites every intake entry ever logged against this food, and the response says how many and over what dates.",
    request: {
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
  async (c) => {
    const id = await resolveFoodId(c.req.valid("param").ref);
    const [before] = await sql`select * from foods where id = ${id}`;
    const b = c.req.valid("json");

    const fields: Record<string, unknown> = {};
    for (
      const key of [
        "kcal_100g",
        "protein_100g",
        "carbs_100g",
        "fat_100g",
        "fiber_100g",
        "grams_per_unit",
        "name",
        "brand",
        "source",
        "source_note",
      ] as const
    ) {
      if (b[key] !== undefined) fields[key] = b[key];
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
      b.energy_check === "override",
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
  },
);

// A synonym never becomes a second food row — that splits the food's history
// exactly the way a duplicate exercise splits a lift's.
foods.openapi(
  createRoute({
    method: "post",
    path: "/{ref}/aliases",
    tags: ["Nutrition"],
    summary: "Add a synonym",
    request: {
      params: z.object({ ref: ref() }),
      body: {
        content: {
          "application/json": {
            schema: body({ alias: text().optional(), aliases: aliasList() }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The food, with the alias now among its names.",
        content: { "application/json": { schema: z.object({ food: Food }) } },
      },
      409: { description: "That alias already points at something." },
      422: { description: "Neither alias nor aliases was sent." },
    },
  }),
  async (c) => {
    const id = await resolveFoodId(c.req.valid("param").ref);
    const b = c.req.valid("json");
    const aliases = b.alias !== undefined ? [b.alias] : (b.aliases ?? []);
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
  },
);

// An alias is a pointer, not a fact — removing one loses nothing and is how a
// spoken name gets moved to the food that should own it. Aliases are globally
// unique, so without this a retired food would hold "il solito yogurt"
// forever and no replacement could ever claim it.
foods.openapi(
  createRoute({
    method: "delete",
    path: "/{ref}/aliases/{alias}",
    tags: ["Nutrition"],
    summary: "Release a synonym",
    request: {
      params: z.object({ ref: ref(), alias: z.string().min(1) }),
    },
    responses: {
      200: {
        description: "The food, without that name.",
        content: { "application/json": { schema: z.object({ food: Food }) } },
      },
      404: { description: "That alias does not point at that food." },
    },
  }),
  async (c) => {
    const { ref: reference, alias: rawAlias } = c.req.valid("param");
    const id = await resolveFoodId(reference);
    const alias = decodeURIComponent(rawAlias);
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
  },
);

// Only a food nothing has ever used — a typo'd duplicate, a mis-sourced row
// caught before it was logged. Once a food is in the record, deleting it would
// orphan history, so the answer there is PATCH: fix the numbers and the past
// fixes with them.
foods.openapi(
  createRoute({
    method: "delete",
    path: "/{ref}",
    tags: ["Nutrition"],
    summary: "Delete an unused food",
    request: { params: z.object({ ref: ref() }) },
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
  async (c) => {
    const id = await resolveFoodId(c.req.valid("param").ref);
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
  },
);
