import { Hono } from "@hono/hono";
import { sql, type Tx } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import { resolveExerciseId, resolveMesocycle } from "../lib/resolve.ts";
import {
  type Body,
  optionalDate,
  optionalString,
  readJson,
  requireDate,
  requireInt,
  requireOneOf,
  requireString,
  requireUuid,
} from "../lib/validate.ts";

const ROLES = ["main", "accessory"] as const;

// The plan's numbers — weekly doses, load goals, progression — live in the
// mesocycle's intent, not in tables. The exercise list is the plan's nouns.

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

interface PlanExercise {
  exerciseId: number;
  role: string;
  priority: number;
  notes: string | null;
}

// Validates one entry of the exercise list (same shape in creation and in a
// revision's additions, so the caller learns it once).
async function parsePlanExercise(entry: unknown): Promise<PlanExercise> {
  if (typeof entry !== "object" || entry === null) {
    throw new ApiError(422, 'Each entry in "exercises" must be an object.');
  }
  const e = entry as Body;
  if ("weekly_sets" in e || "load_target" in e) {
    throw new ApiError(
      422,
      "Weekly sets and load targets are not stored in tables: the intent carries the plan's numbers (see tasks/programming). An exercise entry is {exercise, role, priority, notes?}.",
    );
  }
  return {
    exerciseId: await resolveExerciseId(e.exercise),
    role: requireOneOf(e, "role", ROLES),
    priority: requireInt(e, "priority", { min: 1 }),
    notes: optionalString(e, "notes"),
  };
}

async function insertPlanExercise(
  tx: Tx,
  mesocycleId: number,
  p: PlanExercise,
) {
  await tx`
    insert into mesocycle_exercises
      (mesocycle_id, exercise_id, role, priority, notes)
    values
      (${mesocycleId}, ${p.exerciseId}, ${p.role}, ${p.priority}, ${p.notes})`;
}

