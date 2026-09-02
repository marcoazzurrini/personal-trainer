// The registry the coach fills as it goes. A food is sourced once — from a
// label, CREA, USDA or Open Food Facts — and saved, so it is never searched
// twice and the numbers stop depending on who remembered what.

import { sql } from "../db.ts";
import { ApiError } from "../shared/errors.ts";
import { checkEnergy, checkMacroMass } from "./rules.ts";
import { writeOnce } from "../shared/idempotency.ts";
import { assertFoodAliasesFree, resolveFoodId } from "./resolve.ts";

export const SOURCES = ["label", "crea", "usda", "off", "estimate"] as const;
export type Source = (typeof SOURCES)[number];

export interface FoodRow {
  id: number;
  name: string;
  brand: string | null;
  kcal_100g: number;
  protein_100g: number;
  carbs_100g: number;
  fat_100g: number;
  fiber_100g: number | null;
  grams_per_unit: number | null;
  source: Source;
  source_note: string | null;
  created_at: string;
  aliases: string[];
}

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

export async function foodById(id: number): Promise<FoodRow> {
  const [row] = await selectFoods(sql`where f.id = ${id}`);
  return row;
}

export async function foodByRef(ref: string): Promise<FoodRow> {
  return await foodById(await resolveFoodId(ref));
}

/**
 * Substring search rather than the whole registry: the list grows without
 * bound, and the question being asked is always "do I already have this?"
 * An empty query means the whole registry, which is what the caller asked for.
 */
export async function searchFoods(q?: string): Promise<FoodRow[]> {
  const term = q?.trim();
  if (!term) return await selectFoods();
  const like = `%${term}%`;
  return await selectFoods(sql`
    where f.name ilike ${like}
      or f.brand ilike ${like}
      or exists (
        select 1 from food_aliases a
        where a.food_id = f.id and a.alias ilike ${like}
      )`);
}

export interface SaveFoodInput {
  name: string;
  brand?: string | null;
  kcal_100g: number;
  protein_100g: number;
  carbs_100g: number;
  fat_100g: number;
  fiber_100g?: number | null;
  grams_per_unit?: number | null;
  source: Source;
  source_note?: string | null;
  energy_check?: "override";
  aliases?: string[] | null;
  request_id: string;
}

/**
 * Saves a food, or answers a retry with the one this request_id already saved.
 *
 * Refuses 422 when the macros do not weigh what they claim or the energy they
 * imply is not the energy stated, and 409 when the name or one of the aliases
 * is taken — naming which, and by what.
 */
export async function saveFood(
  b: SaveFoodInput,
): Promise<{ row: FoodRow; created: boolean }> {
  const { body: row, status } = await writeOnce<
    { id: number },
    FoodRow,
    FoodRow
  >({
    table: "foods",
    requestId: b.request_id,
    select: sql`id`,
    replay: (seen) => foodById(seen.id),
    write: async () => {
      const aliases = b.aliases ?? [];
      // Before the insert, not after: the constraint underneath can only say
      // that one of these was taken, and this says which and by what.
      await assertFoodAliasesFree(aliases);

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

      return await foodById(id);
    },
  });
  return { row, created: status === 201 };
}

export interface CorrectFoodInput {
  name?: string;
  brand?: string | null;
  kcal_100g?: number | null;
  protein_100g?: number | null;
  carbs_100g?: number | null;
  fat_100g?: number | null;
  fiber_100g?: number | null;
  grams_per_unit?: number | null;
  source?: Source;
  source_note?: string | null;
  energy_check?: "override";
}

export interface CorrectedFood {
  food: FoodRow;
  corrected_entries: { count: number; from: string | null; to: string | null };
  note: string;
}

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
// Nothing happens silently: the answer says how many entries were rewritten
// and over what dates.
export async function correctFood(
  ref: string,
  b: CorrectFoodInput,
): Promise<CorrectedFood> {
  const id = await resolveFoodId(ref);
  const [before] = await sql`select * from foods where id = ${id}`;

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

  const rewritten = await sql.begin(
    async (tx): Promise<{ day: string }[]> => {
      await tx`update foods set ${tx(fields)} where id = ${id}`;
      if (!macrosChanged) return [];
      // Recomputed in one statement from each entry's own grams, so a row that
      // recorded 200 g still records 200 g — only what 200 g means changes.
      return await tx<{ day: string }[]>`
      update intake_entries i set
        kcal = round(f.kcal_100g * i.grams / 100, 1),
        protein_g = round(f.protein_100g * i.grams / 100, 1),
        carbs_g = round(f.carbs_100g * i.grams / 100, 1),
        fat_g = round(f.fat_100g * i.grams / 100, 1),
        fiber_g = round(f.fiber_100g * i.grams / 100, 1)
      from foods f
      where f.id = i.food_id and i.food_id = ${id}
      returning i.id, i.day`;
    },
  );

  const days = rewritten.map((r) => r.day).sort();
  return {
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
  };
}

// Only a food nothing has ever used — a typo'd duplicate, a mis-sourced row
// caught before it was logged. Once a food is in the record, deleting it would
// orphan history, so the answer there is a correction: fix the numbers and the
// past fixes with them.
export async function deleteFood(ref: string): Promise<string> {
  const id = await resolveFoodId(ref);
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
  return await sql.begin(async (tx) => {
    await tx`delete from food_aliases where food_id = ${id}`;
    const [row] = await tx`delete from foods where id = ${id} returning name`;
    return row.name as string;
  });
}
