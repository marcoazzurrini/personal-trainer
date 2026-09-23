// Membership, dose history, intent and the decision remain one atomic write.
// Unlike session corrections, plan preconditions fit in SQL itself: no extra
// plan version counter or lock service is needed.
import {
  batch,
  type Clock,
  type Database,
  databaseError,
  date,
  decimal,
  instant,
  jsonChunks,
  type Parameter,
  requestId,
  type Result,
  romeDate,
  rows,
  statement,
  systemClock,
  wireInstant,
} from "../shared/d1.ts";
import { ApiError, requireRow } from "../shared/errors.ts";
import { trainingResolver } from "./resolve.ts";
import { affectedRows, finishWrite } from "./session_write.ts";
import { assertDoseUnit } from "./rules.ts";
import type {
  CreateMesocycleInput,
  DecisionInput,
  DecisionRow,
  MesocycleDetail,
  PlanEntry,
  PlanExercise,
  PlanExerciseRow,
  RecordedRow,
  RenameMesocycleInput,
} from "./mesocycles.types.ts";

type Header = Omit<MesocycleDetail, "week" | "exercises"> & { week: number };
const decisionColumns = "id, mesocycle_id, made_at, what_changed, why";
const publicDecision = (row: RecordedRow): RecordedRow => ({
  ...row,
  made_at: wireInstant(row.made_at)!,
});

