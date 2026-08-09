import { Hono } from "@hono/hono";
import { sql, type Tx } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import { resolveExercise, resolveExerciseId } from "../lib/resolve.ts";
import { MEASURES } from "../lib/training.ts";
import {
  type Body,
  optionalString,
  readJson,
  requireOneOf,
  requireString,
} from "../lib/validate.ts";

const STIMULUS_TYPES = ["strength", "power", "conditioning"] as const;
const SYSTEMIC_FATIGUE_LEVELS = ["normal", "high"] as const;
const VOLUME_FACTORS = [0, 0.5, 1];

function selectExercise(id?: number) {
  return sql`
    select
      e.id, e.name, e.equipment, e.pattern, e.stimulus_type,
      e.systemic_fatigue, e.measure, e.notes,
      coalesce(
        (select array_agg(a.alias order by a.alias)
         from exercise_aliases a where a.exercise_id = e.id),
        '{}'
      ) as aliases,
      coalesce(
        (select json_agg(
           json_build_object('muscle', m.name, 'volume_factor', em.volume_factor::float8)
           order by m.name)
         from exercise_muscles em
         join muscles m on m.id = em.muscle_id
         where em.exercise_id = e.id),
        '[]'
      ) as muscles
    from exercises e
    ${id === undefined ? sql`` : sql`where e.id = ${id}`}
    order by e.name`;
}

interface MuscleEntry {
  muscle: string;
  volumeFactor: number;
}

// One shape for a muscle classification, learned once: creation and the
// full-replacement PUT take exactly the same list.
function parseMuscleList(body: Body): MuscleEntry[] {
  const muscleInputs = body.muscles === undefined ? [] : body.muscles;
  if (!Array.isArray(muscleInputs)) {
    throw new ApiError(
      422,
      '"muscles" must be an array of {muscle, volume_factor} objects, e.g. {"muscle": "quads", "volume_factor": 1.0}.',
    );
  }
  return muscleInputs.map((entry) => {
    const m = entry as Record<string, unknown>;
    if (typeof m !== "object" || m === null) {
      throw new ApiError(422, 'Each entry in "muscles" must be an object.');
    }
    if (m.counts !== undefined) {
      throw new ApiError(
        422,
        '"counts" was replaced by "volume_factor": 1.0 (direct — primary force generator), 0.5 (indirect — meaningfully trained, not primary), 0 (considered and deliberately excluded). See GET /docs/reference/exercises.',
      );
    }
    if (m.fatigue !== undefined) {
      throw new ApiError(
        422,
        'Per-muscle "fatigue" no longer exists. Systemic fatigue is a property of the exercise: send "systemic_fatigue": "normal" | "high" at the top level (defaults to "normal").',
      );
    }
    if (
      typeof m.volume_factor !== "number" ||
      !VOLUME_FACTORS.includes(m.volume_factor)
    ) {
      throw new ApiError(
        422,
        '"volume_factor" must be 0, 0.5, or 1.0 on every muscle entry. 1.0 = direct (primary force generator, loaded dynamically through range), 0.5 = indirect (meaningfully trained, not primary), 0 = considered and deliberately excluded.',
      );
    }
    return {
      muscle: requireString(m, "muscle"),
      volumeFactor: m.volume_factor,
    };
  });
}

async function insertMuscles(
  tx: Tx,
  exerciseId: number,
  muscles: MuscleEntry[],
) {
  for (const { muscle, volumeFactor } of muscles) {
    const [row] = await tx`
      select id from muscles where lower(name) = lower(${muscle})`;
    if (!row) {
      const [{ names }] = await tx`
        select coalesce(string_agg(name, ', ' order by name), '(none yet)') as names
        from muscles`;
      throw new ApiError(
        422,
        `Unknown muscle "${muscle}". Known muscles: ${names}. Add it first with POST /muscles.`,
      );
    }
    await tx`
      insert into exercise_muscles (exercise_id, muscle_id, volume_factor)
      values (${exerciseId}, ${row.id}, ${volumeFactor})`;
  }
}

export const exercises = new Hono();

exercises.get("/", async (c) => {
  return c.json({ exercises: await selectExercise() });
});

