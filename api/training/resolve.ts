import { ApiError, requireRow } from "../shared/errors.ts";
import {
  batch,
  caseKey,
  type Database,
  jsonChunks,
  rows,
  statement,
} from "../shared/d1.ts";
import { TRACKS } from "./rules.ts";

interface Exercise {
  id: number;
  name: string;
  measure: string;
  stimulus_type: string;
}
interface Plan {
  id: number;
  track: string;
}

export interface SetResolver {
  resolveExercise(ref: unknown): Promise<Exercise>;
  resolveSetMesocycleId(
    exerciseId: number,
    ref: unknown,
  ): Promise<number | null>;
}

/** Same id/name/alias and active-plan rules as the PostgreSQL reference. */
export function trainingResolver(db: Database) {
  async function resolveExercise(ref: unknown): Promise<Exercise> {
    if (typeof ref === "number" && Number.isSafeInteger(ref)) {
      const [row] = await rows<Exercise>(
        db,
        "SELECT id, name, measure, stimulus_type FROM exercises WHERE id = ?",
        ref,
      );
      if (row) return row;
      throw new ApiError(
        422,
        `No exercise with id ${ref}. GET /exercises lists the catalogue.`,
      );
    }
    if (typeof ref === "string" && ref.trim() !== "") {
      const name = ref.trim();
      const [row] = await rows<Exercise>(
        db,
        `SELECT e.id, e.name, e.measure, e.stimulus_type FROM exercises e
        WHERE e.id = (
          SELECT id FROM (
            SELECT id, 1 AS rank FROM exercises WHERE name_key = ?
            UNION ALL
            SELECT exercise_id AS id, 2 AS rank FROM exercise_aliases WHERE alias_key = ?
          ) ORDER BY rank LIMIT 1
        )`,
        caseKey(name),
        caseKey(name),
      );
      if (row) return row;
      if (/^\d+$/.test(name)) return await resolveExercise(Number(name));
      throw new ApiError(
        422,
        `Unknown exercise "${name}". Use the id, canonical name, or an alias — GET /exercises lists them. A genuinely new exercise is added with POST /exercises.`,
      );
    }
    throw new ApiError(
      422,
      '"exercise" is required: an exercise id, canonical name, or alias.',
    );
  }

  async function resolveMesocycle(ref: string): Promise<Plan> {
    if (ref === "current" || ref.startsWith("current:")) {
      const active = await rows<Plan>(
        db,
        "SELECT id, track FROM mesocycles WHERE ended_on IS NULL ORDER BY track",
      );
      const tracks = active.map((m) => m.track).join(", ");
      if (ref === "current") {
        if (active.length === 1) return active[0];
        if (active.length === 0) {
          throw new ApiError(
            404,
            "No active mesocycle. Create one with POST /mesocycles, or pass an explicit id.",
          );
        }
        throw new ApiError(
          422,
          `"current" is ambiguous: ${active.length} plans are active (${tracks}). Name the one this call is about as "current:<track>" — e.g. "current:${
            active[0].track
          }".`,
        );
      }
      const track = ref.slice("current:".length);
      const row = active.find((m) => m.track === track);
      if (row) return row;
      if (!TRACKS.includes(track as typeof TRACKS[number])) {
        throw new ApiError(
          422,
          `"${track}" is not a track. Tracks are: ${TRACKS.join(", ")}.`,
        );
      }
      throw new ApiError(
        404,
        `No active ${track} mesocycle. ${
          active.length === 0
            ? "No plan is active at all."
            : `Active tracks: ${tracks}.`
        }`,
      );
    }
    if (!/^\d+$/.test(ref) || !Number.isSafeInteger(Number(ref))) {
      throw new ApiError(
        422,
        `"${ref}" is not a mesocycle reference. Use a numeric id, "current" while one plan is active, or "current:<track>" — tracks are ${
          TRACKS.join(", ")
        }.`,
      );
    }
    return requireRow(
      await rows<Plan>(
        db,
        "SELECT id, track FROM mesocycles WHERE id = ?",
        Number(ref),
      ),
      `No mesocycle with id ${ref}.`,
    );
  }

  async function resolveSetMesocycleId(
    exerciseId: number,
    ref: unknown,
  ): Promise<number | null> {
    if (ref !== undefined && ref !== null) {
      return (await resolveMesocycle(String(ref))).id;
    }
    const plans = await rows<Plan>(
      db,
      `SELECT m.id, m.track FROM mesocycles m
      JOIN mesocycle_exercises me ON me.mesocycle_id = m.id
      WHERE m.ended_on IS NULL AND me.exercise_id = ? ORDER BY m.track`,
      exerciseId,
    );
    if (plans.length === 0) return null;
    if (plans.length === 1) return plans[0].id;
    const exercise = await resolveExercise(exerciseId);
    throw new ApiError(
      422,
      `"${exercise.name}" is in more than one active plan (${
        plans.map((p) => p.track).join(", ")
      }), so which one this set serves cannot be inferred. Add "mesocycle": "current:<track>" to the set.`,
    );
  }

  // One bounded read per JSON chunk, not one query per distinct exercise or
  // plan. The returned cache belongs to this attempt, not to the store lifetime.
  async function forSets(
    entries: readonly { exercise?: unknown; mesocycle?: unknown }[],
  ): Promise<SetResolver> {
    const refs = [...new Set(entries.map((entry) => entry.exercise))];
    const inputs = refs.map((ref) => {
      const name = typeof ref === "string" ? ref.trim() : null;
      const candidate = name !== null && /^\d+$/.test(name)
        ? Number(name)
        : ref;
      return {
        key: name === null || name === "" ? null : caseKey(name),
        id: typeof candidate === "number" && Number.isSafeInteger(candidate)
          ? candidate
          : null,
      };
    });
    const chunks = jsonChunks(inputs);
    const found = await batch(
      db,
      chunks.map((chunk) =>
        statement(
          db,
          `SELECT CAST(v.key AS INTEGER) + ? AS item, e.id, e.name, e.measure, e.stimulus_type
       FROM json_each(?) v JOIN exercises e ON e.id = COALESCE(
         (SELECT id FROM exercises WHERE name_key = json_extract(v.value, '$.key')),
         (SELECT exercise_id FROM exercise_aliases WHERE alias_key = json_extract(v.value, '$.key')),
         (SELECT id FROM exercises WHERE id = json_extract(v.value, '$.id'))
       )`,
          chunk.offset,
          chunk.json,
        )
      ),
    );
    const exercises = new Map<unknown, Exercise>();
    const byId = new Map<number, Exercise>();
    for (const result of found) {
      for (const value of result.results) {
        const { item, ...row } = value as unknown as Exercise & {
          item: number;
        };
        exercises.set(refs[item], row);
        byId.set(row.id, row);
      }
    }
    const explicit = [
      ...new Set(entries.flatMap(({ mesocycle }) => {
        const ref = mesocycle == null ? "" : String(mesocycle);
        return /^\d+$/.test(ref) && Number.isSafeInteger(Number(ref))
          ? [Number(ref)]
          : [];
      })),
    ];
    const active = await rows<Plan>(
      db,
      "SELECT id, track FROM mesocycles WHERE ended_on IS NULL ORDER BY track",
    );
    const plansById = new Map(active.map((plan) => [plan.id, plan]));
    if (explicit.length) {
      for (const chunk of jsonChunks(explicit)) {
        for (
          const plan of await rows<Plan>(
            db,
            "SELECT id, track FROM mesocycles WHERE id IN (SELECT value FROM json_each(?))",
            chunk.json,
          )
        ) {
          plansById.set(plan.id, plan);
        }
      }
    }
    const membership = new Map<number, Plan[]>();
    for (const chunk of jsonChunks([...byId.keys()])) {
      const plans = await rows<Plan & { exercise_id: number }>(
        db,
        `SELECT me.exercise_id, m.id, m.track FROM mesocycle_exercises me
         JOIN mesocycles m ON m.id = me.mesocycle_id
         WHERE m.ended_on IS NULL AND me.exercise_id IN (SELECT value FROM json_each(?))
         ORDER BY m.track`,
        chunk.json,
      );
      for (const plan of plans) {
        const list = membership.get(plan.exercise_id) ?? [];
        list.push(plan);
        membership.set(plan.exercise_id, list);
      }
    }
    return {
      resolveExercise: (ref) =>
        exercises.has(ref)
          ? Promise.resolve(exercises.get(ref)!)
          : resolveExercise(ref),
      async resolveSetMesocycleId(exerciseId, ref) {
        if (ref !== undefined && ref !== null) {
          const name = String(ref);
          const selected = name === "current" && active.length === 1
            ? active[0]
            : name.startsWith("current:")
            ? active.find((plan) => plan.track === name.slice(8))
            : /^\d+$/.test(name)
            ? plansById.get(Number(name))
            : undefined;
          // Keep the existing exact refusals for invalid or ambiguous refs.
          return selected?.id ?? (await resolveMesocycle(name)).id;
        }
        const plans = membership.get(exerciseId) ?? [];
        if (plans.length === 0) return null;
        if (plans.length === 1) return plans[0].id;
        throw new ApiError(
          422,
          `"${byId.get(exerciseId)!.name}" is in more than one active plan (${
            plans.map((p) => p.track).join(", ")
          }), so which one this set serves cannot be inferred. Add "mesocycle": "current:<track>" to the set.`,
        );
      },
    };
  }

  return { resolveExercise, resolveMesocycle, resolveSetMesocycleId, forSets };
}
