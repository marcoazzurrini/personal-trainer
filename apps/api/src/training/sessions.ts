import type {
  Header,
  SetSnapshot,
  SessionSnapshot,
  WriteFields,
} from "@trainer/db/contracts/training.ts";
import type { SessionsRepository } from "@trainer/db/repositories/training/sessions.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import { Conflict, Invalid, NotFound, requireRow } from "../shared/refusals.ts";
import type { DatabaseFailure } from "../shared/refusals.ts";
import {
  date,
  decimal,
  instant,
  now,
  requestId,
  wireInstant,
} from "../shared/values.ts";
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
const validatedFields = Effect.fnUntraced(function* (
  fields: WriteFields
): Effect.fn.Return<WriteFields, Invalid> {
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
      yield* decimal(value, precision, scale);
    }
  }
  const normalized = { ...fields };
  for (const field of ["performed_at", "started_at", "completed_at"] as const) {
    const value = fields[field];
    if (value !== undefined && value !== null) {
      normalized[field] = yield* instant(value);
    }
  }
  return normalized;
});

function snapshot(
  current: SessionSnapshot,
  id: number
): Effect.Effect<Snapshot, NotFound> {
  return requireRow(current.headers, `No session with id ${id}.`).pipe(
    Effect.map((header) => ({ header, sets: current.sets }))
  );
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
  rows: SessionsRepository,
  resolver: ReturnType<typeof trainingResolver>
) {
  const repository = effectful(rows);

  const read = Effect.fnUntraced(function* (
    id: number
  ): Effect.fn.Return<Snapshot, NotFound | DatabaseFailure> {
    return yield* snapshot(yield* repository.read(id), id);
  });
  const sessionDetail = Effect.fn("sessions.sessionDetail")(function* (
    id: number
  ): Effect.fn.Return<SessionDetailRow, NotFound | DatabaseFailure> {
    return detail(yield* read(id));
  });
  const listSessions = Effect.fn("sessions.listSessions")(function* (
    limit: number,
    mesocycle?: string
  ): Effect.fn.Return<
    SessionHeaderRow[],
    Invalid | NotFound | DatabaseFailure
  > {
    const id = mesocycle
      ? (yield* resolver.resolveMesocycle(mesocycle)).id
      : null;
    const found = yield* repository.list(limit, id);
    return found.map((row) => ({
      ...row,
      started_at: wireInstant(row.started_at),
      completed_at: wireInstant(row.completed_at),
    }));
  });

  // Resolution caches belong to one write attempt, never a request-global cache.
  function parser(references: SetResolver = resolver) {
    const exercises = new Map<
      SetEntry["exercise"],
      Effect.Success<ReturnType<typeof resolver.resolveExercise>>
    >();
    const plans = new Map<number, Map<SetEntry["mesocycle"], number | null>>();
    // oxlint-disable-next-line complexity -- Keep ordered target, actual and effort refusals with the attempt-local resolution caches.
    return Effect.fnUntraced(function* (
      s: SetEntry
    ): Effect.fn.Return<WriteFields, Invalid | NotFound | DatabaseFailure> {
      let exercise = exercises.get(s.exercise);
      if (exercise === undefined) {
        exercise = yield* references.resolveExercise(s.exercise);
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
      yield* assertSetMeasures(
        exercise.measure,
        exercise.name,
        "target",
        target
      );
      yield* assertSetMeasures(
        exercise.measure,
        exercise.name,
        "actual",
        actual
      );
      const asked =
        target.reps !== null ||
        target.distanceM !== null ||
        target.durationS !== null;
      const performed =
        actual.reps !== null ||
        actual.distanceM !== null ||
        actual.durationS !== null;
      if (asked && performed) {
        return yield* new Invalid({
          message:
            "A new set carries targets (upcoming session) or actuals (retro-logged), never both: targets written after the fact would always match what was done.",
        });
      }
      yield* assertEffort(
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
        mesocycleId = yield* references.resolveSetMesocycleId(
          exercise.id,
          s.mesocycle
        );
        forExercise.set(s.mesocycle, mesocycleId);
      }
      return yield* validatedFields({
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
    });
  }

  const writeSession = Effect.fn("sessions.writeSession")(function* (
    b: WriteSessionInput
  ): Effect.fn.Return<
    { session: SessionDetailRow; created: boolean },
    Invalid | NotFound | DatabaseFailure
  > {
    const uuid = yield* requestId(b.request_id);
    const [seen] = yield* repository.findRequest(uuid);
    if (seen) {
      return { session: yield* sessionDetail(seen.id), created: false };
    }
    const parse = parser(yield* resolver.forSets(b.sets));
    const sets = [];
    for (const input of b.sets) {
      sets.push(yield* parse(input));
    }
    // Parent lookup uses the unique request id, not last_insert_rowid(), which
    // is fragile in multi-statement batches containing trigger writes.
    const result = yield* repository.create({
      date: yield* date(b.date),
      rationale: b.rationale,
      request_id: uuid,
      sets,
    });
    return {
      session: detail(yield* snapshot(result, 0)),
      created: true,
    };
  });

  const appendSet = Effect.fn("sessions.appendSet")(function* (
    id: number,
    b: SetEntry & { request_id: string }
  ): Effect.fn.Return<
    { set: AppendedSetRow; created: boolean },
    Invalid | NotFound | Conflict | DatabaseFailure
  > {
    const uuid = yield* requestId(b.request_id);
    return yield* retrySessionWrite(
      id,
      Effect.gen(function* () {
        const current = yield* read(id);
        const seen = current.sets.find((set) => set.request_id === uuid);
        if (seen) {
          return { set: appended(seen), created: false };
        }
        const set = yield* parser()(b);
        if (
          set.target_reps !== null ||
          set.target_distance_m !== null ||
          set.target_duration_s !== null
        ) {
          return yield* new Invalid({
            message:
              "An unplanned set records what was done: send actuals, not targets.",
          });
        }
        if (
          set.reps === null &&
          set.distance_m === null &&
          set.duration_s === null
        ) {
          return yield* new Invalid({
            message:
              "An unplanned set records what was done, so it needs a measurement: reps, distance_m, or duration_s, depending on how the exercise is measured.",
          });
        }
        set.performed_at ??= yield* now;
        const result = yield* repository.append(
          id,
          current.header.write_version,
          uuid,
          set
        );
        return {
          set: appended(
            yield* requireRow(result, "The appended set could not be read.")
          ),
          created: true,
        };
      })
    );
  });

  const correctSession = Effect.fn("sessions.correctSession")(function* (
    id: number,
    b: CorrectSessionInput
  ): Effect.fn.Return<
    SessionDetailRow,
    Invalid | NotFound | Conflict | DatabaseFailure
  > {
    return yield* retrySessionWrite(
      id,
      Effect.gen(function* () {
        const current = yield* read(id);
        const facts = yield* validatedFields(
          Object.fromEntries(
            sessionFields
              .filter((field) => b[field] !== undefined)
              .map((field) => [field, b[field]])
          )
        );
        if (Object.keys(facts).length === 0 && b.sets === undefined) {
          return yield* new Invalid({
            message:
              'Send at least one of "notes", "overall_feel", "rationale", "started_at", "completed_at", or a non-empty "sets" array of corrections with set ids.',
          });
        }
        if (b.sets !== undefined && b.sets.length === 0) {
          return yield* new Invalid({
            message:
              '"sets" must be a non-empty array of corrections with set ids. Omit it when changing only session facts.',
          });
        }
        if (new Set(b.sets?.map((s) => s.id)).size !== (b.sets?.length ?? 0)) {
          return yield* new Invalid({
            message:
              'Each set id may appear only once in "sets". Combine corrections for the same set into one entry. Nothing was written.',
          });
        }
        const byId = new Map(current.sets.map((set) => [set.id, set]));
        const stamp = yield* now;
        const changes = [];
        for (const entry of b.sets ?? []) {
          const was = byId.get(entry.id);
          if (!was) {
            return yield* new NotFound({
              message: `No set with id ${entry.id} in session ${id}. Read GET /sessions/${id} for its set ids. Nothing was written.`,
            });
          }
          changes.push({
            id: entry.id,
            fields: yield* validatedFields(
              yield* prepareSetCorrection(was, entry, stamp)
            ),
          });
        }
        const result = yield* repository.correct(
          id,
          current.header.write_version,
          facts,
          changes
        );
        return detail(yield* snapshot(result, id));
      })
    );
  });

  const correctSet = Effect.fn("sessions.correctSet")(function* (
    setId: number,
    input: CorrectSetInput
  ): Effect.fn.Return<SetRow, Invalid | NotFound | Conflict | DatabaseFailure> {
    const owner = yield* requireRow(
      yield* repository.owner(setId),
      `No set with id ${setId}.`
    );
    return yield* Effect.gen(function* () {
      const session = yield* correctSession(owner.session_id, {
        sets: [{ ...input, id: setId }],
      });
      const set = yield* requireRow(
        session.sets.filter((s) => s.id === setId),
        `No set with id ${setId}.`
      );
      const { exercise: _exercise, measure: _measure, ...fields } = set;
      return { ...fields, session_id: owner.session_id };
    }).pipe(
      // Every absence on the way — the session, or the set within it — is
      // answered as the set the caller named.
      Effect.catchTag("NotFound", () =>
        Effect.fail(new NotFound({ message: `No set with id ${setId}.` }))
      )
    );
  });

  const discardSession = Effect.fn("sessions.discardSession")(function* (
    id: number
  ): Effect.fn.Return<
    { id: number; date: string; sets: number },
    NotFound | Conflict | DatabaseFailure
  > {
    return yield* retrySessionWrite(
      id,
      Effect.gen(function* () {
        const current = yield* read(id);
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
          return yield* new Conflict({
            message: `This session is on the record — ${why} — so it cannot be deleted. A wrong actual is corrected with PATCH /sets/:id, session-level facts with PATCH /sessions/:id. Only a planned session nothing has touched can be discarded.`,
          });
        }
        yield* repository.discard(id, current.header.write_version, total);
        return { id, date: current.header.date, sets: total };
      })
    );
  });

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
