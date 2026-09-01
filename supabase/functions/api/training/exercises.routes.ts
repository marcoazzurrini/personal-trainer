import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  addExercise,
  addMuscle,
  correctExercise,
  deleteExercise,
  exerciseById,
  exerciseHistory,
  listExercises,
  listMuscles,
  reclassifyMuscles,
  SYSTEMIC_FATIGUE_LEVELS,
} from "./exercises.ts";
import { assertExerciseAliasesFree, resolveExercise } from "./resolve.ts";
import { MEASURES, STIMULUS_TYPES } from "./rules.ts";
import {
  aliasList,
  body,
  oneOf,
  optionalText,
  query,
  text,
} from "../shared/schema.ts";
import { addAliasRoute, releaseAliasRoute } from "../shared/aliases.routes.ts";

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

const muscleList = () =>
  z.array(muscleEntry(), { error: musclesError }).optional();

exercises.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Exercises"],
    summary: "The catalogue",
    request: { query: query({}) },
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
  async (c) => c.json({ exercises: await listExercises() }),
);

exercises.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Exercises"],
    summary: "Add an exercise",
    description:
      "Creates the exercise with its aliases and muscle classification in one call. Muscles are referenced by name and must already exist.",
    request: {
      query: query({}),
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
      409: {
        description:
          "That name already exists, or one of the aliases already belongs to another exercise — which one, and to what, is named in the error.",
      },
      422: { description: "An unknown muscle, or a bad volume_factor." },
    },
  }),
  async (c) =>
    c.json({ exercise: await addExercise(c.req.valid("json")) }, 201),
);

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
      query: query({
        limit: z.string().min(1).optional().meta({
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
  async (c) =>
    c.json(
      await exerciseHistory(
        c.req.valid("param").ref,
        c.req.valid("query").limit,
      ),
    ),
);

exercises.openapi(
  createRoute({
    method: "patch",
    path: "/{ref}",
    tags: ["Exercises"],
    summary: "Correct an exercise",
    description:
      "Prose and labels change freely. `measure` and `stimulus_type` freeze at the first logged set — every one of them was validated and counted under the current values. The muscle classification and the aliases have their own surfaces.",
    request: {
      query: query({}),
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
  async (c) =>
    c.json({
      exercise: await correctExercise(
        c.req.valid("param").ref,
        c.req.valid("json"),
      ),
    }),
);

// A synonym never becomes a second exercise row — that splits the lift's
// history in two. Same rule and same surface as foods.
const aliasSurface = {
  tag: "Exercises",
  aliasTable: "exercise_aliases",
  foreignKey: "exercise_id",
  ref,
  resolve: resolveExercise,
  respond: async (id: number) => ({ exercise: await exerciseById(id) }),
  responseSchema: z.object({ exercise: Exercise }),
};

addAliasRoute(exercises, {
  ...aliasSurface,
  assertFree: assertExerciseAliasesFree,
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

exercises.openapi(
  createRoute({
    method: "delete",
    path: "/{ref}",
    tags: ["Exercises"],
    summary: "Delete an unreferenced exercise",
    request: { params: z.object({ ref: ref() }), query: query({}) },
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
  async (c) =>
    c.json({ deleted: await deleteExercise(c.req.valid("param").ref) }),
);

exercises.openapi(
  createRoute({
    method: "put",
    path: "/{ref}/muscles",
    tags: ["Exercises"],
    summary: "Replace the muscle classification",
    description:
      "The complete replacement classification, not a patch. Retroactive by design — a wrong classification was wrong when written — and refused while any plan holding the exercise is still running, because it rewrites the very volume numbers that plan is being judged on.",
    request: {
      query: query({}),
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
  async (c) =>
    c.json(
      await reclassifyMuscles(
        c.req.valid("param").ref,
        c.req.valid("json").muscles,
      ),
    ),
);

export const muscles = new OpenAPIHono();

const Muscle = z.object({ id: z.int(), name: z.string() });

muscles.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Exercises"],
    summary: "Known muscles",
    request: { query: query({}) },
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
  async (c) => c.json({ muscles: await listMuscles() }),
);

muscles.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Exercises"],
    summary: "Add a muscle",
    request: {
      query: query({}),
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
  async (c) =>
    c.json({ muscle: await addMuscle(c.req.valid("json").name) }, 201),
);
