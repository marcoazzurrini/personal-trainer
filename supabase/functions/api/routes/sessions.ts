import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { ApiError, requireRow } from "../http/errors.ts";
import { writeOnce } from "../record/idempotency.ts";
import {
  resolveExercise,
  resolveMesocycle,
  resolveSetMesocycleId,
} from "../record/resolve.ts";
import { assertEffort, assertSetMeasures } from "../rules/training.ts";
import {
  body,
  date,
  idParam,
  oneOf,
  optionalInt,
  optionalNumber,
  optionalText,
  optionalTimestamp,
  requestId,
  text,
} from "../http/schema.ts";

const KINDS = ["warmup", "working"] as const;
const EFFORTS = ["easy", "hard", "failure"] as const;

export const sessions = new OpenAPIHono();

// An exercise or mesocycle by id, name, or alias — the resolver decides.
const reference = () => z.union([z.string().min(1), z.number()]).optional();

const SetRow = z.object({
  id: z.int(),
  exercise: z.string(),
  exercise_id: z.int(),
  measure: z.string(),
  mesocycle_id: z.int().nullable(),
  position: z.int(),
  kind: z.enum(KINDS),
  target_weight_kg: z.number().nullable(),
  target_reps: z.int().nullable(),
  target_distance_m: z.number().nullable(),
  target_duration_s: z.number().nullable(),
  weight_kg: z.number().nullable(),
  reps: z.int().nullable(),
  distance_m: z.number().nullable(),
  duration_s: z.number().nullable(),
  effort: z.enum(EFFORTS).nullable(),
  performed_at: z.string().nullable(),
  notes: z.string().nullable(),
});

const SessionHeader = z.object({
  id: z.int(),
  public_id: z.string(),
  date: z.string(),
  rationale: z.string().nullable(),
  notes: z.string().nullable(),
  overall_feel: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

const SessionDetail = SessionHeader.extend({ sets: z.array(SetRow) });

// The set written by POST /sessions/{id}/sets: an unplanned set, so it never
// carries targets and the row returned has none to show.
const AppendedSet = SetRow.omit({
  exercise: true,
  measure: true,
  target_weight_kg: true,
  target_reps: true,
  target_distance_m: true,
  target_duration_s: true,
});

function newPublicId(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function sessionDetail(id: number) {
  const session = requireRow(
    await sql<z.infer<typeof SessionHeader>[]>`
    select id, public_id, date, rationale, notes,
      overall_feel, started_at, completed_at
    from sessions where id = ${id}`,
    `No session with id ${id}.`,
  );
  // Each set says which plan it serves; the session says nothing, because a
  // session that sprints and then squats serves two.
  const sets = await sql<z.infer<typeof SetRow>[]>`
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
const setEntryShape = {
  exercise: reference(),
  kind: oneOf(KINDS).default("working"),
  mesocycle: reference(),
  target_weight_kg: optionalNumber({ min: 0 }),
  target_reps: optionalInt({ min: 1 }),
  target_distance_m: optionalNumber({ min: 0 }),
  target_duration_s: optionalNumber({ min: 0 }),
  weight_kg: optionalNumber({ min: 0 }),
  reps: optionalInt({ min: 1 }),
  distance_m: optionalNumber({ min: 0 }),
  duration_s: optionalNumber({ min: 0 }),
  effort: oneOf(EFFORTS).nullish(),
  performed_at: optionalTimestamp(),
  notes: optionalText(),
};

type SetEntry = z.infer<ReturnType<typeof setEntry>>;
const setEntry = () => body(setEntryShape, 'an entry in "sets"');

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

sessions.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Training"],
    summary: "Recent sessions",
    request: {
      query: z.object({
        limit: z.string().optional().meta({
          description: "How many, newest first. Default 20, capped at 100.",
        }),
        mesocycle: z.string().optional().meta({
          description:
            "Keep only sessions containing work for this plan — a session is no longer owned by one.",
        }),
      }),
    },
    responses: {
      200: {
        description: "Session headers, newest first. Sets are not included.",
        content: {
          "application/json": {
            schema: z.object({ sessions: z.array(SessionHeader) }),
          },
        },
      },
    },
  }),
  async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
    const mesoParam = c.req.query("mesocycle");
    const mesoId = mesoParam ? (await resolveMesocycle(mesoParam)).id : null;
    // Filtering by plan asks which sessions contained work for it, because a
    // session is no longer owned by one.
    const rows = await sql<z.infer<typeof SessionHeader>[]>`
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
  },
);

sessions.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Training"],
    summary: "One session, with its sets",
    request: { params: z.object({ id: idParam("session") }) },
    responses: {
      200: {
        description: "The session and every set in it, in position order.",
        content: {
          "application/json": {
            schema: z.object({ session: SessionDetail }),
          },
        },
      },
      404: { description: "No session carries that id." },
    },
  }),
  async (c) => {
    return c.json({ session: await sessionDetail(c.req.valid("param").id) });
  },
);

