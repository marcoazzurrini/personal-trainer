import type { MesocyclesRepository } from "@trainer/db/repositories/training/mesocycles.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import {
  Conflict,
  DatabaseFailure,
  Invalid,
  requireRow,
} from "../shared/refusals.ts";
import type { NotFound } from "../shared/refusals.ts";
import {
  date,
  decimal,
  now,
  requestId,
  romeDate,
  today,
  wireInstant,
} from "../shared/values.ts";
import type {
  CreateMesocycleInput,
  DecisionInput,
  DecisionRow,
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
): Effect.Effect<MesocycleDetail, NotFound> {
  return requireRow(current.headers, `No mesocycle with id ${key}.`).pipe(
    Effect.map((header) => ({
      ...header,
      week: header.week < 1 ? null : header.week,
      exercises: current.exercises,
    }))
  );
}

// The decision batch's membership assertion, and nothing else.
function planChanged<E>(error: E): boolean {
  return (
    error instanceof DatabaseFailure &&
    error.kind === "check" &&
    error.subject === "api_plan_membership_changed"
  );
}

export function mesocycleStore(
  rows: MesocyclesRepository,
  resolver: ReturnType<typeof trainingResolver>
) {
  const repository = effectful(rows);

  const mesocycleDetail = Effect.fn("mesocycles.mesocycleDetail")(function* (
    id: number
  ): Effect.fn.Return<MesocycleDetail, NotFound | DatabaseFailure> {
    return yield* detail(yield* repository.read(id, yield* today), id);
  });
  const mesocycleByRef = Effect.fn("mesocycles.mesocycleByRef")(function* (
    ref: string
  ): Effect.fn.Return<MesocycleDetail, Invalid | NotFound | DatabaseFailure> {
    return yield* mesocycleDetail((yield* resolver.resolveMesocycle(ref)).id);
  });

  // Bulk lookup also serves large plans without spending one D1 query per noun.
  const prepare = Effect.fnUntraced(function* (
    entries: PlanEntry[],
    removals: (string | number)[] = [],
    redoses: NonNullable<DecisionInput["redose"]> = []
  ) {
    const references = yield* resolver.forSets([
      ...entries,
      ...removals.map((exercise) => ({ exercise })),
      ...redoses,
    ]);
    const remove = [];
    for (const ref of removals) {
      remove.push(yield* references.resolveExercise(ref));
    }
    const add: PlanExercise[] = [];
    for (const entry of entries) {
      if (entry.weekly_sets !== undefined) {
        return yield* new Invalid({
          message:
            'The weekly dose is "weekly_dose" plus "weekly_dose_unit" (sets, minutes, or km), so that work in metres and minutes can be dosed too. An exercise entry is {exercise, role, priority, weekly_dose, weekly_dose_unit, notes?}.',
        });
      }
      if (entry.load_target !== undefined) {
        return yield* new Invalid({
          message:
            "Load targets are not stored in tables: the intent carries the plan's goals and its progression mechanism (see tasks/programming). Only the weekly dose is structured.",
        });
      }
      const exercise = yield* references.resolveExercise(entry.exercise);
      yield* assertDoseUnit(
        exercise.measure,
        entry.weekly_dose_unit,
        exercise.name
      );
      yield* decimal(entry.weekly_dose, 6, 1);
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
      const exercise = yield* references.resolveExercise(entry.exercise);
      yield* assertDoseUnit(
        exercise.measure,
        entry.weekly_dose_unit,
        exercise.name
      );
      yield* decimal(entry.weekly_dose, 6, 1);
      redose.push({
        exerciseId: exercise.id,
        name: exercise.name,
        dose: entry.weekly_dose,
        unit: entry.weekly_dose_unit,
      });
    }
    return { remove, add, redose };
  });

  const seenPlan = Effect.fnUntraced(function* (uuid: string) {
    const [seen] = yield* repository.findRequest(uuid);
    return seen ? yield* mesocycleDetail(seen.id) : undefined;
  });
  const createMesocycle = Effect.fn("mesocycles.createMesocycle")(function* (
    b: CreateMesocycleInput
  ): Effect.fn.Return<
    { mesocycle: MesocycleDetail; created: boolean },
    Invalid | NotFound | DatabaseFailure
  > {
    const uuid = yield* requestId(b.request_id);
    const seen = yield* seenPlan(uuid);
    if (seen) {
      return { mesocycle: seen, created: false };
    }
    return yield* Effect.gen(function* () {
      const prepared = yield* prepare(b.exercises);
      const at = yield* now;
      const start = yield* date(b.started_on);
      const results = yield* repository.create({
        ...b,
        started_on: start,
        request_id: uuid,
        exercises: prepared.add,
        now: at,
        today: yield* romeDate(at),
      });
      return { mesocycle: yield* detail(results, uuid), created: true };
    }).pipe(
      // Recover a concurrent replay or a confirmed completed request by reading
      // its key, never by retrying an uncertain non-idempotent write. Anything
      // that failed, defects included, is first checked against the key.
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const replay = yield* seenPlan(uuid);
          if (replay) {
            return { mesocycle: replay, created: false };
          }
          return yield* Effect.failCause(cause);
        })
      )
    );
  });
  const renameMesocycle = Effect.fn("mesocycles.renameMesocycle")(function* (
    ref: string,
    b: RenameMesocycleInput
  ): Effect.fn.Return<MesocycleDetail, Invalid | NotFound | DatabaseFailure> {
    const m = yield* resolver.resolveMesocycle(ref);
    if (b.intent !== undefined) {
      return yield* new Invalid({
        message:
          "The intent is the plan; changing it is a decision. POST /mesocycles/:id/decisions with the full replacement intent, what changed, and why.",
      });
    }
    if (b.ended_on !== undefined) {
      return yield* new Invalid({
        message:
          'Ending a plan is a plan change, so it carries its reason: POST /mesocycles/:id/decisions with {"ended_on": "YYYY-MM-DD", "what_changed": …, "why": …}.',
      });
    }
    const results = yield* repository.rename(m.id, b.name, yield* today);
    return yield* detail(results, m.id);
  });

  const seenDecision = Effect.fnUntraced(function* (id: number, uuid: string) {
    const [seen] = yield* repository.findDecision(id, uuid);
    return seen
      ? {
          mesocycle: yield* mesocycleDetail(id),
          decision: publicDecision(seen),
          created: false,
        }
      : undefined;
  });
  const recordDecision = Effect.fn("mesocycles.recordDecision")(function* (
    ref: string,
    b: DecisionInput
  ): Effect.fn.Return<
    { mesocycle: MesocycleDetail; decision: RecordedRow; created: boolean },
    Invalid | NotFound | Conflict | DatabaseFailure
  > {
    const m = yield* resolver.resolveMesocycle(ref);
    const uuid = yield* requestId(b.request_id);
    const write = Effect.gen(function* () {
      if (b.weekly_sets !== undefined) {
        return yield* new Invalid({
          message:
            'Dose changes are "redose": [{exercise, weekly_dose, weekly_dose_unit}], for exercises already in the plan.',
        });
      }
      if (b.load_targets !== undefined) {
        return yield* new Invalid({
          message:
            'Load targets are not stored in tables: a change to a goal or to the progression mechanism is an intent change. Send "intent" with the full replacement text (see tasks/programming).',
        });
      }
      const inputs = yield* prepare(
        b.add ?? [],
        b.remove ?? [],
        b.redose ?? []
      );
      const members = new Set(
        (yield* repository.members(m.id)).map((row) => row.exercise_id)
      );
      for (const exercise of inputs.remove) {
        if (!members.delete(exercise.id)) {
          return yield* new Invalid({
            message: `"${exercise.name}" is not in this mesocycle's plan, so it cannot be removed. GET /mesocycles/${m.id} shows the plan.`,
          });
        }
      }
      for (const entry of inputs.add) {
        members.add(entry.exerciseId);
      }
      for (const entry of inputs.redose) {
        if (!members.has(entry.exerciseId)) {
          return yield* new Invalid({
            message: `"${entry.name}" is not in this mesocycle's plan, so its dose cannot be changed. Add it with "add" instead, or GET /mesocycles/${m.id} to see the plan.`,
          });
        }
      }
      const at = yield* now;
      const day = yield* romeDate(at);
      const newIntent = b.intent ?? null;
      const endedOn = yield* optionalDate(b.ended_on);
      const results = yield* repository.record({
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
        now: at,
        today: day,
      });
      return {
        mesocycle: yield* detail(results, m.id),
        decision: publicDecision(
          yield* requireRow(
            results.decisions,
            "The decision could not be read after saving."
          )
        ),
        created: true,
      };
    });
    // Each attempt reads the key first. Whatever the write failed with,
    // defects included, a replay found under the key answers instead; only a
    // stale membership assertion is attempted again.
    const attempt = Effect.gen(function* () {
      const seen = yield* seenDecision(m.id, uuid);
      if (seen) {
        return seen;
      }
      return yield* write.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const replay = yield* seenDecision(m.id, uuid);
            if (replay) {
              return replay;
            }
            return yield* Effect.failCause(cause);
          })
        )
      );
    });
    return yield* attempt.pipe(
      // Three attempts in all: the first and two retries.
      Effect.retry({ times: 2, while: planChanged }),
      Effect.mapError((error) =>
        planChanged(error)
          ? new Conflict({
              message: `The plan kept changing. Nothing was saved by this request. Read GET /mesocycles/${m.id} before retrying.`,
            })
          : error
      )
    );
  });
  const decisionLog = Effect.fn("mesocycles.decisionLog")(function* (
    ref: string
  ): Effect.fn.Return<
    { mesocycle_id: number; decisions: DecisionRow[] },
    Invalid | NotFound | DatabaseFailure
  > {
    const m = yield* resolver.resolveMesocycle(ref);
    const decisions = yield* repository.decisions(m.id);
    return {
      mesocycle_id: m.id,
      decisions: decisions.map((row) => ({
        ...row,
        made_at: wireInstant(row.made_at),
      })),
    };
  });
  return {
    mesocycleDetail,
    mesocycleByRef,
    createMesocycle,
    renameMesocycle,
    recordDecision,
    decisionLog,
  };
}

function optionalDate(
  value: string | null | undefined
): Effect.Effect<string | null, Invalid> {
  return value === null || value === undefined
    ? Effect.succeed(null)
    : date(value);
}
