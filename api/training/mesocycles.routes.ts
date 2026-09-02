import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  createMesocycle,
  decisionLog,
  mesocycleByRef,
  recordDecision,
  renameMesocycle,
} from "./mesocycles.ts";
import { DOSE_UNITS, ROLES, TRACKS } from "./rules.ts";
import {
  body,
  date,
  int,
  number,
  oneOf,
  optionalDate,
  optionalText,
  query,
  requestId,
  text,
} from "../shared/schema.ts";

export const mesocycles = new OpenAPIHono();

const selector = () =>
  z.string().min(1).meta({
    description: 'A mesocycle id, "current", or "current:<track>".',
    example: "current",
  });

const reference = () => z.union([z.string().min(1), z.number()]).optional();

// Named in the schema rather than left to the unknown-field check: each is a
// mistake with a particular explanation, and the document should carry the
// reason rather than only the refusal.
const refusedField = (why: string) =>
  z.unknown().optional().meta({ description: `Refused. ${why}` });

const PlanExerciseRow = z.object({
  id: z.int(),
  exercise_id: z.int(),
  exercise: z.string(),
  measure: z.string(),
  role: z.enum(ROLES),
  priority: z.int(),
  weekly_dose: z.number(),
  weekly_dose_unit: z.enum(DOSE_UNITS),
  notes: z.string().nullable(),
});

const MesocycleDetail = z.object({
  id: z.int(),
  block_id: z.int(),
  name: z.string(),
  track: z.enum(TRACKS),
  // The plan's judgment in prose. Never arithmetic.
  intent: z.string(),
  planned_weeks: z.int(),
  sessions_per_week: z.int(),
  started_on: z.string(),
  ended_on: z.string().nullable(),
  // Null until the plan starts.
  week: z.int().nullable(),
  exercises: z.array(PlanExerciseRow),
});

const Decision = z.object({
  id: z.int(),
  made_at: z.string(),
  what_changed: z.string(),
  why: z.string(),
  prior_intent: z.string().nullable(),
});

// A decision as the write answers it: named by its plan, and without the
// prior intent, which only an intent replacement carries. Declared once so the
// query returning it is typed by the same shape the document promises.
const Recorded = Decision.omit({ prior_intent: true }).extend({
  mesocycle_id: z.int(),
});

const planEntryShape = {
  exercise: reference(),
  role: oneOf(ROLES),
  priority: int({ min: 1 }),
  weekly_dose: number(),
  weekly_dose_unit: oneOf(DOSE_UNITS),
  notes: optionalText(),
  weekly_sets: refusedField(
    'The weekly dose is "weekly_dose" plus "weekly_dose_unit", so that work in metres and minutes can be dosed too.',
  ),
  load_target: refusedField(
    "Load targets are not stored in tables: the intent carries the plan's goals and its progression mechanism.",
  ),
};

const planEntry = () => body(planEntryShape, 'an entry in "exercises"');

mesocycles.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Planning"],
    summary: "Create a plan",
    description:
      "A mesocycle arrives complete: intent plus the exercise list, in one transaction. The load goals and the progression mechanism belong in `intent` — only the weekly dose is structured.",
    request: {
      query: query({}),
      body: {
        content: {
          "application/json": {
            schema: body({
              block_id: int(),
              name: text(),
              track: oneOf(TRACKS),
              intent: text(),
              started_on: date(),
              planned_weeks: int({ min: 1 }),
              sessions_per_week: int({ min: 1 }),
              exercises: z.array(planEntry()).min(1, {
                error: () =>
                  'A mesocycle arrives complete: "exercises" must be a non-empty array of {exercise, role, priority, weekly_dose, weekly_dose_unit, notes?}. The load goals and the progression mechanism belong in "intent".',
              }),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The plan, with its exercise list.",
        content: {
          "application/json": {
            schema: z.object({ mesocycle: MesocycleDetail }),
          },
        },
      },
      200: {
        description:
          "The plan this request_id already created. A retry, answered with the original result.",
        content: {
          "application/json": {
            schema: z.object({ mesocycle: MesocycleDetail }),
          },
        },
      },
      409: { description: "A plan is already active on that track." },
      422: {
        description:
          "A dose unit that does not fit how the exercise is measured, or a started_on that is not a Monday.",
      },
    },
  }),
  async (c) => {
    const { mesocycle, created } = await createMesocycle(c.req.valid("json"));
    return created ? c.json({ mesocycle }, 201) : c.json({ mesocycle }, 200);
  },
);

mesocycles.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Planning"],
    summary: "One plan",
    request: { params: z.object({ id: selector() }), query: query({}) },
    responses: {
      200: {
        description: "The plan, its exercise list, and which week it is on.",
        content: {
          "application/json": {
            schema: z.object({ mesocycle: MesocycleDetail }),
          },
        },
      },
      404: { description: "Nothing resolves to that selector." },
    },
  }),
  async (c) =>
    c.json({ mesocycle: await mesocycleByRef(c.req.valid("param").id) }),
);

