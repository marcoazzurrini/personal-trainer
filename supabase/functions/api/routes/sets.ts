import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "../db.ts";
import { ApiError } from "../lib/errors.ts";
import { assertEffort, assertSetMeasures } from "../lib/training.ts";
import {
  body,
  idParam,
  oneOf,
  optionalInt,
  optionalNumber,
  optionalText,
  optionalTimestamp,
} from "../lib/schema.ts";

const EFFORTS = ["easy", "hard", "failure"] as const;

const TARGET_FIELDS = [
  "target_weight_kg",
  "target_reps",
  "target_distance_m",
  "target_duration_s",
] as const;

export const sets = new OpenAPIHono();

const Set = z.object({
  id: z.int(),
  session_id: z.int(),
  exercise_id: z.int(),
  mesocycle_id: z.int().nullable(),
  position: z.int(),
  kind: z.string(),
  target_weight_kg: z.number().nullable(),
  target_reps: z.int().nullable(),
  target_distance_m: z.number().nullable(),
  target_duration_s: z.number().nullable(),
  weight_kg: z.number().nullable(),
  reps: z.int().nullable(),
  distance_m: z.number().nullable(),
  duration_s: z.number().nullable(),
  effort: z.enum(EFFORTS).nullable(),
  performed_at: z.string().nullable(),
  notes: z.string().nullable(),
});

type SetRow = z.infer<typeof Set>;

// Named in the schema rather than left to the unknown-field check, so the
// document says why they are refused instead of only that they are. Sending
// one is a mistake with a specific explanation, and it deserves it.
const immutableTarget = () =>
  z.unknown().optional().meta({
    description:
      "Refused. Targets are the record of what was asked that day and never change after the session exists.",
  });

// One set, sent as it's entered. Flat, not nested under the session: a set id
// is unique on its own, and patching a known id is idempotent — the log page
// resends after being offline. Targets are immutable: once written they are
// the record of what was asked, so this endpoint never touches them.
sets.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Training"],
    summary: "Correct a set's actuals",
    description:
      "Partial. A field left out is untouched; a field sent as null is cleared. Only actuals, performed_at and notes can change — targets are immutable.",
    request: {
      params: z.object({ id: idParam("set") }),
      body: {
        content: {
          "application/json": {
            schema: body({
              weight_kg: optionalNumber({ min: 0 }),
              reps: optionalInt({ min: 1 }),
              distance_m: optionalNumber({ min: 0 }),
              duration_s: optionalNumber({ min: 0 }),
              effort: oneOf(EFFORTS).nullish(),
              performed_at: optionalTimestamp(),
              notes: optionalText(),
              target_weight_kg: immutableTarget(),
              target_reps: immutableTarget(),
              target_distance_m: immutableTarget(),
              target_duration_s: immutableTarget(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The set as it now stands, targets beside actuals.",
        content: {
          "application/json": { schema: z.object({ set: Set }) },
        },
      },
      404: { description: "No set carries that id." },
      422: {
        description:
          "A target was sent, nothing was sent, or the result would break the exercise's measure or effort rule.",
      },
    },
  }),
  async (c) => {
    const setId = c.req.valid("param").id;
    const [existing] = await sql`
    select t.id, t.kind, t.performed_at, t.effort, t.weight_kg::float8, t.reps,
      t.distance_m::float8, t.duration_s::float8,
      e.name as exercise, e.measure, e.stimulus_type
    from sets t join exercises e on e.id = t.exercise_id
    where t.id = ${setId}`;
    if (!existing) throw new ApiError(404, `No set with id ${setId}.`);

    const b = c.req.valid("json");
    const target = TARGET_FIELDS.find((f) => b[f] !== undefined);
    if (target) {
      throw new ApiError(
        422,
        `Targets are immutable once the session exists: they are the record of what was asked that day, and "${target}" is one of them. Only actuals (weight_kg, reps, distance_m, duration_s, effort), performed_at, and notes can change. If the whole session was mis-planned and nothing has been performed yet, DELETE /sessions/:id discards the draft — then write it again.`,
      );
    }

    // Absent and explicitly null are different instructions — leave it alone
    // against clear it — and the schema keeps them apart: an omitted field
    // parses to undefined, a null one to null.
    const fields: Record<string, unknown> = {};
    for (
      const f of [
        "weight_kg",
        "reps",
        "distance_m",
        "duration_s",
        "effort",
        "performed_at",
        "notes",
      ] as const
    ) {
      if (b[f] !== undefined) fields[f] = b[f];
    }
    if (Object.keys(fields).length === 0) {
      throw new ApiError(
        422,
        'Send at least one of "weight_kg", "reps", "distance_m", "duration_s", "effort", "performed_at", "notes".',
      );
    }

    // A patch is partial, so the measure rule has to be checked against what the
    // row will be, not against what arrived. Correcting a squat's reps to null
    // and leaving its weight behind would otherwise sail through here and be
    // caught only by the constraint, which cannot explain itself as well.
    const pick = <T>(field: string, was: T) =>
      field in fields ? fields[field] as T : was;
    assertSetMeasures(existing.measure, existing.exercise, "actual", {
      weightKg: pick("weight_kg", existing.weight_kg),
      reps: pick("reps", existing.reps),
      distanceM: pick("distance_m", existing.distance_m),
      durationS: pick("duration_s", existing.duration_s),
    });
    assertEffort(
      existing.stimulus_type,
      existing.exercise,
      existing.kind,
      pick("reps", existing.reps),
      pick("effort", existing.effort),
    );

    // A set being performed right now gets its timestamp for free.
    const nowMeasured = fields.reps != null || fields.distance_m != null ||
      fields.duration_s != null;
    if (
      fields.performed_at === undefined && existing.performed_at === null &&
      nowMeasured
    ) {
      fields.performed_at = new Date().toISOString();
    }

    const [row] = await sql<SetRow[]>`
    update sets set ${sql(fields)} where id = ${setId}
    returning id, session_id, exercise_id, mesocycle_id, position, kind,
      target_weight_kg::float8, target_reps,
      target_distance_m::float8, target_duration_s::float8,
      weight_kg::float8, reps, distance_m::float8, duration_s::float8,
      effort, performed_at, notes`;
    return c.json({ set: row });
  },
);
