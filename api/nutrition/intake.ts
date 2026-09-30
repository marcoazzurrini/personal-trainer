import type {
  IntakeRepository,
  IntakeDay,
  LogIntake,
} from "../../db/repositories/nutrition/intake.ts";
import { requireNotFuture } from "../shared/dates.ts";
import { ApiError, databaseError, requireRow } from "../shared/errors.ts";
import {
  date,
  decimal,
  instant,
  requestId,
  romeDate,
  systemClock,
  wireInstant,
} from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
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

function intakeScale(b: LogInput): number | null {
  const wants = (["meal", "food", "adhoc_kcal"] as const).filter(
    (k) => b[k] !== undefined && b[k] !== null
  );
  if (wants.length !== 1) {
    throw new ApiError(
      422,
      wants.length === 0
        ? 'An intake entry is one of three things: "meal" (a saved meal by id, name, or alias), "food" plus "grams" or "units", or "adhoc_kcal" for an estimated entry. Send exactly one.'
        : `Send exactly one of "meal", "food", "adhoc_kcal" — got ${wants.join(" and ")}. A meal plus an extra food is two calls, which is also how a variation on a routine gets logged.`
    );
  }
  for (const field of ["grams", "units"] as const) {
    if (b[field] !== null && b[field] !== undefined && wants[0] !== "food") {
      throw new ApiError(
        422,
        `"${field}" goes with "food". For a saved meal send "scale"; for an estimate send "adhoc_kcal" at the number you mean.`
      );
    }
  }
  if (
    b.adhoc_protein_g !== null &&
    b.adhoc_protein_g !== undefined &&
    wants[0] !== "adhoc_kcal"
  ) {
    throw new ApiError(
      422,
      '"adhoc_protein_g" goes with "adhoc_kcal". Food and meal protein is computed from the saved food and quantity; omit the ad-hoc protein field.'
    );
  }
  // A scale of 0 would log nothing; past 10x a routine portion is a misplaced decimal.
  const scale = b.scale ?? null;
  if (scale !== null) {
    if (wants[0] !== "meal") {
      throw new ApiError(
        422,
        '"scale" is a portion of a saved meal, so it goes with "meal". A part of a single food is that food at fewer grams; an estimate is "adhoc_kcal" at the number you mean.'
      );
    }
    if (scale <= 0 || scale > MAX_SCALE) {
      throw new ApiError(
        422,
        `"scale" must be greater than 0 and at most ${MAX_SCALE} — 0.5 for half the usual portion, 2 for a double. A meal not eaten is not logged, and past ${MAX_SCALE}x the decimal point is usually in the wrong place.`
      );
    }
  }
  return scale;
}

