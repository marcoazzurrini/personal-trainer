import { asc, count, eq } from "drizzle-orm";

import type { Client } from "../../client.ts";
import type {
  ExerciseRecord as ExerciseRow,
  ExerciseHistorySet as HistorySet,
  MuscleRecord as MuscleRow,
  MuscleAssignment,
  NewExercise,
  ExerciseChanges,
} from "../../contracts/training.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import type { Parameter } from "../../native.ts";
import { batch, rows, statement } from "../../native.ts";
import { muscles, sets } from "../../schema/index.ts";
import { scaledInteger as decimal, caseKey } from "../../storage.ts";
import { jsonChunks } from "../../write.ts";

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

export function exercisesRepository(db: Client) {
  async function list() {
    return (await rows<StoredExercise>(db, `${select} ORDER BY e.name`)).map(
      decode
    );
  }
  async function byId(id: number) {
    return (await rows<StoredExercise>(db, `${select} WHERE e.id = ?`, id)).map(
      decode
    );
  }
  async function listMuscles(): Promise<MuscleRow[]> {
    try {
      return await db
        .select({ id: muscles.id, name: muscles.name })
        .from(muscles)
        .orderBy(asc(muscles.name));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function addMuscle(name: string): Promise<MuscleRow[]> {
    try {
      return await db
        .insert(muscles)
        .values({ name })
        .returning({ id: muscles.id, name: muscles.name });
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  // Guard and readback share the write transaction. A late set or membership
  // must refuse the whole edit, not invalidate an eligibility read silently.
  function guard(condition: string, ...values: Parameter[]) {
    return statement(
      db,
      `INSERT INTO api_write_assertions (id, rows_match) SELECT 1, (${condition})`,
      ...values
    );
  }
  const cleanup = () =>
    statement(db, "DELETE FROM api_write_assertions WHERE id = 1");
  function muscleStatements(
    owner: string,
    ownerValue: Parameter,
    entries: readonly MuscleAssignment[]
  ) {
    return jsonChunks(
      entries.map((entry) => ({
        ...entry,
        volume_factor: decimal(entry.volume_factor, 2, 1),
      }))
    ).map((chunk) =>
      statement(
        db,
        `INSERT INTO exercise_muscles (exercise_id, muscle_id, volume_factor)
       SELECT ${owner}, json_extract(value, '$.muscle_id'), json_extract(value, '$.volume_factor') FROM json_each(?)`,
        ownerValue,
        chunk.json
      )
    );
  }
  async function create(b: NewExercise) {
    const { muscles: assignments } = b;
    const key = caseKey(b.name);
    const result = await batch<StoredExercise>(db, [
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
        b.notes ?? null
      ),
      ...jsonChunks(
        (b.aliases ?? []).map((alias) => ({ alias, key: caseKey(alias) }))
      ).map((chunk) =>
        statement(
          db,
          `INSERT INTO exercise_aliases (exercise_id, alias, alias_key)
         SELECT (SELECT id FROM exercises WHERE name_key = ?), json_extract(value, '$.alias'), json_extract(value, '$.key') FROM json_each(?)`,
          key,
          chunk.json
        )
      ),
      ...muscleStatements(
        "(SELECT id FROM exercises WHERE name_key = ?)",
        key,
        assignments
      ),
      statement(db, `${select} WHERE e.name_key = ?`, key),
    ]);
    const [readback] = result.slice(-1);
    return readback.results.map(decode);
  }
  async function history(id: number, limit: number) {
    const result = await batch<HistorySet | { total: number }>(db, [
      statement(
        db,
        `SELECT count(*) AS total FROM sets t WHERE t.exercise_id = ? AND t.kind = 'working' AND ${performed}`,
        id
      ),
      statement(
        db,
        `SELECT s.date, t.weight_kg / 100.0 AS weight_kg, t.reps,
        t.distance_m / 10.0 AS distance_m, t.duration_s / 100.0 AS duration_s, t.effort, t.notes, t.session_id
        FROM sets t JOIN sessions s ON s.id = t.session_id
        WHERE t.exercise_id = ? AND t.kind = 'working' AND ${performed}
        ORDER BY s.date DESC, t.position DESC LIMIT ?`,
        id,
        limit
      ),
    ]);
    // SAFETY: the second statement selects the HistorySet columns; the first selects only total.
    const entries = (result[1].results as HistorySet[]).toReversed();
    // SAFETY: the first statement is SELECT count(*) AS total, which always returns one count row.
    const total = result[0].results[0] as { total: number };
    return { sets: entries, total: total.total };
  }
  async function setCount(id: number) {
    try {
      return await db
        .select({ n: count() })
        .from(sets)
        .where(eq(sets.exercise_id, id));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function correct(
    id: number,
    changes: ExerciseChanges,
    identity: boolean
  ) {
    const fields: ExerciseChanges & { name_key?: string } = { ...changes };
    if (changes.name !== undefined) {
      fields.name_key = caseKey(changes.name);
    }
    const result = await batch<StoredExercise>(db, [
      guard(
        `EXISTS (SELECT 1 FROM exercises WHERE id = ?)${
          identity
            ? " AND NOT EXISTS (SELECT 1 FROM sets WHERE exercise_id = ?)"
            : ""
        }`,
        id,
        ...(identity ? [id] : [])
      ),
      statement(
        db,
        `UPDATE exercises SET ${Object.keys(fields)
          .map((f) => `${f} = ?`)
          .join(", ")} WHERE id = ?`,
        ...Object.values(fields),
        id
      ),
      statement(db, `${select} WHERE e.id = ?`, id),
      cleanup(),
    ]);
    const [readback] = result.slice(-2);
    return readback.results.map(decode);
  }
  async function usage(id: number) {
    const result = await rows<{
      set_count: number;
      plan_count: number;
      dose_count: number;
    }>(
      db,
      `SELECT (SELECT count(*) FROM sets WHERE exercise_id = ?) AS set_count,
       (SELECT count(*) FROM mesocycle_exercises WHERE exercise_id = ?) AS plan_count,
       (SELECT count(*) FROM mesocycle_exercise_doses WHERE exercise_id = ?) AS dose_count`,
      id,
      id,
      id
    );
    return result;
  }
  async function remove(id: number) {
    const result = await batch<{ name: string }>(db, [
      guard(
        "NOT EXISTS (SELECT 1 FROM sets WHERE exercise_id = ?) AND NOT EXISTS (SELECT 1 FROM mesocycle_exercises WHERE exercise_id = ?) AND NOT EXISTS (SELECT 1 FROM mesocycle_exercise_doses WHERE exercise_id = ?)",
        id,
        id,
        id
      ),
      statement(db, "DELETE FROM exercises WHERE id = ? RETURNING name", id),
      cleanup(),
    ]);
    return result[1].results;
  }
  const activeSql = `SELECT mc.name FROM mesocycle_exercises me JOIN mesocycles mc ON mc.id = me.mesocycle_id WHERE me.exercise_id = ? AND mc.ended_on IS NULL`;
  async function activePlans(id: number) {
    return await rows<{ name: string }>(
      db,
      `${activeSql} ORDER BY mc.name`,
      id
    );
  }
  async function reclassify(
    id: number,
    assignments: readonly MuscleAssignment[],
    cutoff: string
  ) {
    const result = await batch<StoredExercise | { weeks: number }>(db, [
      guard(
        `EXISTS (SELECT 1 FROM exercises WHERE id = ?) AND NOT EXISTS (${activeSql})`,
        id,
        id
      ),
      statement(db, "DELETE FROM exercise_muscles WHERE exercise_id = ?", id),
      ...muscleStatements("?", id, assignments),
      statement(
        db,
        `SELECT count(DISTINCT date(s.date, '-' || ((CAST(strftime('%w', s.date) AS INTEGER) + 6) % 7) || ' days')) AS weeks
        FROM sets t JOIN sessions s ON s.id = t.session_id WHERE t.exercise_id = ? AND t.kind = 'working' AND s.date < ?`,
        id,
        cutoff
      ),
      statement(db, `${select} WHERE e.id = ?`, id),
      cleanup(),
    ]);
    const [total, readback] = result.slice(-3);
    return {
      // SAFETY: the third-last statement selects one count(*) AS weeks row.
      weeks: (total.results as { weeks: number }[])[0].weeks,
      // SAFETY: the second-last statement selects the complete stored exercise row.
      exercises: (readback.results as StoredExercise[]).map(decode),
    };
  }
  return {
    list,
    byId,
    listMuscles,
    addMuscle,
    create,
    history,
    setCount,
    correct,
    usage,
    remove,
    activePlans,
    reclassify,
  };
}
export type ExercisesRepository = ReturnType<typeof exercisesRepository>;