// One call creates the exercise with its aliases and muscle mappings.
// Muscles are referenced by name and must already exist.
exercises.post("/", async (c) => {
  const body = await readJson(c);
  const name = requireString(body, "name");
  const equipment = optionalString(body, "equipment");
  const pattern = optionalString(body, "pattern");
  const notes = optionalString(body, "notes");
  const stimulusType = requireOneOf(
    body,
    "stimulus_type",
    STIMULUS_TYPES,
    "strength",
  );
  const systemicFatigue = requireOneOf(
    body,
    "systemic_fatigue",
    SYSTEMIC_FATIGUE_LEVELS,
    "normal",
  );
  // What a set of this exercise records. Defaults to the barbell case, which
  // is what almost every exercise in the catalogue is; a run or a sprint has
  // to say so, and saying so is what makes the log page ask for metres.
  const measure = requireOneOf(body, "measure", MEASURES, "load_reps");

  const aliases = body.aliases === undefined ? [] : body.aliases;
  if (
    !Array.isArray(aliases) ||
    aliases.some((a) => typeof a !== "string" || a.trim() === "")
  ) {
    throw new ApiError(422, '"aliases" must be an array of non-empty strings.');
  }

  const muscles = parseMuscleList(body);

  const id = await sql.begin(async (sql) => {
    const [exercise] = await sql`
      insert into exercises
        (name, equipment, pattern, stimulus_type, systemic_fatigue, measure,
         notes)
      values
        (${name}, ${equipment}, ${pattern}, ${stimulusType},
         ${systemicFatigue}, ${measure}, ${notes})
      returning id`;

    for (const alias of aliases as string[]) {
      await sql`
        insert into exercise_aliases (exercise_id, alias)
        values (${exercise.id}, ${alias.trim()})`;
    }

    await insertMuscles(sql, exercise.id, muscles);

    return exercise.id as number;
  });

  const [created] = await selectExercise(id);
  return c.json({ exercise: created }, 201);
});

// Every working set for one lift over time. Accepts id, name, or alias.
exercises.get("/:ref/history", async (c) => {
  const exerciseId = await resolveExerciseId(c.req.param("ref"));
  const [exercise] = await sql`
    select id, name, measure from exercises where id = ${exerciseId}`;
  // Every measure comes back, and which ones are populated is the exercise's
  // measure. A sprint's history is metres and seconds; reading it for a rising
  // weight would find nothing and conclude wrongly that nothing is happening.
  const rows = await sql`
    select s.date, t.weight_kg::float8, t.reps,
      t.distance_m::float8, t.duration_s::float8, t.effort, t.session_id
    from sets t
    join sessions s on s.id = t.session_id
    where t.exercise_id = ${exerciseId} and t.kind = 'working'
      and set_performed(t.reps, t.distance_m, t.duration_s)
    order by s.date, t.position`;
  return c.json({
    exercise: exercise.name,
    exercise_id: exercise.id,
    measure: exercise.measure,
    sets: rows,
  });
});

// ---------------------------------------------------------------------------
// The correction surface, tiered by what a change rewrites.
//
// Foods have had one from the start; exercises were write-once, and the docs
// promised corrections the API never offered — "synonyms become aliases" with
// no alias endpoint, "the exercise's measure is what needs changing" with no
// way to change it. The tiers below match how much history each field can
// rewrite: prose changes freely, identity-shaping fields only while nothing
// has been logged, and the muscle classification only between plans.
// ---------------------------------------------------------------------------

