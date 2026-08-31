import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql, type Tx } from "../db.ts";
import { ApiError } from "../http/errors.ts";
import { romeNow } from "../record/calendar.ts";
import { resolveExercise, resolveExerciseId } from "../record/resolve.ts";
import { MEASURES } from "../rules/training.ts";
import { aliasList, body, oneOf, optionalText, text } from "../http/schema.ts";
import { addAliasRoute, releaseAliasRoute } from "./aliases.ts";

const STIMULUS_TYPES = ["strength", "power", "conditioning"] as const;
const SYSTEMIC_FATIGUE_LEVELS = ["normal", "high"] as const;

export const exercises = new OpenAPIHono();

const ref = () =>
  z.string().min(1).meta({
    description: "An exercise id, its name, or any of its aliases.",
    example: "back squat",
  });

const MuscleLink = z.object({
  muscle: z.string(),
  volume_factor: z.number(),
});

const Exercise = z.object({
  id: z.int(),
  name: z.string(),
  equipment: z.string().nullable(),
  pattern: z.string().nullable(),
  stimulus_type: z.enum(STIMULUS_TYPES),
  systemic_fatigue: z.enum(SYSTEMIC_FATIGUE_LEVELS),
  measure: z.enum(MEASURES),
  notes: z.string().nullable(),
  aliases: z.array(z.string()),
  muscles: z.array(MuscleLink),
});

type ExerciseRow = z.infer<typeof Exercise>;

const volumeFactorError = () =>
  '"volume_factor" must be 0, 0.5, or 1.0 on every muscle entry. 1.0 = direct (primary force generator, loaded dynamically through range), 0.5 = indirect (meaningfully trained, not primary), 0 = considered and deliberately excluded.';

// Named in the schema rather than left to the unknown-field check: both are
// fields that used to exist, so the caller needs to be told what replaced
// them, not merely that they are gone.
const musclesError = () =>
  '"muscles" must be an array of {muscle, volume_factor} objects, e.g. {"muscle": "quads", "volume_factor": 1.0}.';

const muscleEntry = () =>
  body({
    muscle: text(),
    volume_factor: z.union([
      z.literal(0),
      z.literal(0.5),
      z.literal(1),
    ], { error: volumeFactorError }),
    counts: z.unknown().optional().meta({
      description: 'Refused. Replaced by "volume_factor".',
    }),
    fatigue: z.unknown().optional().meta({
      description:
        'Refused. Systemic fatigue is a property of the exercise, not of a muscle: send "systemic_fatigue" at the top level.',
    }),
  }, 'an entry in "muscles"');

type MuscleEntryInput = z.infer<ReturnType<typeof muscleEntry>>;

const muscleList = () =>
  z.array(muscleEntry(), { error: musclesError }).optional();

interface MuscleEntry {
  muscle: string;
  volumeFactor: number;
}

