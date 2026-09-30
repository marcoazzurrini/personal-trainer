import { DatabaseFailureError } from "../../db/errors.ts";
import type { MesocyclesRepository } from "../../db/repositories/training/mesocycles.ts";
import { ApiError, databaseError, requireRow } from "../shared/errors.ts";
import {
  date,
  decimal,
  instant,
  requestId,
  romeDate,
  systemClock,
  wireInstant,
} from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import type {
  CreateMesocycleInput,
  DecisionInput,
  MesocycleDetail,
  PlanEntry,
  PlanExercise,
  RecordedRow,
  RenameMesocycleInput,
} from "./mesocycles.types.ts";
import type { trainingResolver } from "./resolve.ts";
import { assertDoseUnit } from "./rules.ts";

const publicDecision = (row: RecordedRow): RecordedRow => ({
  ...row,
  made_at: wireInstant(row.made_at),
});

function detail(
  current: Awaited<ReturnType<MesocyclesRepository["read"]>>,
  key: string | number
): MesocycleDetail {
  const header = requireRow(current.headers, `No mesocycle with id ${key}.`);
  return {
    ...header,
    week: header.week < 1 ? null : header.week,
    exercises: current.exercises,
  };
}
export function mesocycleStore(
  repository: MesocyclesRepository,
  resolver: ReturnType<typeof trainingResolver>,
  clock: Clock = systemClock
) {
  async function mesocycleDetail(id: number): Promise<MesocycleDetail> {
    return detail(
      await repository.read(id, romeDate(instant(clock().toISOString()))),
      id
    );
  }
  async function mesocycleByRef(ref: string) {
    return await mesocycleDetail((await resolver.resolveMesocycle(ref)).id);
  }

  // Bulk lookup also serves large plans without spending one D1 query per noun.
  async function prepare(
    entries: PlanEntry[],
    removals: (string | number)[] = [],
    redoses: NonNullable<DecisionInput["redose"]> = []
  ) {
    const references = await resolver.forSets([
      ...entries,
      ...removals.map((exercise) => ({ exercise })),
      ...redoses,
    ]);
    const remove = [];
    for (const ref of removals) {
      remove.push(await references.resolveExercise(ref));
    }
    const add: PlanExercise[] = [];
    for (const entry of entries) {
      if (entry.weekly_sets !== undefined) {
        throw new ApiError(
          422,
          'The weekly dose is "weekly_dose" plus "weekly_dose_unit" (sets, minutes, or km), so that work in metres and minutes can be dosed too. An exercise entry is {exercise, role, priority, weekly_dose, weekly_dose_unit, notes?}.'
        );
      }
      if (entry.load_target !== undefined) {
        throw new ApiError(
          422,
          "Load targets are not stored in tables: the intent carries the plan's goals and its progression mechanism (see tasks/programming). Only the weekly dose is structured."
        );
      }
      const exercise = await references.resolveExercise(entry.exercise);
      assertDoseUnit(exercise.measure, entry.weekly_dose_unit, exercise.name);
      decimal(entry.weekly_dose, 6, 1);
      add.push({
        exerciseId: exercise.id,
        role: entry.role,
        priority: entry.priority,
        weeklyDose: entry.weekly_dose,
        weeklyDoseUnit: entry.weekly_dose_unit,
        notes: entry.notes ?? null,
      });
    }
    const redose = [];
    for (const entry of redoses) {
      const exercise = await references.resolveExercise(entry.exercise);
      assertDoseUnit(exercise.measure, entry.weekly_dose_unit, exercise.name);
      decimal(entry.weekly_dose, 6, 1);
      redose.push({
        exerciseId: exercise.id,
        name: exercise.name,
        dose: entry.weekly_dose,
        unit: entry.weekly_dose_unit,
      });
    }
    return { remove, add, redose };
  }

  async function seenPlan(uuid: string) {
    const [seen] = await repository.findRequest(uuid);
    return seen ? await mesocycleDetail(seen.id) : undefined;
  }
  async function createMesocycle(b: CreateMesocycleInput) {
    const uuid = requestId(b.request_id);
    const seen = await seenPlan(uuid);
    if (seen) {
      return { mesocycle: seen, created: false };
    }
    try {
      const prepared = await prepare(b.exercises);
      const now = instant(clock().toISOString());
      const start = date(b.started_on);
      const results = await repository.create({
        ...b,
        started_on: start,
        request_id: uuid,
        exercises: prepared.add,
        now,
        today: romeDate(now),
      });
      return { mesocycle: detail(results, uuid), created: true };
    } catch (error) {
      // Recover a concurrent replay or a confirmed completed request by reading
      // its key, never by retrying an uncertain non-idempotent write.
      const replay = await seenPlan(uuid);
      if (replay) {
        return { mesocycle: replay, created: false };
      }
      throw databaseError(error);
    }
  }
  async function renameMesocycle(ref: string, b: RenameMesocycleInput) {
    const m = await resolver.resolveMesocycle(ref);
    if (b.intent !== undefined) {
      throw new ApiError(
        422,
        "The intent is the plan; changing it is a decision. POST /mesocycles/:id/decisions with the full replacement intent, what changed, and why."
      );
    }
    if (b.ended_on !== undefined) {
      throw new ApiError(
        422,
        'Ending a plan is a plan change, so it carries its reason: POST /mesocycles/:id/decisions with {"ended_on": "YYYY-MM-DD", "what_changed": …, "why": …}.'
      );
    }
    const results = await repository.rename(
      m.id,
      b.name,
      romeDate(instant(clock().toISOString()))
    );
    return detail(results, m.id);
  }

  async function seenDecision(id: number, uuid: string) {
    const [seen] = await repository.findDecision(id, uuid);
    return seen
      ? {
          mesocycle: await mesocycleDetail(id),
          decision: publicDecision(seen),
          created: false,
        }
      : undefined;
  }
  async function recordDecision(ref: string, b: DecisionInput) {
    const m = await resolver.resolveMesocycle(ref);
    const uuid = requestId(b.request_id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const seen = await seenDecision(m.id, uuid);
      if (seen) {
        return seen;
      }
      try {
        if (b.weekly_sets !== undefined) {
          throw new ApiError(
            422,
            'Dose changes are "redose": [{exercise, weekly_dose, weekly_dose_unit}], for exercises already in the plan.'
          );
        }
        if (b.load_targets !== undefined) {
          throw new ApiError(
            422,
            'Load targets are not stored in tables: a change to a goal or to the progression mechanism is an intent change. Send "intent" with the full replacement text (see tasks/programming).'
          );
        }
        const inputs = await prepare(
          b.add ?? [],
          b.remove ?? [],
          b.redose ?? []
        );
        const members = new Set(
          (await repository.members(m.id)).map((row) => row.exercise_id)
        );
        for (const exercise of inputs.remove) {
          if (!members.delete(exercise.id)) {
            throw new ApiError(
              422,
              `"${exercise.name}" is not in this mesocycle's plan, so it cannot be removed. GET /mesocycles/${m.id} shows the plan.`
            );
          }
        }
        for (const entry of inputs.add) {
          members.add(entry.exerciseId);
        }
        for (const entry of inputs.redose) {
          if (!members.has(entry.exerciseId)) {
            throw new ApiError(
              422,
              `"${entry.name}" is not in this mesocycle's plan, so its dose cannot be changed. Add it with "add" instead, or GET /mesocycles/${m.id} to see the plan.`
            );
          }
        }
        const now = instant(clock().toISOString());
        const today = romeDate(now);
        const newIntent = b.intent ?? null;
        const endedOn = optionalDate(b.ended_on);
        const results = await repository.record({
          mesocycle_id: m.id,
          request_id: uuid,
          what_changed: b.what_changed,
          why: b.why,
          intent: newIntent,
          changeEndedOn: b.ended_on !== undefined,
          ended_on: endedOn,
          remove: inputs.remove.map((exercise) => exercise.id),
          add: inputs.add,
          redose: inputs.redose,
          now,
          today,
        });
        return {
          mesocycle: detail(results, m.id),
          decision: publicDecision(
            requireRow(
              results.decisions,
              "The decision could not be read after saving."
            )
          ),
          created: true,
        };
      } catch (error) {
        const replay = await seenDecision(m.id, uuid);
        if (replay) {
          return replay;
        }
        if (
          error instanceof DatabaseFailureError &&
          error.kind === "check" &&
          error.subject === "api_plan_membership_changed"
        ) {
          continue;
        }
        throw databaseError(error);
      }
    }
    throw new ApiError(
      409,
      `The plan kept changing. Nothing was saved by this request. Read GET /mesocycles/${m.id} before retrying.`
    );
  }
  async function decisionLog(ref: string) {
    const m = await resolver.resolveMesocycle(ref);
    const decisions = await repository.decisions(m.id);
    return {
      mesocycle_id: m.id,
      decisions: decisions.map((row) => ({
        ...row,
        made_at: wireInstant(row.made_at),
      })),
    };
  }
  return {
    mesocycleDetail,
    mesocycleByRef,
    createMesocycle,
    renameMesocycle,
    recordDecision,
    decisionLog,
  };
}

function optionalDate(value: string | null | undefined) {
  return value === null || value === undefined ? null : date(value);
}