// Prose and labels change freely — nothing computes with them. measure and
// stimulus_type are the creation-mistake window: every logged set was
// validated and counted under them, so they freeze at the first set. After
// that the fix is a new exercise with the right value, taking this one's
// aliases — the same rule as foods' "a different product is never an edit".
exercises.patch("/:ref", async (c) => {
  const e = await resolveExercise(c.req.param("ref"));
  const body = await readJson(c);

  if ("muscles" in body) {
    throw new ApiError(
      422,
      "The muscle classification is replaced whole with PUT /exercises/:ref/muscles — a partial edit of a classification is ambiguous about the rows it does not mention.",
    );
  }
  if ("alias" in body || "aliases" in body) {
    throw new ApiError(
      422,
      "Aliases have their own surface: POST /exercises/:ref/aliases adds, DELETE /exercises/:ref/aliases/:alias removes.",
    );
  }

  const fields: Record<string, unknown> = {};
  if ("name" in body) fields.name = requireString(body, "name");
  if ("equipment" in body) fields.equipment = optionalString(body, "equipment");
  if ("pattern" in body) fields.pattern = optionalString(body, "pattern");
  if ("notes" in body) fields.notes = optionalString(body, "notes");
  if ("systemic_fatigue" in body) {
    fields.systemic_fatigue = requireOneOf(
      body,
      "systemic_fatigue",
      SYSTEMIC_FATIGUE_LEVELS,
    );
  }

  if ("measure" in body || "stimulus_type" in body) {
    const [{ n }] = await sql`
      select count(*)::int as n from sets where exercise_id = ${e.id}`;
    if (n > 0) {
      throw new ApiError(
        422,
        `"measure" and "stimulus_type" are frozen once an exercise has logged sets — "${e.name}" has ${n}. Every one of them was validated and counted under the current values, so changing them would rewrite history that already happened. The fix now is a new exercise with the right value, which takes over this one's aliases (POST /exercises, then move the aliases).`,
      );
    }
    if ("measure" in body) {
      fields.measure = requireOneOf(body, "measure", MEASURES);
    }
    if ("stimulus_type" in body) {
      fields.stimulus_type = requireOneOf(
        body,
        "stimulus_type",
        STIMULUS_TYPES,
      );
    }
  }

  if (Object.keys(fields).length === 0) {
    throw new ApiError(
      422,
      "Send at least one of: name, equipment, pattern, notes, systemic_fatigue — or, while the exercise has no logged sets, measure and stimulus_type.",
    );
  }

  await sql`update exercises set ${sql(fields)} where id = ${e.id}`;
  const [updated] = await selectExercise(e.id);
  return c.json({ exercise: updated });
});

// A synonym never becomes a second exercise row — that splits the lift's
// history in two. Same rule and same surface as foods.
exercises.post("/:ref/aliases", async (c) => {
  const e = await resolveExercise(c.req.param("ref"));
  const body = await readJson(c);
  const aliases = body.alias !== undefined
    ? [requireString(body, "alias")]
    : body.aliases;
  if (
    !Array.isArray(aliases) || aliases.length === 0 ||
    aliases.some((a) => typeof a !== "string" || a.trim() === "")
  ) {
    throw new ApiError(
      422,
      'Send "alias" (a string) or "aliases" (an array of non-empty strings).',
    );
  }
  await sql.begin(async (tx) => {
    for (const alias of aliases as string[]) {
      await tx`
        insert into exercise_aliases (exercise_id, alias)
        values (${e.id}, ${alias.trim()})`;
    }
  });
  const [updated] = await selectExercise(e.id);
  return c.json({ exercise: updated }, 201);
});

// An alias is a pointer, not a fact — removing one loses nothing, and it is
// how a spoken name moves to the exercise that should own it. Aliases are
// globally unique, so without this a retired exercise would hold its names
// forever and no replacement could ever claim them.
exercises.delete("/:ref/aliases/:alias", async (c) => {
  const e = await resolveExercise(c.req.param("ref"));
  const alias = decodeURIComponent(c.req.param("alias"));
  const rows = await sql`
    delete from exercise_aliases
    where exercise_id = ${e.id} and lower(alias) = lower(${alias})
    returning id`;
  if (rows.length === 0) {
    throw new ApiError(
      404,
      `"${alias}" is not an alias of "${e.name}". GET /exercises lists each exercise's aliases.`,
    );
  }
  const [updated] = await selectExercise(e.id);
  return c.json({ exercise: updated });
});

