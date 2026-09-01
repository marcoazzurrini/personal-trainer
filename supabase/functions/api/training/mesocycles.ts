// The plan's judgment — load goals, progression, deload rules, what would
// force a rethink — lives in the mesocycle's intent, not in tables. The
// exercise list is the plan's nouns, and the weekly dose is the one number
// that is structured, because the server computes behind-and-ahead from it
// at every session generation.

import { sql, type Tx } from "../db.ts";
import { ApiError } from "../http/errors.ts";
import { romeDate } from "../shared/calendar.ts";
import { writeOnce } from "../shared/idempotency.ts";
import {
  exerciseName,
  resolveExercise,
  resolveExerciseId,
  resolveMesocycle,
} from "./resolve.ts";
import {
  assertDoseUnit,
  type DoseUnit,
  type Role,
  type Track,
} from "./rules.ts";

export interface PlanExerciseRow {
  id: number;
  exercise_id: number;
  exercise: string;
  measure: string;
  role: Role;
  priority: number;
  weekly_dose: number;
  weekly_dose_unit: DoseUnit;
  notes: string | null;
}

export interface MesocycleDetail {
  id: number;
  block_id: number;
  name: string;
  track: Track;
  /** The plan's judgment in prose. Never arithmetic. */
  intent: string;
  planned_weeks: number;
  sessions_per_week: number;
  started_on: string;
  ended_on: string | null;
  /** Null until the plan starts. */
  week: number | null;
  exercises: PlanExerciseRow[];
}

export interface DecisionRow {
  id: number;
  made_at: string;
  what_changed: string;
  why: string;
  prior_intent: string | null;
}

/** A decision as the write answers it: named by its plan, no prior intent. */
export type RecordedRow = Omit<DecisionRow, "prior_intent"> & {
  mesocycle_id: number;
};

// Which week of the plan today falls in, asked of Postgres against the same
// Rome clock that stamps every other day in this system. Week 1 is the week
// containing started_on, so a plan that has not started yet computes to zero
// or less — which planWeekOrNull turns into the null the document promises.
//
// Written once because it is stated in two places: the plan detail below, and
// the active plans in training state. Two spellings of one arithmetic is how
// a plan reads as week 4 on one endpoint and week 3 on another.
export function planWeekSince(startedOn = sql`started_on`) {
  return sql`((((${romeDate()}) - ${startedOn}) / 7) + 1)::int`;
}

export function planWeekOrNull(week: number): number | null {
  return week < 1 ? null : week;
}

export interface PlanExercise {
  exerciseId: number;
  role: Role;
  priority: number;
  weeklyDose: number;
  weeklyDoseUnit: DoseUnit;
  notes: string | null;
}

/** What one entry of the exercise list may carry, retired names included. */
export interface PlanEntry {
  exercise?: string | number;
  role: Role;
  priority: number;
  weekly_dose: number;
  weekly_dose_unit: DoseUnit;
  notes?: string | null;
  weekly_sets?: unknown;
  load_target?: unknown;
}

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
export async function mesocycleDetail(id: number): Promise<MesocycleDetail> {
  // week arrives as a plain int and becomes null below when the plan has not
  // started, so it is typed here as the column and not as the field.
  const [m] = await sql<
    Array<Omit<MesocycleDetail, "week" | "exercises"> & { week: number }>
  >`
    select id, block_id, name, track, intent, planned_weeks,
      sessions_per_week, started_on, ended_on,
      ${planWeekSince()} as week
    from mesocycles where id = ${id}`;
  const exercises = await sql<PlanExerciseRow[]>`
    select me.id, e.id as exercise_id, e.name as exercise, e.measure,
      me.role, me.priority, me.weekly_dose::float8, me.weekly_dose_unit,
      me.notes
    from mesocycle_exercises me
    join exercises e on e.id = me.exercise_id
    where me.mesocycle_id = ${id}
    order by me.priority, e.name`;
  return {
    ...m,
    week: planWeekOrNull(m.week),
    exercises,
  };
}

export async function mesocycleByRef(ref: string): Promise<MesocycleDetail> {
  return await mesocycleDetail((await resolveMesocycle(ref)).id);
}

/**
 * Creates a plan complete: intent plus exercise list, in one transaction.
 * A retry with the same request_id answers with the original result.
 */
