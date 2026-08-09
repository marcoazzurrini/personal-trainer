import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import { resolveExerciseId } from "../lib/resolve.ts";
import { MEASURES } from "../lib/training.ts";
import {
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

  const muscleInputs = body.muscles === undefined ? [] : body.muscles;
  if (!Array.isArray(muscleInputs)) {
    throw new ApiError(
      422,
      '"muscles" must be an array of {muscle, volume_factor} objects, e.g. {"muscle": "quads", "volume_factor": 1.0}.',
    );
  }
  const muscles = muscleInputs.map((entry) => {
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

    for (const { muscle, volumeFactor } of muscles) {
      const [row] = await sql`
        select id from muscles where lower(name) = lower(${muscle})`;
      if (!row) {
        const [{ names }] = await sql`
          select coalesce(string_agg(name, ', ' order by name), '(none yet)') as names
          from muscles`;
        throw new ApiError(
          422,
          `Unknown muscle "${muscle}". Known muscles: ${names}. Add it first with POST /muscles.`,
        );
      }
      await sql`
        insert into exercise_muscles (exercise_id, muscle_id, volume_factor)
        values (${exercise.id}, ${row.id}, ${volumeFactor})`;
    }

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
