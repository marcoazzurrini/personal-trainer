import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import { resolveExerciseId, resolveMesocycle } from "../lib/resolve.ts";
import {
  type Body,
  optionalInt,
  optionalNumber,
  optionalString,
  optionalTimestamp,
  optionalUuid,
  readJson,
  requireDate,
  requireOneOf,
  requireString,
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
    select id, public_id, mesocycle_id, date, type, rationale, notes,
      overall_feel, started_at, completed_at
    from sessions where id = ${id}`;
  if (!session) throw new ApiError(404, `No session with id ${id}.`);
  const sets = await sql`
    select t.id, e.name as exercise, t.exercise_id, t.position, t.kind,
      t.target_weight_kg::float8, t.target_reps,
      t.weight_kg::float8, t.reps, t.effort, t.performed_at, t.notes
    from sets t join exercises e on e.id = t.exercise_id
    where t.session_id = ${id}
    order by t.position`;
  return { ...session, sets };
}

interface NewSet {
  exerciseId: number;
  kind: string;
  targetWeightKg: number | null;
  targetReps: number | null;
  weightKg: number | null;
  reps: number | null;
  effort: string | null;
  performedAt: string | null;
  notes: string | null;
}

// One set entry of POST /sessions. Targets only (upcoming) or actuals only
// (retro) — a target written after the work would always match what was done.
async function parseNewSet(entry: unknown): Promise<NewSet> {
  if (typeof entry === "object" && entry === null) {
    throw new ApiError(422, 'Each entry in "sets" must be an object.');
  }
  const s = entry as Body;
  const exerciseId = await resolveExerciseId(s.exercise);
  const kind = requireOneOf(s, "kind", KINDS, "working");

  const targetWeightKg = optionalNumber(s, "target_weight_kg", { min: 0 });
  const targetReps = optionalInt(s, "target_reps", { min: 1 });
  if ((targetWeightKg === null) !== (targetReps === null)) {
    throw new ApiError(
      422,
      'Targets are a pair: send both "target_weight_kg" and "target_reps", or neither.',
    );
  }
  const weightKg = optionalNumber(s, "weight_kg", { min: 0 });
  const reps = optionalInt(s, "reps", { min: 1 });
  if ((weightKg === null) !== (reps === null)) {
    throw new ApiError(
      422,
      'Actuals are a pair: send both "weight_kg" and "reps", or neither.',
    );
  }
  if (targetReps !== null && reps !== null) {
    throw new ApiError(
      422,
      "A new set carries targets (upcoming session) or actuals (retro-logged), never both: targets written after the fact would always match what was done.",
    );
  }
  const effort = s.effort === undefined || s.effort === null
    ? null
    : requireOneOf(s, "effort", EFFORTS);
  if (kind === "working" && reps !== null && effort === null) {
    throw new ApiError(
      422,
      "effort is required on a performed working set; send easy, hard, or failure.",
    );
  }
  return {
    exerciseId,
    kind,
    targetWeightKg,
    targetReps,
    weightKg,
    reps,
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
  const rows = await sql`
    select id, public_id, mesocycle_id, date, type, rationale, notes,
      overall_feel, started_at, completed_at
    from sessions
    ${mesoId === null ? sql`` : sql`where mesocycle_id = ${mesoId}`}
    order by date desc, id desc
    limit ${limit}`;
  return c.json({ sessions: rows });
});

sessions.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    throw new ApiError(422, "Session ids are numeric.");
  }
  return c.json({ session: await sessionDetail(id) });
});

// Two shapes. Upcoming: sets with targets, for the log page. Retro: a past
// date, sets with actuals and null targets. Set rows are created here —
// logging fills them in rather than inserting.
sessions.post("/", async (c) => {
  const body = await readJson(c);
  const requestId = optionalUuid(body, "request_id");
  if (requestId) {
    const [existing] = await sql`
      select id from sessions where request_id = ${requestId}`;
    if (existing) return c.json({ session: await sessionDetail(existing.id) });
  }

  const meso = await resolveMesocycle(
    typeof body.mesocycle === "number"
      ? String(body.mesocycle)
      : (body.mesocycle as string | undefined) ?? "current",
  );
  const date = requireDate(body, "date");
  const rationale = requireString(body, "rationale");
  const type = optionalString(body, "type") ?? "lift";

  if (!Array.isArray(body.sets) || body.sets.length === 0) {
    throw new ApiError(
      422,
      '"sets" must be a non-empty array. Upcoming session: [{exercise, kind?, target_weight_kg, target_reps}]. Retro-logged: [{exercise, kind?, weight_kg, reps, effort}].',
    );
  }
  const sets: NewSet[] = [];
  for (const entry of body.sets) sets.push(await parseNewSet(entry));

  const id = await sql.begin(async (tx) => {
    const [session] = await tx`
      insert into sessions (public_id, mesocycle_id, date, type, rationale, request_id)
      values (${newPublicId()}, ${meso.id}, ${date}, ${type}, ${rationale}, ${requestId})
      returning id`;
    let position = 1;
    for (const s of sets) {
      await tx`
        insert into sets
          (session_id, exercise_id, position, kind, target_weight_kg,
           target_reps, weight_kg, reps, effort, performed_at, notes)
        values
          (${session.id}, ${s.exerciseId}, ${position++}, ${s.kind},
           ${s.targetWeightKg}, ${s.targetReps}, ${s.weightKg}, ${s.reps},
           ${s.effort}, ${s.performedAt}, ${s.notes})`;
    }
    return session.id as number;
  });

  return c.json({ session: await sessionDetail(id) }, 201);
});

// An unplanned set: actuals, null targets. Behind the log page's extra-row
// and add-exercise actions, and available when logging in chat.
sessions.post("/:id/sets", async (c) => {
  const sessionId = Number(c.req.param("id"));
  const [session] = await sql`select id from sessions where id = ${sessionId}`;
  if (!session) throw new ApiError(404, `No session with id ${sessionId}.`);

  const body = await readJson(c);
  const s = await parseNewSet(body);
  if (s.targetReps !== null) {
    throw new ApiError(
      422,
      "An unplanned set records what was done: send actuals (weight_kg, reps, effort), not targets.",
    );
  }
  if (s.reps === null) {
    throw new ApiError(
      422,
      'An unplanned set records what was done: "weight_kg" and "reps" are required.',
    );
  }
  const [row] = await sql`
    insert into sets
      (session_id, exercise_id, position, kind, weight_kg, reps, effort,
       performed_at, notes)
    values
      (${sessionId}, ${s.exerciseId},
       (select coalesce(max(position), 0) + 1 from sets where session_id = ${sessionId}),
       ${s.kind}, ${s.weightKg}, ${s.reps}, ${s.effort},
       ${s.performedAt ?? new Date().toISOString()}, ${s.notes})
    returning id, session_id, exercise_id, position, kind,
      weight_kg::float8, reps, effort, performed_at, notes`;
  return c.json({ set: row }, 201);
});

// Notes, how it felt, marking complete. Finishing a workout is a field
// changing, not a separate action.
sessions.patch("/:id", async (c) => {
  const sessionId = Number(c.req.param("id"));
  const [session] = await sql`select id from sessions where id = ${sessionId}`;
  if (!session) throw new ApiError(404, `No session with id ${sessionId}.`);

  const body = await readJson(c);
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
