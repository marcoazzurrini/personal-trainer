import { aliasStore } from "../shared/aliases.ts";
import {
  batch,
  caseKey,
  type Clock,
  type Database,
  decimal,
  instant,
  jsonChunks,
  type Parameter,
  romeDate,
  rows,
  statement,
  systemClock,
} from "../shared/d1.ts";
import { mondayOf } from "../shared/dates.ts";
import { ApiError, requireRow } from "../shared/errors.ts";
import { trainingResolver } from "./resolve.ts";
import type {
  AddExerciseInput,
  CorrectExerciseInput,
  ExerciseHistory,
  ExerciseRow,
  HistorySet,
  MuscleEntryInput,
  MuscleRow,
} from "./exercises.types.ts";

export const SYSTEMIC_FATIGUE_LEVELS = ["normal", "high"] as const;
export type SystemicFatigue = (typeof SYSTEMIC_FATIGUE_LEVELS)[number];

const select = `SELECT e.id, e.name, e.equipment, e.pattern, e.stimulus_type,
  e.systemic_fatigue, e.measure, e.notes,
  (SELECT json_group_array(alias) FROM (SELECT alias FROM exercise_aliases WHERE exercise_id = e.id ORDER BY alias)) AS aliases,
  (SELECT json_group_array(json_object('muscle', name, 'volume_factor', volume_factor / 10.0))
   FROM (SELECT m.name, em.volume_factor FROM exercise_muscles em JOIN muscles m ON m.id = em.muscle_id
         WHERE em.exercise_id = e.id ORDER BY m.name)) AS muscles FROM exercises e`;
type StoredExercise = Omit<ExerciseRow, "aliases" | "muscles"> & {
  aliases: string;
  muscles: string;
};
const decode = (row: StoredExercise): ExerciseRow => ({
  ...row,
  aliases: JSON.parse(row.aliases),
  muscles: JSON.parse(row.muscles),
});
const performed =
  "(t.reps IS NOT NULL OR t.distance_m IS NOT NULL OR t.duration_s IS NOT NULL)";