export function intakeStore(
  repository: IntakeRepository,
  resolver: NutritionResolver,
  clock: Clock = systemClock
) {
  const today = () => romeDate(instant(clock().toISOString()));
  async function viewDay(day?: string | null): Promise<DayView> {
    const on = date(day ?? today());
    return view(on, await repository.day(on));
  }
  async function seen(uuid: string) {
    const day = await repository.requestDay(uuid);
    return day ? await viewDay(day) : undefined;
  }
  async function foodInput(
    b: LogInput,
    common: Pick<LogIntake, "day" | "note" | "requestId" | "createdAt">
  ): Promise<LogIntake> {
    const foodId = await resolver.resolveFoodId(b.food);
    const food = requireRow(
      await repository.food(foodId),
      `No food with id ${foodId}.`
    );
    const grams = gramsEaten(
      b.grams ?? null,
      b.units ?? null,
      food.grams_per_unit,
      food.name
    );
    decimal(grams, 7, 1);
    const input: LogIntake = { ...common, kind: "food", foodId, grams };
    if (b.units !== null && b.units !== undefined) {
      input.gramsPerUnit = food.grams_per_unit;
    }
    return input;
  }
  async function logIntake(
    b: LogInput
  ): Promise<{ view: DayView; created: boolean }> {
    const uuid = requestId(b.request_id);
    const replay = await seen(uuid);
    if (replay) {
      return { view: replay, created: false };
    }
    try {
      const day = requireNotFuture(date(b.day ?? today()), today(), "day");
      const note = b.note ?? null;
      const scale = intakeScale(b);

      const common = {
        day,
        note,
        requestId: uuid,
        createdAt: instant(clock().toISOString()),
      };
      let input: LogIntake;
      if (b.adhoc_kcal !== null && b.adhoc_kcal !== undefined) {
        if (b.adhoc_kcal < 0) {
          throw new ApiError(422, '"adhoc_kcal" must be zero or more.');
        }
        decimal(b.adhoc_kcal, 7, 1);
        decimal(b.adhoc_protein_g ?? null, 6, 1);
        input = {
          ...common,
          kind: "adhoc",
          kcal: b.adhoc_kcal,
          protein: b.adhoc_protein_g ?? null,
        };
      } else if (b.food === null || b.food === undefined) {
        const mealId = await resolver.resolveMealId(b.meal);
        const [meal] = await repository.meal(mealId);
        if (!meal?.items) {
          throw new ApiError(
            422,
            `"${meal?.name}" has no foods in it, so there is nothing to log. Add its items first.`
          );
        }
        input = { ...common, kind: "meal", mealId, scale: scale ?? 1 };
      } else {
        input = await foodInput(b, common);
      }
      return { view: view(day, await repository.log(input)), created: true };
    } catch (error) {
      const recovered = await seen(uuid);
      if (recovered) {
        return { view: recovered, created: false };
      }
      throw databaseError(error);
    }
  }
  // oxlint-disable-next-line complexity -- Keep correction validation, ordered refusals and the coordinated write in the existing request boundary.
  async function correctEntry(
    id: number,
    b: CorrectInput
  ): Promise<{ view: DayView; movedFrom: string | null }> {
    const entry = requireRow(
      await repository.entry(id),
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
      rawDay === null ? null : requireNotFuture(date(rawDay), today(), "day");
    const rawGrams = b.grams ?? null;
    const grams =
      rawGrams === null ? null : gramsEaten(rawGrams, null, null, "");

    // "grams" answers every macro question by re-scaling from the food; a
    // direct macro is a second answer to one of them. Accepting both wrote a
    // row whose macros described the grams while the overridden field said
    // something else — the same contradiction checkEnergy refuses at food
    // creation, so it is refused here too.
    const overridden = (
      ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const
    ).filter((k) => b[k] !== undefined && b[k] !== null);
    if (grams !== null && overridden.length > 0) {
      throw new ApiError(
        422,
        `"grams" recomputes kcal and the macros from the food, so it cannot be combined with ${overridden
          .map((k) => `"${k}"`)
          .join(
            ", "
          )}. Send "grams" alone to re-scale, or the numbers alone to override them.`
      );
    }

    if (grams !== null && entry.food_id === null) {
      throw new ApiError(
        422,
        'This is an ad-hoc entry, so it has no food to re-scale from. Correct it with "kcal" (and optionally "protein_g") directly.'
      );
    }

    if (grams !== null) {
      decimal(grams, 7, 1);
    }
    const macros: Partial<Record<(typeof MACROS)[number], number>> = {};
    for (const macro of MACROS) {
      const value = b[macro] ?? null;
      if (value !== null) {
        decimal(value, macro === "kcal" ? 7 : 6, 1);
        macros[macro] = value;
      }
    }
    if (
      note === undefined &&
      day === null &&
      grams === null &&
      !overridden.length
    ) {
      throw new ApiError(
        422,
        'Send at least one of "day" (moves the entry to another date, numbers untouched), "grams" (re-scales from the food as it is now), "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", or "note". To remove an entry entirely, DELETE it.'
      );
    }
    const result = await repository
      .correct(id, {
        note,
        day,
        grams,
        macros,
        foodBacked: entry.food_id !== null,
      })
      .catch((error) => {
        throw databaseError(error);
      });
    return {
      view: view(result.landed, result.day),
      movedFrom: result.landed === result.previous ? null : result.previous,
    };
  }
  async function removeEntry(id: number): Promise<DayView> {
    const entry = requireRow(
      await repository.remove(id).catch((error) => {
        throw databaseError(error);
      }),
      `No intake entry with id ${id}.`
    );
    return await viewDay(entry.day);
  }
  async function flagDay(day: string, flag: string): Promise<DayView> {
    const on = requireNotFuture(date(day), today(), "day");
    return view(
      on,
      await repository
        .flag(on, flag, instant(clock().toISOString()))
        .catch((error) => {
          throw databaseError(error);
        })
    );
  }
  async function unflagDay(day: string, flag: string): Promise<DayView> {
    const on = date(day);
    const result = await repository.unflag(on, flag).catch((error) => {
      throw databaseError(error);
    });
    requireRow(
      result.removed ? [true] : [],
      `${day} is not flagged "${flag}".`
    );
    return view(on, result.day);
  }
  return { viewDay, logIntake, correctEntry, removeEntry, flagDay, unflagDay };
}

export type IntakeService = ReturnType<typeof intakeStore>;