function selectExercise(id?: number) {
  return sql<ExerciseRow[]>`
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

// One shape for a muscle classification, learned once: creation and the
// full-replacement PUT take exactly the same list. The two retired field
// names are checked here because each needs to name its replacement.
function parseMuscleList(
  entries: ReadonlyArray<MuscleEntryInput> | undefined,
): MuscleEntry[] {
  return (entries ?? []).map((m) => {
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
    return { muscle: m.muscle, volumeFactor: m.volume_factor };
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

exercises.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Exercises"],
    summary: "The catalogue",
    responses: {
      200: {
        description:
          "Every exercise with its aliases and muscle classification, by name.",
        content: {
          "application/json": {
            schema: z.object({ exercises: z.array(Exercise) }),
          },
        },
      },
    },
  }),
  async (c) => {
    return c.json({ exercises: await selectExercise() });
  },
);

// One call creates the exercise with its aliases and muscle mappings.
// Muscles are referenced by name and must already exist.
exercises.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Exercises"],
    summary: "Add an exercise",
    description:
      "Creates the exercise with its aliases and muscle classification in one call. Muscles are referenced by name and must already exist.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: body({
              name: text(),
              equipment: optionalText(),
              pattern: optionalText(),
              notes: optionalText(),
              measure: oneOf(MEASURES).default("load_reps"),
              stimulus_type: oneOf(STIMULUS_TYPES).default("strength"),
              systemic_fatigue: oneOf(SYSTEMIC_FATIGUE_LEVELS).default(
                "normal",
              ),
              aliases: aliasList(),
              muscles: muscleList(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "The exercise that was added.",
        content: {
          "application/json": { schema: z.object({ exercise: Exercise }) },
        },
      },
      409: { description: "That name or alias already exists." },
      422: { description: "An unknown muscle, or a bad volume_factor." },
    },
  }),
  async (c) => {
    const b = c.req.valid("json");
    const aliases = b.aliases ?? [];
    const muscles = parseMuscleList(b.muscles);

    const id = await sql.begin(async (sql) => {
      const [exercise] = await sql`
      insert into exercises
        (name, equipment, pattern, stimulus_type, systemic_fatigue, measure,
         notes)
      values
        (${b.name}, ${b.equipment ?? null}, ${b.pattern ?? null},
         ${b.stimulus_type}, ${b.systemic_fatigue}, ${b.measure},
         ${b.notes ?? null})
      returning id`;

      for (const alias of aliases) {
        await sql`
        insert into exercise_aliases (exercise_id, alias)
        values (${exercise.id}, ${alias})`;
      }

      await insertMuscles(sql, exercise.id, muscles);

      return exercise.id as number;
    });

    const [created] = await selectExercise(id);
    return c.json({ exercise: created }, 201);
  },
);

// How much history the caller asked for — required, with no default.
//
// A default here would be a decision nobody makes. request_id was optional
// once and the calls that could have sent it simply did not; the fix was to
// stop offering the choice of not deciding. The same applies to a read whose
// size grows forever: a main lift reaches a few hundred sets in a year, every
// set now carries its note, and "however much there is" is not an amount
// anybody chose.
//
// "all" is a first-class answer rather than a large number, because charting
// a whole block genuinely wants the series. Forced to invent a number, a
// caller picks a round one and plots a third of the history without noticing.
function historyLimit(raw: string | undefined): number | null {
  if (raw === "all") return null;
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n < 1) {
    throw new ApiError(
      422,
      '"limit" is required on a history read: a whole number for the most recent sets — 10 to 30 is usually enough to judge how an exercise is going — or "all" for the whole series, which is what charting a block or a year needs. Every set carries its note, so ask for what you will actually read. The reply says how many sets exist in total, so a partial read knows what it left behind.',
    );
  }
  return n;
}

const HistorySet = z.object({
  date: z.string(),
  weight_kg: z.number().nullable(),
  reps: z.int().nullable(),
  distance_m: z.number().nullable(),
  duration_s: z.number().nullable(),
  effort: z.string().nullable(),
  notes: z.string().nullable(),
  session_id: z.int(),
});

// Every working set for one lift over time. Accepts id, name, or alias.
exercises.openapi(
  createRoute({
    method: "get",
    path: "/{ref}/history",
    tags: ["Exercises"],
    summary: "Every working set of one lift, oldest last",
    description:
      '`limit` is required and has no default: this read grows forever, and "however much there is" is not an amount anybody chose. Every measure comes back — a sprint\'s history is metres and seconds — and every set carries its note, because this is where an exercise is judged and not only where it is plotted.',
    request: {
      params: z.object({ ref: ref() }),
      query: z.object({
        limit: z.string().optional().meta({
          description:
            'A whole number of most-recent sets, or "all" for the whole series. Required.',
          example: "30",
        }),
      }),
    },
    responses: {
      200: {
        description:
          "The series oldest to newest, with how many sets exist in total so a partial read knows what it left behind.",
        content: {
          "application/json": {
            schema: z.object({
              exercise: z.string(),
              exercise_id: z.int(),
              measure: z.enum(MEASURES),
              total_sets: z.int(),
              returned: z.int(),
              sets: z.array(HistorySet),
            }),
          },
        },
      },
      422: { description: "limit was missing or not a whole number or all." },
    },
  }),
  async (c) => {
    const limit = historyLimit(c.req.query("limit"));
    const exerciseId = await resolveExerciseId(c.req.valid("param").ref);
    const [exercise] = await sql`
    select id, name, measure from exercises where id = ${exerciseId}`;

    const [{ total }] = await sql`
    select count(*)::int as total
    from sets t
    where t.exercise_id = ${exerciseId} and t.kind = 'working'
      and set_performed(t.reps, t.distance_m, t.duration_s)`;

    // Every measure comes back, and which ones are populated is the exercise's
    // measure. A sprint's history is metres and seconds; reading it for a rising
    // weight would find nothing and conclude wrongly that nothing is happening.
    //
    // notes comes with them because this is where an exercise is judged, not
    // only where it is plotted. Four sessions at four reps read as a plateau;
    // "top third under control, red band" is the only thing that says otherwise,
    // and it was invisible here while the numbers were not.
    //
    // Ordered newest-first so a limit keeps the recent end, then reversed: the
    // series reads oldest to newest whichever amount was asked for. Postgres
    // treats `limit null` as no limit, which is what "all" resolves to.
    const rows = await sql<z.infer<typeof HistorySet>[]>`
    select s.date, t.weight_kg::float8, t.reps,
      t.distance_m::float8, t.duration_s::float8, t.effort, t.notes,
      t.session_id
    from sets t
    join sessions s on s.id = t.session_id
    where t.exercise_id = ${exerciseId} and t.kind = 'working'
      and set_performed(t.reps, t.distance_m, t.duration_s)
    order by s.date desc, t.position desc
    limit ${limit}`;

    return c.json({
      exercise: exercise.name as string,
      exercise_id: exercise.id as number,
      measure: exercise.measure as typeof MEASURES[number],
      total_sets: total as number,
      returned: rows.length,
      sets: rows.reverse(),
    });
  },
);

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
exercises.openapi(
  createRoute({
    method: "patch",
    path: "/{ref}",
    tags: ["Exercises"],
    summary: "Correct an exercise",
    description:
      "Prose and labels change freely. `measure` and `stimulus_type` freeze at the first logged set — every one of them was validated and counted under the current values. The muscle classification and the aliases have their own surfaces.",
    request: {
      params: z.object({ ref: ref() }),
      body: {
        content: {
          "application/json": {
            schema: body({
              name: text().optional(),
              equipment: optionalText(),
              pattern: optionalText(),
              notes: optionalText(),
              measure: oneOf(MEASURES).optional(),
              stimulus_type: oneOf(STIMULUS_TYPES).optional(),
              systemic_fatigue: oneOf(SYSTEMIC_FATIGUE_LEVELS).optional(),
              alias: z.unknown().optional().meta({
                description:
                  "Refused. Aliases have their own surface: POST /exercises/{ref}/aliases.",
              }),
              aliases: z.unknown().optional().meta({
                description:
                  "Refused. Aliases have their own surface: POST /exercises/{ref}/aliases.",
              }),
              muscles: z.unknown().optional().meta({
                description:
                  "Refused. The classification is replaced whole with PUT /exercises/{ref}/muscles.",
              }),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The exercise as it now stands.",
        content: {
          "application/json": { schema: z.object({ exercise: Exercise }) },
        },
      },
      422: {
        description:
          "Nothing was sent, a frozen field was sent after the first logged set, or a field with its own surface was sent here.",
      },
    },
  }),
  async (c) => {
    const e = await resolveExercise(c.req.valid("param").ref);
    const b = c.req.valid("json");

    if (b.muscles !== undefined) {
      throw new ApiError(
        422,
        "The muscle classification is replaced whole with PUT /exercises/:ref/muscles — a partial edit of a classification is ambiguous about the rows it does not mention.",
      );
    }
    if (b.alias !== undefined || b.aliases !== undefined) {
      throw new ApiError(
        422,
        "Aliases have their own surface: POST /exercises/:ref/aliases adds, DELETE /exercises/:ref/aliases/:alias removes.",
      );
    }

    const fields: Record<string, unknown> = {};
    for (
      const f of [
        "name",
        "equipment",
        "pattern",
        "notes",
        "systemic_fatigue",
      ] as const
    ) {
      if (b[f] !== undefined) fields[f] = b[f];
    }

    if (b.measure !== undefined || b.stimulus_type !== undefined) {
      const [{ n }] = await sql`
      select count(*)::int as n from sets where exercise_id = ${e.id}`;
      if (n > 0) {
        throw new ApiError(
          422,
          `"measure" and "stimulus_type" are frozen once an exercise has logged sets — "${e.name}" has ${n}. Every one of them was validated and counted under the current values, so changing them would rewrite history that already happened. The fix now is a new exercise with the right value, which takes over this one's aliases (POST /exercises, then move the aliases).`,
        );
      }
      if (b.measure !== undefined) fields.measure = b.measure;
      if (b.stimulus_type !== undefined) {
        fields.stimulus_type = b.stimulus_type;
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
  },
);

