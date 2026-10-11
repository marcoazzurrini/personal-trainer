import type { AliasRepository } from "@trainer/db/repositories/aliases.ts";
import { Effect } from "effect";

import { effectful } from "./database.ts";
import { Conflict, NotFound } from "./refusals.ts";
import type { DatabaseFailure } from "./refusals.ts";

const kinds = {
  exercise: {
    route: "/exercises",
  },
  food: {
    route: "/foods",
  },
  meal: {
    route: "/meals",
  },
} as const;

export function aliasStore(rows: AliasRepository) {
  const repository = effectful(rows);
  const { kind } = repository;
  if (!Object.hasOwn(kinds, kind)) {
    throw new Error("Unknown alias kind.");
  }
  const spec = kinds[kind];

  const assertAliasesFree = Effect.fn("aliases.assertAliasesFree")(function* (
    aliases: readonly string[]
  ): Effect.fn.Return<void, Conflict | DatabaseFailure> {
    const taken = yield* repository.findTaken(aliases);
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
      .map((t) => `"${t.alias}" already belongs to ${kind} ${t.id} (${t.name})`)
      .join("; ");
    const one = taken.length === 1;
    return yield* new Conflict({
      message: `${clashes}. Aliases are case-insensitive and globally unique — one name points at one ${kind}. Nothing was written: resend without ${
        one ? "that alias" : "those aliases"
      }, which costs only ${
        one ? "that word" : "those words"
      } and keeps the rest of the call. If ${
        one ? "the name belongs" : "a name belongs"
      } on this row instead, release it first with DELETE ${spec.route}/${
        taken[0].id
      }/aliases/${encodeURIComponent(taken[0].alias)}.`,
    });
  });

  const addAliases = Effect.fn("aliases.addAliases")(function* (
    id: number,
    aliases: readonly string[]
  ): Effect.fn.Return<void, DatabaseFailure> {
    if (!aliases.length) {
      return;
    }
    yield* repository.add(id, aliases);
  });

  const releaseAlias = Effect.fn("aliases.releaseAlias")(function* (input: {
    id: number;
    alias: string;
    notAnAlias: string;
  }): Effect.fn.Return<void, NotFound | DatabaseFailure> {
    if (!(yield* repository.release(input.id, input.alias))) {
      return yield* new NotFound({ message: input.notAnAlias });
    }
  });
  return { addAliases, releaseAlias, assertAliasesFree };
}
