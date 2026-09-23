import {
  batch,
  type Clock,
  type Database,
  decimal,
  instant,
  romeDate,
  rows,
  statement,
  systemClock,
} from "../shared/d1.ts";
import { requireNotFutureInstant } from "../shared/dates.ts";
import { ApiError, requireRow } from "../shared/errors.ts";
import { trendSeries } from "./trend.ts";
import type { BodyweightRow, RecordedBodyweight } from "./bodyweight.types.ts";

const measurementColumns =
  "value_kg / 100.0 AS value_kg, substr(measured_at, 1, 23) || 'Z' AS measured_at, source";
const columns = `id, ${measurementColumns}`;

export function bodyweightStore(db: Database, clock: Clock = systemClock) {
  async function recordBodyweight(
    input: { valueKg: number; measuredAt: string; source: string },
  ): Promise<RecordedBodyweight> {
    const { valueKg, source } = input;
    if (valueKg < 25 || valueKg > 300) {
      throw new ApiError(
        422,
        `${valueKg} kg is not a plausible bodyweight (expected 25–300 kg). A missing or misplaced decimal point is the usual cause — 8.2 for 82.4. Send the weight as it was read off the scale, in kilograms.`,
      );
    }
    const measuredAt = instant(input.measuredAt);
    requireNotFutureInstant(input.measuredAt, "measured_at", clock().getTime());
    const value = decimal(valueKg, 5, 2);
    // The read shares the insertion's transaction. A concurrent delete cannot
    // turn an ordinary duplicate into a missing readback between statements.
    const result = await batch(db, [
      statement(
        db,
        `INSERT INTO bodyweight (value_kg, measured_at, measured_date, source)
        VALUES (?, ?, ?, ?) ON CONFLICT (measured_at, source) DO NOTHING RETURNING ${columns}`,
        value,
        measuredAt,
        romeDate(measuredAt),
        source,
      ),
      statement(
        db,
        `SELECT ${columns}, value_kg AS stored_value FROM bodyweight
        WHERE measured_at = ? AND source = ?`,
        measuredAt,
        source,
      ),
    ]);
    const inserted = result[0].results as unknown as BodyweightRow[];
    if (inserted.length) return { row: inserted[0], created: true };
    const { stored_value, ...existing } = requireRow(
      result[1]
        .results as unknown as (BodyweightRow & { stored_value: number })[],
      "The bodyweight measurement could not be read after saving.",
    );
    if (stored_value === value) return { row: existing, created: false };
    throw new ApiError(
      409,
      `You sent ${valueKg} kg for ${input.measuredAt} (source "${source}"), but ${existing.value_kg} kg is already recorded for that instant. A measurement is a fact and should not change — if the recorded value is the mistake, DELETE /bodyweight/${existing.id} and re-enter.`,
    );
  }

  async function listBodyweight(): Promise<BodyweightRow[]> {
    return await rows<BodyweightRow>(
      db,
      `SELECT ${columns} FROM bodyweight ORDER BY bodyweight.measured_at, id`,
    );
  }
  async function loadTrend() {
    return trendSeries(
      await rows<{ day: string; value_kg: number }>(
        db,
        "SELECT day, value_kg FROM daily_bodyweight ORDER BY day",
      ),
    );
  }
  async function removeBodyweight(
    id: number,
  ): Promise<Omit<BodyweightRow, "id">> {
    return requireRow(
      await rows<Omit<BodyweightRow, "id">>(
        db,
        `DELETE FROM bodyweight WHERE id = ? RETURNING ${measurementColumns}`,
        id,
      ),
      `No bodyweight measurement with id ${id}.`,
    );
  }
  return { recordBodyweight, listBodyweight, loadTrend, removeBodyweight };
}
