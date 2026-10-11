import type { ResolutionRepository } from "@trainer/db/repositories/training/resolve.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import { Invalid, NotFound, requireRow } from "../shared/refusals.ts";
import type { DatabaseFailure } from "../shared/refusals.ts";
import { caseKey } from "../shared/values.ts";
import { TRACKS } from "./rules.ts";
import type { Measure, StimulusType } from "./rules.ts";

interface Exercise {
  id: number;
  name: string;
  measure: Measure;
  stimulus_type: StimulusType;
}
interface Plan {
  id: number;
  track: string;
}

export interface SetResolver {
  resolveExercise: (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Resolver is the boundary that rejects invalid id/name/alias inputs with the existing refusal.
    ref: unknown
  ) => Effect.Effect<Exercise, Invalid | DatabaseFailure>;
  resolveSetMesocycleId: (
    exerciseId: number,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve coercion and refusal of raw references at the resolver boundary.
    ref: unknown
  ) => Effect.Effect<number | null, Invalid | NotFound | DatabaseFailure>;
}

/** Same id/name/alias and active-plan rules as the PostgreSQL reference. */
export function trainingResolver(rows: ResolutionRepository) {
  const repository = effectful(rows);

  const resolveExercise = Effect.fn("trainingResolver.resolveExercise")(
    function* (
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This function validates raw id/name/alias inputs before issuing a lookup.
      ref: unknown
    ): Effect.fn.Return<Exercise, Invalid | DatabaseFailure> {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Numeric references require a safe-integer check before the id lookup.
      if (typeof ref === "number" && Number.isSafeInteger(ref)) {
        const row = yield* repository.exerciseById(ref);
        if (row) {
          return row;
        }
        return yield* new Invalid({
          message: `No exercise with id ${ref}. GET /exercises lists the catalogue.`,
        });
      }
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- String references require nonempty trimmed text before name/alias lookup.
      if (typeof ref === "string" && ref.trim() !== "") {
        const name = ref.trim();
        const row = yield* repository.exerciseByKey(caseKey(name));
        if (row) {
          return row;
        }
        if (/^\d+$/u.test(name)) {
          return yield* resolveExercise(Number(name));
        }
        return yield* new Invalid({
          message: `Unknown exercise "${name}". Use the id, canonical name, or an alias — GET /exercises lists them. A genuinely new exercise is added with POST /exercises.`,
        });
      }
      return yield* new Invalid({
        message:
          '"exercise" is required: an exercise id, canonical name, or alias.',
      });
    }
  );

  const resolveMesocycle = Effect.fn("trainingResolver.resolveMesocycle")(
    function* (
      ref: string
    ): Effect.fn.Return<Plan, Invalid | NotFound | DatabaseFailure> {
      if (ref === "current" || ref.startsWith("current:")) {
        const active = yield* repository.activePlans();
        const tracks = active.map((m) => m.track).join(", ");
        if (ref === "current") {
          if (active.length === 1) {
            return active[0];
          }
          if (active.length === 0) {
            return yield* new NotFound({
              message:
                "No active mesocycle. Create one with POST /mesocycles, or pass an explicit id.",
            });
          }
          return yield* new Invalid({
            message: `"current" is ambiguous: ${active.length} plans are active (${tracks}). Name the one this call is about as "current:<track>" — e.g. "current:${
              active[0].track
            }".`,
          });
        }
        const track = ref.slice("current:".length);
        const row = active.find((m) => m.track === track);
        if (row) {
          return row;
        }
        if (!TRACKS.some((knownTrack) => knownTrack === track)) {
          return yield* new Invalid({
            message: `"${track}" is not a track. Tracks are: ${TRACKS.join(", ")}.`,
          });
        }
        return yield* new NotFound({
          message: `No active ${track} mesocycle. ${
            active.length === 0
              ? "No plan is active at all."
              : `Active tracks: ${tracks}.`
          }`,
        });
      }
      if (!/^\d+$/u.test(ref) || !Number.isSafeInteger(Number(ref))) {
        return yield* new Invalid({
          message: `"${ref}" is not a mesocycle reference. Use a numeric id, "current" while one plan is active, or "current:<track>" — tracks are ${TRACKS.join(
            ", "
          )}.`,
        });
      }
      return yield* requireRow(
        yield* repository.planById(Number(ref)),
        `No mesocycle with id ${ref}.`
      );
    }
  );

  const resolveSetMesocycleId = Effect.fn(
    "trainingResolver.resolveSetMesocycleId"
  )(function* (
    exerciseId: number,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve String coercion of explicit raw references before resolveMesocycle validates them.
    ref: unknown
  ): Effect.fn.Return<number | null, Invalid | NotFound | DatabaseFailure> {
    if (ref !== undefined && ref !== null) {
      return (yield* resolveMesocycle(String(ref))).id;
    }
    const plans = yield* repository.activePlansForExercise(exerciseId);
    if (plans.length === 0) {
      return null;
    }
    if (plans.length === 1) {
      return plans[0].id;
    }
    const exercise = yield* resolveExercise(exerciseId);
    return yield* new Invalid({
      message: `"${exercise.name}" is in more than one active plan (${plans
        .map((p) => p.track)
        .join(
          ", "
        )}), so which one this set serves cannot be inferred. Add "mesocycle": "current:<track>" to the set.`,
    });
  });

  // One bounded read per JSON chunk, not one query per distinct exercise or
  // plan. The returned cache belongs to this attempt, not to the store lifetime.
  const forSets = Effect.fn("trainingResolver.forSets")(function* (
    entries: readonly { exercise?: unknown; mesocycle?: unknown }[]
  ): Effect.fn.Return<SetResolver, DatabaseFailure> {
    const refs = [...new Set(entries.map((entry) => entry.exercise))];
    const inputs = refs.map((ref) => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preload only string names; invalid values still reach resolveExercise's exact refusal.
      const name = typeof ref === "string" ? ref.trim() : null;
      const candidate =
        name !== null && /^\d+$/u.test(name) ? Number(name) : ref;
      return {
        key: name === null || name === "" ? null : caseKey(name),
        id:
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Only safe numeric ids are eligible for the preload query.
          typeof candidate === "number" && Number.isSafeInteger(candidate)
            ? candidate
            : null,
      };
    });
    const found = yield* repository.exercisesForReferences(inputs);
    const exercises = new Map<unknown, Exercise>();
    const byId = new Map<number, Exercise>();
    for (const value of found) {
      const { item, ...row } = value;
      exercises.set(refs[item], row);
      byId.set(row.id, row);
    }
    const explicit = [
      ...new Set(
        entries.flatMap(({ mesocycle }) => {
          const ref =
            mesocycle === null || mesocycle === undefined
              ? ""
              : String(mesocycle);
          return /^\d+$/u.test(ref) && Number.isSafeInteger(Number(ref))
            ? [Number(ref)]
            : [];
        })
      ),
    ];
    const active = yield* repository.activePlans();
    const plansById = new Map(active.map((plan) => [plan.id, plan]));
    if (explicit.length) {
      for (const plan of yield* repository.plansByIds(explicit)) {
        plansById.set(plan.id, plan);
      }
    }
    const membership = new Map<number, Plan[]>();
    const memberships = yield* repository.activeMembership([...byId.keys()]);
    for (const plan of memberships) {
      const list = membership.get(plan.exercise_id) ?? [];
      list.push(plan);
      membership.set(plan.exercise_id, list);
    }
    return {
      resolveExercise: (ref) => {
        const cached = exercises.get(ref);
        return cached ? Effect.succeed(cached) : resolveExercise(ref);
      },
      resolveSetMesocycleId: Effect.fnUntraced(function* (
        exerciseId: number,
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve String coercion of explicit raw references before resolveMesocycle validates them.
        ref: unknown
      ): Effect.fn.Return<number | null, Invalid | NotFound | DatabaseFailure> {
        if (ref !== undefined && ref !== null) {
          const name = String(ref);
          let selected: Plan | undefined;
          if (name === "current" && active.length === 1) {
            [selected] = active;
          } else if (name.startsWith("current:")) {
            selected = active.find((plan) => plan.track === name.slice(8));
          } else if (/^\d+$/u.test(name)) {
            selected = plansById.get(Number(name));
          }
          // Keep the existing exact refusals for invalid or ambiguous refs.
          return selected?.id ?? (yield* resolveMesocycle(name)).id;
        }
        const plans = membership.get(exerciseId) ?? [];
        if (plans.length === 0) {
          return null;
        }
        if (plans.length === 1) {
          return plans[0].id;
        }
        // SAFETY: membership is loaded only for byId.keys(), so an ambiguous membership has a cached exercise.
        const exercise = byId.get(exerciseId) as Exercise;
        return yield* new Invalid({
          message: `"${exercise.name}" is in more than one active plan (${plans
            .map((p) => p.track)
            .join(
              ", "
            )}), so which one this set serves cannot be inferred. Add "mesocycle": "current:<track>" to the set.`,
        });
      }),
    };
  });

  return { resolveExercise, resolveMesocycle, resolveSetMesocycleId, forSets };
}

export type TrainingResolver = ReturnType<typeof trainingResolver>;
