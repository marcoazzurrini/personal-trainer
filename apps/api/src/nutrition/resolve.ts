import type { ResolveRepository } from "@trainer/db/repositories/nutrition/resolve.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import { Conflict, Invalid } from "../shared/refusals.ts";
import type { DatabaseFailure } from "../shared/refusals.ts";
import { caseKey } from "../shared/values.ts";

interface ResolutionMessages {
  what: "food" | "meal";
  route: string;
  noSuchId: (id: number) => string;
  unknownName: (name: string) => string;
  missingRef: string;
}

const FOODS: ResolutionMessages = {
  noSuchId: (ref) =>
    `No food with id ${ref}. GET /foods?q=<search> lists them.`,
  unknownName: (name) =>
    `Unknown food "${name}". GET /foods?q=<search> lists what exists — use the id, canonical name, or an alias. A food that genuinely does not exist yet is sourced (label, CREA, USDA, Open Food Facts) and saved with POST /foods — never invented. A synonym of a food that exists gets an alias instead: POST /foods/:ref/aliases.`,
  missingRef: '"food" is required: a food id, canonical name, or alias.',
  what: "food",
  route: "/foods",
};

const MEALS: ResolutionMessages = {
  noSuchId: (ref) => `No meal with id ${ref}. GET /meals lists them.`,
  unknownName: (name) =>
    `Unknown meal "${name}". GET /meals lists what exists — use the id, canonical name, or an alias. A meal that has become a routine is saved with POST /meals. A one-off variation on a saved meal is not a new meal — log the meal and log the difference as a separate entry.`,
  missingRef: '"meal" is required: a meal id, canonical name, or alias.',
  what: "meal",
  route: "/meals",
};

export function nutritionResolver(rows: ResolveRepository) {
  const repository = effectful(rows);

  const resolveMany = Effect.fnUntraced(function* (
    ns: ResolutionMessages,
    refs: readonly unknown[]
  ): Effect.fn.Return<number[], Invalid | DatabaseFailure> {
    const result = new Map<number, number>();
    const lookups = refs.map((ref, index) => ({
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
    }));
    const found = yield* repository.resolve(
      ns.what === "food" ? "food" : "meal",
      lookups
    );
    for (const row of found) {
      if (row.id !== null) {
        result.set(row.position, row.id);
      }
    }
    const ids: number[] = [];
    for (const [index, ref] of refs.entries()) {
      const id = result.get(index);
      if (id !== undefined) {
        ids.push(id);
        continue;
      }
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- Preserve the integer-id refusal for unresolved raw references.
      if (typeof ref === "number" && Number.isInteger(ref)) {
        return yield* new Invalid({ message: ns.noSuchId(ref) });
      }
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- Distinguish an unknown name from a missing or invalid JSON reference.
      if (typeof ref === "string" && ref.trim()) {
        if (/^\d+$/u.test(ref.trim())) {
          return yield* new Invalid({
            message: ns.noSuchId(Number(ref.trim())),
          });
        }
        return yield* new Invalid({ message: ns.unknownName(ref.trim()) });
      }
      return yield* new Invalid({ message: ns.missingRef });
    }
    return ids;
  });

  const aliasesFree = Effect.fnUntraced(function* (
    ns: ResolutionMessages,
    aliases: readonly string[]
  ): Effect.fn.Return<void, Conflict | DatabaseFailure> {
    const taken = yield* repository.takenAliases(
      ns.what === "food" ? "food" : "meal",
      [...new Set(aliases.map((a) => caseKey(a.trim())))]
    );
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
    return yield* new Conflict({
      message: `${clashes}. Aliases are case-insensitive and globally unique — one name points at one ${ns.what}. Nothing was written: resend without ${
        one ? "that alias" : "those aliases"
      }, which costs only ${
        one ? "that word" : "those words"
      } and keeps the rest of the call. If ${
        one ? "the name belongs" : "a name belongs"
      } on this row instead, release it first with DELETE ${ns.route}/${
        taken[0].id
      }/aliases/${encodeURIComponent(taken[0].alias)}.`,
    });
  });

  const resolveFoodId = Effect.fn("nutritionResolver.resolveFoodId")(function* (
    // eslint-disable-next-line anti-slop/no-unknown-parameters -- This parser boundary accepts raw food references and resolveMany validates their representation and existence.
    ref: unknown
  ): Effect.fn.Return<number, Invalid | DatabaseFailure> {
    return (yield* resolveMany(FOODS, [ref]))[0];
  });

  const resolveMealId = Effect.fn("nutritionResolver.resolveMealId")(function* (
    // eslint-disable-next-line anti-slop/no-unknown-parameters -- This parser boundary accepts raw meal references and resolveMany validates their representation and existence.
    ref: unknown
  ): Effect.fn.Return<number, Invalid | DatabaseFailure> {
    return (yield* resolveMany(MEALS, [ref]))[0];
  });

  const resolveFoodIds = Effect.fn("nutritionResolver.resolveFoodIds")(
    function* (
      refs: readonly unknown[]
    ): Effect.fn.Return<number[], Invalid | DatabaseFailure> {
      return yield* resolveMany(FOODS, refs);
    }
  );

  const assertFoodAliasesFree = Effect.fn(
    "nutritionResolver.assertFoodAliasesFree"
  )(function* (
    aliases: readonly string[]
  ): Effect.fn.Return<void, Conflict | DatabaseFailure> {
    yield* aliasesFree(FOODS, aliases);
  });

  const assertMealAliasesFree = Effect.fn(
    "nutritionResolver.assertMealAliasesFree"
  )(function* (
    aliases: readonly string[]
  ): Effect.fn.Return<void, Conflict | DatabaseFailure> {
    yield* aliasesFree(MEALS, aliases);
  });

  return {
    resolveFoodId,
    resolveMealId,
    resolveFoodIds,
    assertFoodAliasesFree,
    assertMealAliasesFree,
  };
}

export type NutritionResolver = ReturnType<typeof nutritionResolver>;