export async function createMesocycle(b: {
  block_id: number;
  name: string;
  track: Track;
  intent: string;
  started_on: string;
  planned_weeks: number;
  sessions_per_week: number;
  exercises: PlanEntry[];
  request_id: string;
}): Promise<{ mesocycle: MesocycleDetail; created: boolean }> {
  const { body: mesocycle, status } = await writeOnce<
    { id: number },
    MesocycleDetail,
    MesocycleDetail
  >({
    table: "mesocycles",
    requestId: b.request_id,
    select: sql`id`,
    replay: (seen) => mesocycleDetail(seen.id),
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

      return await mesocycleDetail(id);
    },
  });
  return { mesocycle, created: status === 201 };
}

/**
 * Renames a plan.
 *
 * The name is a label on the plan, not the plan. Everything that is the plan —
 * exercises, dose, intent, and ending it — changes through a decision.
 */
export async function renameMesocycle(ref: string, b: {
  name: string;
  intent?: unknown;
  ended_on?: unknown;
}): Promise<MesocycleDetail> {
  const m = await resolveMesocycle(ref);
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
  return await mesocycleDetail(m.id);
}

export interface DecisionInput {
  what_changed: string;
  why: string;
  intent?: string | null;
  add?: PlanEntry[];
  remove?: Array<string | number>;
  redose?: Array<
    {
      exercise?: string | number;
      weekly_dose: number;
      weekly_dose_unit: DoseUnit;
    }
  >;
  ended_on?: string | null;
  weekly_sets?: unknown;
  load_targets?: unknown;
  request_id: string;
}

/**
 * The one door onto a plan's history, and the only way the plan changes.
 *
 * Send change fields and the call changes the plan; send none and it is a
 * review that deliberately changed nothing. Both append the same row for the
 * same reason — the log is the plan's history — and neither is accepted
 * without what changed and why.
 *
 * This was two endpoints and a hole until #38. `/revisions` refused a call
 * that changed nothing and pointed at `/decisions`; `/decisions` existed only
 * for the case `/revisions` refused; and `PATCH ended_on` changed the plan
 * without writing here at all, so the one change that most needed a reason
 * was the only one never asked for one. Two doors onto one drawer, and the
 * drawer could not say which door had filled it — which is how a retry came
 * to answer 200 for work that never happened.
 */
export async function recordDecision(
  ref: string,
  b: DecisionInput,
): Promise<
  { mesocycle: MesocycleDetail; decision: RecordedRow; created: boolean }
> {
  const m = await resolveMesocycle(ref);

  const { body: answer, status } = await writeOnce<
    RecordedRow,
    { mesocycle: MesocycleDetail; decision: RecordedRow },
    { mesocycle: MesocycleDetail; decision: RecordedRow }
  >({
    table: "mesocycle_decisions",
    requestId: b.request_id,
    select: sql`id, mesocycle_id, made_at, what_changed, why`,
    // Scoped to the plan, because one table-wide id was enough to replay
    // one plan's decision as another's.
    scope: sql`and mesocycle_id = ${m.id}`,
    replay: async (existing) => ({
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
      const newDoses: { exerciseId: number; dose: number; unit: DoseUnit }[] =
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
            throw new ApiError(
              422,
              `"${await exerciseName(
                tx,
                exerciseId,
              )}" is not in this mesocycle's plan, so it cannot be removed. GET /mesocycles/${m.id} shows the plan.`,
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
            throw new ApiError(
              422,
              `"${await exerciseName(
                tx,
                d.exerciseId,
              )}" is not in this mesocycle's plan, so its dose cannot be changed. Add it with "add" instead, or GET /mesocycles/${m.id} to see the plan.`,
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
  return { ...answer, created: status === 201 };
}

/**
 * The plan's decision log, oldest first.
 *
 * Every change to the plan carries one and every review that changed nothing
 * leaves one, so this is the plan's history — including the intent each
 * replacement displaced.
 */
export async function decisionLog(
  ref: string,
): Promise<{ mesocycle_id: number; decisions: DecisionRow[] }> {
  const m = await resolveMesocycle(ref);
  return {
    mesocycle_id: m.id,
    decisions: await sql<DecisionRow[]>`
    select id, made_at, what_changed, why, prior_intent
    from mesocycle_decisions
    where mesocycle_id = ${m.id}
    order by made_at, id`,
  };
}
