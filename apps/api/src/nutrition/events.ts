import type {
  EventRecord,
  EventsRepository,
} from "@trainer/db/repositories/nutrition/events.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import { addDays } from "../shared/dates.ts";
import { requireRow } from "../shared/refusals.ts";
import type { DatabaseFailure, Invalid, NotFound } from "../shared/refusals.ts";
import {
  date,
  now,
  requestId,
  romeDate,
  wireInstant,
} from "../shared/values.ts";
import type { ActiveTransient, EventRow, Kind } from "./events.types.ts";

function wireEvent(row: EventRecord): EventRow {
  return { ...row, created_at: wireInstant(row.created_at) };
}

export function eventStore(rows: EventsRepository) {
  const repository = effectful(rows);

  const listEvents = Effect.fn("events.listEvents")(
    function* (): Effect.fn.Return<EventRow[], DatabaseFailure> {
      return (yield* repository.list()).map(wireEvent);
    }
  );

  const activeTransients = Effect.fn("events.activeTransients")(function* (
    asOf: string
  ): Effect.fn.Return<ActiveTransient[], Invalid | DatabaseFailure> {
    const day = yield* date(asOf);
    return yield* repository.inRange(addDays(day, -14), day);
  });

  const registerEvent = Effect.fn("events.registerEvent")(function* (b: {
    day?: string | null;
    kind: Kind;
    note?: string | null;
    request_id: string;
  }): Effect.fn.Return<
    { row: EventRow; created: boolean },
    Invalid | NotFound | DatabaseFailure
  > {
    const uuid = yield* requestId(b.request_id);
    const seen = () => repository.findRequest(uuid);
    const replay = yield* seen();
    if (replay) {
      return { row: wireEvent(replay), created: false };
    }
    return yield* Effect.gen(function* () {
      const createdAt = yield* now;
      const result = yield* repository.save({
        day: yield* date(b.day ?? (yield* romeDate(createdAt))),
        kind: b.kind,
        note: b.note ?? null,
        request_id: uuid,
        created_at: createdAt,
      });
      return {
        row: wireEvent(
          yield* requireRow(
            result.row ? [result.row] : [],
            "The nutrition event could not be read after saving."
          )
        ),
        created: result.created,
      };
    }).pipe(
      // Whatever went wrong, a concurrent retry may have saved this request;
      // anything else still fails exactly as it did.
      Effect.catchCause((cause) =>
        seen().pipe(
          Effect.flatMap((recovered) =>
            recovered
              ? Effect.succeed({ row: wireEvent(recovered), created: false })
              : Effect.failCause(cause)
          )
        )
      )
    );
  });

  const withdrawEvent = Effect.fn("events.withdrawEvent")(function* (
    id: number
  ): Effect.fn.Return<
    Pick<EventRow, "day" | "kind" | "note">,
    NotFound | DatabaseFailure
  > {
    const missing = `No nutrition event with id ${id}. Read GET /nutrition-events and use an id from the current events list.`;
    const row =
      id < 0
        ? yield* repository.suppressGoalSwitch(id)
        : yield* repository.remove(id);
    return yield* requireRow(row ? [row] : [], missing);
  });

  return { listEvents, activeTransients, registerEvent, withdrawEvent };
}

export type EventsService = ReturnType<typeof eventStore>;
