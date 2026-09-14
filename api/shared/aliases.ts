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
 * One bulk statement makes the list atomic: an invalid alias refuses the
 * whole list rather than leaving a half-added list behind.
 */
export async function addAliases(
  table: string,
  foreignKey: string,
  id: number,
  aliases: readonly string[],
): Promise<void> {
  if (aliases.length === 0) return;
  await sql`
    insert into ${sql(table)}
    ${
    sql(
      aliases.map((alias) => ({ [foreignKey]: id, alias })),
      foreignKey,
      "alias",
    )
  }`;
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
