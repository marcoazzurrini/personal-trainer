import { eq } from "drizzle-orm";

import type { Client } from "../../client.ts";
import type {
  Header,
  SetSnapshot,
  SessionHeaderRow,
  SessionSnapshot,
  WriteFields,
} from "../../contracts/training.ts";
import { classifyDatabaseFailure } from "../../errors.ts";
import { batch, rows, statement } from "../../native.ts";
import { sessions, sets } from "../../schema/index.ts";
import {
  scaledInteger as decimal,
  canonicalInstant as instant,
} from "../../storage.ts";
import { jsonChunks } from "../../write.ts";
import { affectedRows, finishWrite, sessionVersion } from "./write.ts";

const headerColumns =
  "id, date, rationale, notes, overall_feel, started_at, completed_at, write_version";
const setColumns = `t.id, t.session_id, e.name AS exercise, t.exercise_id, e.measure, e.stimulus_type,
  t.mesocycle_id, t.position, t.kind,
  t.target_weight_kg / 100.0 AS target_weight_kg, t.target_reps,
  t.target_distance_m / 10.0 AS target_distance_m, t.target_duration_s / 100.0 AS target_duration_s,
  t.weight_kg / 100.0 AS weight_kg, t.reps,
  t.distance_m / 10.0 AS distance_m, t.duration_s / 100.0 AS duration_s,
  t.effort, t.performed_at, t.notes, t.request_id`;
const sessionFields = [
  "notes",
  "overall_feel",
  "rationale",
  "started_at",
  "completed_at",
] as const;
const scales = {
  weight_kg: [6, 2],
  target_weight_kg: [6, 2],
  distance_m: [7, 1],
  target_distance_m: [7, 1],
  duration_s: [8, 2],
  target_duration_s: [8, 2],
} as const;

function scaledField(field: string): field is keyof typeof scales {
  return Object.hasOwn(scales, field);
}
const insertSetFields = [
  "exercise_id",
  "mesocycle_id",
  "kind",
  "target_weight_kg",
  "target_reps",
  "target_distance_m",
  "target_duration_s",
  "weight_kg",
  "reps",
  "distance_m",
  "duration_s",
  "effort",
  "performed_at",
  "notes",
] as const;

function stored(fields: WriteFields): WriteFields {
  return Object.fromEntries(
    Object.entries(fields).map(([field, value]) => {
      if (value === null) {
        return [field, null];
      }
      if (scaledField(field)) {
        const [precision, scale] = scales[field];
        // SAFETY: scaled keys in WriteFields hold numbers or null; null returned above and callers omit undefined fields.
        return [field, decimal(value as number, precision, scale)];
      }
      if (
        field === "performed_at" ||
        field === "started_at" ||
        field === "completed_at"
      ) {
        // SAFETY: timestamp keys in WriteFields hold strings or null; null returned above and callers omit undefined fields.
        return [field, instant(value as string)];
      }
      return [field, value];
    })
  );
}

type SessionRead = Header | SetSnapshot;
function snapshot(result: { results: SessionRead[] }[]): SessionSnapshot {
  // The paired readback statements select the header first, then sets.
  return {
    // SAFETY: the first paired SELECT contains the session header columns.
    headers: result[0].results as Header[],
    // SAFETY: the second paired SELECT contains joined set snapshot columns.
    sets: result[1].results as SetSnapshot[],
  };
}
function readStatements(db: Client, id: number) {
  return [
    statement(db, `SELECT ${headerColumns} FROM sessions WHERE id = ?`, id),
    statement(
      db,
      `SELECT ${setColumns} FROM sets t JOIN exercises e ON e.id = t.exercise_id
      WHERE t.session_id = ? ORDER BY t.position`,
      id
    ),
  ];
}

