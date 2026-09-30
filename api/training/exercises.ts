import type { ExerciseChanges } from "../../db/contracts/training.ts";
import type { ExercisesRepository } from "../../db/repositories/training/exercises.ts";
import type { aliasStore } from "../shared/aliases.ts";
import { mondayOf } from "../shared/dates.ts";
import { ApiError, requireRow } from "../shared/errors.ts";
import {
  caseKey,
  decimal,
  instant,
  romeDate,
  systemClock,
} from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
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
  repository: ExercisesRepository,
  resolver: ReturnType<typeof trainingResolver>,
  aliases: ReturnType<typeof aliasStore>,
  clock: Clock = systemClock
) {
  async function listExercises(): Promise<ExerciseRow[]> {
    return await repository.list();
  }
  async function exerciseById(id: number): Promise<ExerciseRow> {
    return requireRow(await repository.byId(id), `No exercise with id ${id}.`);
  }
  async function listMuscles(): Promise<MuscleRow[]> {
    return await repository.listMuscles();
  }
  async function addMuscle(name: string): Promise<MuscleRow> {
    return requireRow(
      await repository.addMuscle(name),
      "The muscle could not be read after saving."
    );
  }
  async function muscleEntries(entries: readonly MuscleEntryInput[] = []) {
    // muscles.name remains case-sensitive unique. Matching names retains the
    // reference's Unicode case-insensitive lookup rather than SQLite lower().
    const known = await listMuscles();
    return entries.map((entry) => {
      if (entry.counts !== undefined) {
        throw new ApiError(
          422,
          '"counts" was replaced by "volume_factor": 1.0 (direct — primary force generator), 0.5 (indirect — meaningfully trained, not primary), 0 (considered and deliberately excluded). See the `reference/exercises` document.'
        );
      }
      if (entry.fatigue !== undefined) {
        throw new ApiError(
          422,
          'Per-muscle "fatigue" no longer exists. Systemic fatigue is a property of the exercise: send "systemic_fatigue": "normal" | "high" at the top level (defaults to "normal").'
        );
      }
      const muscle = known.find(
        (m) => caseKey(m.name) === caseKey(entry.muscle)
      );
      if (!muscle) {
        throw new ApiError(
          422,
          `Unknown muscle "${entry.muscle}". Known muscles: ${
            known.map((m) => m.name).join(", ") || "(none yet)"
          }. Add it first with POST /muscles.`
        );
      }
      decimal(entry.volume_factor, 2, 1);
      return {
        muscle_id: muscle.id,
        volume_factor: entry.volume_factor,
      };
    });
  }
  async function addExercise(b: AddExerciseInput): Promise<ExerciseRow> {
    const muscles = await muscleEntries(b.muscles);
    await aliases.assertAliasesFree(b.aliases ?? []);
    return requireRow(
      await repository.create({
        ...b,
        equipment: b.equipment ?? null,
        pattern: b.pattern ?? null,
        notes: b.notes ?? null,
        aliases: b.aliases ?? [],
        muscles,
      }),
      "The exercise could not be read after saving."
    );
  }
  async function exerciseHistory(
    ref: string,
    rawLimit?: string
  ): Promise<ExerciseHistory> {
    const limit = rawLimit === "all" ? -1 : Number(rawLimit);
    if (
      rawLimit !== "all" &&
      (rawLimit === undefined || !Number.isInteger(limit) || limit < 1)
    ) {
      throw new ApiError(
        422,
        '"limit" is required on a history read: a whole number for the most recent sets — 10 to 30 is usually enough to judge how an exercise is going — or "all" for the whole series, which is what charting a block or a year needs. Every set carries its note, so ask for what you will actually read. The reply says how many sets exist in total, so a partial read knows what it left behind.'
      );
    }
    const e = await resolver.resolveExercise(ref);
    const { sets, total } = await repository.history(e.id, limit);
    return {
      exercise: e.name,
      exercise_id: e.id,
      measure: e.measure,
      total_sets: total,
      returned: sets.length,
      sets,
    };
  }
  async function correctExercise(
    ref: string,
    b: CorrectExerciseInput
  ): Promise<ExerciseRow> {
    const e = await resolver.resolveExercise(ref);
    if (b.muscles !== undefined) {
      throw new ApiError(
        422,
        "The muscle classification is replaced whole with PUT /exercises/:ref/muscles — a partial edit of a classification is ambiguous about the rows it does not mention."
      );
    }
    if (b.alias !== undefined || b.aliases !== undefined) {
      throw new ApiError(
        422,
        "Aliases have their own surface: POST /exercises/:ref/aliases adds, DELETE /exercises/:ref/aliases/:alias removes."
      );
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
      const [{ n }] = await repository.setCount(e.id);
      if (n > 0) {
        throw new ApiError(
          422,
          `"measure" and "stimulus_type" are frozen once an exercise has logged sets — "${e.name}" has ${n}. Every one of them was validated and counted under the current values, so changing them would rewrite history that already happened. The fix now is a new exercise with the right value, which takes over this one's aliases (POST /exercises, then move the aliases).`
        );
      }
    }
    if (!Object.keys(fields).length) {
      throw new ApiError(
        422,
        "Send at least one of: name, equipment, pattern, notes, systemic_fatigue — or, while the exercise has no logged sets, measure and stimulus_type."
      );
    }
    return requireRow(
      await repository.correct(e.id, fields, identity),
      `No exercise with id ${e.id}.`
    );
  }
  async function deleteExercise(ref: string): Promise<string> {
    const e = await resolver.resolveExercise(ref);
    const [{ set_count, plan_count, dose_count }] = await repository.usage(
      e.id
    );
    if (set_count || plan_count || dose_count) {
      throw new ApiError(
        409,
        `"${e.name}" is in the record — ${set_count} logged ${
          set_count === 1 ? "set" : "sets"
        }, ${plan_count} plan ${
          plan_count === 1 ? "entry" : "entries"
        }, ${dose_count} dose history ${
          dose_count === 1 ? "row" : "rows"
        } — so deleting it would orphan history. PATCH /exercises/:ref fixes what is fixable; a duplicate's aliases move to the exercise being kept.`
      );
    }
    const result = await repository.remove(e.id);
    return requireRow(result, `No exercise with id ${e.id}.`).name;
  }
  async function reclassifyMuscles(
    ref: string,
    entries: MuscleEntryInput[]
  ): Promise<{ exercise: ExerciseRow; note: string }> {
    const e = await resolver.resolveExercise(ref);
    const muscles = await muscleEntries(entries);
    const active = await repository.activePlans(e.id);
    if (active.length) {
      throw new ApiError(
        409,
        `"${e.name}" is in ${active
          .map((m) => `"${m.name}"`)
          .join(
            " and "
          )}, which is still running. Reclassifying its muscles mid-plan silently rewrites the weekly-volume numbers that plan is being judged on — this change belongs between mesocycles, at the review.`
      );
    }
    const { weeks, exercises } = await repository.reclassify(
      e.id,
      muscles,
      mondayOf(romeDate(instant(clock().toISOString())))
    );
    return {
      exercise: requireRow(exercises, `No exercise with id ${e.id}.`),
      note:
        weeks === 0
          ? "No finished week of volume references this exercise, so nothing historical moved."
          : `This reclassification rewrote the weekly-volume numbers of ${weeks} finished ${
              weeks === 1 ? "week" : "weeks"
            }. That is the point — a wrong classification was wrong when written — but it is why this is refused mid-plan.`,
    };
  }
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
