import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  appendSet,
  correctSession,
  discardSession,
  listSessions,
  sessionDetail,
  writeSession,
} from "./sessions.ts";
import { EFFORTS, KINDS } from "./rules.ts";
import {
  body,
  date,
  idParam,
  limitParam,
  oneOf,
  optionalInt,
  optionalNumber,
  optionalText,
  optionalTimestamp,
  query,
  requestId,
  text,
} from "../shared/schema.ts";

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
// Carries session_id, which the sets listed inside a session detail do not:
// there the session is the thing being read, here the set is answered on its
// own. GET /exercises/{ref}/history and PATCH /sets/{id} both send it too, so
// a set arrives the same way whichever route produced it.
const AppendedSet = SetRow.omit({
  exercise: true,
  measure: true,
  target_weight_kg: true,
  target_reps: true,
  target_distance_m: true,
  target_duration_s: true,
}).extend({ session_id: z.int() });

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

const setEntry = () => body(setEntryShape, 'an entry in "sets"');

sessions.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Training"],
    summary: "Recent sessions",
    request: {
      query: query({
        limit: limitParam({ default: 20, max: 100 }).meta({
          description: "How many, newest first. Default 20, maximum 100.",
        }),
        mesocycle: z.string().min(1).optional().meta({
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
    const { limit, mesocycle } = c.req.valid("query");
    return c.json({ sessions: await listSessions(limit ?? 20, mesocycle) });
  },
);

sessions.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Training"],
    summary: "One session, with its sets",
    request: { params: z.object({ id: idParam("session") }), query: query({}) },
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
  async (c) =>
    c.json({ session: await sessionDetail(c.req.valid("param").id) }),
);

sessions.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Training"],
    summary: "Write a session",
    description:
      "Two shapes. Upcoming: sets carrying targets, the session about to be trained. Retro-logged: a past date and sets carrying actuals. Never both on one set — a target written after the work would always match what was done.",
    request: {
      query: query({}),
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
    const { session, created } = await writeSession(c.req.valid("json"));
    return created ? c.json({ session }, 201) : c.json({ session }, 200);
  },
);

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
      query: query({}),
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
    const { set, created } = await appendSet(
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    return created ? c.json({ set }, 201) : c.json({ set }, 200);
  },
);

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
      query: query({}),
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
  async (c) =>
    c.json({
      session: await correctSession(
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    }),
);

sessions.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Training"],
    summary: "Discard an untouched draft",
    description:
      "Only a planned session nothing has touched can be discarded. The moment any set carries an actual, or the session was started or finished, it happened — and history is corrected, never deleted.",
    request: { params: z.object({ id: idParam("session") }), query: query({}) },
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
  async (c) =>
    c.json({ deleted: await discardSession(c.req.valid("param").id) }),
);
