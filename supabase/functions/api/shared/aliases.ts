// The two writes behind the shared alias surface.
//
// Generic over the alias table on purpose. Exercises, foods and meals each
// have their own — exercise_aliases, food_aliases, meal_aliases — and the
// statement is the same statement in all three; what differs is the table
// name and the column pointing back at the owner. Splitting the surface into
// three copies to avoid two identifier parameters would restate one rule
// three times, which is what #26 removed.
//
// Apart from aliases.routes.ts because that file declares HTTP routes and may
// not reach the database (ADR-0006). It is the same split every topic makes,
// on a surface that belongs to no topic.

import { sql } from "../db.ts";
import { requireRow } from "./errors.ts";

/**
 * Adds every alias to one owner, or none of them.
 *
 * One transaction because the caller sends a list and a half-added list is a
 * worse answer than a refusal: the second name is the one that would be
 * missing, and nothing in the response would say so.
 */
export async function addAliases(
  table: string,
  foreignKey: string,
  id: number,
  aliases: readonly string[],
): Promise<void> {
  await sql.begin(async (tx) => {
    for (const alias of aliases) {
      await tx`
      insert into ${sql(table)}
      (${sql(foreignKey)}, alias) values (${id}, ${alias})`;
    }
  });
}

/**
 * Removes one alias from one owner, or refuses 404 with the caller's sentence.
 *
 * Case-insensitive, because that is how the name was matched when it was
 * resolved and a caller that reached the entity by "Il Solito Yogurt" should
 * be able to release it by the same spelling.
 */
export async function releaseAlias(spec: {
  table: string;
  foreignKey: string;
  id: number;
  alias: string;
  notAnAlias: string;
}): Promise<void> {
  requireRow(
    await sql`
      delete from ${sql(spec.table)}
      where ${sql(spec.foreignKey)} = ${spec.id}
        and lower(alias) = lower(${spec.alias})
      returning id`,
    spec.notAnAlias,
  );
}
