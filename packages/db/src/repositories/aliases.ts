import { and, asc, eq, sql } from "drizzle-orm";

import type { Client } from "../client.ts";
import { classifyDatabaseFailure } from "../errors.ts";
import {
  exercise_aliases,
  exercises,
  food_aliases,
  foods,
  meal_aliases,
  meals,
} from "../schema/index.ts";
import { caseKey } from "../storage.ts";
import { jsonChunks } from "../write.ts";

const kinds = {
  exercise: {
    table: exercises,
    aliases: exercise_aliases,
    owner: exercise_aliases.exercise_id,
  },
  food: { table: foods, aliases: food_aliases, owner: food_aliases.food_id },
  meal: { table: meals, aliases: meal_aliases, owner: meal_aliases.meal_id },
} as const;
export type AliasKind = keyof typeof kinds;

export interface TakenAlias {
  alias: string;
  id: number;
  name: string;
}

/** Table dispatch is limited to this trusted catalogue, never SQL from a caller. */
export function aliasRepository(db: Client, kind: AliasKind) {
  if (!Object.hasOwn(kinds, kind)) {
    throw new Error("Unknown alias kind.");
  }
  const spec = kinds[kind];

  async function findTaken(aliases: readonly string[]): Promise<TakenAlias[]> {
    const taken: TakenAlias[] = [];
    try {
      for (const { json: chunk } of jsonChunks([
        ...new Set(aliases.map((alias) => caseKey(alias.trim()))),
      ])) {
        taken.push(
          ...(await db
            .select({
              alias: spec.aliases.alias,
              id: spec.table.id,
              name: spec.table.name,
            })
            .from(spec.aliases)
            .innerJoin(spec.table, eq(spec.table.id, spec.owner))
            .where(
              sql`${spec.aliases.alias_key} in (select value from json_each(${chunk}))`
            )
            .orderBy(asc(spec.aliases.alias)))
        );
      }
      return taken;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function add(id: number, aliases: readonly string[]): Promise<void> {
    if (!aliases.length) {
      return;
    }
    try {
      const inserts = jsonChunks(
        aliases.map((alias) => ({ alias, key: caseKey(alias) }))
      ).map(({ json: chunk }) => {
        const fields = {
          alias: sql<string>`json_extract(value, '$.alias')`.as("alias"),
          alias_key: sql<string>`json_extract(value, '$.key')`.as("alias_key"),
        };
        // Each SELECT follows its table's column order, including the generated id.
        switch (kind) {
          case "exercise": {
            return db.insert(exercise_aliases).select(
              db
                .select({
                  id: sql<number>`null`.as("id"),
                  exercise_id: sql<number>`${id}`.as("exercise_id"),
                  ...fields,
                })
                .from(sql`json_each(${chunk})`)
            );
          }
          case "food": {
            return db.insert(food_aliases).select(
              db
                .select({
                  id: sql<number>`null`.as("id"),
                  food_id: sql<number>`${id}`.as("food_id"),
                  ...fields,
                })
                .from(sql`json_each(${chunk})`)
            );
          }
          case "meal": {
            return db.insert(meal_aliases).select(
              db
                .select({
                  id: sql<number>`null`.as("id"),
                  meal_id: sql<number>`${id}`.as("meal_id"),
                  ...fields,
                })
                .from(sql`json_each(${chunk})`)
            );
          }
          default: {
            throw new Error("Unknown alias kind.");
          }
        }
      });
      const [first, ...rest] = inserts;
      if (first) {
        // A late uniqueness or owner failure rolls back every chunk.
        await db.batch([first, ...rest]);
      }
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  async function release(id: number, alias: string): Promise<boolean> {
    try {
      const rows = await db
        .delete(spec.aliases)
        .where(
          and(eq(spec.owner, id), eq(spec.aliases.alias_key, caseKey(alias)))
        )
        .returning({ id: spec.aliases.id });
      return rows.length > 0;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }

  return { kind, findTaken, add, release };
}

export type AliasRepository = ReturnType<typeof aliasRepository>;
