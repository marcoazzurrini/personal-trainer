import type { AliasRepository } from "../../db/repositories/aliases.ts";
import { ApiError, databaseError } from "./errors.ts";

export type { AliasKind } from "../../db/repositories/aliases.ts";

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

export function aliasStore(repository: AliasRepository) {
  const { kind } = repository;
  if (!Object.hasOwn(kinds, kind)) {
    throw new Error("Unknown alias kind.");
  }
  const spec = kinds[kind];

  async function assertAliasesFree(aliases: readonly string[]): Promise<void> {
    const taken = await repository.findTaken(aliases).catch((error) => {
      throw databaseError(error);
    });
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
      }/aliases/${encodeURIComponent(taken[0].alias)}.`
    );
  }

  async function addAliases(
    id: number,
    aliases: readonly string[]
  ): Promise<void> {
    if (!aliases.length) {
      return;
    }
    try {
      await repository.add(id, aliases);
    } catch (error) {
      throw databaseError(error);
    }
  }

  async function releaseAlias(input: {
    id: number;
    alias: string;
    notAnAlias: string;
  }): Promise<void> {
    try {
      if (!(await repository.release(input.id, input.alias))) {
        throw new ApiError(404, input.notAnAlias);
      }
    } catch (error) {
      throw databaseError(error);
    }
  }
  return { addAliases, releaseAlias, assertAliasesFree };
}