export function exerciseStore(db: Database, clock: Clock = systemClock) {
  const resolver = trainingResolver(db);
  const aliases = aliasStore(db, "exercise");
  async function listExercises(): Promise<ExerciseRow[]> {
    return (await rows<StoredExercise>(db, `${select} ORDER BY e.name`)).map(
      decode,
    );
  }
  async function exerciseById(id: number): Promise<ExerciseRow> {
    return decode(
      requireRow(
        await rows<StoredExercise>(db, `${select} WHERE e.id = ?`, id),
        `No exercise with id ${id}.`,
      ),
    );
  }
  async function listMuscles(): Promise<MuscleRow[]> {
    return await rows<MuscleRow>(
      db,
      "SELECT id, name FROM muscles ORDER BY name",
    );
  }
  async function addMuscle(name: string): Promise<MuscleRow> {
    return requireRow(
      await rows<MuscleRow>(
        db,
        "INSERT INTO muscles (name) VALUES (?) RETURNING id, name",
        name,
      ),
      "The muscle could not be read after saving.",
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
          '"counts" was replaced by "volume_factor": 1.0 (direct — primary force generator), 0.5 (indirect — meaningfully trained, not primary), 0 (considered and deliberately excluded). See the `reference/exercises` document.',
        );
      }
      if (entry.fatigue !== undefined) {
        throw new ApiError(
          422,
          'Per-muscle "fatigue" no longer exists. Systemic fatigue is a property of the exercise: send "systemic_fatigue": "normal" | "high" at the top level (defaults to "normal").',
        );
      }
      const muscle = known.find(
        (m) => caseKey(m.name) === caseKey(entry.muscle),
      );
      if (!muscle) {
        throw new ApiError(
          422,
          `Unknown muscle "${entry.muscle}". Known muscles: ${
            known.map((m) => m.name).join(", ") || "(none yet)"
          }. Add it first with POST /muscles.`,
        );
      }
      return {
        muscle_id: muscle.id,
        volume_factor: decimal(entry.volume_factor, 2, 1),
      };
    });
  }
  // Guard and readback share the write transaction. A late set or membership
  // must refuse the whole edit, not invalidate an eligibility read silently.
  function guard(condition: string, ...values: Parameter[]) {
    return statement(
      db,
      `INSERT INTO api_write_assertions (id, rows_match) SELECT 1, (${condition})`,
      ...values,
    );
  }
  const cleanup = () =>
    statement(db, "DELETE FROM api_write_assertions WHERE id = 1");
  function muscleStatements(
    owner: string,
    ownerValue: Parameter,
    entries: Awaited<ReturnType<typeof muscleEntries>>,
  ) {
    return jsonChunks(entries).map((chunk) =>
      statement(
        db,
        `INSERT INTO exercise_muscles (exercise_id, muscle_id, volume_factor)
       SELECT ${owner}, json_extract(value, '$.muscle_id'), json_extract(value, '$.volume_factor') FROM json_each(?)`,
        ownerValue,
        chunk.json,
      )
    );
  }
  async function addExercise(
    b: AddExerciseInput,
  ): Promise<ExerciseRow> {
    const muscles = await muscleEntries(b.muscles);
    await aliases.assertAliasesFree(b.aliases ?? []);
    const key = caseKey(b.name);
    const result = await batch(db, [
      statement(
        db,
        `INSERT INTO exercises (name, name_key, equipment, pattern, stimulus_type, systemic_fatigue, measure, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        b.name,
        key,
        b.equipment ?? null,
        b.pattern ?? null,
        b.stimulus_type,
        b.systemic_fatigue,
        b.measure,
        b.notes ?? null,
      ),
      ...jsonChunks(
        (b.aliases ?? []).map((alias) => ({ alias, key: caseKey(alias) })),
      ).map((chunk) =>
        statement(
          db,
          `INSERT INTO exercise_aliases (exercise_id, alias, alias_key)
         SELECT (SELECT id FROM exercises WHERE name_key = ?), json_extract(value, '$.alias'), json_extract(value, '$.key') FROM json_each(?)`,
          key,
          chunk.json,
        )
      ),
      ...muscleStatements(
        "(SELECT id FROM exercises WHERE name_key = ?)",
        key,
        muscles,
      ),
      statement(db, `${select} WHERE e.name_key = ?`, key),
    ]);
    return decode(
      requireRow(
        result.at(-1)!.results as unknown as StoredExercise[],
        "The exercise could not be read after saving.",
      ),
    );
  }
  async function exerciseHistory(
    ref: string,
    rawLimit?: string,
  ): Promise<ExerciseHistory> {
    const limit = rawLimit === "all" ? -1 : Number(rawLimit);
    if (
      rawLimit !== "all" &&
      (rawLimit === undefined || !Number.isInteger(limit) || limit < 1)
    ) {
      throw new ApiError(
        422,
        '"limit" is required on a history read: a whole number for the most recent sets — 10 to 30 is usually enough to judge how an exercise is going — or "all" for the whole series, which is what charting a block or a year needs. Every set carries its note, so ask for what you will actually read. The reply says how many sets exist in total, so a partial read knows what it left behind.',
      );
    }
    const e = await resolver.resolveExercise(ref);
    const result = await batch(db, [
      statement(
        db,
        `SELECT count(*) AS total FROM sets t WHERE t.exercise_id = ? AND t.kind = 'working' AND ${performed}`,
        e.id,
      ),
      statement(
        db,
        `SELECT s.date, t.weight_kg / 100.0 AS weight_kg, t.reps,
        t.distance_m / 10.0 AS distance_m, t.duration_s / 100.0 AS duration_s, t.effort, t.notes, t.session_id
        FROM sets t JOIN sessions s ON s.id = t.session_id
        WHERE t.exercise_id = ? AND t.kind = 'working' AND ${performed}
        ORDER BY s.date DESC, t.position DESC LIMIT ?`,
        e.id,
        limit,
      ),
    ]);
    const sets = (result[1].results as unknown as HistorySet[]).reverse();
    return {
      exercise: e.name,
      exercise_id: e.id,
      measure: e.measure as ExerciseRow["measure"],
      total_sets: result[0].results[0].total as number,
      returned: sets.length,
      sets,
    };
  }
  async function correctExercise(
    ref: string,
    b: CorrectExerciseInput,
  ): Promise<ExerciseRow> {
    const e = await resolver.resolveExercise(ref);
    if (b.muscles !== undefined) {
      throw new ApiError(
        422,
        "The muscle classification is replaced whole with PUT /exercises/:ref/muscles — a partial edit of a classification is ambiguous about the rows it does not mention.",
      );
    }
    if (b.alias !== undefined || b.aliases !== undefined) {
      throw new ApiError(
        422,
        "Aliases have their own surface: POST /exercises/:ref/aliases adds, DELETE /exercises/:ref/aliases/:alias removes.",
      );
    }
    const fields: Record<string, Parameter> = {};
    for (
      const f of [
        "name",
        "equipment",
        "pattern",
        "notes",
        "systemic_fatigue",
        "measure",
        "stimulus_type",
      ] as const
    ) {
      if (b[f] !== undefined) fields[f] = b[f];
    }
    const identity = b.measure !== undefined || b.stimulus_type !== undefined;
    if (identity) {
      const [{ n }] = await rows<{ n: number }>(
        db,
        "SELECT count(*) AS n FROM sets WHERE exercise_id = ?",
        e.id,
      );
      if (n > 0) {
        throw new ApiError(
          422,
          `"measure" and "stimulus_type" are frozen once an exercise has logged sets — "${e.name}" has ${n}. Every one of them was validated and counted under the current values, so changing them would rewrite history that already happened. The fix now is a new exercise with the right value, which takes over this one's aliases (POST /exercises, then move the aliases).`,
        );
      }
    }
    if (!Object.keys(fields).length) {
      throw new ApiError(
        422,
        "Send at least one of: name, equipment, pattern, notes, systemic_fatigue — or, while the exercise has no logged sets, measure and stimulus_type.",
      );
    }
    if (b.name !== undefined) fields.name_key = caseKey(b.name);
    const result = await batch(db, [
      guard(
        `EXISTS (SELECT 1 FROM exercises WHERE id = ?)${
          identity
            ? " AND NOT EXISTS (SELECT 1 FROM sets WHERE exercise_id = ?)"
            : ""
        }`,
        e.id,
        ...(identity ? [e.id] : []),
      ),
      statement(
        db,
        `UPDATE exercises SET ${
          Object.keys(fields)
            .map((f) => `${f} = ?`)
            .join(", ")
        } WHERE id = ?`,
        ...Object.values(fields),
        e.id,
      ),
      statement(db, `${select} WHERE e.id = ?`, e.id),
      cleanup(),
    ]);
    return decode(
      requireRow(
        result.at(-2)!.results as unknown as StoredExercise[],
        `No exercise with id ${e.id}.`,
      ),
    );
  }
  async function deleteExercise(ref: string): Promise<string> {
    const e = await resolver.resolveExercise(ref);
    const [{ set_count, plan_count, dose_count }] = await rows<{
      set_count: number;
      plan_count: number;
      dose_count: number;
    }>(
      db,
      `SELECT (SELECT count(*) FROM sets WHERE exercise_id = ?) AS set_count,
       (SELECT count(*) FROM mesocycle_exercises WHERE exercise_id = ?) AS plan_count,
       (SELECT count(*) FROM mesocycle_exercise_doses WHERE exercise_id = ?) AS dose_count`,
      e.id,
      e.id,
      e.id,
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
        } — so deleting it would orphan history. PATCH /exercises/:ref fixes what is fixable; a duplicate's aliases move to the exercise being kept.`,
      );
    }
    const result = await batch(db, [
      guard(
        "NOT EXISTS (SELECT 1 FROM sets WHERE exercise_id = ?) AND NOT EXISTS (SELECT 1 FROM mesocycle_exercises WHERE exercise_id = ?) AND NOT EXISTS (SELECT 1 FROM mesocycle_exercise_doses WHERE exercise_id = ?)",
        e.id,
        e.id,
        e.id,
      ),
      statement(db, "DELETE FROM exercises WHERE id = ? RETURNING name", e.id),
      cleanup(),
    ]);
    return requireRow(result[1].results, `No exercise with id ${e.id}.`)
      .name as string;
  }
  async function reclassifyMuscles(
    ref: string,
    entries: MuscleEntryInput[],
  ): Promise<{ exercise: ExerciseRow; note: string }> {
    const e = await resolver.resolveExercise(ref);
    const muscles = await muscleEntries(entries);
    const activeSql =
      `SELECT mc.name FROM mesocycle_exercises me JOIN mesocycles mc ON mc.id = me.mesocycle_id WHERE me.exercise_id = ? AND mc.ended_on IS NULL`;
    const active = await rows<{ name: string }>(
      db,
      `${activeSql} ORDER BY mc.name`,
      e.id,
    );
    if (active.length) {
      throw new ApiError(
        409,
        `"${e.name}" is in ${
          active.map((m) => `"${m.name}"`).join(" and ")
        }, which is still running. Reclassifying its muscles mid-plan silently rewrites the weekly-volume numbers that plan is being judged on — this change belongs between mesocycles, at the review.`,
      );
    }
    const result = await batch(db, [
      guard(
        `EXISTS (SELECT 1 FROM exercises WHERE id = ?) AND NOT EXISTS (${activeSql})`,
        e.id,
        e.id,
      ),
      statement(db, "DELETE FROM exercise_muscles WHERE exercise_id = ?", e.id),
      ...muscleStatements("?", e.id, muscles),
      statement(
        db,
        `SELECT count(DISTINCT date(s.date, '-' || ((CAST(strftime('%w', s.date) AS INTEGER) + 6) % 7) || ' days')) AS weeks
        FROM sets t JOIN sessions s ON s.id = t.session_id WHERE t.exercise_id = ? AND t.kind = 'working' AND s.date < ?`,
        e.id,
        mondayOf(romeDate(instant(clock().toISOString()))),
      ),
      statement(db, `${select} WHERE e.id = ?`, e.id),
      cleanup(),
    ]);
    const weeks = result.at(-3)!.results[0].weeks as number;
    return {
      exercise: decode(
        requireRow(
          result.at(-2)!.results as unknown as StoredExercise[],
          `No exercise with id ${e.id}.`,
        ),
      ),
      note: weeks === 0
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
