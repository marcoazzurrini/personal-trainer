import type {
  EventRecord,
  EventsRepository,
} from "../../db/repositories/nutrition/events.ts";
import { addDays } from "../shared/dates.ts";
import { databaseError, requireRow } from "../shared/errors.ts";
import {
  date,
  instant,
  requestId,
  romeDate,
  systemClock,
  wireInstant,
} from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import type { ActiveTransient, EventRow, Kind } from "./events.types.ts";

function wireEvent(row: EventRecord): EventRow {
  return { ...row, created_at: wireInstant(row.created_at) };
}

export function eventStore(
  repository: EventsRepository,
  clock: Clock = systemClock
) {
  async function listEvents(): Promise<EventRow[]> {
    try {
      return (await repository.list()).map(wireEvent);
    } catch (error) {
      throw databaseError(error);
    }
  }
  async function activeTransients(asOf: string): Promise<ActiveTransient[]> {
    const day = date(asOf);
    try {
      return await repository.inRange(addDays(day, -14), day);
    } catch (error) {
      throw databaseError(error);
    }
  }
  async function registerEvent(b: {
    day?: string | null;
    kind: Kind;
    note?: string | null;
    request_id: string;
  }): Promise<{ row: EventRow; created: boolean }> {
    const uuid = requestId(b.request_id);
    const seen = async () => {
      try {
        return await repository.findRequest(uuid);
      } catch (error) {
        throw databaseError(error);
      }
    };
    const replay = await seen();
    if (replay) {
      return { row: wireEvent(replay), created: false };
    }
    try {
      const now = instant(clock().toISOString());
      const result = await repository.save({
        day: date(b.day ?? romeDate(now)),
        kind: b.kind,
        note: b.note ?? null,
        request_id: uuid,
        created_at: now,
      });
      return {
        row: wireEvent(
          requireRow(
            result.row ? [result.row] : [],
            "The nutrition event could not be read after saving."
          )
        ),
        created: result.created,
      };
    } catch (error) {
      const recovered = await seen();
      if (recovered) {
        return { row: wireEvent(recovered), created: false };
      }
      throw databaseError(error);
    }
  }
  async function withdrawEvent(
    id: number
  ): Promise<Pick<EventRow, "day" | "kind" | "note">> {
    const missing = `No nutrition event with id ${id}. Read GET /nutrition-events and use an id from the current events list.`;
    try {
      const row =
        id < 0
          ? await repository.suppressGoalSwitch(id)
          : await repository.remove(id);
      return requireRow(row ? [row] : [], missing);
    } catch (error) {
      throw databaseError(error);
    }
  }
  return { listEvents, activeTransients, registerEvent, withdrawEvent };
}

export type EventsService = ReturnType<typeof eventStore>;
