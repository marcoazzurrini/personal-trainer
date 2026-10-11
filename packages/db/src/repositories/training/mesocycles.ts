import { asc, eq, and } from "drizzle-orm";

import type { Client } from "../../client.ts";
import type {
  MesocycleHeader,
  PlanExerciseRecord,
  PlanAddition,
  RecordedDecision,
  DecisionRecord,
  NewMesocycle,
  PlanDecision,
} from "../../contracts/training.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import type { Parameter } from "../../native.ts";
import { batch, statement } from "../../native.ts";
import {
  mesocycles,
  mesocycle_decisions,
  mesocycle_exercises,
} from "../../schema/index.ts";
import { scaledInteger } from "../../storage.ts";
import { jsonChunks } from "../../write.ts";
import { affectedRows, finishWrite } from "./write.ts";

type Header = MesocycleHeader & { week: number };
type PlanRead = Header | PlanExerciseRecord | RecordedDecision;
function snapshot(results: { results: PlanRead[] }[]) {
  // Paired reads select the header first and plan exercises second.
  return {
    // SAFETY: the first paired SELECT contains the header and computed week.
    headers: results[0].results as Header[],
    // SAFETY: the second paired SELECT contains the plan exercise columns.
    exercises: results[1].results as PlanExerciseRecord[],
  };
}
const decisionColumns = "id, mesocycle_id, made_at, what_changed, why";
const decisionSelection = {
  id: mesocycle_decisions.id,
  mesocycle_id: mesocycle_decisions.mesocycle_id,
  made_at: mesocycle_decisions.made_at,
  what_changed: mesocycle_decisions.what_changed,
  why: mesocycle_decisions.why,
};
export function mesocyclesRepository(db: Client) {
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
        key
      ),
      statement(
        db,
        `SELECT me.id, e.id AS exercise_id, e.name AS exercise, e.measure,
          me.role, me.priority, d.weekly_dose / 10.0 AS weekly_dose,
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
        key
      ),
    ];
  }
  async function read(id: number, today: string) {
    return snapshot(await batch<PlanRead>(db, detailStatements(id, today)));
  }
  async function findRequest(uuid: string) {
    try {
      return await db
        .select({ id: mesocycles.id })
        .from(mesocycles)
        .where(eq(mesocycles.request_id, uuid));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function findDecision(
    id: number,
    uuid: string
  ): Promise<RecordedDecision[]> {
    try {
      return await db
        .select(decisionSelection)
        .from(mesocycle_decisions)
        .where(
          and(
            eq(mesocycle_decisions.mesocycle_id, id),
            eq(mesocycle_decisions.request_id, uuid)
          )
        );
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function members(id: number) {
    try {
      return await db
        .select({ exercise_id: mesocycle_exercises.exercise_id })
        .from(mesocycle_exercises)
        .where(eq(mesocycle_exercises.mesocycle_id, id));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function decisions(id: number): Promise<DecisionRecord[]> {
    try {
      return await db
        .select({
          id: mesocycle_decisions.id,
          made_at: mesocycle_decisions.made_at,
          what_changed: mesocycle_decisions.what_changed,
          why: mesocycle_decisions.why,
          prior_intent: mesocycle_decisions.prior_intent,
        })
        .from(mesocycle_decisions)
        .where(eq(mesocycle_decisions.mesocycle_id, id))
        .orderBy(asc(mesocycle_decisions.made_at), asc(mesocycle_decisions.id));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  function additions(
    key: Parameter,
    items: PlanAddition[],
    today: string,
    now: string,
    byRequest = false
  ) {
    const predicate = byRequest ? "m.request_id = ?" : "m.id = ?";
    return jsonChunks(
      items.map((item) => ({
        ...item,
        weeklyDose: scaledInteger(item.weeklyDose, 6, 1),
      }))
    ).flatMap((chunk) => [
      statement(
        db,
        `INSERT INTO mesocycle_exercises (mesocycle_id, exercise_id, role, priority, notes)
         SELECT m.id, json_extract(v.value, '$.exerciseId'), json_extract(v.value, '$.role'),
           json_extract(v.value, '$.priority'), json_extract(v.value, '$.notes')
         FROM json_each(?) v CROSS JOIN mesocycles m WHERE ${predicate} ORDER BY CAST(v.key AS INTEGER)`,
        chunk.json,
        key
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
        key
      ),
      affectedRows(db, chunk.count),
    ]);
  }
  function memberCount(expected: number) {
    return statement(
      db,
      "UPDATE api_write_assertions SET plan_matches = (changes() = ?) WHERE id = 1",
      expected
    );
  }
  async function create(b: NewMesocycle) {
    const { request_id: uuid, now, started_on: start } = b;
    const results = await batch<PlanRead>(db, [
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
        uuid
      ),
      affectedRows(db, 1),
      ...additions(uuid, b.exercises, start, now, true),
      ...detailStatements(uuid, b.today, true),
      finishWrite(db),
    ]);
    return snapshot(results.slice(-3, -1));
  }
  async function rename(id: number, name: string, today: string) {
    const results = await batch<PlanRead>(db, [
      statement(db, "INSERT INTO api_write_assertions (id) VALUES (1)"),
      statement(db, "UPDATE mesocycles SET name = ? WHERE id = ?", name, id),
      affectedRows(db, 1),
      ...detailStatements(id, today),
      finishWrite(db),
    ]);
    return snapshot(results.slice(-3, -1));
  }
  async function record(b: PlanDecision) {
    const {
      now,
      today,
      request_id: uuid,
      intent: newIntent,
      ended_on: endedOn,
    } = b;
    const results = await batch<PlanRead>(db, [
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
        b.mesocycle_id
      ),
      affectedRows(db, 1),
      ...jsonChunks(b.remove).flatMap((chunk) => [
        statement(
          db,
          "DELETE FROM mesocycle_exercises WHERE mesocycle_id = ? AND exercise_id IN (SELECT value FROM json_each(?))",
          b.mesocycle_id,
          chunk.json
        ),
        memberCount(chunk.count),
      ]),
      ...additions(b.mesocycle_id, b.add, today, now),
      ...jsonChunks(
        b.redose.map((entry) => ({
          ...entry,
          dose: scaledInteger(entry.dose, 6, 1),
        }))
      ).flatMap((chunk) => [
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
          b.mesocycle_id
        ),
        memberCount(chunk.count),
      ]),
      statement(
        db,
        `UPDATE mesocycles SET intent = CASE WHEN ? THEN ? ELSE intent END,
            ended_on = CASE WHEN ? THEN ? ELSE ended_on END WHERE id = ?`,
        Number(newIntent !== null),
        newIntent,
        Number(b.changeEndedOn),
        endedOn,
        b.mesocycle_id
      ),
      affectedRows(db, 1),
      statement(
        db,
        `SELECT ${decisionColumns} FROM mesocycle_decisions WHERE mesocycle_id = ? AND request_id = ?`,
        b.mesocycle_id,
        uuid
      ),
      ...detailStatements(b.mesocycle_id, today),
      finishWrite(db),
    ]);
    // The decision read precedes the paired detail reads and cleanup.
    const [decision] = results.slice(-4);
    return {
      ...snapshot(results.slice(-3, -1)),
      // SAFETY: the fourth-last SELECT reads the saved decision columns.
      decisions: decision.results as RecordedDecision[],
    };
  }
  return {
    read,
    findRequest,
    findDecision,
    members,
    decisions,
    create,
    rename,
    record,
  };
}
export type MesocyclesRepository = ReturnType<typeof mesocyclesRepository>;
