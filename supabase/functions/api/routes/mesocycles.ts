import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql, type Tx } from "../db.ts";
import { ApiError } from "../http/errors.ts";
import { romeDate } from "../record/calendar.ts";
import { writeOnce } from "../record/idempotency.ts";
import {
  resolveExercise,
  resolveExerciseId,
  resolveMesocycle,
} from "../record/resolve.ts";
import {
  assertDoseUnit,
  DOSE_UNITS,
  ROLES,
  TRACKS,
} from "../rules/training.ts";
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
} from "../http/schema.ts";

// The plan's judgment — load goals, progression, deload rules, what would
// force a rethink — lives in the mesocycle's intent, not in tables. The
// exercise list is the plan's nouns, and the weekly dose is the one number
// that is structured, because the server computes behind-and-ahead from it
// at every session generation.

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

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

// A decision as the standalone route answers it: named by its plan, and
// without the prior intent, which only a revision replaces. Declared once so
// the query returning it is typed by the same shape the document promises.
const Recorded = Decision.omit({ prior_intent: true }).extend({
  mesocycle_id: z.int(),
});

type RecordedRow = z.infer<typeof Recorded>;

interface PlanExercise {
  exerciseId: number;
  role: string;
  priority: number;
  weeklyDose: number;
  weeklyDoseUnit: string;
  notes: string | null;
}

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
type PlanEntry = z.infer<ReturnType<typeof planEntry>>;

// Validates one entry of the exercise list (same shape in creation and in a
// revision's additions, so the caller learns it once).
async function parsePlanExercise(e: PlanEntry): Promise<PlanExercise> {
  if (e.weekly_sets !== undefined) {
    throw new ApiError(
      422,
      'The weekly dose is "weekly_dose" plus "weekly_dose_unit" (sets, minutes, or km), so that work in metres and minutes can be dosed too. An exercise entry is {exercise, role, priority, weekly_dose, weekly_dose_unit, notes?}.',
    );
  }
  if (e.load_target !== undefined) {
    throw new ApiError(
      422,
      "Load targets are not stored in tables: the intent carries the plan's goals and its progression mechanism (see tasks/programming). Only the weekly dose is structured.",
    );
  }
  const exercise = await resolveExercise(e.exercise);
  const weeklyDoseUnit = e.weekly_dose_unit;
  // Which units make sense depends on how the exercise is measured, which no
  // CHECK on this table can see.
  assertDoseUnit(exercise.measure, weeklyDoseUnit, exercise.name);
  return {
    exerciseId: exercise.id,
    role: e.role,
    priority: e.priority,
    weeklyDose: e.weekly_dose,
    weeklyDoseUnit,
    notes: e.notes ?? null,
  };
}

// effectiveFrom is the first day the dose is in force: the plan's start when
// the plan is being created, today when an exercise joins by revision.
async function insertPlanExercise(
  tx: Tx,
  mesocycleId: number,
  p: PlanExercise,
  effectiveFrom: string | null,
) {
  await tx`
    insert into mesocycle_exercises
      (mesocycle_id, exercise_id, role, priority, weekly_dose,
       weekly_dose_unit, notes)
    values
      (${mesocycleId}, ${p.exerciseId}, ${p.role}, ${p.priority},
       ${p.weeklyDose}, ${p.weeklyDoseUnit}, ${p.notes})`;
  await tx`
    insert into mesocycle_exercise_doses
      (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit,
       effective_from)
    values
      (${mesocycleId}, ${p.exerciseId}, ${p.weeklyDose}, ${p.weeklyDoseUnit},
       ${effectiveFrom ?? romeDate()})`;
}

