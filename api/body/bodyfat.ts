import {
  type Clock,
  type Database,
  date,
  decimal,
  instant,
  requestId,
  romeDate,
  rows,
  systemClock,
} from "../shared/d1.ts";
import { requireNotFuture } from "../shared/dates.ts";
import { ApiError, requireRow } from "../shared/errors.ts";
import type {
  BodyfatRow,
  RecordBodyfatInput,
  RecordedBodyfat,
} from "./bodyfat.types.ts";

const columns =
  "id, day, percent / 10.0 AS percent, method, note, substr(created_at, 1, 23) || 'Z' AS created_at";

export function bodyfatStore(db: Database, clock: Clock = systemClock) {
  async function recordBodyfat(
    input: RecordBodyfatInput,
  ): Promise<RecordedBodyfat> {
    const now = instant(clock().toISOString());
    const today = romeDate(now);
    const day = requireNotFuture(date(input.day ?? today), today, "day");
    const value = decimal(input.percent, 4, 1);
    // Keep natural-key precedence over request-id replay, including a changed
    // reading sent after midnight. A retry cannot overwrite a measurement.
    const [found] = await rows<BodyfatRow & { stored_value: number }>(
      db,
      `SELECT ${columns}, percent AS stored_value FROM bodyfat_estimates WHERE day = ? AND method = ?`,
      day,
      input.method,
    );
    if (found) {
      const { stored_value, ...existing } = found;
      if (stored_value === value) return { row: existing, created: false };
      throw new ApiError(
        409,
        `A different estimate (${existing.percent}%) is already recorded for ${day} from method "${input.method}". Record the new reading under its own method, or on the day it was actually taken — an estimate is a measurement, not a running opinion.`,
      );
    }
    const uuid = requestId(input.requestId);
    const [seen] = await rows<BodyfatRow>(
      db,
      `SELECT ${columns} FROM bodyfat_estimates WHERE request_id = ?`,
      uuid,
    );
    if (seen) return { row: seen, created: false };
    const row = requireRow(
      await rows<BodyfatRow>(
        db,
        `INSERT INTO bodyfat_estimates (day, percent, method, note, request_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING ${columns}`,
        day,
        value,
        input.method,
        input.note ?? null,
        uuid,
        now,
      ),
      "The body-fat estimate could not be read after saving.",
    );
    return { row, created: true };
  }
  async function listBodyfat(): Promise<BodyfatRow[]> {
    return await rows<BodyfatRow>(
      db,
      `SELECT ${columns} FROM bodyfat_estimates ORDER BY day, method`,
    );
  }
  async function latestBodyfat(): Promise<BodyfatRow | null> {
    return (await rows<BodyfatRow>(
      db,
      `SELECT ${columns} FROM bodyfat_estimates ORDER BY day DESC, id DESC LIMIT 1`,
    ))[0] ?? null;
  }
  async function removeBodyfat(
    id: number,
  ): Promise<Pick<BodyfatRow, "day" | "percent" | "method">> {
    return requireRow(
      await rows<Pick<BodyfatRow, "day" | "percent" | "method">>(
        db,
        "DELETE FROM bodyfat_estimates WHERE id = ? RETURNING day, percent / 10.0 AS percent, method",
        id,
      ),
      `No body-fat estimate with id ${id}.`,
    );
  }
  return { recordBodyfat, listBodyfat, latestBodyfat, removeBodyfat };
}
