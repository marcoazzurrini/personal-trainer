import type { ExerciseChanges } from "@trainer/db/contracts/training.ts";
import type { ExercisesRepository } from "@trainer/db/repositories/training/exercises.ts";
import { Effect } from "effect";

import type { aliasStore } from "../shared/aliases.ts";
import { effectful } from "../shared/database.ts";
import { mondayOf } from "../shared/dates.ts";
import { Conflict, Invalid, requireRow } from "../shared/refusals.ts";
import type { DatabaseFailure, NotFound } from "../shared/refusals.ts";
import { caseKey, decimal, today } from "../shared/values.ts";
import type {
  AddExerciseInput,
  CorrectExerciseInput,
  ExerciseHistory,
  ExerciseRow,
  MuscleEntryInput,
  MuscleRow,
} from "./exercises.types.ts";
import type { trainingResolver } from "./resolve.ts";

export const SYSTEMIC_FATIGUE_LEVELS = ["normal", "high"] as const;
export type SystemicFatigue = (typeof SYSTEMIC_FATIGUE_LEVELS)[number];

export function exerciseStore(
  rows: ExercisesRepository,
  resolver: ReturnType<typeof trainingResolver>,
  aliases: ReturnType<typeof aliasStore>
) {
  const repository = effectful(rows);

  const listExercises = Effect.fn("exercises.listExercises")(
    function* (): Effect.fn.Return<ExerciseRow[], DatabaseFailure> {
      return yield* repository.list();
    }
  );
  const exerciseById = Effect.fn("exercises.exerciseById")(function* (
    id: number
  ): Effect.fn.Return<ExerciseRow, NotFound | DatabaseFailure> {
    return yield* requireRow(
      yield* repository.byId(id),
      `No exercise with id ${id}.`
    );
  });
  const listMuscles = Effect.fn("exercises.listMuscles")(
    function* (): Effect.fn.Return<MuscleRow[], DatabaseFailure> {
      return yield* repository.listMuscles();
    }
  );
  const addMuscle = Effect.fn("exercises.addMuscle")(function* (
    name: string
  ): Effect.fn.Return<MuscleRow, NotFound | DatabaseFailure> {
    return yield* requireRow(
      yield* repository.addMuscle(name),
      "The muscle could not be read after saving."
    );
  });
  const muscleEntries = Effect.fnUntraced(function* (
    entries: readonly MuscleEntryInput[] = []
  ): Effect.fn.Return<
    { muscle_id: number; volume_factor: number }[],
    Invalid | DatabaseFailure
  > {
    // muscles.name remains case-sensitive unique. Matching names retains the
    // reference's Unicode case-insensitive lookup rather than SQLite lower().
    const known = yield* listMuscles();
    const linked = [];
    for (const entry of entries) {
      if (entry.counts !== undefined) {
        return yield* new Invalid({
          message:
            '"counts" was replaced by "volume_factor": 1.0 (direct — primary force generator), 0.5 (indirect — meaningfully trained, not primary), 0 (considered and deliberately excluded). See the `reference/exercises` document.',
        });
      }
      if (entry.fatigue !== undefined) {
        return yield* new Invalid({
          message:
            'Per-muscle "fatigue" no longer exists. Systemic fatigue is a property of the exercise: send "systemic_fatigue": "normal" | "high" at the top level (defaults to "normal").',
        });
      }
      const muscle = known.find(
        (m) => caseKey(m.name) === caseKey(entry.muscle)
      );
      if (!muscle) {
        return yield* new Invalid({
          message: `Unknown muscle "${entry.muscle}". Known muscles: ${
            known.map((m) => m.name).join(", ") || "(none yet)"
          }. Add it first with POST /muscles.`,
        });
      }
      yield* decimal(entry.volume_factor, 2, 1);
      linked.push({
        muscle_id: muscle.id,
        volume_factor: entry.volume_factor,
      });
    }
    return linked;
  });
  const addExercise = Effect.fn("exercises.addExercise")(function* (
    b: AddExerciseInput
  ): Effect.fn.Return<
    ExerciseRow,
    Invalid | NotFound | Conflict | DatabaseFailure
  > {
    const muscles = yield* muscleEntries(b.muscles);
    yield* aliases.assertAliasesFree(b.aliases ?? []);
    return yield* requireRow(
      yield* repository.create({
        ...b,
        equipment: b.equipment ?? null,
        pattern: b.pattern ?? null,
        notes: b.notes ?? null,
        aliases: b.aliases ?? [],
        muscles,
      }),
      "The exercise could not be read after saving."
    );
  });
  const exerciseHistory = Effect.fn("exercises.exerciseHistory")(function* (
    ref: string,
    rawLimit?: string
  ): Effect.fn.Return<ExerciseHistory, Invalid | DatabaseFailure> {
    const limit = rawLimit === "all" ? -1 : Number(rawLimit);
    if (
      rawLimit !== "all" &&
      (rawLimit === undefined || !Number.isInteger(limit) || limit < 1)
    ) {
      return yield* new Invalid({
        message:
          '"limit" is required on a history read: a whole number for the most recent sets — 10 to 30 is usually enough to judge how an exercise is going — or "all" for the whole series, which is what charting a block or a year needs. Every set carries its note, so ask for what you will actually read. The reply says how many sets exist in total, so a partial read knows what it left behind.',
      });
    }
    const e = yield* resolver.resolveExercise(ref);
    const { sets, total } = yield* repository.history(e.id, limit);
    return {
      exercise: e.name,
      exercise_id: e.id,
      measure: e.measure,
      total_sets: total,
      returned: sets.length,
      sets,
    };
  });
  const correctExercise = Effect.fn("exercises.correctExercise")(function* (
    ref: string,
    b: CorrectExerciseInput
  ): Effect.fn.Return<ExerciseRow, Invalid | NotFound | DatabaseFailure> {
    const e = yield* resolver.resolveExercise(ref);
    if (b.muscles !== undefined) {
      return yield* new Invalid({
        message:
          "The muscle classification is replaced whole with PUT /exercises/:ref/muscles — a partial edit of a classification is ambiguous about the rows it does not mention.",
      });
    }
    if (b.alias !== undefined || b.aliases !== undefined) {
      return yield* new Invalid({
        message:
          "Aliases have their own surface: POST /exercises/:ref/aliases adds, DELETE /exercises/:ref/aliases/:alias removes.",
      });
    }
    const fields: ExerciseChanges = {};
    Object.assign(
      fields,
      Object.fromEntries(
        (
          [
            "name",
            "equipment",
            "pattern",
            "notes",
            "systemic_fatigue",
            "measure",
            "stimulus_type",
          ] as const
        )
          .filter((field) => b[field] !== undefined)
          .map((field) => [field, b[field]])
      )
    );
    const identity = b.measure !== undefined || b.stimulus_type !== undefined;
    if (identity) {
      const [{ n }] = yield* repository.setCount(e.id);
      if (n > 0) {
        return yield* new Invalid({
          message: `"measure" and "stimulus_type" are frozen once an exercise has logged sets — "${e.name}" has ${n}. Every one of them was validated and counted under the current values, so changing them would rewrite history that already happened. The fix now is a new exercise with the right value, which takes over this one's aliases (POST /exercises, then move the aliases).`,
        });
      }
    }
    if (!Object.keys(fields).length) {
      return yield* new Invalid({
        message:
          "Send at least one of: name, equipment, pattern, notes, systemic_fatigue — or, while the exercise has no logged sets, measure and stimulus_type.",
      });
    }
    return yield* requireRow(
      yield* repository.correct(e.id, fields, identity),
      `No exercise with id ${e.id}.`
    );
  });
  const deleteExercise = Effect.fn("exercises.deleteExercise")(function* (
    ref: string
  ): Effect.fn.Return<string, Invalid | NotFound | Conflict | DatabaseFailure> {
    const e = yield* resolver.resolveExercise(ref);
    const [{ set_count, plan_count, dose_count }] = yield* repository.usage(
      e.id
    );
    if (set_count || plan_count || dose_count) {
      return yield* new Conflict({
        message: `"${e.name}" is in the record — ${set_count} logged ${
          set_count === 1 ? "set" : "sets"
        }, ${plan_count} plan ${
          plan_count === 1 ? "entry" : "entries"
        }, ${dose_count} dose history ${
          dose_count === 1 ? "row" : "rows"
        } — so deleting it would orphan history. PATCH /exercises/:ref fixes what is fixable; a duplicate's aliases move to the exercise being kept.`,
      });
    }
    const result = yield* repository.remove(e.id);
    return (yield* requireRow(result, `No exercise with id ${e.id}.`)).name;
  });
  const reclassifyMuscles = Effect.fn("exercises.reclassifyMuscles")(function* (
    ref: string,
    entries: MuscleEntryInput[]
  ): Effect.fn.Return<
    { exercise: ExerciseRow; note: string },
    Invalid | NotFound | Conflict | DatabaseFailure
  > {
    const e = yield* resolver.resolveExercise(ref);
    const muscles = yield* muscleEntries(entries);
    const active = yield* repository.activePlans(e.id);
    if (active.length) {
      return yield* new Conflict({
        message: `"${e.name}" is in ${active
          .map((m) => `"${m.name}"`)
          .join(
            " and "
          )}, which is still running. Reclassifying its muscles mid-plan silently rewrites the weekly-volume numbers that plan is being judged on — this change belongs between mesocycles, at the review.`,
      });
    }
    const { weeks, exercises } = yield* repository.reclassify(
      e.id,
      muscles,
      mondayOf(yield* today)
    );
    return {
      exercise: yield* requireRow(exercises, `No exercise with id ${e.id}.`),
      note:
        weeks === 0
          ? "No finished week of volume references this exercise, so nothing historical moved."
          : `This reclassification rewrote the weekly-volume numbers of ${weeks} finished ${
              weeks === 1 ? "week" : "weeks"
            }. That is the point — a wrong classification was wrong when written — but it is why this is refused mid-plan.`,
    };
  });
  return {
    listExercises,
    exerciseById,
    addExercise,
    exerciseHistory,
    correctExercise,
    deleteExercise,
    reclassifyMuscles,
    listMuscles,
    addMuscle,
  };
}
