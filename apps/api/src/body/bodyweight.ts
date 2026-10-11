import type {
  BodyweightMeasurement,
  BodyweightRepository,
} from "@trainer/db/repositories/bodyweight.ts";
import { Effect } from "effect";

import { effectful } from "../shared/database.ts";
import { requireNotFutureInstant } from "../shared/dates.ts";
import { Conflict, Invalid, NotFound } from "../shared/refusals.ts";
import type { DatabaseFailure } from "../shared/refusals.ts";
import { decimal, instant, wireInstant } from "../shared/values.ts";
import type { BodyweightRow, RecordedBodyweight } from "./bodyweight.types.ts";
import { trendSeries } from "./trend.ts";

function wireMeasurement(row: BodyweightMeasurement): BodyweightRow {
  return { ...row, measured_at: wireInstant(row.measured_at) };
}

export function bodyweightStore(rows: BodyweightRepository) {
  const repository = effectful(rows);

  // Synchronization counts these refusals per reading; a defect aborts it.
  const recordBodyweight = Effect.fn("bodyweight.recordBodyweight")(
    function* (input: {
      valueKg: number;
      measuredAt: string;
      source: string;
    }): Effect.fn.Return<
      RecordedBodyweight,
      Invalid | NotFound | Conflict | DatabaseFailure
    > {
      const { valueKg, source } = input;
      if (valueKg < 25 || valueKg > 300) {
        return yield* new Invalid({
          message: `${valueKg} kg is not a plausible bodyweight (expected 25–300 kg). A missing or misplaced decimal point is the usual cause — 8.2 for 82.4. Send the weight as it was read off the scale, in kilograms.`,
        });
      }
      const measuredAt = yield* instant(input.measuredAt);
      yield* requireNotFutureInstant(input.measuredAt, "measured_at");
      yield* decimal(valueKg, 5, 2);
      const result = yield* repository.save({ valueKg, measuredAt, source });
      if (result.kind === "missing") {
        return yield* new NotFound({
          message: "The bodyweight measurement could not be read after saving.",
        });
      }
      const row = wireMeasurement(result.row);
      if (result.kind === "conflict") {
        return yield* new Conflict({
          message: `You sent ${valueKg} kg for ${input.measuredAt} (source "${source}"), but ${row.value_kg} kg is already recorded for that instant. A measurement is a fact and should not change — if the recorded value is the mistake, DELETE /bodyweight/${row.id} and re-enter.`,
        });
      }
      return { row, created: result.kind === "created" };
    }
  );

  const listBodyweight = Effect.fn("bodyweight.listBodyweight")(
    function* (): Effect.fn.Return<BodyweightRow[], DatabaseFailure> {
      return (yield* repository.list()).map(wireMeasurement);
    }
  );

  const loadTrend = Effect.fn("bodyweight.loadTrend")(function* () {
    return trendSeries(yield* repository.dailyMeasurements());
  });

  const removeBodyweight = Effect.fn("bodyweight.removeBodyweight")(function* (
    id: number
  ): Effect.fn.Return<Omit<BodyweightRow, "id">, NotFound | DatabaseFailure> {
    const row = yield* repository.remove(id);
    if (!row) {
      return yield* new NotFound({
        message: `No bodyweight measurement with id ${id}.`,
      });
    }
    return {
      value_kg: row.value_kg,
      measured_at: wireInstant(row.measured_at),
      source: row.source,
    };
  });

  return { recordBodyweight, listBodyweight, loadTrend, removeBodyweight };
}

export type BodyweightService = ReturnType<typeof bodyweightStore>;
