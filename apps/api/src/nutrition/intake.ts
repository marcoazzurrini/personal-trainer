import type {
  IntakeRepository,
  IntakeDay,
  LogIntake,
} from "@trainer/db/repositories/nutrition/intake.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import { requireNotFuture } from "../shared/dates.ts";
import { Invalid, requireRow } from "../shared/refusals.ts";
import type { DatabaseFailure, NotFound } from "../shared/refusals.ts";
import {
  date,
  decimal,
  now,
  requestId,
  today,
  wireInstant,
} from "../shared/values.ts";
import type { CorrectInput, DayView, LogInput } from "./intake.types.ts";
import type { NutritionResolver } from "./resolve.ts";
import { gramsEaten, sumMacros } from "./rules.ts";

const MAX_SCALE = 10;
const MACROS = ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const;
function view(day: string, result: IntakeDay): DayView {
  const entries = result.entries.map((entry) => ({
    ...entry,
    created_at: wireInstant(entry.created_at),
  }));
  return { day, entries, totals: sumMacros(entries), flags: result.flags };
}

const intakeScale = Effect.fnUntraced(function* (
  b: LogInput
): Effect.fn.Return<number | null, Invalid> {
  const wants = (["meal", "food", "adhoc_kcal"] as const).filter(
    (k) => b[k] !== undefined && b[k] !== null
  );
  if (wants.length !== 1) {
    return yield* new Invalid({
      message:
        wants.length === 0
          ? 'An intake entry is one of three things: "meal" (a saved meal by id, name, or alias), "food" plus "grams" or "units", or "adhoc_kcal" for an estimated entry. Send exactly one.'
          : `Send exactly one of "meal", "food", "adhoc_kcal" — got ${wants.join(" and ")}. A meal plus an extra food is two calls, which is also how a variation on a routine gets logged.`,
    });
  }
  for (const field of ["grams", "units"] as const) {
    if (b[field] !== null && b[field] !== undefined && wants[0] !== "food") {
      return yield* new Invalid({
        message: `"${field}" goes with "food". For a saved meal send "scale"; for an estimate send "adhoc_kcal" at the number you mean.`,
      });
    }
  }
  if (
    b.adhoc_protein_g !== null &&
    b.adhoc_protein_g !== undefined &&
    wants[0] !== "adhoc_kcal"
  ) {
    return yield* new Invalid({
      message:
        '"adhoc_protein_g" goes with "adhoc_kcal". Food and meal protein is computed from the saved food and quantity; omit the ad-hoc protein field.',
    });
  }
  // A scale of 0 would log nothing; past 10x a routine portion is a misplaced decimal.
  const scale = b.scale ?? null;
  if (scale !== null) {
    if (wants[0] !== "meal") {
      return yield* new Invalid({
        message:
          '"scale" is a portion of a saved meal, so it goes with "meal". A part of a single food is that food at fewer grams; an estimate is "adhoc_kcal" at the number you mean.',
      });
    }
    if (scale <= 0 || scale > MAX_SCALE) {
      return yield* new Invalid({
        message: `"scale" must be greater than 0 and at most ${MAX_SCALE} — 0.5 for half the usual portion, 2 for a double. A meal not eaten is not logged, and past ${MAX_SCALE}x the decimal point is usually in the wrong place.`,
      });
    }
  }
  return scale;
});