// A synonym never becomes a second exercise row — that splits the lift's
// history in two. Same rule and same surface as foods.
const aliasSurface = {
  tag: "Exercises",
  aliasTable: "exercise_aliases",
  foreignKey: "exercise_id",
  ref,
  resolve: resolveExercise,
  respond: async (id: number) => ({ exercise: (await selectExercise(id))[0] }),
  responseSchema: z.object({ exercise: Exercise }),
};

addAliasRoute(exercises, {
  ...aliasSurface,
  created: "The exercise, with the alias now among its names.",
  neither:
    'Send "alias" (a string) or "aliases" (an array of non-empty strings).',
});

releaseAliasRoute(exercises, {
  ...aliasSurface,
  summary: "Release a synonym",
  removed: "The exercise, without that name.",
  notAnAliasResponse: "That alias does not point at that exercise.",
  notAnAlias: (alias, e) =>
    `"${alias}" is not an alias of "${e.name}". GET /exercises lists each exercise's aliases.`,
});

// Only an exercise nothing has ever referenced — a typo'd duplicate caught
// before it was logged or planned. Once it is in the record, deleting it
// would orphan history; the answer there is PATCH for the fixable fields, or
// aliases moved to the exercise being kept.
exercises.openapi(
  createRoute({
    method: "delete",
    path: "/{ref}",
    tags: ["Exercises"],
    summary: "Delete an unreferenced exercise",
    request: { params: z.object({ ref: ref() }) },
    responses: {
      200: {
        description: "The name of the exercise that was deleted.",
        content: {
          "application/json": { schema: z.object({ deleted: z.string() }) },
        },
      },
      409: {
        description:
          "The exercise is in the record — logged sets, plan entries or dose history — so deleting it would orphan history.",
      },
    },
  }),
  async (c) => {
    const e = await resolveExercise(c.req.valid("param").ref);
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
  },
);