// The plan, exactly: the mesocycle row (intent included — it is the plan's
// numbers), the exercise list, and which week it is.
async function mesocycleDetail(id: number) {
  // week arrives as a plain int and becomes null below when the plan has not
  // started, so it is typed here as the column and not as the field.
  const [m] = await sql<
    Array<
      Omit<z.infer<typeof MesocycleDetail>, "week" | "exercises"> & {
        week: number;
      }
    >
  >`
    select id, block_id, name, track, intent, planned_weeks,
      sessions_per_week, started_on, ended_on,
      ((((${romeDate()}) - started_on) / 7) + 1)::int as week
    from mesocycles where id = ${id}`;
  const exercises = await sql<z.infer<typeof PlanExerciseRow>[]>`
    select me.id, e.id as exercise_id, e.name as exercise, e.measure,
      me.role, me.priority, me.weekly_dose::float8, me.weekly_dose_unit,
      me.notes
    from mesocycle_exercises me
    join exercises e on e.id = me.exercise_id
    where me.mesocycle_id = ${id}
    order by me.priority, e.name`;
  return {
    ...m,
    week: m.week < 1 ? null : m.week, // null = not started yet
    exercises,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// The complete plan in one call and one transaction: intent plus exercise
// list. Retries with the same request_id return the original result.
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
    const b = c.req.valid("json");

    const { body: answer, status } = await writeOnce({
      table: "mesocycles",
      requestId: b.request_id,
      select: sql`id`,
      replay: async (seen: { id: number }) => ({
        mesocycle: await mesocycleDetail(seen.id),
      }),
      write: async () => {
        const plan: PlanExercise[] = [];
        for (const entry of b.exercises) {
          plan.push(await parsePlanExercise(entry));
        }

        const id = await sql.begin(async (tx) => {
          const [m] = await tx`
      insert into mesocycles
        (block_id, name, track, intent, planned_weeks, sessions_per_week,
         started_on, request_id)
      values
        (${b.block_id}, ${b.name}, ${b.track}, ${b.intent}, ${b.planned_weeks},
         ${b.sessions_per_week}, ${b.started_on}, ${b.request_id})
      returning id`;
          for (const p of plan) {
            await insertPlanExercise(tx, m.id, p, b.started_on);
          }
          return m.id as number;
        });

        return { mesocycle: await mesocycleDetail(id) };
      },
    });
    return c.json(answer, status);
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
  async (c) => {
    const m = await resolveMesocycle(c.req.valid("param").id);
    return c.json({ mesocycle: await mesocycleDetail(m.id) });
  },
);

// Trivial single-field edits only. Structural change goes through revisions.
mesocycles.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Planning"],
    summary: "Rename a plan, or end it",
    description:
      "Trivial single-field edits only. Structural change — exercises, intent — goes through a revision, which requires a decision.",
    request: {
      query: query({}),
      params: z.object({ id: selector() }),
      body: {
        content: {
          "application/json": {
            schema: body({
              name: text().optional(),
              ended_on: optionalDate(),
              intent: refusedField(
                "The intent is the plan; changing it is a revision.",
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
        description: "Nothing was sent, or intent was — which is a revision.",
      },
    },
  }),
  async (c) => {
    const m = await resolveMesocycle(c.req.valid("param").id);
    const b = c.req.valid("json");
    const fields: Record<string, unknown> = {};
    if (b.name !== undefined) fields.name = b.name;
    if (b.ended_on !== undefined) fields.ended_on = b.ended_on;
    if (b.intent !== undefined) {
      throw new ApiError(
        422,
        "The intent is the plan; changing it is a revision. POST /mesocycles/:id/revisions with the full replacement intent and a decision.",
      );
    }
    if (Object.keys(fields).length === 0) {
      throw new ApiError(
        422,
        'Send at least one of "name", "ended_on". Structural changes (exercises, intent) go through POST /mesocycles/:id/revisions.',
      );
    }
    await sql`update mesocycles set ${sql(fields)} where id = ${m.id}`;
    return c.json({ mesocycle: await mesocycleDetail(m.id) });
  },
);

// The mid-mesocycle revision: exercise-list changes and/or a full intent
// replacement, plus a required decision — all-or-nothing, one transaction.
// There is no way to change the plan without saying why.
mesocycles.openapi(
  createRoute({
    method: "post",
    path: "/{id}/revisions",
    tags: ["Planning"],
    summary: "Revise a plan, with the reason",
    description:
      "Exercise-list changes and/or a full intent replacement, all-or-nothing in one transaction. The decision is required: there is no way to change the plan without saying why.",
    request: {
      query: query({}),
      params: z.object({ id: selector() }),
      body: {
        content: {
          "application/json": {
            schema: body({
              decision: body({ what_changed: text(), why: text() }, "decision")
                .meta({
                  description: "Required. What changed, and why.",
                }),
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
      200: {
        description:
          "The plan as revised. Also the answer to a retry carrying a request_id already used.",
        content: {
          "application/json": {
            schema: z.object({ mesocycle: MesocycleDetail }),
          },
        },
      },
      422: {
        description:
          "The revision changes nothing, names an exercise not in the plan, or carries a refused field.",
      },
    },
  }),
  async (c) => {
    const m = await resolveMesocycle(c.req.valid("param").id);
    const b = c.req.valid("json");

    const { body: answer } = await writeOnce({
      table: "mesocycle_decisions",
      requestId: b.request_id,
      select: sql`id`,
      // A revision answers 200 either way: it changes a plan that already
      // existed, so there is no created row to announce.
      replay: async () => ({ mesocycle: await mesocycleDetail(m.id) }),
      write: async () => {
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

        const whatChanged = b.decision.what_changed;
        const why = b.decision.why;

        const newIntent = b.intent ?? null;
        const removals = b.remove ?? [];
        const additions = b.add ?? [];
        const redoses = b.redose ?? [];
        if (
          removals.length + additions.length + redoses.length === 0 &&
          newIntent === null
        ) {
          throw new ApiError(
            422,
            'The revision changes nothing. Send at least one of: "remove" (exercise refs), "add" (plan entries), "redose" (new weekly doses for exercises already in the plan), "intent" (the full replacement text). A review outcome with no change ("hold") is recorded with POST /mesocycles/:id/decisions instead.',
          );
        }

        // Resolve everything before touching the database.
        const removeIds: number[] = [];
        for (const ref of removals) {
          removeIds.push(await resolveExerciseId(ref));
        }
        const addPlans: PlanExercise[] = [];
        for (const entry of additions) {
          addPlans.push(await parsePlanExercise(entry));
        }
        const newDoses: { exerciseId: number; dose: number; unit: string }[] =
          [];
        for (const r of redoses) {
          const exercise = await resolveExercise(r.exercise);
          const unit = r.weekly_dose_unit;
          assertDoseUnit(exercise.measure, unit, exercise.name);
          newDoses.push({
            exerciseId: exercise.id,
            dose: r.weekly_dose,
            unit,
          });
        }

        await sql.begin(async (tx) => {
          for (const exerciseId of removeIds) {
            const [row] = await tx`
        select me.id from mesocycle_exercises me
        where me.mesocycle_id = ${m.id} and me.exercise_id = ${exerciseId}`;
            if (!row) {
              const [e] =
                await tx`select name from exercises where id = ${exerciseId}`;
              throw new ApiError(
                422,
                `"${e.name}" is not in this mesocycle's plan, so it cannot be removed. GET /mesocycles/${m.id} shows the plan.`,
              );
            }
            await tx`delete from mesocycle_exercises where id = ${row.id}`;
          }
          for (const p of addPlans) await insertPlanExercise(tx, m.id, p, null);
          for (const d of newDoses) {
            const [row] = await tx`
        update mesocycle_exercises
        set weekly_dose = ${d.dose}, weekly_dose_unit = ${d.unit}
        where mesocycle_id = ${m.id} and exercise_id = ${d.exerciseId}
        returning id`;
            if (!row) {
              const [e] =
                await tx`select name from exercises where id = ${d.exerciseId}`;
              throw new ApiError(
                422,
                `"${e.name}" is not in this mesocycle's plan, so its dose cannot be changed. Add it with "add" instead, or GET /mesocycles/${m.id} to see the plan.`,
              );
            }
            // The update above is the current truth; this row is why past weeks
            // stay judged against the dose that was actually in force.
            await tx`
        insert into mesocycle_exercise_doses
          (mesocycle_id, exercise_id, weekly_dose, weekly_dose_unit,
           effective_from)
        values (${m.id}, ${d.exerciseId}, ${d.dose}, ${d.unit},
          ${romeDate()})`;
          }
          if (newIntent !== null) {
            await tx`update mesocycles set intent = ${newIntent} where id = ${m.id}`;
          }
          // A replaced intent is snapshotted on the decision row: the decision log
          // is the plan's history now that no table holds prior numbers.
          await tx`
      insert into mesocycle_decisions
        (mesocycle_id, what_changed, why, request_id, prior_intent)
      values (${m.id}, ${whatChanged}, ${why}, ${b.request_id},
        ${newIntent === null ? null : m.intent})`;
        });

        return { mesocycle: await mesocycleDetail(m.id) };
      },
    });
    return c.json(answer, 200);
  },
);

// A decision that changes nothing (review outcome: hold; early end reasoning;
// a local back-off or a declared light week — see tasks/programming).
mesocycles.openapi(
  createRoute({
    method: "post",
    path: "/{id}/decisions",
    tags: ["Planning"],
    summary: "Record a decision that changed nothing",
    description:
      'A review outcome of "hold", the reasoning behind an early end, a local back-off, a declared light week.',
    request: {
      query: query({}),
      params: z.object({ id: selector() }),
      body: {
        content: {
          "application/json": {
            schema: body({
              what_changed: text(),
              why: text(),
              request_id: requestId(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The decision that was recorded.",
        content: {
          "application/json": { schema: z.object({ decision: Recorded }) },
        },
      },
      200: {
        description:
          "The decision this request_id already recorded. A retry, answered with the original result.",
        content: {
          "application/json": { schema: z.object({ decision: Recorded }) },
        },
      },
    },
  }),
  async (c) => {
    const m = await resolveMesocycle(c.req.valid("param").id);
    const b = c.req.valid("json");

    const { body: answer, status } = await writeOnce({
      table: "mesocycle_decisions",
      requestId: b.request_id,
      select: sql`id, mesocycle_id, made_at, what_changed, why`,
      replay: (existing: RecordedRow) => ({ decision: existing }),
      write: async () => {
        const [row] = await sql<RecordedRow[]>`
        insert into mesocycle_decisions
          (mesocycle_id, what_changed, why, request_id)
        values (${m.id}, ${b.what_changed}, ${b.why}, ${b.request_id})
        returning id, mesocycle_id, made_at, what_changed, why`;
        return { decision: row };
      },
    });
    return c.json(answer, status);
  },
);

mesocycles.openapi(
  createRoute({
    method: "get",
    path: "/{id}/decisions",
    tags: ["Planning"],
    summary: "The plan's decision log",
    description:
      "Every change to the plan carries one, so this is the plan's history — including the intent each revision replaced.",
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
  async (c) => {
    const m = await resolveMesocycle(c.req.valid("param").id);
    const rows = await sql<z.infer<typeof Decision>[]>`
    select id, made_at, what_changed, why, prior_intent
    from mesocycle_decisions
    where mesocycle_id = ${m.id}
    order by made_at, id`;
    return c.json({ mesocycle_id: m.id, decisions: rows });
  },
);
