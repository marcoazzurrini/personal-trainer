import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql, type Tx } from "../db.ts";
import { ApiError } from "../http/errors.ts";
import { romeDate } from "../record/calendar.ts";
import { writeOnce } from "../record/idempotency.ts";
import {
  resolveExercise,
  resolveExerciseId,
  resolveMesocycle,
} from "../training/resolve.ts";
import {
  assertDoseUnit,
  DOSE_UNITS,
  ROLES,
  TRACKS,
} from "../training/rules.ts";
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

// A decision as the write answers it: named by its plan, and without the
// prior intent, which only an intent replacement carries. Declared once so the
// query returning it is typed by the same shape the document promises.
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
// decision's additions, so the caller learns it once).
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
// the plan is being created, today when an exercise joins by decision.
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

// The name is a label on the plan, not the plan. Everything that is the plan
// — exercises, dose, intent, and ending it — changes through a decision.
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
  async (c) => {
    const m = await resolveMesocycle(c.req.valid("param").id);
    const b = c.req.valid("json");
    if (b.intent !== undefined) {
      throw new ApiError(
        422,
        "The intent is the plan; changing it is a decision. POST /mesocycles/:id/decisions with the full replacement intent, what changed, and why.",
      );
    }
    if (b.ended_on !== undefined) {
      throw new ApiError(
        422,
        'Ending a plan is a plan change, so it carries its reason: POST /mesocycles/:id/decisions with {"ended_on": "YYYY-MM-DD", "what_changed": …, "why": …}.',
      );
    }
    await sql`update mesocycles set name = ${b.name} where id = ${m.id}`;
    return c.json({ mesocycle: await mesocycleDetail(m.id) });
  },
);

// The one door onto a plan's history, and the only way the plan changes.
//
// Send change fields and the call changes the plan; send none and it is a
// review that deliberately changed nothing. Both append the same row for the
// same reason — the log is the plan's history — and neither is accepted
// without what changed and why.
//
// This was two endpoints and a hole until #38. `/revisions` refused a call
// that changed nothing and pointed at `/decisions`; `/decisions` existed only
// for the case `/revisions` refused; and `PATCH ended_on` changed the plan
// without writing here at all, so the one change that most needed a reason
// was the only one never asked for one. Two doors onto one drawer, and the
// drawer could not say which door had filled it — which is how a retry came
// to answer 200 for work that never happened.
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
    const m = await resolveMesocycle(c.req.valid("param").id);
    const b = c.req.valid("json");

    const { body: answer, status } = await writeOnce({
      table: "mesocycle_decisions",
      requestId: b.request_id,
      select: sql`id, mesocycle_id, made_at, what_changed, why`,
      // Scoped to the plan, because one table-wide id was enough to replay
      // one plan's decision as another's.
      scope: sql`and mesocycle_id = ${m.id}`,
      replay: async (existing: RecordedRow) => ({
        mesocycle: await mesocycleDetail(m.id),
        decision: existing,
      }),
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

        const newIntent = b.intent ?? null;
        // Absent leaves the end date alone; an explicit null reopens a plan
        // ended by mistake, which is why this asks for undefined and not for
        // a falsy value.
        const endsPlan = b.ended_on !== undefined;
        const removals = b.remove ?? [];
        const additions = b.add ?? [];
        const redoses = b.redose ?? [];

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

        const decision = await sql.begin(async (tx) => {
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
          if (endsPlan) {
            await tx`update mesocycles set ended_on = ${
              b.ended_on ?? null
            } where id = ${m.id}`;
          }
          // A replaced intent is snapshotted on the decision row: the decision log
          // is the plan's history now that no table holds prior numbers.
          const [row] = await tx<RecordedRow[]>`
      insert into mesocycle_decisions
        (mesocycle_id, what_changed, why, request_id, prior_intent)
      values (${m.id}, ${b.what_changed}, ${b.why}, ${b.request_id},
        ${newIntent === null ? null : m.intent})
      returning id, mesocycle_id, made_at, what_changed, why`;
          return row;
        });

        return {
          mesocycle: await mesocycleDetail(m.id),
          decision,
        };
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