// The plan, exactly: the mesocycle row (intent included — it is the plan's
// numbers), the exercise list, and which week it is.
async function mesocycleDetail(id: number) {
  const [m] = await sql`
    select id, block_id, name, intent, planned_weeks, sessions_per_week,
      started_on, ended_on,
      ((((now() at time zone 'Europe/Rome')::date - started_on) / 7) + 1)::int as week
    from mesocycles where id = ${id}`;
  const exercises = await sql`
    select me.id, e.id as exercise_id, e.name as exercise, me.role, me.priority,
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

export const mesocycles = new Hono();

// The complete plan in one call and one transaction: intent plus exercise
// list. Retries with the same request_id return the original result.
mesocycles.post("/", async (c) => {
  const body = await readJson(c);
  const requestId = requireUuid(body, "request_id");
  if (requestId) {
    const [existing] = await sql`
      select id from mesocycles where request_id = ${requestId}`;
    if (existing) {
      return c.json({ mesocycle: await mesocycleDetail(existing.id) });
    }
  }

  const blockId = requireInt(body, "block_id");
  const name = requireString(body, "name");
  const intent = requireString(body, "intent");
  const plannedWeeks = requireInt(body, "planned_weeks", { min: 1 });
  const sessionsPerWeek = requireInt(body, "sessions_per_week", { min: 1 });
  const startedOn = requireDate(body, "started_on");

  if (!Array.isArray(body.exercises) || body.exercises.length === 0) {
    throw new ApiError(
      422,
      'A mesocycle arrives complete: "exercises" must be a non-empty array of {exercise, role, priority, notes?}. The doses and goals belong in "intent".',
    );
  }
  const plan: PlanExercise[] = [];
  for (const entry of body.exercises) {
    plan.push(await parsePlanExercise(entry));
  }

  const id = await sql.begin(async (tx) => {
    const [m] = await tx`
      insert into mesocycles
        (block_id, name, intent, planned_weeks, sessions_per_week, started_on, request_id)
      values
        (${blockId}, ${name}, ${intent}, ${plannedWeeks}, ${sessionsPerWeek},
         ${startedOn}, ${requestId})
      returning id`;
    for (const p of plan) await insertPlanExercise(tx, m.id, p);
    return m.id as number;
  });

  return c.json({ mesocycle: await mesocycleDetail(id) }, 201);
});

mesocycles.get("/:id", async (c) => {
  const m = await resolveMesocycle(c.req.param("id"));
  return c.json({ mesocycle: await mesocycleDetail(m.id) });
});

// Trivial single-field edits only. Structural change goes through revisions.
mesocycles.patch("/:id", async (c) => {
  const m = await resolveMesocycle(c.req.param("id"));
  const body = await readJson(c);
  const fields: Record<string, unknown> = {};
  if ("name" in body) fields.name = requireString(body, "name");
  if ("ended_on" in body) fields.ended_on = optionalDate(body, "ended_on");
  if ("intent" in body) {
    throw new ApiError(
      422,
      "The intent is the plan; changing it is a revision. POST /api/mesocycles/:id/revisions with the full replacement intent and a decision.",
    );
  }
  if (Object.keys(fields).length === 0) {
    throw new ApiError(
      422,
      'Send at least one of "name", "ended_on". Structural changes (exercises, intent) go through POST /api/mesocycles/:id/revisions.',
    );
  }
  await sql`update mesocycles set ${sql(fields)} where id = ${m.id}`;
  return c.json({ mesocycle: await mesocycleDetail(m.id) });
});

// The mid-mesocycle revision: exercise-list changes and/or a full intent
// replacement, plus a required decision — all-or-nothing, one transaction.
// There is no way to change the plan without saying why.
mesocycles.post("/:id/revisions", async (c) => {
  const m = await resolveMesocycle(c.req.param("id"));
  const body = await readJson(c);

  const requestId = requireUuid(body, "request_id");
  {
    const [existing] = await sql`
      select id from mesocycle_decisions where request_id = ${requestId}`;
    if (existing) {
      return c.json({ mesocycle: await mesocycleDetail(m.id) });
    }
  }

  if ("weekly_sets" in body || "load_targets" in body) {
    throw new ApiError(
      422,
      'Weekly sets and load targets are not stored in tables: dose and goal changes are intent changes. Send "intent" with the full replacement text (see tasks/programming).',
    );
  }

  if (typeof body.decision !== "object" || body.decision === null) {
    throw new ApiError(
      422,
      'A revision is rejected without its decision. Send "decision": {"what_changed": "...", "why": "..."}.',
    );
  }
  const decision = body.decision as Body;
  const whatChanged = requireString(decision, "what_changed");
  const why = requireString(decision, "why");

  const newIntent = optionalString(body, "intent");
  const removals = body.remove ?? [];
  const additions = body.add ?? [];
  if (!Array.isArray(removals) || !Array.isArray(additions)) {
    throw new ApiError(
      422,
      '"remove" and "add" must be arrays when present.',
    );
  }
  if (removals.length + additions.length === 0 && newIntent === null) {
    throw new ApiError(
      422,
      'The revision changes nothing. Send at least one of: "remove" (exercise refs), "add" (plan entries), "intent" (the full replacement text). A review outcome with no change ("hold") is recorded with POST /api/mesocycles/:id/decisions instead.',
    );
  }

  // Resolve everything before touching the database.
  const removeIds: number[] = [];
  for (const ref of removals) removeIds.push(await resolveExerciseId(ref));
  const addPlans: PlanExercise[] = [];
  for (const entry of additions) {
    addPlans.push(await parsePlanExercise(entry));
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
          `"${e.name}" is not in this mesocycle's plan, so it cannot be removed. GET /api/mesocycles/${m.id} shows the plan.`,
        );
      }
      await tx`delete from mesocycle_exercises where id = ${row.id}`;
    }
    for (const p of addPlans) await insertPlanExercise(tx, m.id, p);
    if (newIntent !== null) {
      await tx`update mesocycles set intent = ${newIntent} where id = ${m.id}`;
    }
    // A replaced intent is snapshotted on the decision row: the decision log
    // is the plan's history now that no table holds prior numbers.
    await tx`
      insert into mesocycle_decisions
        (mesocycle_id, what_changed, why, request_id, prior_intent)
      values (${m.id}, ${whatChanged}, ${why}, ${requestId},
        ${newIntent === null ? null : m.intent})`;
  });

  return c.json({ mesocycle: await mesocycleDetail(m.id) });
});

// A decision that changes nothing (review outcome: hold; early end reasoning;
// a local back-off or a declared light week — see tasks/programming).
mesocycles.post("/:id/decisions", async (c) => {
  const m = await resolveMesocycle(c.req.param("id"));
  const body = await readJson(c);
  const [row] = await sql`
    insert into mesocycle_decisions (mesocycle_id, what_changed, why, request_id)
    values (${m.id}, ${requireString(body, "what_changed")},
      ${requireString(body, "why")}, ${requireUuid(body, "request_id")})
    returning id, mesocycle_id, made_at, what_changed, why`;
  return c.json({ decision: row }, 201);
});

mesocycles.get("/:id/decisions", async (c) => {
  const m = await resolveMesocycle(c.req.param("id"));
  const rows = await sql`
    select id, made_at, what_changed, why, prior_intent
    from mesocycle_decisions
    where mesocycle_id = ${m.id}
    order by made_at, id`;
  return c.json({ mesocycle_id: m.id, decisions: rows });
});
