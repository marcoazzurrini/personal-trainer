import type {
  FoodsRepository,
  FoodRecord,
} from "@trainer/db/repositories/nutrition/foods.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import { Conflict, Invalid, requireRow } from "../shared/refusals.ts";
import type { DatabaseFailure, NotFound } from "../shared/refusals.ts";
import {
  caseKey,
  decimal,
  now,
  requestId,
  wireInstant,
} from "../shared/values.ts";
import type {
  CorrectedFood,
  CorrectFoodInput,
  FoodRow,
  SaveFoodInput,
} from "./foods.types.ts";
import type { NutritionResolver } from "./resolve.ts";
import { checkEnergy, checkMacroMass } from "./rules.ts";

const macros = [
  "kcal_100g",
  "protein_100g",
  "carbs_100g",
  "fat_100g",
  "fiber_100g",
] as const;
const fields = [
  ...macros,
  "grams_per_unit",
  "name",
  "brand",
  "source",
  "source_note",
] as const;
const wireFood = (row: FoodRecord): FoodRow => ({
  ...row,
  created_at: wireInstant(row.created_at),
});
const validateNumbers = Effect.fnUntraced(function* (
  input: CorrectFoodInput
): Effect.fn.Return<void, Invalid> {
  for (const key of [...macros, "grams_per_unit"] as const) {
    if (input[key] !== undefined) {
      yield* decimal(
        input[key] ?? null,
        key === "kcal_100g" || key === "grams_per_unit" ? 6 : 5,
        1
      );
    }
  }
});
export function foodStore(rows: FoodsRepository, resolver: NutritionResolver) {
  const repository = effectful(rows);

  const foodById = Effect.fn("foods.foodById")(function* (
    id: number
  ): Effect.fn.Return<FoodRow, NotFound | DatabaseFailure> {
    const { macro_revision: _revision, ...food } = yield* requireRow(
      yield* repository.byId(id),
      `No food with id ${id}. GET /foods?q=<search> lists them.`
    );
    return wireFood(food);
  });

  const foodByRef = Effect.fn("foods.foodByRef")(function* (
    ref: string
  ): Effect.fn.Return<FoodRow, Invalid | NotFound | DatabaseFailure> {
    return yield* foodById(yield* resolver.resolveFoodId(ref));
  });

  const searchFoods = Effect.fn("foods.searchFoods")(function* (
    q?: string
  ): Effect.fn.Return<FoodRow[], DatabaseFailure> {
    const term = q?.trim();
    // SQLite LIKE cannot fold Unicode. Names and aliases already carry Unicode keys;
    // brand matching is done in JS so its casing follows the same contract.
    const all = (yield* repository.all()).map(wireFood);
    if (!term) {
      return all;
    }
    const pattern = new RegExp(
      [...caseKey(term)]
        .map((c) => {
          if (c === "%") {
            return ".*";
          }
          if (c === "_") {
            return ".";
          }
          return c.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        })
        .join(""),
      "su"
    );
    return all.filter((f) =>
      [f.name, f.brand, ...f.aliases].some(
        (v) => v !== null && pattern.test(caseKey(v))
      )
    );
  });

  const seen = Effect.fnUntraced(function* (
    uuid: string
  ): Effect.fn.Return<FoodRow | undefined, DatabaseFailure> {
    const row = yield* repository.byRequest(uuid);
    return row ? wireFood(row) : undefined;
  });

  const saveFood = Effect.fn("foods.saveFood")(function* (
    b: SaveFoodInput
  ): Effect.fn.Return<
    { row: FoodRow; created: boolean },
    Invalid | NotFound | Conflict | DatabaseFailure
  > {
    const uuid = yield* requestId(b.request_id);
    const replay = yield* seen(uuid);
    if (replay) {
      return { row: replay, created: false };
    }
    return yield* Effect.gen(function* () {
      yield* resolver.assertFoodAliasesFree(b.aliases ?? []);
      yield* checkMacroMass(b.protein_100g, b.carbs_100g, b.fat_100g);
      yield* checkEnergy(
        b.kcal_100g,
        b.protein_100g,
        b.carbs_100g,
        b.fat_100g,
        b.energy_check === "override",
        b.source_note ?? null
      );
      yield* validateNumbers(b);
      const selected = yield* repository.save({
        ...b,
        brand: b.brand ?? null,
        fiber_100g: b.fiber_100g ?? null,
        grams_per_unit: b.grams_per_unit ?? null,
        source_note: b.source_note ?? null,
        aliases: b.aliases ?? [],
        request_id: uuid,
        created_at: yield* now,
      });
      return {
        row: wireFood(
          yield* requireRow(
            selected,
            "The food could not be read after saving."
          )
        ),
        created: true,
      };
    }).pipe(
      // Any failure, defects included, may be a concurrent retry that saved
      // this request first; otherwise it fails as it was.
      Effect.catchCause((cause) =>
        seen(uuid).pipe(
          Effect.flatMap((recovered) =>
            recovered
              ? Effect.succeed({ row: recovered, created: false })
              : Effect.failCause(cause)
          )
        )
      )
    );
  });

  const correctFood = Effect.fn("foods.correctFood")(function* (
    ref: string,
    b: CorrectFoodInput
  ): Effect.fn.Return<
    CorrectedFood,
    Invalid | NotFound | Conflict | DatabaseFailure
  > {
    const id = yield* resolver.resolveFoodId(ref);
    const before = yield* requireRow(
      yield* repository.byId(id),
      `No food with id ${id}.`
    );
    const keys = fields.filter((k) => b[k] !== undefined);
    if (!keys.length) {
      return yield* new Invalid({
        message:
          "Send at least one of: name, brand, kcal_100g, protein_100g, carbs_100g, fat_100g, fiber_100g, grams_per_unit, source, source_note. A different product is not an edit — save it as a new food with POST /foods.",
      });
    }
    const merged = {
      ...before,
      ...Object.fromEntries(keys.map((k) => [k, b[k]])),
    };
    yield* checkMacroMass(
      Number(merged.protein_100g),
      Number(merged.carbs_100g),
      Number(merged.fat_100g)
    );
    yield* checkEnergy(
      Number(merged.kcal_100g),
      Number(merged.protein_100g),
      Number(merged.carbs_100g),
      Number(merged.fat_100g),
      b.energy_check === "override",
      merged.source_note
    );
    yield* validateNumbers(b);
    const result = yield* repository.correct(id, before.macro_revision, b).pipe(
      // The write asserts the revision it validated against. When that
      // assertion fails, the food changed underneath this correction, and the
      // caller is told so in a food's terms rather than a record's.
      Effect.catchTag("DatabaseFailure", (failure) =>
        Effect.fail(
          failure.kind === "check" && failure.subject === "api_incomplete_write"
            ? new Conflict({
                message:
                  "That food changed while this correction was being checked. Read GET /foods/:ref again, then resend the correction against its current values.",
              })
            : failure
        )
      )
    );
    const { macrosChanged, affected } = result;
    const food = wireFood(
      yield* requireRow(
        result.foods,
        "The food could not be read after saving."
      )
    );
    return {
      food,
      corrected_entries: affected,
      note: macrosChanged
        ? `Corrected ${affected.count} logged ${
            affected.count === 1 ? "entry" : "entries"
          }: their totals now use the corrected food values, without changing what was eaten. Meals containing this food update on their own — their totals are computed, never stored.`
        : "No macros changed, so nothing logged was affected.",
    };
  });

  const deleteFood = Effect.fn("foods.deleteFood")(function* (
    ref: string
  ): Effect.fn.Return<string, Invalid | NotFound | Conflict | DatabaseFailure> {
    const id = yield* resolver.resolveFoodId(ref);
    const { entries, items } = yield* repository.usage(id);
    if (entries || items) {
      return yield* new Conflict({
        message: `That food is in use — ${entries} logged ${
          entries === 1 ? "entry" : "entries"
        } and ${items} meal ${
          items === 1 ? "item" : "items"
        } — so deleting it would orphan the record. If its numbers are wrong, PATCH /foods/:ref fixes them and every entry logged against them. If it is a duplicate, move its aliases to the food you are keeping.`,
      });
    }
    return (yield* requireRow(
      yield* repository.remove(id),
      `No food with id ${id}.`
    )).name;
  });

  return {
    foodById,
    foodByRef,
    searchFoods,
    saveFood,
    correctFood,
    deleteFood,
  };
}

export type FoodService = ReturnType<typeof foodStore>;