export function mesocycleStore(db: Database, clock: Clock = systemClock) {
  const resolver = trainingResolver(db);

  function detailStatements(key: Parameter, today: string, byRequest = false) {
    const predicate = byRequest ? "m.request_id = ?" : "m.id = ?";
    return [
      statement(
        db,
        `SELECT m.id, m.block_id, m.name, m.track, m.intent, m.planned_weeks,
          m.sessions_per_week, m.started_on, m.ended_on,
          CAST((julianday(?) - julianday(m.started_on)) / 7 AS INTEGER) + 1 AS week
         FROM mesocycles m WHERE ${predicate}`,
        today,
        key,
      ),
      statement(
        db,
        `SELECT me.id, e.id AS exercise_id, e.name AS exercise, e.measure,
          me.role, me.priority, d.weekly_dose / 100.0 AS weekly_dose,
          d.weekly_dose_unit, me.notes
         FROM mesocycle_exercises me JOIN mesocycles m ON m.id = me.mesocycle_id
         JOIN exercises e ON e.id = me.exercise_id
         JOIN mesocycle_exercise_doses d ON d.id = (
           SELECT h.id FROM mesocycle_exercise_doses h
           WHERE h.mesocycle_id = m.id AND h.exercise_id = me.exercise_id
             AND h.effective_from <= max(?, m.started_on)
           ORDER BY h.effective_from DESC, h.id DESC LIMIT 1
         ) WHERE ${predicate} ORDER BY me.priority, e.name`,
        today,
        key,
      ),
    ];
  }
  function detail(results: Result[], key: Parameter): MesocycleDetail {
    const header = requireRow(
      results[0].results as unknown as Header[],
      `No mesocycle with id ${key}.`,
    );
    return {
      ...header,
      week: header.week < 1 ? null : header.week,
      exercises: results[1].results as unknown as PlanExerciseRow[],
    };
  }
  async function mesocycleDetail(id: number): Promise<MesocycleDetail> {
    return detail(
      await batch(
        db,
        detailStatements(id, romeDate(instant(clock().toISOString()))),
      ),
      id,
    );
  }
  async function mesocycleByRef(ref: string) {
    return await mesocycleDetail((await resolver.resolveMesocycle(ref)).id);
  }

  // Bulk lookup also serves large plans without spending one D1 query per noun.
  async function prepare(
    additions: PlanEntry[],
    removals: (string | number)[] = [],
    redoses: NonNullable<DecisionInput["redose"]> = [],
  ) {
    const references = await resolver.forSets([
      ...additions,
      ...removals.map((exercise) => ({ exercise })),
      ...redoses,
    ]);
    const remove = [];
    for (const ref of removals) {
      remove.push(await references.resolveExercise(ref));
    }
    const add: PlanExercise[] = [];
    for (const entry of additions) {
      if (entry.weekly_sets !== undefined) {
        throw new ApiError(
          422,
          'The weekly dose is "weekly_dose" plus "weekly_dose_unit" (sets, minutes, or km), so that work in metres and minutes can be dosed too. An exercise entry is {exercise, role, priority, weekly_dose, weekly_dose_unit, notes?}.',
        );
      }
      if (entry.load_target !== undefined) {
        throw new ApiError(
          422,
          "Load targets are not stored in tables: the intent carries the plan's goals and its progression mechanism (see tasks/programming). Only the weekly dose is structured.",
        );
      }
      const exercise = await references.resolveExercise(entry.exercise);
      assertDoseUnit(exercise.measure, entry.weekly_dose_unit, exercise.name);
      add.push({
        exerciseId: exercise.id,
        role: entry.role,
        priority: entry.priority,
        weeklyDose: decimal(entry.weekly_dose, 6, 2)!,
        weeklyDoseUnit: entry.weekly_dose_unit,
        notes: entry.notes ?? null,
      });
    }
    const redose = [];
    for (const entry of redoses) {
      const exercise = await references.resolveExercise(entry.exercise);
      assertDoseUnit(exercise.measure, entry.weekly_dose_unit, exercise.name);
      redose.push({
        exerciseId: exercise.id,
        name: exercise.name,
        dose: decimal(entry.weekly_dose, 6, 2)!,
        unit: entry.weekly_dose_unit,
      });
    }
    return { remove, add, redose };
  }

  function additions(
    key: Parameter,
    items: PlanExercise[],
    today: string,
    now: string,
    byRequest = false,
  ) {
    const predicate = byRequest ? "m.request_id = ?" : "m.id = ?";
    return jsonChunks(items).flatMap((chunk) => [
      statement(
        db,
        `INSERT INTO mesocycle_exercises (mesocycle_id, exercise_id, role, priority, notes)
         SELECT m.id, json_extract(v.value, '$.exerciseId'), json_extract(v.value, '$.role'),
           json_extract(v.value, '$.priority'), json_extract(v.value, '$.notes')
         FROM json_each(?) v CROSS JOIN mesocycles m WHERE ${predicate} ORDER BY CAST(v.key AS INTEGER)`,
        chunk.json,
        key,
      ),
      affectedRows(db, chunk.count),
      statement(
        db,
        `INSERT INTO mesocycle_exercise_doses (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit, effective_from, created_at)
         SELECT m.id, json_extract(v.value, '$.exerciseId'), json_extract(v.value, '$.weeklyDose'),
           json_extract(v.value, '$.weeklyDoseUnit'), max(?, m.started_on), ?
         FROM json_each(?) v CROSS JOIN mesocycles m WHERE ${predicate} ORDER BY CAST(v.key AS INTEGER)`,
        today,
        now,
        chunk.json,
        key,
      ),
      affectedRows(db, chunk.count),
    ]);
  }
  async function seenPlan(uuid: string) {
    const [seen] = await rows<{ id: number }>(
      db,
      "SELECT id FROM mesocycles WHERE request_id = ?",
      uuid,
    );
    return seen ? await mesocycleDetail(seen.id) : undefined;
  }
  async function createMesocycle(
    b: CreateMesocycleInput,
  ) {
    const uuid = requestId(b.request_id);
    const seen = await seenPlan(uuid);
    if (seen) return { mesocycle: seen, created: false };
    try {
      const prepared = await prepare(b.exercises);
      const now = instant(clock().toISOString());
      const start = date(b.started_on);
      const results = await db.batch([
        statement(db, "INSERT INTO api_write_assertions (id) VALUES (1)"),
        statement(
          db,
          `INSERT INTO mesocycles (block_id, name, track, intent, planned_weeks, sessions_per_week, started_on, request_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          b.block_id,
          b.name,
          b.track,
          b.intent,
          b.planned_weeks,
          b.sessions_per_week,
          start,
          uuid,
        ),
        affectedRows(db, 1),
        ...additions(uuid, prepared.add, start, now, true),
        ...detailStatements(uuid, romeDate(now), true),
        finishWrite(db),
      ]);
      return { mesocycle: detail(results.slice(-3, -1), uuid), created: true };
    } catch (error) {
      // Recover a concurrent replay or a confirmed completed request by reading
      // its key, never by retrying an uncertain non-idempotent write.
      const replay = await seenPlan(uuid);
      if (replay) return { mesocycle: replay, created: false };
      throw databaseError(error);
    }
  }
  async function renameMesocycle(
    ref: string,
    b: RenameMesocycleInput,
  ) {
    const m = await resolver.resolveMesocycle(ref);
    if (b.intent !== undefined) {
      throw new ApiError(
        422,
        "The intent is the plan; changing it is a decision. POST /mesocycles/:id/decisions with the full replacement intent, what changed, and why.",
      );
    }
    if (b.ended_on !== undefined) {
      throw new ApiError(
        422,
        'Ending a plan is a plan change, so it carries its reason: POST /mesocycles/:id/decisions with {"ended_on": "YYYY-MM-DD", "what_changed": …, "why": …}.',
      );
    }
    const results = await batch(db, [
      statement(db, "INSERT INTO api_write_assertions (id) VALUES (1)"),
      statement(
        db,
        "UPDATE mesocycles SET name = ? WHERE id = ?",
        b.name,
        m.id,
      ),
      affectedRows(db, 1),
      ...detailStatements(m.id, romeDate(instant(clock().toISOString()))),
      finishWrite(db),
    ]);
    return detail(results.slice(-3, -1), m.id);
  }

  async function seenDecision(id: number, uuid: string) {
    const [seen] = await rows<RecordedRow>(
      db,
      `SELECT ${decisionColumns} FROM mesocycle_decisions WHERE mesocycle_id = ? AND request_id = ?`,
      id,
      uuid,
    );
    return seen
      ? {
        mesocycle: await mesocycleDetail(id),
        decision: publicDecision(seen),
        created: false,
      }
      : undefined;
  }
  function memberCount(expected: number) {
    return statement(
      db,
      "UPDATE api_write_assertions SET plan_matches = (changes() = ?) WHERE id = 1",
      expected,
    );
  }
  async function recordDecision(ref: string, b: DecisionInput) {
    const m = await resolver.resolveMesocycle(ref);
    const uuid = requestId(b.request_id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const seen = await seenDecision(m.id, uuid);
      if (seen) return seen;
      try {
        if (b.weekly_sets !== undefined) {
          throw new ApiError(
            422,
            'Dose changes are "redose": [{exercise, weekly_dose, weekly_dose_unit}], for exercises already in the plan.',
          );
        }
        if (b.load_targets !== undefined) {
          throw new ApiError(
            422,
            'Load targets are not stored in tables: a change to a goal or to the progression mechanism is an intent change. Send "intent" with the full replacement text (see tasks/programming).',
          );
        }
        const inputs = await prepare(
          b.add ?? [],
          b.remove ?? [],
          b.redose ?? [],
        );
        const members = new Set(
          (await rows<{ exercise_id: number }>(
            db,
            "SELECT exercise_id FROM mesocycle_exercises WHERE mesocycle_id = ?",
            m.id,
          )).map((row) => row.exercise_id),
        );
        for (const exercise of inputs.remove) {
          if (!members.delete(exercise.id)) {
            throw new ApiError(
              422,
              `"${exercise.name}" is not in this mesocycle's plan, so it cannot be removed. GET /mesocycles/${m.id} shows the plan.`,
            );
          }
        }
        for (const entry of inputs.add) members.add(entry.exerciseId);
        for (const entry of inputs.redose) {
          if (!members.has(entry.exerciseId)) {
            throw new ApiError(
              422,
              `"${entry.name}" is not in this mesocycle's plan, so its dose cannot be changed. Add it with "add" instead, or GET /mesocycles/${m.id} to see the plan.`,
            );
          }
        }
        const now = instant(clock().toISOString());
        const today = romeDate(now);
        const newIntent = b.intent ?? null;
        const endedOn = b.ended_on == null ? null : date(b.ended_on);
        const results = await db.batch([
          statement(db, "INSERT INTO api_write_assertions (id) VALUES (1)"),
          // Capture the intent being displaced inside the transaction, not from
          // a stale application read. A failed later change rolls this back.
          statement(
            db,
            `INSERT INTO mesocycle_decisions
            (mesocycle_id, what_changed, why, request_id, prior_intent, made_at)
            SELECT id, ?, ?, ?, CASE WHEN ? THEN intent ELSE NULL END, ? FROM mesocycles WHERE id = ?`,
            b.what_changed,
            b.why,
            uuid,
            Number(newIntent !== null),
            now,
            m.id,
          ),
          affectedRows(db, 1),
          ...jsonChunks(inputs.remove.map((exercise) => exercise.id)).flatMap((
            chunk,
          ) => [
            statement(
              db,
              "DELETE FROM mesocycle_exercises WHERE mesocycle_id = ? AND exercise_id IN (SELECT value FROM json_each(?))",
              m.id,
              chunk.json,
            ),
            memberCount(chunk.count),
          ]),
          ...additions(m.id, inputs.add, today, now),
          ...jsonChunks(inputs.redose).flatMap((chunk) => [
            statement(
              db,
              `INSERT INTO mesocycle_exercise_doses
              (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit, effective_from, created_at)
              SELECT m.id, me.exercise_id, json_extract(v.value, '$.dose'), json_extract(v.value, '$.unit'), max(?, m.started_on), ?
              FROM json_each(?) v JOIN mesocycle_exercises me ON me.exercise_id = json_extract(v.value, '$.exerciseId')
              JOIN mesocycles m ON m.id = me.mesocycle_id WHERE m.id = ? ORDER BY CAST(v.key AS INTEGER)`,
              today,
              now,
              chunk.json,
              m.id,
            ),
            memberCount(chunk.count),
          ]),
          statement(
            db,
            `UPDATE mesocycles SET intent = CASE WHEN ? THEN ? ELSE intent END,
            ended_on = CASE WHEN ? THEN ? ELSE ended_on END WHERE id = ?`,
            Number(newIntent !== null),
            newIntent,
            Number(b.ended_on !== undefined),
            endedOn,
            m.id,
          ),
          affectedRows(db, 1),
          statement(
            db,
            `SELECT ${decisionColumns} FROM mesocycle_decisions WHERE mesocycle_id = ? AND request_id = ?`,
            m.id,
            uuid,
          ),
          ...detailStatements(m.id, today),
          finishWrite(db),
        ]);
        return {
          mesocycle: detail(results.slice(-3, -1), m.id),
          decision: publicDecision(
            requireRow(
              results.at(-4)!.results as unknown as RecordedRow[],
              "The decision could not be read after saving.",
            ),
          ),
          created: true,
        };
      } catch (error) {
        const replay = await seenDecision(m.id, uuid);
        if (replay) return replay;
        if (
          error instanceof Error &&
          /CHECK constraint failed: api_plan_membership_changed\b/.test(
            error.message,
          )
        ) continue;
        throw databaseError(error);
      }
    }
    throw new ApiError(
      409,
      `The plan kept changing. Nothing was saved by this request. Read GET /mesocycles/${m.id} before retrying.`,
    );
  }
  async function decisionLog(ref: string) {
    const m = await resolver.resolveMesocycle(ref);
    const decisions = await rows<DecisionRow>(
      db,
      "SELECT id, made_at, what_changed, why, prior_intent FROM mesocycle_decisions WHERE mesocycle_id = ? ORDER BY made_at, id",
      m.id,
    );
    return {
      mesocycle_id: m.id,
      decisions: decisions.map((row) => ({
        ...row,
        made_at: wireInstant(row.made_at)!,
      })),
    };
  }
  return {
    mesocycleDetail,
    mesocycleByRef,
    createMesocycle,
    renameMesocycle,
    recordDecision,
    decisionLog,
  };
}