mesocycles.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Planning"],
    summary: "Rename a plan",
    description:
      "The name is a label, not the plan. Everything that is the plan — exercises, dose, intent, and ending it — changes through POST /mesocycles/:id/decisions, which does not accept a change without its reason.",
    request: {
      query: query({}),
      params: z.object({ id: selector() }),
      body: {
        content: {
          "application/json": {
            schema: body({
              name: text(),
              intent: refusedField(
                "The intent is the plan; changing it is a decision.",
              ),
              ended_on: refusedField(
                "Ending a plan is a plan change, so it carries its reason.",
              ),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The plan as it now stands.",
        content: {
          "application/json": {
            schema: z.object({ mesocycle: MesocycleDetail }),
          },
        },
      },
      422: {
        description:
          "No name was sent, or intent or ended_on was — which are decisions.",
      },
    },
  }),
  async (c) =>
    c.json({
      mesocycle: await renameMesocycle(
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
    }),
);

mesocycles.openapi(
  createRoute({
    method: "post",
    path: "/{id}/decisions",
    tags: ["Planning"],
    summary: "Change a plan, or record why it was left alone",
    description:
      "Exercise-list changes, doses, a full intent replacement, ending the plan, or none of them — all-or-nothing in one transaction, and never without what changed and why. A review outcome that changed nothing is the same call with no change fields.",
    request: {
      query: query({}),
      params: z.object({ id: selector() }),
      body: {
        content: {
          "application/json": {
            schema: body({
              what_changed: text(),
              why: text(),
              intent: optionalText(),
              add: z.array(planEntry()).optional(),
              remove: z.array(z.union([z.string(), z.number()])).optional()
                .meta({
                  description:
                    "Exercise references to drop from the plan's list.",
                }),
              redose: z.array(
                body({
                  exercise: reference(),
                  weekly_dose: number(),
                  weekly_dose_unit: oneOf(DOSE_UNITS),
                }, 'an entry in "redose"'),
              ).optional(),
              ended_on: optionalDate().meta({
                description:
                  "Ends the plan, freeing its track for the next one. Earlier than planned is a plan cut short, and this is the reason it was. Null reopens a plan ended by mistake.",
              }),
              weekly_sets: refusedField(
                'Dose changes are "redose", for exercises already in the plan.',
              ),
              load_targets: refusedField(
                "A change to a goal or to the progression mechanism is an intent change.",
              ),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The decision, and the plan as it now stands.",
        content: {
          "application/json": {
            schema: z.object({
              mesocycle: MesocycleDetail,
              decision: Recorded,
            }),
          },
        },
      },
      200: {
        description:
          "The decision this request_id already recorded, replayed exactly, with the plan as it stands now — which later decisions may have moved on.",
        content: {
          "application/json": {
            schema: z.object({
              mesocycle: MesocycleDetail,
              decision: Recorded,
            }),
          },
        },
      },
      409: {
        description:
          "That request_id was already spent on a different plan's decision.",
      },
      422: {
        description:
          "Names an exercise not in the plan, or carries a refused field.",
      },
    },
  }),
  async (c) => {
    const { mesocycle, decision, created } = await recordDecision(
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    return created
      ? c.json({ mesocycle, decision }, 201)
      : c.json({ mesocycle, decision }, 200);
  },
);

mesocycles.openapi(
  createRoute({
    method: "get",
    path: "/{id}/decisions",
    tags: ["Planning"],
    summary: "The plan's decision log",
    description:
      "Every change to the plan carries one and every review that changed nothing leaves one, so this is the plan's history — including the intent each replacement displaced.",
    request: { params: z.object({ id: selector() }), query: query({}) },
    responses: {
      200: {
        description: "Decisions oldest first, with any intent they replaced.",
        content: {
          "application/json": {
            schema: z.object({
              mesocycle_id: z.int(),
              decisions: z.array(Decision),
            }),
          },
        },
      },
    },
  }),
  async (c) => c.json(await decisionLog(c.req.valid("param").id)),
);
