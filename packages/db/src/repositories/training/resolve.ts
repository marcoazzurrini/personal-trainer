import { and, asc, eq, isNull } from "drizzle-orm";

import type { Client } from "../../client.ts";
import type {
  ExerciseLookup,
  ExerciseReference,
  PlanReference,
} from "../../contracts/training.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import { batch, rows, statement } from "../../native.ts";
import {
  exercises,
  mesocycles,
  mesocycle_exercises,
} from "../../schema/index.ts";
import { jsonChunks } from "../../write.ts";

const exerciseColumns = {
  id: exercises.id,
  name: exercises.name,
  measure: exercises.measure,
  stimulus_type: exercises.stimulus_type,
};
const planColumns = { id: mesocycles.id, track: mesocycles.track };

export function resolutionRepository(db: Client) {
  async function exerciseById(
    id: number
  ): Promise<ExerciseReference | undefined> {
    try {
      const result = await db
        .select(exerciseColumns)
        .from(exercises)
        .where(eq(exercises.id, id));
      // SAFETY: SQL CHECK constraints restrict measure and stimulus_type to these catalog enums.
      return result[0] as ExerciseReference | undefined;
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function exerciseByKey(
    key: string
  ): Promise<ExerciseReference | undefined> {
    const result = await rows<ExerciseReference>(
      db,
      `SELECT e.id, e.name, e.measure, e.stimulus_type FROM exercises e
      WHERE e.id = (
        SELECT id FROM (
          SELECT id, 1 AS rank FROM exercises WHERE name_key = ?
          UNION ALL
          SELECT exercise_id AS id, 2 AS rank FROM exercise_aliases WHERE alias_key = ?
        ) ORDER BY rank LIMIT 1
      )`,
      key,
      key
    );
    return result[0];
  }
  async function activePlans(): Promise<PlanReference[]> {
    try {
      return await db
        .select(planColumns)
        .from(mesocycles)
        .where(isNull(mesocycles.ended_on))
        .orderBy(asc(mesocycles.track));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function planById(id: number): Promise<PlanReference[]> {
    try {
      return await db
        .select(planColumns)
        .from(mesocycles)
        .where(eq(mesocycles.id, id));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function activePlansForExercise(
    exerciseId: number
  ): Promise<PlanReference[]> {
    try {
      return await db
        .select(planColumns)
        .from(mesocycles)
        .innerJoin(
          mesocycle_exercises,
          eq(mesocycle_exercises.mesocycle_id, mesocycles.id)
        )
        .where(
          and(
            isNull(mesocycles.ended_on),
            eq(mesocycle_exercises.exercise_id, exerciseId)
          )
        )
        .orderBy(asc(mesocycles.track));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function exercisesForReferences(
    inputs: readonly ExerciseLookup[]
  ): Promise<(ExerciseReference & { item: number })[]> {
    const found = await batch<ExerciseReference & { item: number }>(
      db,
      jsonChunks(inputs).map((chunk) =>
        statement(
          db,
          `SELECT CAST(v.key AS INTEGER) + ? AS item, e.id, e.name, e.measure, e.stimulus_type
         FROM json_each(?) v JOIN exercises e ON e.id = COALESCE(
           (SELECT id FROM exercises WHERE name_key = json_extract(v.value, '$.key')),
           (SELECT exercise_id FROM exercise_aliases WHERE alias_key = json_extract(v.value, '$.key')),
           (SELECT id FROM exercises WHERE id = json_extract(v.value, '$.id'))
         )`,
          chunk.offset,
          chunk.json
        )
      )
    );
    return found.flatMap((result) => result.results);
  }
  async function plansByIds(ids: readonly number[]): Promise<PlanReference[]> {
    const found: PlanReference[] = [];
    for (const chunk of jsonChunks(ids)) {
      found.push(
        ...(await rows<PlanReference>(
          db,
          "SELECT id, track FROM mesocycles WHERE id IN (SELECT value FROM json_each(?))",
          chunk.json
        ))
      );
    }
    return found;
  }
  async function activeMembership(
    ids: readonly number[]
  ): Promise<(PlanReference & { exercise_id: number })[]> {
    const found: (PlanReference & { exercise_id: number })[] = [];
    for (const chunk of jsonChunks(ids)) {
      found.push(
        ...(await rows<PlanReference & { exercise_id: number }>(
          db,
          `SELECT me.exercise_id, m.id, m.track FROM mesocycle_exercises me
         JOIN mesocycles m ON m.id = me.mesocycle_id
         WHERE m.ended_on IS NULL AND me.exercise_id IN (SELECT value FROM json_each(?))
         ORDER BY m.track`,
          chunk.json
        ))
      );
    }
    return found;
  }
  return {
    exerciseById,
    exerciseByKey,
    activePlans,
    planById,
    activePlansForExercise,
    exercisesForReferences,
    plansByIds,
    activeMembership,
  };
}

export type ResolutionRepository = ReturnType<typeof resolutionRepository>;
