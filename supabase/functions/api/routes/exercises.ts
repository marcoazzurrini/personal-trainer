import { Hono } from "@hono/hono";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import {
  optionalString,
  readJson,
  requireOneOf,
  requireString,
} from "../lib/validate.ts";

const STIMULUS_TYPES = ["strength", "power", "conditioning"] as const;
const FATIGUE_LEVELS = ["none", "some", "lots"] as const;

function selectExercise(id?: number) {
  return sql`
    select
      e.id, e.name, e.equipment, e.pattern, e.stimulus_type, e.notes,
      coalesce(
        (select array_agg(a.alias order by a.alias)
         from exercise_aliases a where a.exercise_id = e.id),
        '{}'
      ) as aliases,
      coalesce(
        (select json_agg(
           json_build_object('muscle', m.name, 'counts', em.counts, 'fatigue', em.fatigue)
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
      '"muscles" must be an array of {muscle, counts, fatigue} objects, e.g. {"muscle": "quads", "counts": true, "fatigue": "lots"}.',
    );
  }
  const muscles = muscleInputs.map((entry) => {
    const m = entry as Record<string, unknown>;
    if (typeof m !== "object" || m === null) {
      throw new ApiError(422, 'Each entry in "muscles" must be an object.');
    }
    if (typeof m.counts !== "boolean") {
      throw new ApiError(
        422,
        `"counts" must be true or false on every muscle entry: true only if the exercise takes that muscle close to failure.`,
      );
    }
    return {
      muscle: requireString(m, "muscle"),
      counts: m.counts,
      fatigue: requireOneOf(m, "fatigue", FATIGUE_LEVELS),
    };
  });

  const id = await sql.begin(async (sql) => {
    const [exercise] = await sql`
      insert into exercises (name, equipment, pattern, stimulus_type, notes)
      values (${name}, ${equipment}, ${pattern}, ${stimulusType}, ${notes})
      returning id`;

    for (const alias of aliases as string[]) {
      await sql`
        insert into exercise_aliases (exercise_id, alias)
        values (${exercise.id}, ${alias.trim()})`;
    }

    for (const { muscle, counts, fatigue } of muscles) {
      const [row] = await sql`
        select id from muscles where lower(name) = lower(${muscle})`;
      if (!row) {
        const [{ names }] = await sql`
          select coalesce(string_agg(name, ', ' order by name), '(none yet)') as names
          from muscles`;
        throw new ApiError(
          422,
          `Unknown muscle "${muscle}". Known muscles: ${names}. Add it first with POST /api/muscles.`,
        );
      }
      await sql`
        insert into exercise_muscles (exercise_id, muscle_id, counts, fatigue)
        values (${exercise.id}, ${row.id}, ${counts}, ${fatigue})`;
    }

    return exercise.id as number;
  });

  const [created] = await selectExercise(id);
  return c.json({ exercise: created }, 201);
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
