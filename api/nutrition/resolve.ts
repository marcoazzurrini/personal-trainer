import { caseKey, jsonChunks, rows, statement } from "../shared/d1.ts";
import type { Clock, Database, Parameter } from "../shared/d1.ts";
import { ApiError } from "../shared/errors.ts";
import type { Namespace } from "../shared/resolve.ts";

const FOODS: Namespace = {
  table: "foods",
  aliasTable: "food_aliases",
  foreignKey: "food_id",
  noSuchId: (ref) =>
    `No food with id ${ref}. GET /foods?q=<search> lists them.`,
  unknownName: (name) =>
    `Unknown food "${name}". GET /foods?q=<search> lists what exists — use the id, canonical name, or an alias. A food that genuinely does not exist yet is sourced (label, CREA, USDA, Open Food Facts) and saved with POST /foods — never invented. A synonym of a food that exists gets an alias instead: POST /foods/:ref/aliases.`,
  missingRef: '"food" is required: a food id, canonical name, or alias.',
  what: "food",
  route: "/foods",
};

const MEALS: Namespace = {
  table: "meals",
  aliasTable: "meal_aliases",
  foreignKey: "meal_id",
  noSuchId: (ref) => `No meal with id ${ref}. GET /meals lists them.`,
  unknownName: (name) =>
    `Unknown meal "${name}". GET /meals lists what exists — use the id, canonical name, or an alias. A meal that has become a routine is saved with POST /meals. A one-off variation on a saved meal is not a new meal — log the meal and log the difference as a separate entry.`,
  missingRef: '"meal" is required: a meal id, canonical name, or alias.',
  what: "meal",
  route: "/meals",
};

// These statements belong to the same atomic batch as the guarded write.
export const beginNutritionWrite = (db: Database) =>
  statement(db, "INSERT INTO nutrition_write_assertions (id) VALUES (1)");
export const finishNutritionWrite = (db: Database) =>
  statement(db, "DELETE FROM nutrition_write_assertions WHERE id = 1");
export const nutritionRows = (db: Database, count: number) =>
  statement(
    db,
    "UPDATE nutrition_write_assertions SET valid = (changes() = ?) WHERE id = 1",
    count
  );
export const nutritionCheck = (
  db: Database,
  predicate: string,
  ...values: Parameter[]
) =>
  statement(
    db,
    `UPDATE nutrition_write_assertions SET valid = (${predicate}) WHERE id = 1`,
    ...values
  );

export function nutritionResolver(db: Database, _clock?: Clock) {
  async function resolveMany(
    ns: Namespace,
    refs: readonly unknown[]
  ): Promise<number[]> {
    const result = new Map<number, number>();
    for (const chunk of jsonChunks(
      refs.map((ref, index) => ({
        index,
        // eslint-disable-next-line anti-slop/no-runtime-typeof -- Reference parser accepts integer ids and must reject other JSON values without coercion.
        id: typeof ref === "number" && Number.isInteger(ref) ? ref : null,
        // eslint-disable-next-line anti-slop/no-runtime-typeof -- Only string references may be trimmed and normalized as names.
        name: typeof ref === "string" ? caseKey(ref.trim()) : null,
        fallback:
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Numeric strings fall back to ids only after the name and alias lookup.
          typeof ref === "string" && /^\d+$/u.test(ref.trim())
            ? Number(ref.trim())
            : null,
      }))
    )) {
      const found = await rows<{ position: number; id: number | null }>(
        db,
        `
        SELECT json_extract(v.value, '$.index') AS position, coalesce(
          (SELECT id FROM ${ns.table} WHERE id = json_extract(v.value, '$.id')),
          (SELECT id FROM ${ns.table} WHERE name_key = json_extract(v.value, '$.name') AND json_extract(v.value, '$.name') <> ''),
          (SELECT ${ns.foreignKey} FROM ${ns.aliasTable} WHERE alias_key = json_extract(v.value, '$.name') AND json_extract(v.value, '$.name') <> ''),
          (SELECT id FROM ${ns.table} WHERE id = json_extract(v.value, '$.fallback'))
        ) AS id FROM json_each(?) v`,
        chunk.json
      );
      for (const row of found) {
        if (row.id !== null) {
          result.set(row.position, row.id);
        }
      }
    }
    return refs.map((ref, index) => {
      const id = result.get(index);
      if (id !== undefined) {
        return id;
      }
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- Preserve the integer-id refusal for unresolved raw references.
      if (typeof ref === "number" && Number.isInteger(ref)) {
        throw new ApiError(422, ns.noSuchId(ref));
      }
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- Distinguish an unknown name from a missing or invalid JSON reference.
      if (typeof ref === "string" && ref.trim()) {
        if (/^\d+$/u.test(ref.trim())) {
          throw new ApiError(422, ns.noSuchId(Number(ref.trim())));
        }
        throw new ApiError(422, ns.unknownName(ref.trim()));
      }
      throw new ApiError(422, ns.missingRef);
    });
  }
  async function aliasesFree(ns: Namespace, aliases: readonly string[]) {
    const taken: { alias: string; id: number; name: string }[] = [];
    for (const chunk of jsonChunks([
      ...new Set(aliases.map((a) => caseKey(a.trim()))),
    ])) {
      taken.push(
        ...(await rows<{ alias: string; id: number; name: string }>(
          db,
          `SELECT a.alias, e.id, e.name FROM ${ns.aliasTable} a JOIN ${ns.table} e ON e.id = a.${ns.foreignKey}
         WHERE a.alias_key IN (SELECT value FROM json_each(?)) ORDER BY a.alias`,
          chunk.json
        ))
      );
    }
    if (!taken.length) {
      return;
    }
    taken.sort((a, b) => {
      if (a.alias < b.alias) {
        return -1;
      }
      return a.alias > b.alias ? 1 : 0;
    });
    const clashes = taken
      .map(
        (t) => `"${t.alias}" already belongs to ${ns.what} ${t.id} (${t.name})`
      )
      .join("; ");
    const one = taken.length === 1;
    throw new ApiError(
      409,
      `${clashes}. Aliases are case-insensitive and globally unique — one name points at one ${ns.what}. Nothing was written: resend without ${
        one ? "that alias" : "those aliases"
      }, which costs only ${
        one ? "that word" : "those words"
      } and keeps the rest of the call. If ${
        one ? "the name belongs" : "a name belongs"
      } on this row instead, release it first with DELETE ${ns.route}/${
        taken[0].id
      }/aliases/${encodeURIComponent(taken[0].alias)}.`
    );
  }
  return {
    // eslint-disable-next-line anti-slop/no-unknown-parameters -- This parser boundary accepts raw food references and resolveMany validates their representation and existence.
    resolveFoodId: async (ref: unknown) => (await resolveMany(FOODS, [ref]))[0],
    // eslint-disable-next-line anti-slop/no-unknown-parameters -- This parser boundary accepts raw meal references and resolveMany validates their representation and existence.
    resolveMealId: async (ref: unknown) => (await resolveMany(MEALS, [ref]))[0],
    resolveFoodIds: (refs: readonly unknown[]) => resolveMany(FOODS, refs),
    assertFoodAliasesFree: (aliases: readonly string[]) =>
      aliasesFree(FOODS, aliases),
    assertMealAliasesFree: (aliases: readonly string[]) =>
      aliasesFree(MEALS, aliases),
  };
}
