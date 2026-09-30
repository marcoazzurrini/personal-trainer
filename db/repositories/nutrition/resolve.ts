import type { Client } from "../../client.ts";
import { rows } from "../../native.ts";
import { jsonChunks } from "../../write.ts";

export type NutritionKind = "food" | "meal";
export interface ReferenceLookup {
  index: number;
  id: number | null;
  name: string | null;
  fallback: number | null;
}
const namespaces = {
  food: { table: "foods", aliasTable: "food_aliases", foreignKey: "food_id" },
  meal: { table: "meals", aliasTable: "meal_aliases", foreignKey: "meal_id" },
} as const;

export function resolveRepository(db: Client) {
  async function resolve(
    kind: NutritionKind,
    refs: readonly ReferenceLookup[]
  ) {
    const ns = namespaces[kind];
    const result: { position: number; id: number | null }[] = [];
    for (const chunk of jsonChunks(refs)) {
      result.push(
        ...(await rows<{ position: number; id: number | null }>(
          db,
          `
        SELECT json_extract(v.value, '$.index') AS position, coalesce(
          (SELECT id FROM ${ns.table} WHERE id = json_extract(v.value, '$.id')),
          (SELECT id FROM ${ns.table} WHERE name_key = json_extract(v.value, '$.name') AND json_extract(v.value, '$.name') <> ''),
          (SELECT ${ns.foreignKey} FROM ${ns.aliasTable} WHERE alias_key = json_extract(v.value, '$.name') AND json_extract(v.value, '$.name') <> ''),
          (SELECT id FROM ${ns.table} WHERE id = json_extract(v.value, '$.fallback'))
        ) AS id FROM json_each(?) v`,
          chunk.json
        ))
      );
    }
    return result;
  }
  async function takenAliases(kind: NutritionKind, keys: readonly string[]) {
    const ns = namespaces[kind];
    const taken: { alias: string; id: number; name: string }[] = [];
    for (const chunk of jsonChunks(keys)) {
      taken.push(
        ...(await rows<{ alias: string; id: number; name: string }>(
          db,
          `SELECT a.alias, e.id, e.name FROM ${ns.aliasTable} a JOIN ${ns.table} e ON e.id = a.${ns.foreignKey}
         WHERE a.alias_key IN (SELECT value FROM json_each(?)) ORDER BY a.alias`,
          chunk.json
        ))
      );
    }
    return taken;
  }
  return { resolve, takenAliases };
}
export type ResolveRepository = ReturnType<typeof resolveRepository>;