// Reclassification is a retroactive fix in the PATCH /foods sense: a wrong
// classification was wrong when written, and every past volume number it fed
// was wrong with it. That is also why it is refused while any active plan
// holds the exercise — "wholesale change belongs between mesocycles" was
// programming.md's rule with no enforcement, and a mid-plan reclassification
// silently rewrites the very numbers the plan is being judged on.
exercises.openapi(
  createRoute({
    method: "put",
    path: "/{ref}/muscles",
    tags: ["Exercises"],
    summary: "Replace the muscle classification",
    description:
      "The complete replacement classification, not a patch. Retroactive by design — a wrong classification was wrong when written — and refused while any plan holding the exercise is still running, because it rewrites the very volume numbers that plan is being judged on.",
    request: {
      params: z.object({ ref: ref() }),
      body: {
        content: {
          "application/json": {
            schema: body({
              muscles: z.array(muscleEntry(), {
                error: () =>
                  'Send "muscles" as the complete replacement classification — every {muscle, volume_factor} row, not just the ones changing. A partial list is ambiguous about the rows it does not mention.',
              }),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "The reclassified exercise, and how many finished weeks of volume the change rewrote.",
        content: {
          "application/json": {
            schema: z.object({ exercise: Exercise, note: z.string() }),
          },
        },
      },
      409: {
        description:
          "A plan holding this exercise is still running. The change belongs between mesocycles, at the review.",
      },
      422: { description: "An unknown muscle, or a bad volume_factor." },
    },
  }),
  async (c) => {
    const e = await resolveExercise(c.req.valid("param").ref);
    const muscles = parseMuscleList(c.req.valid("json").muscles);

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
        < date_trunc('week', ${romeNow()})`;

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
  },
);

export const muscles = new OpenAPIHono();

const Muscle = z.object({ id: z.int(), name: z.string() });

muscles.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Exercises"],
    summary: "Known muscles",
    responses: {
      200: {
        description: "Every muscle an exercise can be classified against.",
        content: {
          "application/json": {
            schema: z.object({ muscles: z.array(Muscle) }),
          },
        },
      },
    },
  }),
  async (c) => {
    const rows = await sql<z.infer<typeof Muscle>[]>`
      select id, name from muscles order by name`;
    return c.json({ muscles: rows });
  },
);

muscles.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Exercises"],
    summary: "Add a muscle",
    request: {
      body: {
        content: { "application/json": { schema: body({ name: text() }) } },
      },
    },
    responses: {
      201: {
        description: "The muscle that was added.",
        content: {
          "application/json": { schema: z.object({ muscle: Muscle }) },
        },
      },
      409: { description: "That muscle already exists." },
    },
  }),
  async (c) => {
    const { name } = c.req.valid("json");
    const [row] = await sql<z.infer<typeof Muscle>[]>`
    insert into muscles (name) values (${name}) returning id, name`;
    return c.json({ muscle: row }, 201);
  },
);
