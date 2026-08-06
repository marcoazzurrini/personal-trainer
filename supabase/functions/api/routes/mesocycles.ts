import { Hono } from "@hono/hono";
import { sql, type Tx } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import { resolveExerciseId, resolveMesocycle } from "../lib/resolve.ts";
import {
  type Body,
  optionalDate,
  optionalInt,
  optionalNumber,
  optionalString,
  optionalUuid,
  readJson,
  requireDate,
  requireInt,
  requireOneOf,
  requireString,
} from "../lib/validate.ts";

const ROLES = ["main", "accessory"] as const;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

interface PlanExercise {
  exerciseId: number;
  role: string;
  priority: number;
  notes: string | null;
  weeklySets: { week: number; sets: number }[];
  loadTarget: {
    targetWeightKg: number;
    targetReps: number;
    baselineWeightKg: number | null;
    baselineReps: number | null;
    byWeek: number | null;
  } | null;
}

// Validates one entry of the nested exercise list (same shape in creation
// and in a revision's additions, so the caller learns it once).
async function parsePlanExercise(
  entry: unknown,
  plannedWeeks: number,
): Promise<PlanExercise> {
  if (typeof entry !== "object" || entry === null) {
    throw new ApiError(422, 'Each entry in "exercises" must be an object.');
  }
  const e = entry as Body;
  const exerciseId = await resolveExerciseId(e.exercise);

  const weeklyRaw = e.weekly_sets;
  if (!Array.isArray(weeklyRaw) || weeklyRaw.length === 0) {
    throw new ApiError(
      422,
      '"weekly_sets" is required on every exercise: an array of {"week": N, "sets": N} rows, one per week. This table carries the whole progression.',
    );
  }
  const weeks = new Set<number>();
  const weeklySets = weeklyRaw.map((row) => {
    const r = row as Body;
    const week = requireInt(r, "week", { min: 1 });
    const sets = requireInt(r, "sets", { min: 0 });
    if (week > plannedWeeks) {
      throw new ApiError(
        422,
        `weekly_sets week ${week} is beyond planned_weeks (${plannedWeeks}).`,
      );
    }
    if (weeks.has(week)) {
      throw new ApiError(422, `weekly_sets lists week ${week} twice.`);
    }
    weeks.add(week);
    return { week, sets };
  });

  let loadTarget: PlanExercise["loadTarget"] = null;
  if (e.load_target !== undefined && e.load_target !== null) {
    if (typeof e.load_target !== "object") {
      throw new ApiError(422, '"load_target" must be an object when present.');
    }
    const t = e.load_target as Body;
    const baselineWeightKg = optionalNumber(t, "baseline_weight_kg", {
      min: 0,
    });
    const baselineReps = optionalInt(t, "baseline_reps", { min: 1 });
    if ((baselineWeightKg === null) !== (baselineReps === null)) {
      throw new ApiError(
        422,
        'The baseline is a pair: send both "baseline_weight_kg" and "baseline_reps", or neither.',
      );
    }
    loadTarget = {
      targetWeightKg: (() => {
        const v = optionalNumber(t, "target_weight_kg", { min: 0 });
        if (v === null) {
          throw new ApiError(
            422,
            '"target_weight_kg" is required on a load target.',
          );
        }
        return v;
      })(),
      targetReps: requireInt(t, "target_reps", { min: 1 }),
      baselineWeightKg,
      baselineReps,
      byWeek: optionalInt(t, "by_week", { min: 1 }),
    };
  }

  return {
    exerciseId,
    role: requireOneOf(e, "role", ROLES),
    priority: requireInt(e, "priority", { min: 1 }),
    notes: optionalString(e, "notes"),
    weeklySets,
    loadTarget,
  };
}

async function insertPlanExercise(
  tx: Tx,
  mesocycleId: number,
  p: PlanExercise,
) {
  const [me] = await tx`
    insert into mesocycle_exercises
      (mesocycle_id, exercise_id, role, priority, notes)
    values
      (${mesocycleId}, ${p.exerciseId}, ${p.role}, ${p.priority}, ${p.notes})
    returning id`;
  for (const { week, sets } of p.weeklySets) {
    await tx`
      insert into mesocycle_weekly_exercise_sets (mesocycle_exercise_id, week, sets)
      values (${me.id}, ${week}, ${sets})`;
  }
  if (p.loadTarget) {
    const t = p.loadTarget;
    await tx`
      insert into mesocycle_load_targets
        (mesocycle_exercise_id, target_weight_kg, target_reps,
         baseline_weight_kg, baseline_reps, by_week)
      values
        (${me.id}, ${t.targetWeightKg}, ${t.targetReps},
         ${t.baselineWeightKg}, ${t.baselineReps}, ${t.byWeek})`;
  }
}

