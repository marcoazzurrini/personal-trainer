import { sql } from "../db.ts";
import { ApiError } from "./errors.ts";

// Exercises, foods and meals resolve the same way — id, name, or alias,
// case-insensitively, server-side — so voice-to-text phrasing ("il solito
// yogurt") never has to be matched by the caller. Shared because the rule is
// one rule: a synonym that creates a second row splits a food's history the
// way a duplicate exercise splits a lift's.
//
// The engine only. Each namespace is declared by the topic that owns its
// table — foods and meals in nutrition/resolve.ts, exercises in training's —
// because what is shared is the ranked-union law and not the prose that
// refuses a call.
export interface Namespace {
  table: string;
  aliasTable: string;
  foreignKey: string;
  // The refusals, written per namespace rather than filled from one template.
  // Only the rule is shared, not the prose: the client is a model, and the
  // sentence telling it how to add a food it could not find is not the
  // sentence telling it how to add an exercise.
  noSuchId: (ref: number) => string;
  unknownName: (name: string) => string;
  missingRef: string;
  // What one of these is called, and the prefix its aliases hang off — the
  // alias-clash refusal names both.
  what: string;
  route: string;
}

export async function resolveNamed(
  ns: Namespace,
  ref: unknown,
): Promise<number> {
  if (typeof ref === "number" && Number.isInteger(ref)) {
    const [row] = await sql`
      select id from ${sql(ns.table)} where id = ${ref}`;
    if (row) return row.id;
    throw new ApiError(422, ns.noSuchId(ref));
  }
  if (typeof ref === "string" && ref.trim() !== "") {
    const name = ref.trim();
    // Ranked rather than relying on union order: a canonical name always wins
    // over an alias that happens to spell the same thing. A bare union with
    // limit 1 left the collision to whichever row the planner produced first,
    // which is a different exercise on a different day.
    //
    // Refusing the collision instead was tried and reverted. It reads as the
    // safer answer — two real candidates, say so — but the two are not equal:
    // a row's own name is what it *is*, and another row's synonym is a word
    // someone attached to it. "Nordic Curl" is in the catalogue beside a
    // "Nordic Hamstring Curl" that answers to the same phrase, and asking for
    // the first by its exact name is not ambiguous in any sense the caller
    // would recognise. The rank is the answer; reference_test holds it.
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
    throw new ApiError(422, ns.unknownName(name));
  }
  throw new ApiError(422, ns.missingRef);
}

// Which aliases in this call are already spoken for, asked before anything is
// written rather than discovered by the unique constraint afterwards.
//
// The constraint's message could only say that *an* alias was taken: it does
// not know which of the several sent collided, nor what owns it, so a caller
// holding {"aliases": ["magnum pistacchio", "magnum"]} was told to go and
// search for the answer the server already had. And because the insert runs
// inside the same transaction as the row itself, that refusal threw away a
// fully sourced food over one word.
//
// Naming the clash makes the retry a one-token edit. The constraint stays
// underneath as the backstop for two calls racing.
export async function assertAliasesFree(
  ns: Namespace,
  aliases: readonly string[],
): Promise<void> {
  const wanted = aliases.map((a) => a.trim().toLowerCase());
  if (wanted.length === 0) return;
  const taken = await sql<{ alias: string; id: number; name: string }[]>`
    select a.alias, e.id, e.name
    from ${sql(ns.aliasTable)} a
    join ${sql(ns.table)} e on e.id = a.${sql(ns.foreignKey)}
    where lower(a.alias) = any(${wanted})
    order by a.alias`;
  if (taken.length === 0) return;

  const clashes = taken
    .map((t) =>
      `"${t.alias}" already belongs to ${ns.what} ${t.id} (${t.name})`
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
    }/aliases/${encodeURIComponent(taken[0].alias)}.`,
  );
}
