import { sql } from "../db.ts";
import { ApiError, requireRow } from "../http/errors.ts";
import { TRACKS } from "../rules/training.ts";

// Exercises, foods and meals resolve the same way — id, name, or alias,
// case-insensitively, server-side — so voice-to-text phrasing ("il solito
// yogurt") never has to be matched by the caller. Shared because the rule is
// one rule: a synonym that creates a second row splits a food's history the
// way a duplicate exercise splits a lift's.
interface Namespace {
  table: string;
  aliasTable: string;
  foreignKey: string;
  // The refusals, written per namespace rather than filled from one template.
  // Only the rule is shared, not the prose: the client is a model, and the
  // sentence telling it how to add a food it could not find is not the
  // sentence telling it how to add an exercise.
  noSuchId: (ref: number) => string;
  unknownName: (name: string) => string;
  missingRef: string;
  // What one of these is called, and the prefix its aliases hang off — the
  // alias-clash refusal names both.
  what: string;
  route: string;
}

async function resolveNamed(ns: Namespace, ref: unknown): Promise<number> {
  if (typeof ref === "number" && Number.isInteger(ref)) {
    const [row] = await sql`
      select id from ${sql(ns.table)} where id = ${ref}`;
    if (row) return row.id;
    throw new ApiError(422, ns.noSuchId(ref));
  }
  if (typeof ref === "string" && ref.trim() !== "") {
    const name = ref.trim();
    // Ranked rather than relying on union order: a canonical name always wins
    // over an alias that happens to spell the same thing. A bare union with
    // limit 1 left the collision to whichever row the planner produced first,
    // which is a different exercise on a different day.
    //
    // Refusing the collision instead was tried and reverted. It reads as the
    // safer answer — two real candidates, say so — but the two are not equal:
    // a row's own name is what it *is*, and another row's synonym is a word
    // someone attached to it. "Nordic Curl" is in the catalogue beside a
    // "Nordic Hamstring Curl" that answers to the same phrase, and asking for
    // the first by its exact name is not ambiguous in any sense the caller
    // would recognise. The rank is the answer; reference_test holds it.
    const [row] = await sql`
      select id, 1 as rank from ${sql(ns.table)}
      where lower(name) = lower(${name})
      union all
      select ${sql(ns.foreignKey)} as id, 2 as rank from ${sql(ns.aliasTable)}
      where lower(alias) = lower(${name})
      order by rank
      limit 1`;
    if (row) return row.id;
    if (/^\d+$/.test(name)) return resolveNamed(ns, Number(name));
    throw new ApiError(422, ns.unknownName(name));
  }
  throw new ApiError(422, ns.missingRef);
}

const EXERCISES: Namespace = {
  table: "exercises",
  aliasTable: "exercise_aliases",
  foreignKey: "exercise_id",
  noSuchId: (ref) =>
    `No exercise with id ${ref}. GET /exercises lists the catalogue.`,
  unknownName: (name) =>
    `Unknown exercise "${name}". Use the id, canonical name, or an alias — GET /exercises lists them. A genuinely new exercise is added with POST /exercises.`,
  missingRef:
    '"exercise" is required: an exercise id, canonical name, or alias.',
  what: "exercise",
  route: "/exercises",
};

const FOODS: Namespace = {
  table: "foods",
  aliasTable: "food_aliases",
  foreignKey: "food_id",
  noSuchId: (ref) =>
    `No food with id ${ref}. GET /foods?q=<search> lists them.`,
  unknownName: (name) =>
    `Unknown food "${name}". GET /foods?q=<search> lists what exists — use the id, canonical name, or an alias. A food that genuinely does not exist yet is sourced (label, CREA, USDA, Open Food Facts) and saved with POST /foods — never invented. A synonym of a food that exists gets an alias instead: POST /foods/:ref/aliases.`,
  missingRef: '"food" is required: a food id, canonical name, or alias.',
  what: "food",
  route: "/foods",
};

const MEALS: Namespace = {
  table: "meals",
  aliasTable: "meal_aliases",
  foreignKey: "meal_id",
  noSuchId: (ref) => `No meal with id ${ref}. GET /meals lists them.`,
  unknownName: (name) =>
    `Unknown meal "${name}". GET /meals lists what exists — use the id, canonical name, or an alias. A meal that has become a routine is saved with POST /meals. A one-off variation on a saved meal is not a new meal — log the meal and log the difference as a separate entry.`,
  missingRef: '"meal" is required: a meal id, canonical name, or alias.',
  what: "meal",
  route: "/meals",
};

