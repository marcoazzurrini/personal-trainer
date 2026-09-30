import type {
  Header,
  SetSnapshot,
  SessionSnapshot,
  WriteFields,
} from "../../db/contracts/training.ts";
import type { SessionsRepository } from "../../db/repositories/training/sessions.ts";
import { ApiError, requireRow } from "../shared/errors.ts";
import {
  date,
  decimal,
  instant,
  requestId,
  systemClock,
  wireInstant,
} from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import type { trainingResolver, SetResolver } from "./resolve.ts";
import { assertEffort, assertSetMeasures } from "./rules.ts";
import { retrySessionWrite } from "./session_write.ts";
import type {
  AppendedSetRow,
  CorrectSessionInput,
  SessionDetailRow,
  SessionHeaderRow,
  SetEntry,
  WriteSessionInput,
} from "./sessions.types.ts";
import { prepareSetCorrection } from "./set_correction.ts";
import type { CorrectSetInput } from "./set_correction.ts";
import type { SetRow } from "./sets.types.ts";

interface Snapshot {
  header: Header;
  sets: SetSnapshot[];
}
const sessionFields = [
  "notes",
  "overall_feel",
  "rationale",
  "started_at",
  "completed_at",
] as const;
/** Validate API values without turning decimal measurements into stored integers. */
function validatedFields(fields: WriteFields): WriteFields {
  const measures = [
    ["weight_kg", 6, 2],
    ["target_weight_kg", 6, 2],
    ["distance_m", 7, 1],
    ["target_distance_m", 7, 1],
    ["duration_s", 8, 2],
    ["target_duration_s", 8, 2],
  ] as const;
  for (const [field, precision, scale] of measures) {
    const value = fields[field];
    if (value !== undefined) {
      decimal(value, precision, scale);
    }
  }
  const normalized = { ...fields };
  for (const field of ["performed_at", "started_at", "completed_at"] as const) {
    const value = fields[field];
    if (value !== undefined && value !== null) {
      normalized[field] = instant(value);
    }
  }
  return normalized;
}

