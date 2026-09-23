// Session persistence uses atomic D1 batches with optimistic version checks.
import {
  batch,
  type Clock,
  type Database,
  date,
  decimal,
  instant,
  jsonChunks,
  requestId,
  type Result,
  rows,
  statement,
  systemClock,
  wireInstant,
} from "../shared/d1.ts";
import { ApiError, requireRow } from "../shared/errors.ts";
import {
  ACTUAL_FIELDS,
  type CorrectSetInput,
  prepareSetCorrection,
} from "./set_correction.ts";
import { assertEffort, assertSetMeasures } from "./rules.ts";
import { type SetResolver, trainingResolver } from "./resolve.ts";
import {
  affectedRows,
  finishWrite,
  retrySessionWrite,
  sessionVersion,
} from "./session_write.ts";
import type {
  AppendedSetRow,
  CorrectSessionInput,
  SessionDetailRow,
  SessionHeaderRow,
  SessionSetRow,
  SetEntry,
  WriteSessionInput,
} from "./sessions.types.ts";
import type { SetRow } from "./sets.types.ts";

type Header = SessionHeaderRow & { write_version: number };
type SetSnapshot = SessionSetRow & {
  session_id: number;
  stimulus_type: string;
  request_id: string | null;
};
interface Snapshot {
  header: Header;
  sets: SetSnapshot[];
}

const headerColumns =
  "id, date, rationale, notes, overall_feel, started_at, completed_at, write_version";