// Only an exercise nothing has ever referenced — a typo'd duplicate caught
// before it was logged or planned. Once it is in the record, deleting it
// would orphan history; the answer there is PATCH for the fixable fields, or
// aliases moved to the exercise being kept.
exercises.delete("/:ref", async (c) => {
  const e = await resolveExercise(c.req.param("ref"));
  const [{ set_count, plan_count, dose_count }] = await sql`
    select
      (select count(*)::int from sets where exercise_id = ${e.id})
        as set_count,
      (select count(*)::int from mesocycle_exercises
       where exercise_id = ${e.id}) as plan_count,
      (select count(*)::int from mesocycle_exercise_doses
       where exercise_id = ${e.id}) as dose_count`;
  if (set_count > 0 || plan_count > 0 || dose_count > 0) {
    throw new ApiError(
      409,
      `"${e.name}" is in the record — ${set_count} logged ${
        set_count === 1 ? "set" : "sets"
      }, ${plan_count} plan ${
        plan_count === 1 ? "entry" : "entries"
      }, ${dose_count} dose history ${
        dose_count === 1 ? "row" : "rows"
      } — so deleting it would orphan history. PATCH /exercises/:ref fixes what is fixable; a duplicate's aliases move to the exercise being kept.`,
    );
  }
  const name = await sql.begin(async (tx) => {
    await tx`delete from exercise_aliases where exercise_id = ${e.id}`;
    await tx`delete from exercise_muscles where exercise_id = ${e.id}`;
    const [row] = await tx`
      delete from exercises where id = ${e.id} returning name`;
    return row.name as string;
  });
  return c.json({ deleted: name });
});

// Reclassification is a retroactive fix in the PATCH /foods sense: a wrong
// classification was wrong when written, and every past volume number it fed
// was wrong with it. That is also why it is refused while any active plan
// holds the exercise — "wholesale change belongs between mesocycles" was
// programming.md's rule with no enforcement, and a mid-plan reclassification
// silently rewrites the very numbers the plan is being judged on.
exercises.put("/:ref/muscles", async (c) => {
  const e = await resolveExercise(c.req.param("ref"));
  const body = await readJson(c);
  if (!Array.isArray(body.muscles)) {
    throw new ApiError(
      422,
      'Send "muscles" as the complete replacement classification — every {muscle, volume_factor} row, not just the ones changing. A partial list is ambiguous about the rows it does not mention.',
    );
  }
  const muscles = parseMuscleList(body);

  const active = await sql`
    select mc.name from mesocycle_exercises me
    join mesocycles mc on mc.id = me.mesocycle_id
    where me.exercise_id = ${e.id} and mc.ended_on is null
    order by mc.name`;
  if (active.length > 0) {
    throw new ApiError(
      409,
      `"${e.name}" is in ${
        active.map((m) => `"${m.name}"`).join(" and ")
      }, which is still running. Reclassifying its muscles mid-plan silently rewrites the weekly-volume numbers that plan is being judged on — this change belongs between mesocycles, at the review.`,
    );
  }

  const [{ weeks }] = await sql`
    select count(distinct date_trunc('week', s.date))::int as weeks
    from sets t
    join sessions s on s.id = t.session_id
    where t.exercise_id = ${e.id} and t.kind = 'working'
      and date_trunc('week', s.date)
        < date_trunc('week', now() at time zone 'Europe/Rome')`;

  await sql.begin(async (tx) => {
    await tx`delete from exercise_muscles where exercise_id = ${e.id}`;
    await insertMuscles(tx, e.id, muscles);
  });

  const [updated] = await selectExercise(e.id);
  return c.json({
    exercise: updated,
    note: weeks === 0
      ? "No finished week of volume references this exercise, so nothing historical moved."
      : `This reclassification rewrote the weekly-volume numbers of ${weeks} finished ${
        weeks === 1 ? "week" : "weeks"
      }. That is the point — a wrong classification was wrong when written — but it is why this is refused mid-plan.`,
  });
});

export const muscles = new Hono();

muscles.get("/", async (c) => {
  const rows = await sql`select id, name from muscles order by name`;
  return c.json({ muscles: rows });
});

muscles.post("/", async (c) => {
  const body = await readJson(c);
  const name = requireString(body, "name");
  const [row] = await sql`
    insert into muscles (name) values (${name}) returning id, name`;
  return c.json({ muscle: row }, 201);
});
