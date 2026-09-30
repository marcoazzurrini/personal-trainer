import type { ResolutionRepository } from "../../db/repositories/training/resolve.ts";
import { ApiError, requireRow } from "../shared/errors.ts";
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Resolver is the boundary that rejects invalid id/name/alias inputs with the existing refusal.
  resolveExercise: (ref: unknown) => Promise<Exercise>;
  resolveSetMesocycleId: (
    exerciseId: number,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve coercion and refusal of raw references at the resolver boundary.
    ref: unknown
  ) => Promise<number | null>;
}

/** Same id/name/alias and active-plan rules as the PostgreSQL reference. */
export function trainingResolver(repository: ResolutionRepository) {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This function validates raw id/name/alias inputs before issuing a lookup.
  async function resolveExercise(ref: unknown): Promise<Exercise> {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Numeric references require a safe-integer check before the id lookup.
    if (typeof ref === "number" && Number.isSafeInteger(ref)) {
      const row = await repository.exerciseById(ref);
      if (row) {
        return row;
      }
      throw new ApiError(
        422,
        `No exercise with id ${ref}. GET /exercises lists the catalogue.`
      );
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- String references require nonempty trimmed text before name/alias lookup.
    if (typeof ref === "string" && ref.trim() !== "") {
      const name = ref.trim();
      const row = await repository.exerciseByKey(caseKey(name));
      if (row) {
        return row;
      }
      if (/^\d+$/u.test(name)) {
        return await resolveExercise(Number(name));
      }
      throw new ApiError(
        422,
        `Unknown exercise "${name}". Use the id, canonical name, or an alias — GET /exercises lists them. A genuinely new exercise is added with POST /exercises.`
      );
    }
    throw new ApiError(
      422,
      '"exercise" is required: an exercise id, canonical name, or alias.'
    );
  }

  async function resolveMesocycle(ref: string): Promise<Plan> {
    if (ref === "current" || ref.startsWith("current:")) {
      const active = await repository.activePlans();
      const tracks = active.map((m) => m.track).join(", ");
      if (ref === "current") {
        if (active.length === 1) {
          return active[0];
        }
        if (active.length === 0) {
          throw new ApiError(
            404,
            "No active mesocycle. Create one with POST /mesocycles, or pass an explicit id."
          );
        }
        throw new ApiError(
          422,
          `"current" is ambiguous: ${active.length} plans are active (${tracks}). Name the one this call is about as "current:<track>" — e.g. "current:${
            active[0].track
          }".`
        );
      }
      const track = ref.slice("current:".length);
      const row = active.find((m) => m.track === track);
      if (row) {
        return row;
      }
      if (!TRACKS.some((knownTrack) => knownTrack === track)) {
        throw new ApiError(
          422,
          `"${track}" is not a track. Tracks are: ${TRACKS.join(", ")}.`
        );
      }
      throw new ApiError(
        404,
        `No active ${track} mesocycle. ${
          active.length === 0
            ? "No plan is active at all."
            : `Active tracks: ${tracks}.`
        }`
      );
    }
    if (!/^\d+$/u.test(ref) || !Number.isSafeInteger(Number(ref))) {
      throw new ApiError(
        422,
        `"${ref}" is not a mesocycle reference. Use a numeric id, "current" while one plan is active, or "current:<track>" — tracks are ${TRACKS.join(
          ", "
        )}.`
      );
    }
    return requireRow(
      await repository.planById(Number(ref)),
      `No mesocycle with id ${ref}.`
    );
  }

  async function resolveSetMesocycleId(
    exerciseId: number,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve String coercion of explicit raw references before resolveMesocycle validates them.
    ref: unknown
  ): Promise<number | null> {
    if (ref !== undefined && ref !== null) {
      return (await resolveMesocycle(String(ref))).id;
    }
    const plans = await repository.activePlansForExercise(exerciseId);
    if (plans.length === 0) {
      return null;
    }
    if (plans.length === 1) {
      return plans[0].id;
    }
    const exercise = await resolveExercise(exerciseId);
    throw new ApiError(
      422,
      `"${exercise.name}" is in more than one active plan (${plans
        .map((p) => p.track)
        .join(
          ", "
        )}), so which one this set serves cannot be inferred. Add "mesocycle": "current:<track>" to the set.`
    );
  }

  // One bounded read per JSON chunk, not one query per distinct exercise or
  // plan. The returned cache belongs to this attempt, not to the store lifetime.
  async function forSets(
    entries: readonly { exercise?: unknown; mesocycle?: unknown }[]
  ): Promise<SetResolver> {
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
    const found = await repository.exercisesForReferences(inputs);
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
    const active = await repository.activePlans();
    const plansById = new Map(active.map((plan) => [plan.id, plan]));
    if (explicit.length) {
      for (const plan of await repository.plansByIds(explicit)) {
        plansById.set(plan.id, plan);
      }
    }
    const membership = new Map<number, Plan[]>();
    const memberships = await repository.activeMembership([...byId.keys()]);
    for (const plan of memberships) {
      const list = membership.get(plan.exercise_id) ?? [];
      list.push(plan);
      membership.set(plan.exercise_id, list);
    }
    return {
      resolveExercise: (ref) => {
        const cached = exercises.get(ref);
        return cached ? Promise.resolve(cached) : resolveExercise(ref);
      },
      async resolveSetMesocycleId(exerciseId, ref) {
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
          return selected?.id ?? (await resolveMesocycle(name)).id;
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
        throw new ApiError(
          422,
          `"${exercise.name}" is in more than one active plan (${plans
            .map((p) => p.track)
            .join(
              ", "
            )}), so which one this set serves cannot be inferred. Add "mesocycle": "current:<track>" to the set.`
        );
      },
    };
  }

  return { resolveExercise, resolveMesocycle, resolveSetMesocycleId, forSets };
}

export type TrainingResolver = ReturnType<typeof trainingResolver>;