const setColumns =
  `t.id, t.session_id, e.name AS exercise, t.exercise_id, e.measure, e.stimulus_type,
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
const scales: Record<string, [number, number]> = {
  weight_kg: [6, 2],
  target_weight_kg: [6, 2],
  distance_m: [7, 1],
  target_distance_m: [7, 1],
  duration_s: [8, 2],
  target_duration_s: [8, 2],
};
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

function stored(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([field, value]) => {
      if (value === null) return [field, null];
      if (scales[field]) {
        return [field, decimal(value as number, ...scales[field])];
      }
      if (
        field === "performed_at" || field === "started_at" ||
        field === "completed_at"
      ) {
        return [field, instant(value as string)];
      }
      return [field, value];
    }),
  );
}

function snapshot(result: Result<unknown>[], id: number): Snapshot {
  return {
    header: requireRow(
      result[0].results as Header[],
      `No session with id ${id}.`,
    ),
    sets: result[1].results as SetSnapshot[],
  };
}
function detail(current: Snapshot): SessionDetailRow {
  const { write_version: _version, ...header } = current.header;
  return {
    ...header,
    started_at: wireInstant(header.started_at),
    completed_at: wireInstant(header.completed_at),
    sets: current.sets.map((set) => {
      const {
        session_id: _session,
        stimulus_type: _stimulus,
        request_id: _request,
        ...publicSet
      } = set;
      return {
        ...publicSet,
        performed_at: wireInstant(publicSet.performed_at),
      };
    }),
  };
}
function appended(set: SetSnapshot): AppendedSetRow {
  const {
    exercise: _exercise,
    measure: _measure,
    stimulus_type: _stimulus,
    request_id: _request,
    target_weight_kg: _weight,
    target_reps: _reps,
    target_distance_m: _distance,
    target_duration_s: _duration,
    ...publicSet
  } = set;
  return { ...publicSet, performed_at: wireInstant(publicSet.performed_at) };
}
function readStatements(db: Database, id: number) {
  return [
    statement(db, `SELECT ${headerColumns} FROM sessions WHERE id = ?`, id),
    statement(
      db,
      `SELECT ${setColumns} FROM sets t JOIN exercises e ON e.id = t.exercise_id
      WHERE t.session_id = ? ORDER BY t.position`,
      id,
    ),
  ];
}

export function sessionStore(db: Database, clock: Clock = systemClock) {
  const resolver = trainingResolver(db);
  async function read(id: number): Promise<Snapshot> {
    return snapshot(await db.batch<unknown>(readStatements(db, id)), id);
  }
  async function sessionDetail(id: number): Promise<SessionDetailRow> {
    return detail(await read(id));
  }
  async function listSessions(
    limit: number,
    mesocycle?: string,
  ): Promise<SessionHeaderRow[]> {
    const id = mesocycle
      ? (await resolver.resolveMesocycle(mesocycle)).id
      : null;
    const found = await rows<SessionHeaderRow>(
      db,
      `SELECT id, date, rationale, notes, overall_feel, started_at, completed_at
      FROM sessions s WHERE (? IS NULL OR EXISTS (SELECT 1 FROM sets t WHERE t.session_id = s.id AND t.mesocycle_id = ?))
      ORDER BY date DESC, id DESC LIMIT ?`,
      id,
      id,
      limit,
    );
    return found.map((row) => ({
      ...row,
      started_at: wireInstant(row.started_at),
      completed_at: wireInstant(row.completed_at),
    }));
  }

  // Resolution caches belong to one write attempt, never a request-global cache.
  function parser(references: SetResolver = resolver) {
    const exercises = new Map<
      SetEntry["exercise"],
      Awaited<ReturnType<typeof resolver.resolveExercise>>
    >();
    const plans = new Map<number, Map<SetEntry["mesocycle"], number | null>>();
    return async (s: SetEntry) => {
      let exercise = exercises.get(s.exercise);
      if (exercise === undefined) {
        exercise = await references.resolveExercise(s.exercise);
        exercises.set(s.exercise, exercise);
      }
      const target = {
        weightKg: s.target_weight_kg ?? null,
        reps: s.target_reps ?? null,
        distanceM: s.target_distance_m ?? null,
        durationS: s.target_duration_s ?? null,
      };
      const actual = {
        weightKg: s.weight_kg ?? null,
        reps: s.reps ?? null,
        distanceM: s.distance_m ?? null,
        durationS: s.duration_s ?? null,
      };
      assertSetMeasures(exercise.measure, exercise.name, "target", target);
      assertSetMeasures(exercise.measure, exercise.name, "actual", actual);
      const asked = target.reps !== null || target.distanceM !== null ||
        target.durationS !== null;
      const performed = actual.reps !== null || actual.distanceM !== null ||
        actual.durationS !== null;
      if (asked && performed) {
        throw new ApiError(
          422,
          "A new set carries targets (upcoming session) or actuals (retro-logged), never both: targets written after the fact would always match what was done.",
        );
      }
      assertEffort(
        exercise.stimulus_type,
        exercise.name,
        s.kind,
        actual.reps,
        s.effort ?? null,
      );
      let forExercise = plans.get(exercise.id);
      if (!forExercise) {
        forExercise = new Map();
        plans.set(exercise.id, forExercise);
      }
      let mesocycleId = forExercise.get(s.mesocycle);
      if (mesocycleId === undefined) {
        mesocycleId = await references.resolveSetMesocycleId(
          exercise.id,
          s.mesocycle,
        );
        forExercise.set(s.mesocycle, mesocycleId);
      }
      return stored({
        exercise_id: exercise.id,
        // Recheck the identity used for validation inside the write batch.
        // A registry edit must not race the first set logged for an exercise.
        expected_measure: exercise.measure,
        expected_stimulus_type: exercise.stimulus_type,
        mesocycle_id: mesocycleId,
        kind: s.kind,
        target_weight_kg: target.weightKg,
        target_reps: target.reps,
        target_distance_m: target.distanceM,
        target_duration_s: target.durationS,
        weight_kg: actual.weightKg,
        reps: actual.reps,
        distance_m: actual.distanceM,
        duration_s: actual.durationS,
        effort: s.effort ?? null,
        performed_at: s.performed_at ?? null,
        notes: s.notes ?? null,
      });
    };
  }

  async function writeSession(
    b: WriteSessionInput,
  ): Promise<{ session: SessionDetailRow; created: boolean }> {
    const uuid = requestId(b.request_id);
    const [seen] = await rows<{ id: number }>(
      db,
      "SELECT id FROM sessions WHERE request_id = ?",
      uuid,
    );
    if (seen) return { session: await sessionDetail(seen.id), created: false };
    const parse = parser(await resolver.forSets(b.sets));
    const sets = [];
    for (const input of b.sets) sets.push(await parse(input));
    // Parent lookup uses the unique request id, not last_insert_rowid(), which
    // is fragile in multi-statement batches containing trigger writes.
    const result = await batch(db, [
      statement(db, "INSERT INTO api_write_assertions (id) VALUES (1)"),
      statement(
        db,
        "INSERT INTO sessions (date, rationale, request_id) VALUES (?, ?, ?)",
        date(b.date),
        b.rationale,
        uuid,
      ),
      affectedRows(db, 1),
      ...jsonChunks(sets).flatMap((chunk) => [
        statement(
          db,
          `INSERT INTO sets (session_id, position, ${
            insertSetFields.join(", ")
          })
          SELECT s.id, CAST(v.key AS INTEGER) + ?, ${
            insertSetFields.map((field) =>
              `json_extract(v.value, '$.${field}')`
            ).join(", ")
          }
          FROM json_each(?) v CROSS JOIN sessions s
          JOIN exercises e ON e.id = json_extract(v.value, '$.exercise_id')
            AND e.measure = json_extract(v.value, '$.expected_measure')
            AND e.stimulus_type = json_extract(v.value, '$.expected_stimulus_type')
          WHERE s.request_id = ?`,
          chunk.offset + 1,
          chunk.json,
          uuid,
        ),
        affectedRows(db, chunk.count),
      ]),
      statement(
        db,
        `SELECT ${headerColumns} FROM sessions WHERE request_id = ?`,
        uuid,
      ),
      statement(
        db,
        `SELECT ${setColumns} FROM sets t JOIN exercises e ON e.id = t.exercise_id
        JOIN sessions s ON s.id = t.session_id WHERE s.request_id = ? ORDER BY t.position`,
        uuid,
      ),
      finishWrite(db),
    ]);
    return {
      session: detail(snapshot(result.slice(-3, -1), 0)),
      created: true,
    };
  }

  async function appendSet(
    id: number,
    b: SetEntry & { request_id: string },
  ): Promise<{ set: AppendedSetRow; created: boolean }> {
    const uuid = requestId(b.request_id);
    return await retrySessionWrite(id, async () => {
      const current = await read(id);
      const seen = current.sets.find((set) => set.request_id === uuid);
      if (seen) return { set: appended(seen), created: false };
      const set = await parser()(b);
      if (
        set.target_reps !== null || set.target_distance_m !== null ||
        set.target_duration_s !== null
      ) {
        throw new ApiError(
          422,
          "An unplanned set records what was done: send actuals, not targets.",
        );
      }
      if (
        set.reps === null && set.distance_m === null && set.duration_s === null
      ) {
        throw new ApiError(
          422,
          "An unplanned set records what was done, so it needs a measurement: reps, distance_m, or duration_s, depending on how the exercise is measured.",
        );
      }
      set.performed_at ??= instant(clock().toISOString());
      const fields = insertSetFields.filter((field) =>
        !field.startsWith("target_")
      );
      const result = await db.batch<unknown>([
        sessionVersion(db, id, current.header.write_version),
        statement(
          db,
          `INSERT INTO sets (session_id, position, request_id, ${
            fields.join(", ")
          })
          SELECT ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM sets WHERE session_id = ?), ?,
            ${
            fields.map((field) => `json_extract(v.fields, '$.${field}')`).join(
              ", ",
            )
          }
          FROM (SELECT ? AS fields) v
          JOIN exercises e ON e.id = json_extract(v.fields, '$.exercise_id')
            AND e.measure = json_extract(v.fields, '$.expected_measure')
            AND e.stimulus_type = json_extract(v.fields, '$.expected_stimulus_type')`,
          id,
          id,
          uuid,
          JSON.stringify(set),
        ),
        affectedRows(db, 1),
        statement(
          db,
          `SELECT ${setColumns} FROM sets t JOIN exercises e ON e.id = t.exercise_id
          WHERE t.session_id = ? AND t.request_id = ?`,
          id,
          uuid,
        ),
        finishWrite(db),
      ]);
      return {
        set: appended(
          requireRow(
            result[3].results as SetSnapshot[],
            "The appended set could not be read.",
          ),
        ),
        created: true,
      };
    });
  }

  async function correctSession(
    id: number,
    b: CorrectSessionInput,
  ): Promise<SessionDetailRow> {
    return await retrySessionWrite(id, async () => {
      const current = await read(id);
      const facts = stored(
        Object.fromEntries(
          sessionFields.filter((field) => b[field] !== undefined).map((
            field,
          ) => [field, b[field]]),
        ),
      );
      if (Object.keys(facts).length === 0 && b.sets === undefined) {
        throw new ApiError(
          422,
          'Send at least one of "notes", "overall_feel", "rationale", "started_at", "completed_at", or a non-empty "sets" array of corrections with set ids.',
        );
      }
      if (b.sets !== undefined && b.sets.length === 0) {
        throw new ApiError(
          422,
          '"sets" must be a non-empty array of corrections with set ids. Omit it when changing only session facts.',
        );
      }
      if (new Set(b.sets?.map((s) => s.id)).size !== (b.sets?.length ?? 0)) {
        throw new ApiError(
          422,
          'Each set id may appear only once in "sets". Combine corrections for the same set into one entry. Nothing was written.',
        );
      }
      const byId = new Map(current.sets.map((set) => [set.id, set]));
      const stamp = instant(clock().toISOString());
      const changes = (b.sets ?? []).map((entry) => {
        const was = byId.get(entry.id);
        if (!was) {
          throw new ApiError(
            404,
            `No set with id ${entry.id} in session ${id}. Read GET /sessions/${id} for its set ids. Nothing was written.`,
          );
        }
        return {
          id: entry.id,
          fields: stored(prepareSetCorrection(was, entry, stamp)),
        };
      });
      const result = await db.batch<unknown>([
        sessionVersion(db, id, current.header.write_version),
        ...jsonChunks(changes).flatMap((chunk) => [
          statement(
            db,
            `UPDATE sets AS t SET ${
              ACTUAL_FIELDS.map((field) =>
                `${field} = CASE
            WHEN json_type(v.value, '$.fields.${field}') IS NOT NULL THEN json_extract(v.value, '$.fields.${field}') ELSE t.${field} END`
              ).join(", ")
            }
            FROM json_each(?) v WHERE t.id = json_extract(v.value, '$.id') AND t.session_id = ?`,
            chunk.json,
            id,
          ),
          affectedRows(db, chunk.count),
        ]),
        statement(
          db,
          `UPDATE sessions SET ${
            sessionFields.map((field) =>
              `${field} = CASE
          WHEN json_type(v.fields, '$.${field}') IS NOT NULL THEN json_extract(v.fields, '$.${field}') ELSE sessions.${field} END`
            ).join(", ")
          }
          FROM (SELECT ? AS fields) v WHERE sessions.id = ?`,
          JSON.stringify(facts),
          id,
        ),
        affectedRows(db, 1),
        ...readStatements(db, id),
        finishWrite(db),
      ]);
      return detail(snapshot(result.slice(-3, -1), id));
    });
  }

  async function correctSet(
    setId: number,
    input: CorrectSetInput,
  ): Promise<SetRow> {
    const owner = requireRow(
      await rows<{ session_id: number }>(
        db,
        "SELECT session_id FROM sets WHERE id = ?",
        setId,
      ),
      `No set with id ${setId}.`,
    );
    try {
      const session = await correctSession(owner.session_id, {
        sets: [{ ...input, id: setId }],
      });
      const set = requireRow(
        session.sets.filter((s) => s.id === setId),
        `No set with id ${setId}.`,
      );
      const { exercise: _exercise, measure: _measure, ...fields } = set;
      return { ...fields, session_id: owner.session_id };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new ApiError(404, `No set with id ${setId}.`);
      }
      throw error;
    }
  }

  async function discardSession(
    id: number,
  ): Promise<{ id: number; date: string; sets: number }> {
    return await retrySessionWrite(id, async () => {
      const current = await read(id);
      const total = current.sets.length;
      const performed = current.sets.filter((s) =>
        [
          s.weight_kg,
          s.reps,
          s.distance_m,
          s.duration_s,
          s.effort,
          s.performed_at,
        ].some((v) => v !== null)
      ).length;
      if (
        performed > 0 || current.header.started_at !== null ||
        current.header.completed_at !== null
      ) {
        const why = performed > 0
          ? `${performed} of its ${total} sets carry actuals`
          : "it was started or finished";
        throw new ApiError(
          409,
          `This session is on the record — ${why} — so it cannot be deleted. A wrong actual is corrected with PATCH /sets/:id, session-level facts with PATCH /sessions/:id. Only a planned session nothing has touched can be discarded.`,
        );
      }
      await db.batch([
        sessionVersion(db, id, current.header.write_version),
        statement(db, "DELETE FROM sets WHERE session_id = ?", id),
        affectedRows(db, total),
        statement(db, "DELETE FROM sessions WHERE id = ?", id),
        affectedRows(db, 1),
        finishWrite(db),
      ]);
      return { id, date: current.header.date, sets: total };
    });
  }

  return {
    sessionDetail,
    listSessions,
    writeSession,
    appendSet,
    correctSession,
    correctSet,
    discardSession,
  };
}
