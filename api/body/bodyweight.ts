import type {
  BodyweightMeasurement,
  BodyweightRepository,
} from "../../db/repositories/bodyweight.ts";
import { requireNotFutureInstant } from "../shared/dates.ts";
import { ApiError, databaseError } from "../shared/errors.ts";
import {
  decimal,
  instant,
  systemClock,
  wireInstant,
} from "../shared/values.ts";
import type { Clock } from "../shared/values.ts";
import type { BodyweightRow, RecordedBodyweight } from "./bodyweight.types.ts";
import { trendSeries } from "./trend.ts";

function wireMeasurement(row: BodyweightMeasurement): BodyweightRow {
  return { ...row, measured_at: wireInstant(row.measured_at) };
}

export function bodyweightStore(
  repository: BodyweightRepository,
  clock: Clock = systemClock
) {
  async function recordBodyweight(input: {
    valueKg: number;
    measuredAt: string;
    source: string;
  }): Promise<RecordedBodyweight> {
    const { valueKg, source } = input;
    if (valueKg < 25 || valueKg > 300) {
      throw new ApiError(
        422,
        `${valueKg} kg is not a plausible bodyweight (expected 25–300 kg). A missing or misplaced decimal point is the usual cause — 8.2 for 82.4. Send the weight as it was read off the scale, in kilograms.`
      );
    }
    const measuredAt = instant(input.measuredAt);
    requireNotFutureInstant(input.measuredAt, "measured_at", clock().getTime());
    decimal(valueKg, 5, 2);
    try {
      const result = await repository.save({ valueKg, measuredAt, source });
      if (result.kind === "missing") {
        throw new ApiError(
          404,
          "The bodyweight measurement could not be read after saving."
        );
      }
      const row = wireMeasurement(result.row);
      if (result.kind === "conflict") {
        throw new ApiError(
          409,
          `You sent ${valueKg} kg for ${input.measuredAt} (source "${source}"), but ${row.value_kg} kg is already recorded for that instant. A measurement is a fact and should not change — if the recorded value is the mistake, DELETE /bodyweight/${row.id} and re-enter.`
        );
      }
      return { row, created: result.kind === "created" };
    } catch (error) {
      // Synchronization counts known refusals here; unknown failures must abort.
      throw databaseError(error);
    }
  }

  async function listBodyweight(): Promise<BodyweightRow[]> {
    return (await repository.list()).map(wireMeasurement);
  }

  async function loadTrend() {
    return trendSeries(await repository.dailyMeasurements());
  }

  async function removeBodyweight(
    id: number
  ): Promise<Omit<BodyweightRow, "id">> {
    const row = await repository.remove(id);
    if (!row) {
      throw new ApiError(404, `No bodyweight measurement with id ${id}.`);
    }
    return {
      value_kg: row.value_kg,
      measured_at: wireInstant(row.measured_at),
      source: row.source,
    };
  }

  return { recordBodyweight, listBodyweight, loadTrend, removeBodyweight };
}

export type BodyweightService = ReturnType<typeof bodyweightStore>;