const ACTUAL_FIELDS = [
  "weight_kg",
  "reps",
  "distance_m",
  "duration_s",
  "effort",
  "performed_at",
  "notes",
] as const;
export function sessionsRepository(db: Client) {
  async function read(id: number) {
    return snapshot(await batch<SessionRead>(db, readStatements(db, id)));
  }
  async function findRequest(uuid: string) {
    try {
      return await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.request_id, uuid));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function owner(setId: number) {
    try {
      return await db
        .select({ session_id: sets.session_id })
        .from(sets)
        .where(eq(sets.id, setId));
    } catch (error) {
      throw classifyDatabaseFailure(error);
    }
  }
  async function list(limit: number, id: number | null) {
    const found = await rows<SessionHeaderRow>(
      db,
      `SELECT id, date, rationale, notes, overall_feel, started_at, completed_at
      FROM sessions s WHERE (? IS NULL OR EXISTS (SELECT 1 FROM sets t WHERE t.session_id = s.id AND t.mesocycle_id = ?))
      ORDER BY date DESC, id DESC LIMIT ?`,
      id,
      id,
      limit
    );
    return found;
  }
  async function create(input: {
    date: string;
    rationale: string;
    request_id: string;
    sets: WriteFields[];
  }) {
    const uuid = input.request_id;
    const entries = input.sets.map(stored);
    const result = await batch<SessionRead>(db, [
      statement(db, "INSERT INTO api_write_assertions (id) VALUES (1)"),
      statement(
        db,
        "INSERT INTO sessions (date, rationale, request_id) VALUES (?, ?, ?)",
        input.date,
        input.rationale,
        uuid
      ),
      affectedRows(db, 1),
      ...jsonChunks(entries).flatMap((chunk) => [
        statement(
          db,
          `INSERT INTO sets (session_id, position, ${insertSetFields.join(
            ", "
          )})
          SELECT s.id, CAST(v.key AS INTEGER) + ?, ${insertSetFields
            .map((field) => `json_extract(v.value, '$.${field}')`)
            .join(", ")}
          FROM json_each(?) v CROSS JOIN sessions s
          JOIN exercises e ON e.id = json_extract(v.value, '$.exercise_id')
            AND e.measure = json_extract(v.value, '$.expected_measure')
            AND e.stimulus_type = json_extract(v.value, '$.expected_stimulus_type')
          WHERE s.request_id = ?`,
          chunk.offset + 1,
          chunk.json,
          uuid
        ),
        affectedRows(db, chunk.count),
      ]),
      statement(
        db,
        `SELECT ${headerColumns} FROM sessions WHERE request_id = ?`,
        uuid
      ),
      statement(
        db,
        `SELECT ${setColumns} FROM sets t JOIN exercises e ON e.id = t.exercise_id
        JOIN sessions s ON s.id = t.session_id WHERE s.request_id = ? ORDER BY t.position`,
        uuid
      ),
      finishWrite(db),
    ]);
    return snapshot(result.slice(-3, -1));
  }
  async function append(
    id: number,
    version: number,
    uuid: string,
    fieldsToWrite: WriteFields
  ) {
    const set = stored(fieldsToWrite);
    const fields = insertSetFields.filter(
      (field) => !field.startsWith("target_")
    );
    const result = await batch<SetSnapshot>(db, [
      sessionVersion(db, id, version),
      statement(
        db,
        `INSERT INTO sets (session_id, position, request_id, ${fields.join(
          ", "
        )})
          SELECT ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM sets WHERE session_id = ?), ?,
            ${fields
              .map((field) => `json_extract(v.fields, '$.${field}')`)
              .join(", ")}
          FROM (SELECT ? AS fields) v
          JOIN exercises e ON e.id = json_extract(v.fields, '$.exercise_id')
            AND e.measure = json_extract(v.fields, '$.expected_measure')
            AND e.stimulus_type = json_extract(v.fields, '$.expected_stimulus_type')`,
        id,
        id,
        uuid,
        JSON.stringify(set)
      ),
      affectedRows(db, 1),
      statement(
        db,
        `SELECT ${setColumns} FROM sets t JOIN exercises e ON e.id = t.exercise_id
          WHERE t.session_id = ? AND t.request_id = ?`,
        id,
        uuid
      ),
      finishWrite(db),
    ]);
    return result[3].results;
  }
  async function correct(
    id: number,
    version: number,
    header: WriteFields,
    corrections: { id: number; fields: WriteFields }[]
  ) {
    const facts = stored(header);
    const changes = corrections.map((entry) => ({
      id: entry.id,
      fields: stored(entry.fields),
    }));
    const result = await batch<SessionRead>(db, [
      sessionVersion(db, id, version),
      ...jsonChunks(changes).flatMap((chunk) => [
        statement(
          db,
          `UPDATE sets AS t SET ${ACTUAL_FIELDS.map(
            (field) =>
              `${field} = CASE
            WHEN json_type(v.value, '$.fields.${field}') IS NOT NULL THEN json_extract(v.value, '$.fields.${field}') ELSE t.${field} END`
          ).join(", ")}
            FROM json_each(?) v WHERE t.id = json_extract(v.value, '$.id') AND t.session_id = ?`,
          chunk.json,
          id
        ),
        affectedRows(db, chunk.count),
      ]),
      statement(
        db,
        `UPDATE sessions SET ${sessionFields
          .map(
            (field) =>
              `${field} = CASE
          WHEN json_type(v.fields, '$.${field}') IS NOT NULL THEN json_extract(v.fields, '$.${field}') ELSE sessions.${field} END`
          )
          .join(", ")}
          FROM (SELECT ? AS fields) v WHERE sessions.id = ?`,
        JSON.stringify(facts),
        id
      ),
      affectedRows(db, 1),
      ...readStatements(db, id),
      finishWrite(db),
    ]);
    return snapshot(result.slice(-3, -1));
  }
  async function discard(id: number, version: number, total: number) {
    await batch(db, [
      sessionVersion(db, id, version),
      statement(db, "DELETE FROM sets WHERE session_id = ?", id),
      affectedRows(db, total),
      statement(db, "DELETE FROM sessions WHERE id = ?", id),
      affectedRows(db, 1),
      finishWrite(db),
    ]);
  }
  return { read, findRequest, owner, list, create, append, correct, discard };
}
export type SessionsRepository = ReturnType<typeof sessionsRepository>;
