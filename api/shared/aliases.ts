import { ApiError, requireRow } from "./errors.ts";
import {
  batch,
  caseKey,
  type Database,
  jsonChunks,
  rows,
  statement,
} from "./d1.ts";

const kinds = {
  exercise: {
    table: "exercises",
    aliases: "exercise_aliases",
    key: "exercise_id",
    route: "/exercises",
  },
  food: {
    table: "foods",
    aliases: "food_aliases",
    key: "food_id",
    route: "/foods",
  },
  meal: {
    table: "meals",
    aliases: "meal_aliases",
    key: "meal_id",
    route: "/meals",
  },
} as const;
export type AliasKind = keyof typeof kinds;

/** Identifiers come only from this trusted catalogue, never from request input. */
export function aliasStore(db: Database, kind: AliasKind) {
  if (!Object.hasOwn(kinds, kind)) throw new Error("Unknown alias kind.");
  const spec = kinds[kind];

  async function assertAliasesFree(aliases: readonly string[]): Promise<void> {
    const taken: { alias: string; id: number; name: string }[] = [];
    for (
      const chunk of jsonChunks([
        ...new Set(aliases.map((a) => caseKey(a.trim()))),
      ])
    ) {
      taken.push(
        ...(await rows<{ alias: string; id: number; name: string }>(
          db,
          `SELECT a.alias, e.id, e.name FROM ${spec.aliases} a
         JOIN ${spec.table} e ON e.id = a.${spec.key}
         WHERE a.alias_key IN (SELECT value FROM json_each(?)) ORDER BY a.alias`,
          chunk.json,
        )),
      );
    }
    if (!taken.length) return;
    taken.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
    const clashes = taken
      .map((t) => `"${t.alias}" already belongs to ${kind} ${t.id} (${t.name})`)
      .join("; ");
    const one = taken.length === 1;
    throw new ApiError(
      409,
      `${clashes}. Aliases are case-insensitive and globally unique — one name points at one ${kind}. Nothing was written: resend without ${
        one ? "that alias" : "those aliases"
      }, which costs only ${
        one ? "that word" : "those words"
      } and keeps the rest of the call. If ${
        one ? "the name belongs" : "a name belongs"
      } on this row instead, release it first with DELETE ${spec.route}/${
        taken[0].id
      }/aliases/${encodeURIComponent(taken[0].alias)}.`,
    );
  }

  async function addAliases(
    id: number,
    aliases: readonly string[],
  ): Promise<void> {
    if (!aliases.length) return;
    await batch(
      db,
      jsonChunks(aliases.map((alias) => ({ alias, key: caseKey(alias) }))).map(
        (chunk) =>
          statement(
            db,
            `INSERT INTO ${spec.aliases} (${spec.key}, alias, alias_key)
       SELECT ?, json_extract(value, '$.alias'), json_extract(value, '$.key') FROM json_each(?)`,
            id,
            chunk.json,
          ),
      ),
    );
  }

  async function releaseAlias(input: {
    id: number;
    alias: string;
    notAnAlias: string;
  }): Promise<void> {
    requireRow(
      await rows(
        db,
        `DELETE FROM ${spec.aliases} WHERE ${spec.key} = ? AND alias_key = ? RETURNING id`,
        input.id,
        caseKey(input.alias),
      ),
      input.notAnAlias,
    );
  }
  return { addAliases, releaseAlias, assertAliasesFree };
}