// Two shapes. Upcoming: sets with targets, for the log page. Retro: a past
// date, sets with actuals and null targets. Set rows are created here —
// logging fills them in rather than inserting.
sessions.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Training"],
    summary: "Write a session",
    description:
      "Two shapes. Upcoming: sets carrying targets, for the log page. Retro-logged: a past date and sets carrying actuals. Never both on one set — a target written after the work would always match what was done.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: body({
              date: date(),
              rationale: text(),
              sets: z.array(setEntry(), {
                error: () =>
                  '"sets" must be a non-empty array. Upcoming session: [{exercise, kind?, target_weight_kg, target_reps}] — or target_distance_m / target_duration_s for work measured that way. Retro-logged: the same fields without the target_ prefix, plus effort on rep-counted working sets.',
              }).min(1, {
                error: () =>
                  '"sets" must be a non-empty array. Upcoming session: [{exercise, kind?, target_weight_kg, target_reps}] — or target_distance_m / target_duration_s for work measured that way. Retro-logged: the same fields without the target_ prefix, plus effort on rep-counted working sets.',
              }),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The session that was written, with its sets.",
        content: {
          "application/json": {
            schema: z.object({ session: SessionDetail }),
          },
        },
      },
      200: {
        description:
          "The session this request_id already wrote. A retry, answered with the original result.",
        content: {
          "application/json": {
            schema: z.object({ session: SessionDetail }),
          },
        },
      },
      422: {
        description:
          "A set carrying both targets and actuals, or measures that do not fit the exercise.",
      },
    },
  }),
  async (c) => {
    const b = c.req.valid("json");

    const { body: answer, status } = await writeOnce({
      table: "sessions",
      requestId: b.request_id,
      select: sql`id`,
      replay: async (seen: { id: number }) => ({
        session: await sessionDetail(seen.id),
      }),
      write: async () => {
        const sets: NewSet[] = [];
        for (const entry of b.sets) sets.push(await parseNewSet(entry));

        const id = await sql.begin(async (tx) => {
          const [session] = await tx`
      insert into sessions (public_id, date, rationale, request_id)
      values (${newPublicId()}, ${b.date}, ${b.rationale}, ${b.request_id})
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

        return { session: await sessionDetail(id) };
      },
    });
    return c.json(answer, status);
  },
);

// An unplanned set: actuals, null targets. Behind the log page's extra-row
// and add-exercise actions, and available when logging in chat.
sessions.openapi(
  createRoute({
    method: "post",
    path: "/{id}/sets",
    tags: ["Training"],
    summary: "Append an unplanned set",
    description:
      "Records what was done, so it carries actuals and never targets. Appends at the end of the session.",
    request: {
      params: z.object({ id: idParam("session") }),
      body: {
        content: {
          "application/json": {
            schema: body({ ...setEntryShape, request_id: requestId() }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The set that was appended.",
        content: {
          "application/json": { schema: z.object({ set: AppendedSet }) },
        },
      },
      200: {
        description:
          "The set this request_id already appended. A retry, answered with the original row.",
        content: {
          "application/json": { schema: z.object({ set: AppendedSet }) },
        },
      },
      404: { description: "No session carries that id." },
      422: { description: "Targets were sent, or no measurement was." },
    },
  }),
  async (c) => {
    const sessionId = c.req.valid("param").id;
    requireRow(
      await sql`select id from sessions where id = ${sessionId}`,
      `No session with id ${sessionId}.`,
    );

    const b = c.req.valid("json");
    // Appends at max(position)+1, so there is no natural key to collide on:
    // without the id a lost response becomes a duplicate set.
    const { body: answer, status } = await writeOnce({
      table: "sets",
      requestId: b.request_id,
      select: sql`id, session_id, exercise_id, mesocycle_id, position, kind,
        weight_kg::float8, reps, distance_m::float8, duration_s::float8,
        effort, performed_at, notes`,
      replay: (duplicate: z.infer<typeof AppendedSet>) => ({ set: duplicate }),
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
        const [row] = await sql<z.infer<typeof AppendedSet>[]>`
    insert into sets
      (session_id, exercise_id, mesocycle_id, position, kind, weight_kg, reps,
       distance_m, duration_s, effort, performed_at, notes, request_id)
    values
      (${sessionId}, ${s.exerciseId}, ${s.mesocycleId},
       (select coalesce(max(position), 0) + 1 from sets where session_id = ${sessionId}),
       ${s.kind}, ${s.weightKg}, ${s.reps}, ${s.distanceM}, ${s.durationS},
       ${s.effort}, ${s.performedAt ?? new Date().toISOString()}, ${s.notes},
       ${b.request_id})
    returning id, session_id, exercise_id, mesocycle_id, position, kind,
      weight_kg::float8, reps, distance_m::float8, duration_s::float8,
      effort, performed_at, notes`;
        return { set: row };
      },
    });
    return c.json(answer, status);
  },
);

// Notes, how it felt, marking complete. Finishing a workout is a field
// changing, not a separate action.
sessions.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Training"],
    summary: "Session-level facts",
    description:
      "Finishing a workout is completed_at changing, not a separate action.",
    request: {
      params: z.object({ id: idParam("session") }),
      body: {
        content: {
          "application/json": {
            schema: body({
              started_at: optionalTimestamp(),
              completed_at: optionalTimestamp(),
              overall_feel: optionalText(),
              notes: optionalText(),
              rationale: text().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The session as it now stands.",
        content: {
          "application/json": {
            schema: z.object({ session: SessionDetail }),
          },
        },
      },
      404: { description: "No session carries that id." },
      422: { description: "Nothing was sent." },
    },
  }),
  async (c) => {
    const sessionId = c.req.valid("param").id;
    requireRow(
      await sql`select id from sessions where id = ${sessionId}`,
      `No session with id ${sessionId}.`,
    );

    const b = c.req.valid("json");
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
    return c.json({ session: await sessionDetail(sessionId) });
  },
);

// A planned session nobody has touched is a proposal, not history. Iterating
// on a plan means discarding the draft and writing a better one — without
// this, the only path was superseding, which litters the record with dead
// rows precisely because someone was careful about the plan. The moment any
// set carries an actual, or the session was started or finished, it happened:
// from then on it is history, and history is corrected, never deleted.
sessions.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Training"],
    summary: "Discard an untouched draft",
    description:
      "Only a planned session nothing has touched can be discarded. The moment any set carries an actual, or the session was started or finished, it happened — and history is corrected, never deleted.",
    request: { params: z.object({ id: idParam("session") }) },
    responses: {
      200: {
        description: "The draft that was discarded.",
        content: {
          "application/json": {
            schema: z.object({
              deleted: z.object({
                id: z.int(),
                date: z.string(),
                sets: z.int(),
              }),
            }),
          },
        },
      },
      404: { description: "No session carries that id." },
      409: {
        description:
          "The session is on the record. Corrections go through PATCH.",
      },
    },
  }),
  async (c) => {
    const sessionId = c.req.valid("param").id;
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
    return c.json({
      deleted: {
        id: session.id as number,
        date: session.date as string,
        sets: total as number,
      },
    });
  },
);
