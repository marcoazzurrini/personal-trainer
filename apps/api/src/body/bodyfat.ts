import type {
  BodyfatMeasurement,
  BodyfatRepository,
} from "@trainer/db/repositories/bodyfat.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import { requireNotFuture } from "../shared/dates.ts";
import { Conflict, NotFound } from "../shared/refusals.ts";
import type { DatabaseFailure, Invalid } from "../shared/refusals.ts";
import {
  date,
  decimal,
  now,
  requestId,
  romeDate,
  wireInstant,
} from "../shared/values.ts";
import type {
  BodyfatRow,
  Method,
  RecordBodyfatInput,
  RecordedBodyfat,
} from "./bodyfat.types.ts";
import { METHODS } from "./constants.ts";

function storedMethod(value: string): Method {
  const method = METHODS.find((candidate) => candidate === value);
  if (!method) {
    throw new Error("Unknown stored body-fat method.");
  }
  return method;
}

function wireMeasurement(row: BodyfatMeasurement): BodyfatRow {
  return {
    ...row,
    method: storedMethod(row.method),
    created_at: wireInstant(row.created_at),
  };
}

export function bodyfatStore(rows: BodyfatRepository) {
  const repository = effectful(rows);

  const recordBodyfat = Effect.fn("bodyfat.recordBodyfat")(function* (
    input: RecordBodyfatInput
  ): Effect.fn.Return<
    RecordedBodyfat,
    Invalid | NotFound | Conflict | DatabaseFailure
  > {
    const createdAt = yield* now;
    const today = yield* romeDate(createdAt);
    const day = yield* requireNotFuture(
      yield* date(input.day ?? today),
      today,
      "day"
    );
    const value = yield* decimal(input.percent, 4, 1);
    const conflict = (existing: BodyfatRow) =>
      new Conflict({
        message: `A different estimate (${existing.percent}%) is already recorded for ${day} from method "${input.method}". Record the new reading under its own method, or on the day it was actually taken — an estimate is a measurement, not a running opinion.`,
      });
    // Natural-key precedence includes request-id validation: an existing
    // measurement is answered before inspecting the retry identifier.
    const found = yield* repository.findByDayMethod(day, input.method);
    if (found) {
      const row = wireMeasurement(found);
      if (found.percent === value / 10) {
        return { row, created: false };
      }
      return yield* conflict(row);
    }
    const result = yield* repository.save({
      day,
      percent: input.percent,
      method: input.method,
      note: input.note ?? null,
      requestId: yield* requestId(input.requestId),
      createdAt,
    });
    if (result.kind === "missing") {
      return yield* new NotFound({
        message: "The body-fat estimate could not be read after saving.",
      });
    }
    const row = wireMeasurement(result.row);
    if (result.kind === "conflict") {
      return yield* conflict(row);
    }
    return { row, created: result.kind === "created" };
  });

  const listBodyfat = Effect.fn("bodyfat.listBodyfat")(
    function* (): Effect.fn.Return<BodyfatRow[], DatabaseFailure> {
      return (yield* repository.list()).map(wireMeasurement);
    }
  );

  const latestBodyfat = Effect.fn("bodyfat.latestBodyfat")(
    function* (): Effect.fn.Return<BodyfatRow | null, DatabaseFailure> {
      const row = yield* repository.latest();
      return row ? wireMeasurement(row) : null;
    }
  );

  const removeBodyfat = Effect.fn("bodyfat.removeBodyfat")(function* (
    id: number
  ): Effect.fn.Return<
    Pick<BodyfatRow, "day" | "percent" | "method">,
    NotFound | DatabaseFailure
  > {
    const row = yield* repository.remove(id);
    if (!row) {
      return yield* new NotFound({
        message: `No body-fat estimate with id ${id}.`,
      });
    }
    return { ...row, method: storedMethod(row.method) };
  });

  return { recordBodyfat, listBodyfat, latestBodyfat, removeBodyfat };
}

export type BodyfatService = ReturnType<typeof bodyfatStore>;
