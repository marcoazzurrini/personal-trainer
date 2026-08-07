import { sql } from "../db.ts";
import { ApiError } from "./errors.ts";

// Exercises resolve by id, name, or alias, case-insensitively, server-side.
export async function resolveExerciseId(ref: unknown): Promise<number> {
  if (typeof ref === "number" && Number.isInteger(ref)) {
    const [row] = await sql`select id from exercises where id = ${ref}`;
    if (row) return row.id;
    throw new ApiError(
      422,
      `No exercise with id ${ref}. GET /api/exercises lists the catalogue.`,
    );
  }
  if (typeof ref === "string" && ref.trim() !== "") {
    const name = ref.trim();
    const [row] = await sql`
      select e.id from exercises e where lower(e.name) = lower(${name})
      union all
      select a.exercise_id from exercise_aliases a
      where lower(a.alias) = lower(${name})
      limit 1`;
    if (row) return row.id;
    if (/^\d+$/.test(name)) return resolveExerciseId(Number(name));
    throw new ApiError(
      422,
      `Unknown exercise "${name}". Use the id, canonical name, or an alias — GET /api/exercises lists them. A genuinely new exercise is added with POST /api/exercises.`,
    );
  }
  throw new ApiError(
    422,
    '"exercise" is required: an exercise id, canonical name, or alias.',
  );
}

// Foods and meals resolve the same way exercises do — id, name, or alias,
// case-insensitively, server-side — so voice-to-text phrasing ("il solito
// yogurt") never has to be matched by the caller. Shared because the rule is
// one rule: a synonym that creates a second row splits a food's history the
// way a duplicate exercise splits a lift's.
interface Namespace {
  table: string;
  aliasTable: string;
  foreignKey: string;
  label: string; // "food" / "meal", for the error messages
  listPath: string;
  createHint: string;
}

async function resolveNamed(ns: Namespace, ref: unknown): Promise<number> {
  if (typeof ref === "number" && Number.isInteger(ref)) {
    const [row] = await sql`
      select id from ${sql(ns.table)} where id = ${ref}`;
    if (row) return row.id;
    throw new ApiError(
      422,
      `No ${ns.label} with id ${ref}. ${ns.listPath} lists them.`,
    );
  }
  if (typeof ref === "string" && ref.trim() !== "") {
    const name = ref.trim();
    // Ranked rather than relying on union order: a canonical name always wins
    // over an alias that happens to spell the same thing.
    const [row] = await sql`
      select id, 1 as rank from ${sql(ns.table)}
      where lower(name) = lower(${name})
      union all
      select ${sql(ns.foreignKey)} as id, 2 as rank from ${sql(ns.aliasTable)}
      where lower(alias) = lower(${name})
      order by rank
      limit 1`;
    if (row) return row.id;
    if (/^\d+$/.test(name)) return resolveNamed(ns, Number(name));
    throw new ApiError(
      422,
      `Unknown ${ns.label} "${name}". ${ns.listPath} lists what exists — use the id, canonical name, or an alias. ${ns.createHint}`,
    );
  }
  throw new ApiError(
    422,
    `"${ns.label}" is required: a ${ns.label} id, canonical name, or alias.`,
  );
}

export function resolveFoodId(ref: unknown): Promise<number> {
  return resolveNamed({
    table: "foods",
    aliasTable: "food_aliases",
    foreignKey: "food_id",
    label: "food",
    listPath: "GET /api/foods?q=<search>",
    createHint:
      "A food that genuinely does not exist yet is sourced (label, CREA, USDA, Open Food Facts) and saved with POST /api/foods — never invented. A synonym of a food that exists gets an alias instead: POST /api/foods/:ref/aliases.",
  }, ref);
}

export function resolveMealId(ref: unknown): Promise<number> {
  return resolveNamed({
    table: "meals",
    aliasTable: "meal_aliases",
    foreignKey: "meal_id",
    label: "meal",
    listPath: "GET /api/meals",
    createHint:
      "A meal that has become a routine is saved with POST /api/meals. A one-off variation on a saved meal is not a new meal — log the meal and log the difference as a separate entry.",
  }, ref);
}

// deno-lint-ignore no-explicit-any
export async function resolveMesocycle(idParam: string): Promise<any> {
  if (idParam === "current") {
    const [row] = await sql`
      select * from mesocycles where ended_on is null`;
    if (!row) {
      throw new ApiError(
        404,
        "No active mesocycle. Create one with POST /api/mesocycles, or pass an explicit id.",
      );
    }
    return row;
  }
  if (!/^\d+$/.test(idParam)) {
    throw new ApiError(
      422,
      `"${idParam}" is not a mesocycle reference. Use a numeric id or "current".`,
    );
  }
  const [row] = await sql`
    select * from mesocycles where id = ${Number(idParam)}`;
  if (!row) throw new ApiError(404, `No mesocycle with id ${idParam}.`);
  return row;
}
