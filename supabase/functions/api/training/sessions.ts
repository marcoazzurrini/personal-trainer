// A session is what happened in a room on a day. It is written in one of two
// shapes — upcoming, carrying targets, or retro-logged, carrying actuals —
// and never both on one set, because a target written after the work would
// always match what was done.
//
// Set rows are created with the session. Logging fills them in rather than
// inserting, which is why targets are immutable afterwards: they are the
// record of what was asked that day.

import { sql } from "../db.ts";
import { ApiError, requireRow } from "../http/errors.ts";
import { writeOnce } from "../record/idempotency.ts";
import {
  resolveExercise,
  resolveMesocycle,
  resolveSetMesocycleId,
} from "./resolve.ts";
import {
  assertEffort,
  assertSetMeasures,
  type Effort,
  type Kind,
} from "./rules.ts";

export interface SessionHeaderRow {
  id: number;
  date: string;
  rationale: string | null;
  notes: string | null;
  overall_feel: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface SessionSetRow {
  id: number;
  exercise: string;
  exercise_id: number;
  measure: string;
  mesocycle_id: number | null;
  position: number;
  kind: Kind;
  target_weight_kg: number | null;
  target_reps: number | null;
  target_distance_m: number | null;
  target_duration_s: number | null;
  weight_kg: number | null;
  reps: number | null;
  distance_m: number | null;
  duration_s: number | null;
  effort: Effort | null;
  performed_at: string | null;
  notes: string | null;
}

export interface SessionDetailRow extends SessionHeaderRow {
  sets: SessionSetRow[];
}

/** The row POST /sessions/{id}/sets answers with: no targets to show. */
export type AppendedSetRow =
  & Omit<
    SessionSetRow,
    | "exercise"
    | "measure"
    | "target_weight_kg"
    | "target_reps"
    | "target_distance_m"
    | "target_duration_s"
  >
  & { session_id: number };

/** An exercise or mesocycle by id, name, or alias — the resolver decides. */
type Reference = string | number;

export interface SetEntry {
  exercise?: Reference;
  kind: Kind;
  mesocycle?: Reference;
  target_weight_kg?: number | null;
  target_reps?: number | null;
  target_distance_m?: number | null;
  target_duration_s?: number | null;
  weight_kg?: number | null;
  reps?: number | null;
  distance_m?: number | null;
  duration_s?: number | null;
  effort?: Effort | null;
  performed_at?: string | null;
  notes?: string | null;
}

function appendedSetColumns() {
  return sql`id, session_id, exercise_id, mesocycle_id, position, kind,
    weight_kg::float8, reps, distance_m::float8, duration_s::float8,
    effort, performed_at, notes`;
}

export async function sessionDetail(id: number): Promise<SessionDetailRow> {
  const session = requireRow(
    await sql<SessionHeaderRow[]>`
    select id, date, rationale, notes,
      overall_feel, started_at, completed_at
    from sessions where id = ${id}`,
    `No session with id ${id}.`,
  );
  // Each set says which plan it serves; the session says nothing, because a
  // session that sprints and then squats serves two.
  const sets = await sql<SessionSetRow[]>`
    select t.id, e.name as exercise, t.exercise_id, e.measure, t.mesocycle_id,
      t.position, t.kind,
      t.target_weight_kg::float8, t.target_reps,
      t.target_distance_m::float8, t.target_duration_s::float8,
      t.weight_kg::float8, t.reps,
      t.distance_m::float8, t.duration_s::float8,
      t.effort, t.performed_at, t.notes
    from sets t join exercises e on e.id = t.exercise_id
    where t.session_id = ${id}
    order by t.position`;
  return { ...session, sets };
}

/** Session headers, newest first. Sets are not included. */
export async function listSessions(
  limit: number,
  mesocycle?: string,
): Promise<SessionHeaderRow[]> {
  const mesoId = mesocycle ? (await resolveMesocycle(mesocycle)).id : null;
  // Filtering by plan asks which sessions contained work for it, because a
  // session is no longer owned by one.
  return await sql<SessionHeaderRow[]>`
    select id, date, rationale, notes,
      overall_feel, started_at, completed_at
    from sessions s
    ${
    mesoId === null ? sql`` : sql`where exists (
        select 1 from sets t
        where t.session_id = s.id and t.mesocycle_id = ${mesoId})`
  }
    order by date desc, id desc
    limit ${limit}`;
}

interface NewSet {
  exerciseId: number;
  mesocycleId: number | null;
  kind: string;
  targetWeightKg: number | null;
  targetReps: number | null;
  targetDistanceM: number | null;
  targetDurationS: number | null;
  weightKg: number | null;
  reps: number | null;
  distanceM: number | null;
  durationS: number | null;
  effort: string | null;
  performedAt: string | null;
  notes: string | null;
}

// One set entry of POST /sessions. Targets only (upcoming) or actuals only
// (retro) — a target written after the work would always match what was done.
async function parseNewSet(s: SetEntry): Promise<NewSet> {
  const exercise = await resolveExercise(s.exercise);
  const kind = s.kind;

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
  // What a set of this exercise must carry is the exercise's business, so
  // both sides are checked against its measure rather than against a rule
  // that assumes every set is a weight and a rep count.
  assertSetMeasures(exercise.measure, exercise.name, "target", target);
  assertSetMeasures(exercise.measure, exercise.name, "actual", actual);

  const performed = actual.reps !== null || actual.distanceM !== null ||
    actual.durationS !== null;
  const asked = target.reps !== null || target.distanceM !== null ||
    target.durationS !== null;
  if (asked && performed) {
    throw new ApiError(
      422,
      "A new set carries targets (upcoming session) or actuals (retro-logged), never both: targets written after the fact would always match what was done.",
    );
  }
  const effort = s.effort ?? null;
  assertEffort(
    exercise.stimulus_type,
    exercise.name,
    kind,
    actual.reps,
    effort,
  );
  return {
    exerciseId: exercise.id,
    mesocycleId: await resolveSetMesocycleId(exercise.id, s.mesocycle),
    kind,
    targetWeightKg: target.weightKg,
    targetReps: target.reps,
    targetDistanceM: target.distanceM,
    targetDurationS: target.durationS,
    weightKg: actual.weightKg,
    reps: actual.reps,
    distanceM: actual.distanceM,
    durationS: actual.durationS,
    effort,
    performedAt: s.performed_at ?? null,
    notes: s.notes ?? null,
  };
}

export async function writeSession(b: {
  date: string;
  rationale: string;
  sets: SetEntry[];
  request_id: string;
}): Promise<{ session: SessionDetailRow; created: boolean }> {
  const { body: session, status } = await writeOnce<
    { id: number },
    SessionDetailRow,
    SessionDetailRow
  >({
    table: "sessions",
    requestId: b.request_id,
    select: sql`id`,
    replay: (seen) => sessionDetail(seen.id),
    write: async () => {
      const sets: NewSet[] = [];
      for (const entry of b.sets) sets.push(await parseNewSet(entry));

      const id = await sql.begin(async (tx) => {
        const [session] = await tx`
      insert into sessions (date, rationale, request_id)
      values (${b.date}, ${b.rationale}, ${b.request_id})
      returning id`;
        let position = 1;
        for (const s of sets) {
          await tx`
        insert into sets
          (session_id, exercise_id, mesocycle_id, position, kind,
           target_weight_kg, target_reps, target_distance_m,
           target_duration_s, weight_kg, reps, distance_m, duration_s,
           effort, performed_at, notes)
        values
          (${session.id}, ${s.exerciseId}, ${s.mesocycleId}, ${position++},
           ${s.kind}, ${s.targetWeightKg}, ${s.targetReps},
           ${s.targetDistanceM}, ${s.targetDurationS}, ${s.weightKg},
           ${s.reps}, ${s.distanceM}, ${s.durationS},
           ${s.effort}, ${s.performedAt}, ${s.notes})`;
        }
        return session.id as number;
      });

      return await sessionDetail(id);
    },
  });
  return { session, created: status === 201 };
}

/**
 * Appends an unplanned set: the extra set, or the exercise swapped in on the
 * day, reported afterwards. It records what was done, so it carries actuals
 * and never targets.
 */
export async function appendSet(
  sessionId: number,
  b: SetEntry & { request_id: string },
): Promise<{ set: AppendedSetRow; created: boolean }> {
  requireRow(
    await sql`select id from sessions where id = ${sessionId}`,
    `No session with id ${sessionId}.`,
  );

  // Appends at max(position)+1, so there is no natural key to collide on:
  // without the id a lost response becomes a duplicate set.
  const { body: set, status } = await writeOnce<
    AppendedSetRow,
    AppendedSetRow,
    AppendedSetRow
  >({
    table: "sets",
    requestId: b.request_id,
    select: appendedSetColumns(),
    replay: (duplicate) => duplicate,
    write: async () => {
      const s = await parseNewSet(b);
      if (
        s.targetReps !== null || s.targetDistanceM !== null ||
        s.targetDurationS !== null
      ) {
        throw new ApiError(
          422,
          "An unplanned set records what was done: send actuals, not targets.",
        );
      }
      if (s.reps === null && s.distanceM === null && s.durationS === null) {
        throw new ApiError(
          422,
          "An unplanned set records what was done, so it needs a measurement: reps, distance_m, or duration_s, depending on how the exercise is measured.",
        );
      }
      const [row] = await sql<AppendedSetRow[]>`
    insert into sets
      (session_id, exercise_id, mesocycle_id, position, kind, weight_kg, reps,
       distance_m, duration_s, effort, performed_at, notes, request_id)
    values
      (${sessionId}, ${s.exerciseId}, ${s.mesocycleId},
       (select coalesce(max(position), 0) + 1 from sets where session_id = ${sessionId}),
       ${s.kind}, ${s.weightKg}, ${s.reps}, ${s.distanceM}, ${s.durationS},
       ${s.effort}, ${s.performedAt ?? new Date().toISOString()}, ${s.notes},
       ${b.request_id})
    returning ${appendedSetColumns()}`;
      return row;
    },
  });
  return { set, created: status === 201 };
}

/**
 * Session-level facts: notes, how it felt, marking complete. Finishing a
 * workout is completed_at changing, not a separate action.
 */
export async function correctSession(sessionId: number, b: {
  started_at?: string | null;
  completed_at?: string | null;
  overall_feel?: string | null;
  notes?: string | null;
  rationale?: string;
}): Promise<SessionDetailRow> {
  requireRow(
    await sql`select id from sessions where id = ${sessionId}`,
    `No session with id ${sessionId}.`,
  );

  const fields: Record<string, unknown> = {};
  for (
    const f of [
      "notes",
      "overall_feel",
      "rationale",
      "started_at",
      "completed_at",
    ] as const
  ) {
    if (b[f] !== undefined) fields[f] = b[f];
  }
  if (Object.keys(fields).length === 0) {
    throw new ApiError(
      422,
      'Send at least one of "notes", "overall_feel", "rationale", "started_at", "completed_at".',
    );
  }
  await sql`update sessions set ${sql(fields)} where id = ${sessionId}`;
  return await sessionDetail(sessionId);
}

/**
 * Discards an untouched draft.
 *
 * A planned session nobody has touched is a proposal, not history. Iterating
 * on a plan means discarding the draft and writing a better one — without
 * this, the only path was superseding, which litters the record with dead
 * rows precisely because someone was careful about the plan. The moment any
 * set carries an actual, or the session was started or finished, it happened:
 * from then on it is history, and history is corrected, never deleted.
 */
export async function discardSession(
  sessionId: number,
): Promise<{ id: number; date: string; sets: number }> {
  const session = requireRow(
    await sql`
    select id, date, started_at, completed_at
    from sessions where id = ${sessionId}`,
    `No session with id ${sessionId}.`,
  );

  const [{ total, performed }] = await sql`
    select count(*)::int as total,
      count(*) filter (where
        weight_kg is not null or reps is not null or distance_m is not null
        or duration_s is not null or effort is not null
        or performed_at is not null)::int as performed
    from sets where session_id = ${sessionId}`;

  if (
    performed > 0 || session.started_at !== null ||
    session.completed_at !== null
  ) {
    const why = performed > 0
      ? `${performed} of its ${total} sets carry actuals`
      : "it was started or finished";
    throw new ApiError(
      409,
      `This session is on the record — ${why} — so it cannot be deleted. A wrong actual is corrected with PATCH /sets/:id, session-level facts with PATCH /sessions/:id. Only a planned session nothing has touched can be discarded.`,
    );
  }

  await sql.begin(async (tx) => {
    await tx`delete from sets where session_id = ${sessionId}`;
    await tx`delete from sessions where id = ${sessionId}`;
  });
  return {
    id: session.id as number,
    date: session.date as string,
    sets: total as number,
  };
}
