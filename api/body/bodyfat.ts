import type {
  BodyfatMeasurement,
  BodyfatRepository,
} from "../../db/repositories/bodyfat.ts";
import { requireNotFuture } from "../shared/dates.ts";
import { ApiError, databaseError } from "../shared/errors.ts";
import {
  date,
  decimal,
  instant,
  requestId,
  romeDate,
  systemClock,
  wireInstant,
} from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
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

export function bodyfatStore(
  repository: BodyfatRepository,
  clock: Clock = systemClock
) {
  async function recordBodyfat(
    input: RecordBodyfatInput
  ): Promise<RecordedBodyfat> {
    const now = instant(clock().toISOString());
    const today = romeDate(now);
    const day = requireNotFuture(date(input.day ?? today), today, "day");
    const value = decimal(input.percent, 4, 1);
    function conflict(existing: BodyfatRow): never {
      throw new ApiError(
        409,
        `A different estimate (${existing.percent}%) is already recorded for ${day} from method "${input.method}". Record the new reading under its own method, or on the day it was actually taken — an estimate is a measurement, not a running opinion.`
      );
    }
    try {
      // Natural-key precedence includes request-id validation: an existing
      // measurement is answered before inspecting the retry identifier.
      const found = await repository.findByDayMethod(day, input.method);
      if (found) {
        const row = wireMeasurement(found);
        if (found.percent === value / 10) {
          return { row, created: false };
        }
        return conflict(row);
      }
      const result = await repository.save({
        day,
        percent: input.percent,
        method: input.method,
        note: input.note ?? null,
        requestId: requestId(input.requestId),
        createdAt: now,
      });
      if (result.kind === "missing") {
        throw new ApiError(
          404,
          "The body-fat estimate could not be read after saving."
        );
      }
      const row = wireMeasurement(result.row);
      if (result.kind === "conflict") {
        return conflict(row);
      }
      return { row, created: result.kind === "created" };
    } catch (error) {
      throw databaseError(error);
    }
  }

  async function listBodyfat(): Promise<BodyfatRow[]> {
    try {
      return (await repository.list()).map(wireMeasurement);
    } catch (error) {
      throw databaseError(error);
    }
  }

  async function latestBodyfat(): Promise<BodyfatRow | null> {
    try {
      const row = await repository.latest();
      return row ? wireMeasurement(row) : null;
    } catch (error) {
      throw databaseError(error);
    }
  }

  async function removeBodyfat(
    id: number
  ): Promise<Pick<BodyfatRow, "day" | "percent" | "method">> {
    try {
      const row = await repository.remove(id);
      if (!row) {
        throw new ApiError(404, `No body-fat estimate with id ${id}.`);
      }
      return { ...row, method: storedMethod(row.method) };
    } catch (error) {
      throw databaseError(error);
    }
  }
  return { recordBodyfat, listBodyfat, latestBodyfat, removeBodyfat };
}

export type BodyfatService = ReturnType<typeof bodyfatStore>;