// Which aliases in this call are already spoken for, asked before anything is
// written rather than discovered by the unique constraint afterwards.
//
// The constraint's message could only say that *an* alias was taken: it does
// not know which of the several sent collided, nor what owns it, so a caller
// holding {"aliases": ["magnum pistacchio", "magnum"]} was told to go and
// search for the answer the server already had. And because the insert runs
// inside the same transaction as the row itself, that refusal threw away a
// fully sourced food over one word.
//
// Naming the clash makes the retry a one-token edit. The constraint stays
// underneath as the backstop for two calls racing.
async function assertAliasesFree(
  ns: Namespace,
  aliases: readonly string[],
): Promise<void> {
  const wanted = aliases.map((a) => a.trim().toLowerCase());
  if (wanted.length === 0) return;
  const taken = await sql<{ alias: string; id: number; name: string }[]>`
    select a.alias, e.id, e.name
    from ${sql(ns.aliasTable)} a
    join ${sql(ns.table)} e on e.id = a.${sql(ns.foreignKey)}
    where lower(a.alias) = any(${wanted})
    order by a.alias`;
  if (taken.length === 0) return;

  const clashes = taken
    .map((t) =>
      `"${t.alias}" already belongs to ${ns.what} ${t.id} (${t.name})`
    )
    .join("; ");
  const one = taken.length === 1;
  throw new ApiError(
    409,
    `${clashes}. Aliases are case-insensitive and globally unique — one name points at one ${ns.what}. Nothing was written: resend without ${
      one ? "that alias" : "those aliases"
    }, which costs only ${
      one ? "that word" : "those words"
    } and keeps the rest of the call. If ${
      one ? "the name belongs" : "a name belongs"
    } on this row instead, release it first with DELETE ${ns.route}/${
      taken[0].id
    }/aliases/${encodeURIComponent(taken[0].alias)}.`,
  );
}

export const assertExerciseAliasesFree = (aliases: readonly string[]) =>
  assertAliasesFree(EXERCISES, aliases);
export const assertFoodAliasesFree = (aliases: readonly string[]) =>
  assertAliasesFree(FOODS, aliases);
export const assertMealAliasesFree = (aliases: readonly string[]) =>
  assertAliasesFree(MEALS, aliases);

export function resolveExerciseId(ref: unknown): Promise<number> {
  return resolveNamed(EXERCISES, ref);
}

// The whole exercise row, for the callers that need its name or its measure
// to validate what is being written about it — and to say the name back in
// the error when they reject it.
export async function resolveExercise(
  ref: unknown,
): Promise<
  { id: number; name: string; measure: string; stimulus_type: string }
> {
  const id = await resolveExerciseId(ref);
  const [row] = await sql`
    select id, name, measure, stimulus_type from exercises where id = ${id}`;
  return row as {
    id: number;
    name: string;
    measure: string;
    stimulus_type: string;
  };
}

export function resolveFoodId(ref: unknown): Promise<number> {
  return resolveNamed(FOODS, ref);
}

export function resolveMealId(ref: unknown): Promise<number> {
  return resolveNamed(MEALS, ref);
}

// A mesocycle reference: a numeric id, "current", or "current:<track>".
//
// "current" was unambiguous while only one plan could be active. Now that a
// hypertrophy plan and a speed plan run side by side, a bare "current" that
// silently picked one would write today's sprints into the lifting plan and
// no reader downstream could tell. So it resolves only while exactly one plan
// is active — true for most of this system's life — and otherwise says which
// tracks are running and how to name one.
// deno-lint-ignore no-explicit-any
export async function resolveMesocycle(idParam: string): Promise<any> {
  if (idParam === "current" || idParam.startsWith("current:")) {
    const active = await sql`
      select * from mesocycles where ended_on is null order by track`;
    const tracks = active.map((m) => m.track).join(", ");

    if (idParam === "current") {
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

    const track = idParam.slice("current:".length);
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

  if (!/^\d+$/.test(idParam)) {
    throw new ApiError(
      422,
      `"${idParam}" is not a mesocycle reference. Use a numeric id, "current" while one plan is active, or "current:<track>" — tracks are ${
        TRACKS.join(", ")
      }.`,
    );
  }
  return requireRow(
    await sql`
    select * from mesocycles where id = ${Number(idParam)}`,
    `No mesocycle with id ${idParam}.`,
  );
}

// Which plan a set serves. Resolved server-side on every write, so the log
// page never has to know that plans exist and the coach only has to say
// anything in the one case where the answer is genuinely unclear.
//
// The exercise decides it: a lift that appears in exactly one active plan's
// exercise list belongs to that plan. An exercise in no active plan is
// off-plan — a hike, a five-a-side game — recorded as fact and measured
// against no dose. An exercise in two active plans is the only ambiguous
// case, and the caller is asked rather than guessed at.
export async function resolveSetMesocycleId(
  exerciseId: number,
  ref: unknown,
): Promise<number | null> {
  if (ref !== undefined && ref !== null) {
    const m = await resolveMesocycle(
      typeof ref === "number" ? String(ref) : String(ref),
    );
    return m.id as number;
  }
  const rows = await sql`
    select m.id, m.track from mesocycles m
    join mesocycle_exercises me on me.mesocycle_id = m.id
    where m.ended_on is null and me.exercise_id = ${exerciseId}
    order by m.track`;
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0].id as number;
  const [e] = await sql`select name from exercises where id = ${exerciseId}`;
  throw new ApiError(
    422,
    `"${e.name}" is in more than one active plan (${
      rows.map((r) => r.track).join(", ")
    }), so which one this set serves cannot be inferred. Add "mesocycle": "current:<track>" to the set.`,
  );
}