export function intakeStore(
  rows: IntakeRepository,
  resolver: NutritionResolver
) {
  const repository = effectful(rows);

  const viewDay = Effect.fn("intake.viewDay")(function* (
    day?: string | null
  ): Effect.fn.Return<DayView, Invalid | DatabaseFailure> {
    const on = yield* date(day ?? (yield* today));
    return view(on, yield* repository.day(on));
  });

  const seen = Effect.fnUntraced(function* (
    uuid: string
  ): Effect.fn.Return<DayView | undefined, Invalid | DatabaseFailure> {
    const day = yield* repository.requestDay(uuid);
    return day ? yield* viewDay(day) : undefined;
  });

  const foodInput = Effect.fnUntraced(function* (
    b: LogInput,
    common: Pick<LogIntake, "day" | "note" | "requestId" | "createdAt">
  ): Effect.fn.Return<LogIntake, Invalid | NotFound | DatabaseFailure> {
    const foodId = yield* resolver.resolveFoodId(b.food);
    const food = yield* requireRow(
      yield* repository.food(foodId),
      `No food with id ${foodId}.`
    );
    const grams = yield* gramsEaten(
      b.grams ?? null,
      b.units ?? null,
      food.grams_per_unit,
      food.name
    );
    yield* decimal(grams, 7, 1);
    const input: LogIntake = { ...common, kind: "food", foodId, grams };
    if (b.units !== null && b.units !== undefined) {
      input.gramsPerUnit = food.grams_per_unit;
    }
    return input;
  });

  const logIntake = Effect.fn("intake.logIntake")(function* (
    b: LogInput
  ): Effect.fn.Return<
    { view: DayView; created: boolean },
    Invalid | NotFound | DatabaseFailure
  > {
    const uuid = yield* requestId(b.request_id);
    const replay = yield* seen(uuid);
    if (replay) {
      return { view: replay, created: false };
    }
    return yield* Effect.gen(function* () {
      const day = yield* requireNotFuture(
        yield* date(b.day ?? (yield* today)),
        yield* today,
        "day"
      );
      const note = b.note ?? null;
      const scale = yield* intakeScale(b);

      const common = {
        day,
        note,
        requestId: uuid,
        createdAt: yield* now,
      };
      let input: LogIntake;
      if (b.adhoc_kcal !== null && b.adhoc_kcal !== undefined) {
        if (b.adhoc_kcal < 0) {
          return yield* new Invalid({
            message: '"adhoc_kcal" must be zero or more.',
          });
        }
        yield* decimal(b.adhoc_kcal, 7, 1);
        yield* decimal(b.adhoc_protein_g ?? null, 6, 1);
        input = {
          ...common,
          kind: "adhoc",
          kcal: b.adhoc_kcal,
          protein: b.adhoc_protein_g ?? null,
        };
      } else if (b.food === null || b.food === undefined) {
        const mealId = yield* resolver.resolveMealId(b.meal);
        const [meal] = yield* repository.meal(mealId);
        if (!meal?.items) {
          return yield* new Invalid({
            message: `"${meal?.name}" has no foods in it, so there is nothing to log. Add its items first.`,
          });
        }
        input = { ...common, kind: "meal", mealId, scale: scale ?? 1 };
      } else {
        input = yield* foodInput(b, common);
      }
      return { view: view(day, yield* repository.log(input)), created: true };
    }).pipe(
      // Any failure, defects included, may be a concurrent retry that logged
      // this request first; otherwise it fails as it was.
      Effect.catchCause((cause) =>
        seen(uuid).pipe(
          Effect.flatMap((recovered) =>
            recovered
              ? Effect.succeed({ view: recovered, created: false })
              : Effect.failCause(cause)
          )
        )
      )
    );
  });

  // oxlint-disable-next-line complexity -- Keep correction validation, ordered refusals and the coordinated write in the existing request boundary.
  const correctEntry = Effect.fn("intake.correctEntry")(function* (
    id: number,
    b: CorrectInput
  ): Effect.fn.Return<
    { view: DayView; movedFrom: string | null },
    Invalid | NotFound | DatabaseFailure
  > {
    const entry = yield* requireRow(
      yield* repository.entry(id),
      `No intake entry with id ${id}. GET /intake?day=YYYY-MM-DD lists a day's entries with their ids.`
    );
    const note = b.note === undefined ? undefined : b.note;

    // The date was wrong; the food was not. Logging after midnight, or
    // reconstructing a day from memory, puts entries on the day either side of
    // the one meant. Without this the only repair was to delete each row and log
    // it again, which retypes every ad-hoc number by hand — and a typo made
    // while repairing looks exactly like a correct value.
    //
    // Only the day moves. Ingredients, quantities and overrides stay untouched;
    // no recipe is re-read and no override is replaced by derived values.
    const rawDay = b.day ?? null;
    const day =
      rawDay === null
        ? null
        : yield* requireNotFuture(yield* date(rawDay), yield* today, "day");
    const rawGrams = b.grams ?? null;
    const grams =
      rawGrams === null ? null : yield* gramsEaten(rawGrams, null, null, "");

    // "grams" answers every macro question by re-scaling from the food; a
    // direct macro is a second answer to one of them. Accepting both wrote a
    // row whose macros described the grams while the overridden field said
    // something else — the same contradiction checkEnergy refuses at food
    // creation, so it is refused here too.
    const overridden = (
      ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const
    ).filter((k) => b[k] !== undefined && b[k] !== null);
    if (grams !== null && overridden.length > 0) {
      return yield* new Invalid({
        message: `"grams" recomputes kcal and the macros from the food, so it cannot be combined with ${overridden
          .map((k) => `"${k}"`)
          .join(
            ", "
          )}. Send "grams" alone to re-scale, or the numbers alone to override them.`,
      });
    }

    if (grams !== null && entry.food_id === null) {
      return yield* new Invalid({
        message:
          'This is an ad-hoc entry, so it has no food to re-scale from. Correct it with "kcal" (and optionally "protein_g") directly.',
      });
    }

    if (grams !== null) {
      yield* decimal(grams, 7, 1);
    }
    const macros: Partial<Record<(typeof MACROS)[number], number>> = {};
    for (const macro of MACROS) {
      const value = b[macro] ?? null;
      if (value !== null) {
        yield* decimal(value, macro === "kcal" ? 7 : 6, 1);
        macros[macro] = value;
      }
    }
    if (
      note === undefined &&
      day === null &&
      grams === null &&
      !overridden.length
    ) {
      return yield* new Invalid({
        message:
          'Send at least one of "day" (moves the entry to another date, numbers untouched), "grams" (re-scales from the food as it is now), "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", or "note". To remove an entry entirely, DELETE it.',
      });
    }
    const result = yield* repository.correct(id, {
      note,
      day,
      grams,
      macros,
      foodBacked: entry.food_id !== null,
    });
    return {
      view: view(result.landed, result.day),
      movedFrom: result.landed === result.previous ? null : result.previous,
    };
  });

  const removeEntry = Effect.fn("intake.removeEntry")(function* (
    id: number
  ): Effect.fn.Return<DayView, Invalid | NotFound | DatabaseFailure> {
    const entry = yield* requireRow(
      yield* repository.remove(id),
      `No intake entry with id ${id}.`
    );
    return yield* viewDay(entry.day);
  });

  const flagDay = Effect.fn("intake.flagDay")(function* (
    day: string,
    flag: string
  ): Effect.fn.Return<DayView, Invalid | DatabaseFailure> {
    const on = yield* requireNotFuture(yield* date(day), yield* today, "day");
    return view(on, yield* repository.flag(on, flag, yield* now));
  });

  const unflagDay = Effect.fn("intake.unflagDay")(function* (
    day: string,
    flag: string
  ): Effect.fn.Return<DayView, Invalid | NotFound | DatabaseFailure> {
    const on = yield* date(day);
    const result = yield* repository.unflag(on, flag);
    yield* requireRow(
      result.removed ? [true] : [],
      `${day} is not flagged "${flag}".`
    );
    return view(on, result.day);
  });

  return { viewDay, logIntake, correctEntry, removeEntry, flagDay, unflagDay };
}

export type IntakeService = ReturnType<typeof intakeStore>;