// The full plan, exactly: mesocycle row, exercise list, weekly sets, load
// targets, and which week it is. Nothing from the training record.
async function mesocycleDetail(id: number) {
  const [m] = await sql`
    select id, block_id, name, intent, planned_weeks, sessions_per_week,
      started_on, ended_on,
      ((((now() at time zone 'Europe/Rome')::date - started_on) / 7) + 1)::int as week
    from mesocycles where id = ${id}`;
  const exercises = await sql`
    select me.id, e.id as exercise_id, e.name as exercise, me.role, me.priority,
      me.notes,
      coalesce(
        (select json_agg(json_build_object('week', ws.week, 'sets', ws.sets)
          order by ws.week)
         from mesocycle_weekly_exercise_sets ws
         where ws.mesocycle_exercise_id = me.id),
        '[]'
      ) as weekly_sets,
      (select json_build_object(
          'target_weight_kg', t.target_weight_kg::float8,
          'target_reps', t.target_reps,
          'baseline_weight_kg', t.baseline_weight_kg::float8,
          'baseline_reps', t.baseline_reps,
          'by_week', t.by_week)
       from mesocycle_load_targets t
       where t.mesocycle_exercise_id = me.id) as load_target
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

// The complete plan in one call and one transaction. A partial plan cannot
// exist. Retries with the same request_id return the original result.
mesocycles.post("/", async (c) => {
  const body = await readJson(c);
  const requestId = optionalUuid(body, "request_id");
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
      'A mesocycle arrives complete: "exercises" must be a non-empty array of {exercise, role, priority, notes?, weekly_sets, load_target?}.',
    );
  }
  const plan: PlanExercise[] = [];
  for (const entry of body.exercises) {
    plan.push(await parsePlanExercise(entry, plannedWeeks));
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
  if ("intent" in body) fields.intent = requireString(body, "intent");
  if ("ended_on" in body) fields.ended_on = optionalDate(body, "ended_on");
  if (Object.keys(fields).length === 0) {
    throw new ApiError(
      422,
      'Send at least one of "name", "intent", "ended_on". Structural changes (exercises, weekly sets, load targets) go through POST /api/mesocycles/:id/revisions.',
    );
  }
  await sql`update mesocycles set ${sql(fields)} where id = ${m.id}`;
  return c.json({ mesocycle: await mesocycleDetail(m.id) });
});

// The mid-mesocycle revision: removals, additions, changed weekly rows and
// load targets, and a required decision — all-or-nothing, one transaction.
// There is no way to change the plan without saying why.
mesocycles.post("/:id/revisions", async (c) => {
  const m = await resolveMesocycle(c.req.param("id"));
  const body = await readJson(c);

  const requestId = optionalUuid(body, "request_id");
  if (requestId) {
    const [existing] = await sql`
      select id from mesocycle_decisions where request_id = ${requestId}`;
    if (existing) {
      return c.json({ mesocycle: await mesocycleDetail(m.id) });
    }
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

  const removals = body.remove ?? [];
  const additions = body.add ?? [];
  const weeklyUpdates = body.weekly_sets ?? [];
  const targetUpdates = body.load_targets ?? [];
  if (
    !Array.isArray(removals) || !Array.isArray(additions) ||
    !Array.isArray(weeklyUpdates) || !Array.isArray(targetUpdates)
  ) {
    throw new ApiError(
      422,
      '"remove", "add", "weekly_sets", and "load_targets" must be arrays when present.',
    );
  }
  if (
    removals.length + additions.length + weeklyUpdates.length +
        targetUpdates.length === 0
  ) {
    throw new ApiError(
      422,
      'The revision changes nothing. Send at least one of: "remove" (exercise refs), "add" (plan entries), "weekly_sets" ({exercise, week, sets} upserts), "load_targets" ({exercise, ...} replacements). A review outcome with no change ("hold") is recorded with POST /api/mesocycles/:id/decisions instead.',
    );
  }

  // Resolve everything before touching the database.
  const removeIds: number[] = [];
  for (const ref of removals) removeIds.push(await resolveExerciseId(ref));
  const addPlans: PlanExercise[] = [];
  for (const entry of additions) {
    addPlans.push(await parsePlanExercise(entry, m.planned_weeks));
  }
  const weekly: { exerciseId: number; week: number; sets: number }[] = [];
  for (const row of weeklyUpdates) {
    const r = row as Body;
    weekly.push({
      exerciseId: await resolveExerciseId(r.exercise),
      week: requireInt(r, "week", { min: 1 }),
      sets: requireInt(r, "sets", { min: 0 }),
    });
  }
  const targets: {
    exerciseId: number;
    t: NonNullable<PlanExercise["loadTarget"]>;
  }[] = [];
  for (const row of targetUpdates) {
    const r = row as Body;
    const parsed = await parsePlanExercise({
      exercise: r.exercise,
      role: "main",
      priority: 1,
      weekly_sets: [{ week: 1, sets: 0 }],
      load_target: r,
    }, m.planned_weeks);
    targets.push({ exerciseId: parsed.exerciseId, t: parsed.loadTarget! });
  }

  async function planRowId(
    tx: Tx,
    exerciseId: number,
    context: string,
  ): Promise<number> {
    const [row] = await tx`
      select me.id from mesocycle_exercises me
      where me.mesocycle_id = ${m.id} and me.exercise_id = ${exerciseId}`;
    if (!row) {
      const [e] = await tx`select name from exercises where id = ${exerciseId}`;
      throw new ApiError(
        422,
        `"${e.name}" is not in this mesocycle's plan, so it cannot be ${context}. GET /api/mesocycles/${m.id} shows the plan.`,
      );
    }
    return row.id;
  }

  await sql.begin(async (tx) => {
    for (const exerciseId of removeIds) {
      const meId = await planRowId(tx, exerciseId, "removed");
      await tx`delete from mesocycle_weekly_exercise_sets where mesocycle_exercise_id = ${meId}`;
      await tx`delete from mesocycle_load_targets where mesocycle_exercise_id = ${meId}`;
      await tx`delete from mesocycle_exercises where id = ${meId}`;
    }
    for (const p of addPlans) await insertPlanExercise(tx, m.id, p);
    for (const w of weekly) {
      const meId = await planRowId(tx, w.exerciseId, "given weekly sets");
      await tx`
        insert into mesocycle_weekly_exercise_sets (mesocycle_exercise_id, week, sets)
        values (${meId}, ${w.week}, ${w.sets})
        on conflict (mesocycle_exercise_id, week)
        do update set sets = excluded.sets`;
    }
    for (const { exerciseId, t } of targets) {
      const meId = await planRowId(tx, exerciseId, "given a load target");
      await tx`delete from mesocycle_load_targets where mesocycle_exercise_id = ${meId}`;
      await tx`
        insert into mesocycle_load_targets
          (mesocycle_exercise_id, target_weight_kg, target_reps,
           baseline_weight_kg, baseline_reps, by_week)
        values
          (${meId}, ${t.targetWeightKg}, ${t.targetReps},
           ${t.baselineWeightKg}, ${t.baselineReps}, ${t.byWeek})`;
    }
    await tx`
      insert into mesocycle_decisions (mesocycle_id, what_changed, why, request_id)
      values (${m.id}, ${whatChanged}, ${why}, ${requestId})`;
  });

  return c.json({ mesocycle: await mesocycleDetail(m.id) });
});

// A decision that changes nothing (review outcome: hold; early end reasoning).
mesocycles.post("/:id/decisions", async (c) => {
  const m = await resolveMesocycle(c.req.param("id"));
  const body = await readJson(c);
  const [row] = await sql`
    insert into mesocycle_decisions (mesocycle_id, what_changed, why, request_id)
    values (${m.id}, ${requireString(body, "what_changed")},
      ${requireString(body, "why")}, ${optionalUuid(body, "request_id")})
    returning id, mesocycle_id, made_at, what_changed, why`;
  return c.json({ decision: row }, 201);
});

mesocycles.get("/:id/decisions", async (c) => {
  const m = await resolveMesocycle(c.req.param("id"));
  const rows = await sql`
    select id, made_at, what_changed, why
    from mesocycle_decisions
    where mesocycle_id = ${m.id}
    order by made_at, id`;
  return c.json({ mesocycle_id: m.id, decisions: rows });
});
