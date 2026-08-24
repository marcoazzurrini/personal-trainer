import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import {
  resolveExercise,
  resolveMesocycle,
  resolveSetMesocycleId,
} from "../lib/resolve.ts";
import { assertEffort, assertSetMeasures } from "../lib/training.ts";
import {
  assertKnownFields,
  type Body,
  optionalInt,
  optionalNumber,
  optionalString,
  optionalTimestamp,
  readJson,
  requireDate,
  requireIdParam,
  requireOneOf,
  requireString,
  requireUuid,
} from "../lib/validate.ts";

const KINDS = ["warmup", "working"] as const;
const EFFORTS = ["easy", "hard", "failure"] as const;

function newPublicId(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function sessionDetail(id: number) {
  const [session] = await sql`
    select id, public_id, date, rationale, notes,
      overall_feel, started_at, completed_at
    from sessions where id = ${id}`;
  if (!session) throw new ApiError(404, `No session with id ${id}.`);
  // Each set says which plan it serves; the session says nothing, because a
  // session that sprints and then squats serves two.
  const sets = await sql`
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

// What a set entry may carry. Named here rather than inferred, because a
// nested object is where a guessed field is most likely to go unnoticed:
// "target_rpe" on one set of fifteen answers 201 and is simply not there.
const SET_ENTRY_FIELDS = [
  "exercise",
  "kind",
  "mesocycle",
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

// One set entry of POST /sessions. Targets only (upcoming) or actuals only
// (retro) — a target written after the work would always match what was done.
async function parseNewSet(entry: unknown): Promise<NewSet> {
  if (typeof entry === "object" && entry === null) {
    throw new ApiError(422, 'Each entry in "sets" must be an object.');
  }
  const s = entry as Body;
  assertKnownFields(s, SET_ENTRY_FIELDS, 'an entry in "sets"');
  const exercise = await resolveExercise(s.exercise);
  const kind = requireOneOf(s, "kind", KINDS, "working");

  const target = {
    weightKg: optionalNumber(s, "target_weight_kg", { min: 0 }),
    reps: optionalInt(s, "target_reps", { min: 1 }),
    distanceM: optionalNumber(s, "target_distance_m", { min: 0 }),
    durationS: optionalNumber(s, "target_duration_s", { min: 0 }),
  };
  const actual = {
    weightKg: optionalNumber(s, "weight_kg", { min: 0 }),
    reps: optionalInt(s, "reps", { min: 1 }),
    distanceM: optionalNumber(s, "distance_m", { min: 0 }),
    durationS: optionalNumber(s, "duration_s", { min: 0 }),
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
  const effort = s.effort === undefined || s.effort === null
    ? null
    : requireOneOf(s, "effort", EFFORTS);
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
    performedAt: optionalTimestamp(s, "performed_at"),
    notes: optionalString(s, "notes"),
  };
}

export const sessions = new Hono();

sessions.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
  const mesoParam = c.req.query("mesocycle");
  const mesoId = mesoParam ? (await resolveMesocycle(mesoParam)).id : null;
  // Filtering by plan asks which sessions contained work for it, because a
  // session is no longer owned by one.
  const rows = await sql`
    select id, public_id, date, rationale, notes,
      overall_feel, started_at, completed_at
    from sessions s
    ${
    mesoId === null ? sql`` : sql`where exists (
        select 1 from sets t
        where t.session_id = s.id and t.mesocycle_id = ${mesoId})`
  }
    order by date desc, id desc
    limit ${limit}`;
  return c.json({ sessions: rows });
});

sessions.get("/:id", async (c) => {
  const id = requireIdParam(c.req.param("id"), "session");
  return c.json({ session: await sessionDetail(id) });
});

// Two shapes. Upcoming: sets with targets, for the log page. Retro: a past
// date, sets with actuals and null targets. Set rows are created here —
// logging fills them in rather than inserting.
sessions.post("/", async (c) => {
  const body = await readJson(c, ["date", "rationale", "sets"]);
  const requestId = requireUuid(body, "request_id");
  if (requestId) {
    const [existing] = await sql`
      select id from sessions where request_id = ${requestId}`;
    if (existing) return c.json({ session: await sessionDetail(existing.id) });
  }

  const date = requireDate(body, "date");
  const rationale = requireString(body, "rationale");

  if (!Array.isArray(body.sets) || body.sets.length === 0) {
    throw new ApiError(
      422,
      '"sets" must be a non-empty array. Upcoming session: [{exercise, kind?, target_weight_kg, target_reps}] — or target_distance_m / target_duration_s for work measured that way. Retro-logged: the same fields without the target_ prefix, plus effort on rep-counted working sets.',
    );
  }
  const sets: NewSet[] = [];
  for (const entry of body.sets) sets.push(await parseNewSet(entry));

  const id = await sql.begin(async (tx) => {
    const [session] = await tx`
      insert into sessions (public_id, date, rationale, request_id)
      values (${newPublicId()}, ${date}, ${rationale}, ${requestId})
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

  return c.json({ session: await sessionDetail(id) }, 201);
});