function snapshot(current: SessionSnapshot, id: number): Snapshot {
  return {
    header: requireRow(current.headers, `No session with id ${id}.`),
    sets: current.sets,
  };
}
function detail(current: Snapshot): SessionDetailRow {
  const { write_version: _version, ...header } = current.header;
  return {
    ...header,
    started_at: wireInstant(header.started_at),
    completed_at: wireInstant(header.completed_at),
    sets: current.sets.map((set) => {
      const {
        session_id: _session,
        stimulus_type: _stimulus,
        request_id: _request,
        ...publicSet
      } = set;
      return {
        ...publicSet,
        performed_at: wireInstant(publicSet.performed_at),
      };
    }),
  };
}
function appended(set: SetSnapshot): AppendedSetRow {
  const {
    exercise: _exercise,
    measure: _measure,
    stimulus_type: _stimulus,
    request_id: _request,
    target_weight_kg: _weight,
    target_reps: _reps,
    target_distance_m: _distance,
    target_duration_s: _duration,
    ...publicSet
  } = set;
  return { ...publicSet, performed_at: wireInstant(publicSet.performed_at) };
}
export function sessionStore(
  repository: SessionsRepository,
  resolver: ReturnType<typeof trainingResolver>,
  clock: Clock = systemClock
) {
  async function read(id: number): Promise<Snapshot> {
    return snapshot(await repository.read(id), id);
  }
  async function sessionDetail(id: number): Promise<SessionDetailRow> {
    return detail(await read(id));
  }
  async function listSessions(
    limit: number,
    mesocycle?: string
  ): Promise<SessionHeaderRow[]> {
    const id = mesocycle
      ? (await resolver.resolveMesocycle(mesocycle)).id
      : null;
    const found = await repository.list(limit, id);
    return found.map((row) => ({
      ...row,
      started_at: wireInstant(row.started_at),
      completed_at: wireInstant(row.completed_at),
    }));
  }

  // Resolution caches belong to one write attempt, never a request-global cache.
  function parser(references: SetResolver = resolver) {
    const exercises = new Map<
      SetEntry["exercise"],
      Awaited<ReturnType<typeof resolver.resolveExercise>>
    >();
    const plans = new Map<number, Map<SetEntry["mesocycle"], number | null>>();
    // oxlint-disable-next-line complexity -- Keep ordered target, actual and effort refusals with the attempt-local resolution caches.
    return async (s: SetEntry) => {
      let exercise = exercises.get(s.exercise);
      if (exercise === undefined) {
        exercise = await references.resolveExercise(s.exercise);
        exercises.set(s.exercise, exercise);
      }
      const target = {
        weightKg: s.target_weight_kg ?? null,
        reps: s.target_reps ?? null,
        distanceM: s.target_distance_m ?? null,
        durationS: s.target_duration_s ?? null,
      };
      const actual = {
        weightKg: s.weight_kg ?? null,
        reps: s.reps ?? null,
        distanceM: s.distance_m ?? null,
        durationS: s.duration_s ?? null,
      };
      assertSetMeasures(exercise.measure, exercise.name, "target", target);
      assertSetMeasures(exercise.measure, exercise.name, "actual", actual);
      const asked =
        target.reps !== null ||
        target.distanceM !== null ||
        target.durationS !== null;
      const performed =
        actual.reps !== null ||
        actual.distanceM !== null ||
        actual.durationS !== null;
      if (asked && performed) {
        throw new ApiError(
          422,
          "A new set carries targets (upcoming session) or actuals (retro-logged), never both: targets written after the fact would always match what was done."
        );
      }
      assertEffort(
        exercise.stimulus_type,
        exercise.name,
        s.kind,
        actual.reps,
        s.effort ?? null
      );
      let forExercise = plans.get(exercise.id);
      if (!forExercise) {
        forExercise = new Map();
        plans.set(exercise.id, forExercise);
      }
      let mesocycleId = forExercise.get(s.mesocycle);
      if (mesocycleId === undefined) {
        mesocycleId = await references.resolveSetMesocycleId(
          exercise.id,
          s.mesocycle
        );
        forExercise.set(s.mesocycle, mesocycleId);
      }
      return validatedFields({
        exercise_id: exercise.id,
        // Recheck the identity used for validation inside the write batch.
        // A registry edit must not race the first set logged for an exercise.
        expected_measure: exercise.measure,
        expected_stimulus_type: exercise.stimulus_type,
        mesocycle_id: mesocycleId,
        kind: s.kind,
        target_weight_kg: target.weightKg,
        target_reps: target.reps,
        target_distance_m: target.distanceM,
        target_duration_s: target.durationS,
        weight_kg: actual.weightKg,
        reps: actual.reps,
        distance_m: actual.distanceM,
        duration_s: actual.durationS,
        effort: s.effort ?? null,
        performed_at: s.performed_at ?? null,
        notes: s.notes ?? null,
      });
    };
  }

  async function writeSession(
    b: WriteSessionInput
  ): Promise<{ session: SessionDetailRow; created: boolean }> {
    const uuid = requestId(b.request_id);
    const [seen] = await repository.findRequest(uuid);
    if (seen) {
      return { session: await sessionDetail(seen.id), created: false };
    }
    const parse = parser(await resolver.forSets(b.sets));
    const sets = [];
    for (const input of b.sets) {
      sets.push(await parse(input));
    }
    // Parent lookup uses the unique request id, not last_insert_rowid(), which
    // is fragile in multi-statement batches containing trigger writes.
    const result = await repository.create({
      date: date(b.date),
      rationale: b.rationale,
      request_id: uuid,
      sets,
    });
    return {
      session: detail(snapshot(result, 0)),
      created: true,
    };
  }

  async function appendSet(
    id: number,
    b: SetEntry & { request_id: string }
  ): Promise<{ set: AppendedSetRow; created: boolean }> {
    const uuid = requestId(b.request_id);
    return await retrySessionWrite(id, async () => {
      const current = await read(id);
      const seen = current.sets.find((set) => set.request_id === uuid);
      if (seen) {
        return { set: appended(seen), created: false };
      }
      const set = await parser()(b);
      if (
        set.target_reps !== null ||
        set.target_distance_m !== null ||
        set.target_duration_s !== null
      ) {
        throw new ApiError(
          422,
          "An unplanned set records what was done: send actuals, not targets."
        );
      }
      if (
        set.reps === null &&
        set.distance_m === null &&
        set.duration_s === null
      ) {
        throw new ApiError(
          422,
          "An unplanned set records what was done, so it needs a measurement: reps, distance_m, or duration_s, depending on how the exercise is measured."
        );
      }
      set.performed_at ??= instant(clock().toISOString());
      const result = await repository.append(
        id,
        current.header.write_version,
        uuid,
        set
      );
      return {
        set: appended(
          requireRow(result, "The appended set could not be read.")
        ),
        created: true,
      };
    });
  }

  async function correctSession(
    id: number,
    b: CorrectSessionInput
  ): Promise<SessionDetailRow> {
    return await retrySessionWrite(id, async () => {
      const current = await read(id);
      const facts = validatedFields(
        Object.fromEntries(
          sessionFields
            .filter((field) => b[field] !== undefined)
            .map((field) => [field, b[field]])
        )
      );
      if (Object.keys(facts).length === 0 && b.sets === undefined) {
        throw new ApiError(
          422,
          'Send at least one of "notes", "overall_feel", "rationale", "started_at", "completed_at", or a non-empty "sets" array of corrections with set ids.'
        );
      }
      if (b.sets !== undefined && b.sets.length === 0) {
        throw new ApiError(
          422,
          '"sets" must be a non-empty array of corrections with set ids. Omit it when changing only session facts.'
        );
      }
      if (new Set(b.sets?.map((s) => s.id)).size !== (b.sets?.length ?? 0)) {
        throw new ApiError(
          422,
          'Each set id may appear only once in "sets". Combine corrections for the same set into one entry. Nothing was written.'
        );
      }
      const byId = new Map(current.sets.map((set) => [set.id, set]));
      const stamp = instant(clock().toISOString());
      const changes = (b.sets ?? []).map((entry) => {
        const was = byId.get(entry.id);
        if (!was) {
          throw new ApiError(
            404,
            `No set with id ${entry.id} in session ${id}. Read GET /sessions/${id} for its set ids. Nothing was written.`
          );
        }
        return {
          id: entry.id,
          fields: validatedFields(prepareSetCorrection(was, entry, stamp)),
        };
      });
      const result = await repository.correct(
        id,
        current.header.write_version,
        facts,
        changes
      );
      return detail(snapshot(result, id));
    });
  }

  async function correctSet(
    setId: number,
    input: CorrectSetInput
  ): Promise<SetRow> {
    const owner = requireRow(
      await repository.owner(setId),
      `No set with id ${setId}.`
    );
    try {
      const session = await correctSession(owner.session_id, {
        sets: [{ ...input, id: setId }],
      });
      const set = requireRow(
        session.sets.filter((s) => s.id === setId),
        `No set with id ${setId}.`
      );
      const { exercise: _exercise, measure: _measure, ...fields } = set;
      return { ...fields, session_id: owner.session_id };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new ApiError(404, `No set with id ${setId}.`);
      }
      throw error;
    }
  }

  async function discardSession(
    id: number
  ): Promise<{ id: number; date: string; sets: number }> {
    return await retrySessionWrite(id, async () => {
      const current = await read(id);
      const total = current.sets.length;
      const performed = current.sets.filter((s) =>
        [
          s.weight_kg,
          s.reps,
          s.distance_m,
          s.duration_s,
          s.effort,
          s.performed_at,
        ].some((v) => v !== null)
      ).length;
      if (
        performed > 0 ||
        current.header.started_at !== null ||
        current.header.completed_at !== null
      ) {
        const why =
          performed > 0
            ? `${performed} of its ${total} sets carry actuals`
            : "it was started or finished";
        throw new ApiError(
          409,
          `This session is on the record — ${why} — so it cannot be deleted. A wrong actual is corrected with PATCH /sets/:id, session-level facts with PATCH /sessions/:id. Only a planned session nothing has touched can be discarded.`
        );
      }
      await repository.discard(id, current.header.write_version, total);
      return { id, date: current.header.date, sets: total };
    });
  }

  return {
    sessionDetail,
    listSessions,
    writeSession,
    appendSet,
    correctSession,
    correctSet,
    discardSession,
  };
}
