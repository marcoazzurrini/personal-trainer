import {
  batch,
  type Clock,
  type Database,
  databaseError,
  date,
  instant,
  requestId,
  romeDate,
  rows,
  statement,
  systemClock,
} from "../shared/d1.ts";
import { requireRow } from "../shared/errors.ts";
import { addDays } from "../shared/dates.ts";
import type { ActiveTransient, EventRow, Kind } from "./events.types.ts";

const columns =
  "id, day, kind, note, substr(created_at, 1, 23) || 'Z' AS created_at";
export function eventStore(db: Database, clock: Clock = systemClock) {
  async function listEvents(): Promise<EventRow[]> {
    return await rows<EventRow>(
      db,
      `SELECT ${columns} FROM nutrition_effective_events ORDER BY day DESC, id DESC`,
    );
  }
  async function activeTransients(asOf: string): Promise<ActiveTransient[]> {
    const day = date(asOf);
    return await rows<ActiveTransient>(
      db,
      "SELECT id, day, kind, note FROM nutrition_effective_events WHERE day >= ? AND day <= ? ORDER BY day DESC, id DESC",
      addDays(day, -14),
      day,
    );
  }
  async function registerEvent(b: {
    day?: string | null;
    kind: Kind;
    note?: string | null;
    request_id: string;
  }): Promise<{ row: EventRow; created: boolean }> {
    const uuid = requestId(b.request_id);
    const seen = async () =>
      (
        await rows<EventRow>(
          db,
          `SELECT ${columns} FROM nutrition_events WHERE request_id = ?`,
          uuid,
        )
      )[0];
    const replay = await seen();
    if (replay) return { row: replay, created: false };
    try {
      const now = instant(clock().toISOString());
      const result = await batch(db, [
        statement(
          db,
          `INSERT INTO nutrition_events (day, kind, note, request_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (request_id) DO NOTHING RETURNING ${columns}`,
          date(b.day ?? romeDate(now)),
          b.kind,
          b.note ?? null,
          uuid,
          now,
        ),
        statement(
          db,
          `SELECT ${columns} FROM nutrition_events WHERE request_id = ?`,
          uuid,
        ),
      ]);
      return {
        row: requireRow(
          result[1].results as unknown as EventRow[],
          "The nutrition event could not be read after saving.",
        ),
        created: result[0].results.length > 0,
      };
    } catch (error) {
      const replay = await seen();
      if (replay) return { row: replay, created: false };
      throw databaseError(error);
    }
  }
  async function withdrawEvent(
    id: number,
  ): Promise<Pick<EventRow, "day" | "kind" | "note">> {
    const missing =
      `No nutrition event with id ${id}. Read GET /nutrition-events and use an id from the current events list.`;
    if (id < 0) {
      const result = await batch(db, [
        statement(
          db,
          "SELECT day, kind, note FROM nutrition_goal_switches WHERE id = ?",
          id,
        ),
        statement(
          db,
          `UPDATE nutrition_targets SET phase_switch_suppressed = 1 WHERE id = ? AND phase_switch_suppressed = 0
          AND EXISTS (SELECT 1 FROM nutrition_goal_switches WHERE id = ?) RETURNING id`,
          -id,
          id,
        ),
      ]);
      requireRow(result[1].results, missing);
      return requireRow(
        result[0].results as unknown as Pick<
          EventRow,
          "day" | "kind" | "note"
        >[],
        missing,
      );
    }
    return requireRow(
      await rows<Pick<EventRow, "day" | "kind" | "note">>(
        db,
        "DELETE FROM nutrition_events WHERE id = ? RETURNING day, kind, note",
        id,
      ),
      missing,
    );
  }
  return { listEvents, activeTransients, registerEvent, withdrawEvent };
}