// An unplanned set: actuals, null targets. Behind the log page's extra-row
// and add-exercise actions, and available when logging in chat.
sessions.post("/:id/sets", async (c) => {
  const sessionId = requireIdParam(c.req.param("id"), "session");
  const [session] = await sql`select id from sessions where id = ${sessionId}`;
  if (!session) throw new ApiError(404, `No session with id ${sessionId}.`);

  const body = await readJson(c, [
    "exercise",
    "kind",
    "mesocycle",
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
  ]);
  // Appends at max(position)+1, so there is no natural key to collide on:
  // without the id a lost response becomes a duplicate set.
  const requestId = requireUuid(body, "request_id");
  const [duplicate] = await sql`
    select id, session_id, exercise_id, mesocycle_id, position, kind,
      weight_kg::float8, reps, distance_m::float8, duration_s::float8,
      effort, performed_at, notes
    from sets where request_id = ${requestId}`;
  if (duplicate) return c.json({ set: duplicate });

  const s = await parseNewSet(body);
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
  const [row] = await sql`
    insert into sets
      (session_id, exercise_id, mesocycle_id, position, kind, weight_kg, reps,
       distance_m, duration_s, effort, performed_at, notes, request_id)
    values
      (${sessionId}, ${s.exerciseId}, ${s.mesocycleId},
       (select coalesce(max(position), 0) + 1 from sets where session_id = ${sessionId}),
       ${s.kind}, ${s.weightKg}, ${s.reps}, ${s.distanceM}, ${s.durationS},
       ${s.effort}, ${s.performedAt ?? new Date().toISOString()}, ${s.notes},
       ${requestId})
    returning id, session_id, exercise_id, mesocycle_id, position, kind,
      weight_kg::float8, reps, distance_m::float8, duration_s::float8,
      effort, performed_at, notes`;
  return c.json({ set: row }, 201);
});

// Notes, how it felt, marking complete. Finishing a workout is a field
// changing, not a separate action.
sessions.patch("/:id", async (c) => {
  const sessionId = requireIdParam(c.req.param("id"), "session");
  const [session] = await sql`select id from sessions where id = ${sessionId}`;
  if (!session) throw new ApiError(404, `No session with id ${sessionId}.`);

  const body = await readJson(c, [
    "started_at",
    "completed_at",
    "overall_feel",
    "notes",
    "rationale",
  ]);
  const fields: Record<string, unknown> = {};
  if ("notes" in body) fields.notes = optionalString(body, "notes");
  if ("overall_feel" in body) {
    fields.overall_feel = optionalString(body, "overall_feel");
  }
  if ("rationale" in body) fields.rationale = requireString(body, "rationale");
  if ("started_at" in body) {
    fields.started_at = optionalTimestamp(body, "started_at");
  }
  if ("completed_at" in body) {
    fields.completed_at = optionalTimestamp(body, "completed_at");
  }
  if (Object.keys(fields).length === 0) {
    throw new ApiError(
      422,
      'Send at least one of "notes", "overall_feel", "rationale", "started_at", "completed_at".',
    );
  }
  await sql`update sessions set ${sql(fields)} where id = ${sessionId}`;
  return c.json({ session: await sessionDetail(sessionId) });
});

// A planned session nobody has touched is a proposal, not history. Iterating
// on a plan means discarding the draft and writing a better one — without
// this, the only path was superseding, which litters the record with dead
// rows precisely because someone was careful about the plan. The moment any
// set carries an actual, or the session was started or finished, it happened:
// from then on it is history, and history is corrected, never deleted.
sessions.delete("/:id", async (c) => {
  const sessionId = requireIdParam(c.req.param("id"), "session");
  const [session] = await sql`
    select id, date, started_at, completed_at
    from sessions where id = ${sessionId}`;
  if (!session) throw new ApiError(404, `No session with id ${sessionId}.`);

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
  return c.json({
    deleted: { id: session.id, date: session.date, sets: total },
  });
});
