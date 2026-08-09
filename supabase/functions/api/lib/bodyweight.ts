// Writing a weigh-in, with the guards that make a weigh-in trustworthy.
//
// This lived inside the POST /bodyweight handler until the scale started
// reporting itself. It moved here so there is exactly one way into the table:
// the guards below are not request validation that a trusted internal caller
// could reasonably skip, they are the reason a number in this table can be
// believed at all. A second write path that bypassed them would be a second
// definition of what counts as a measurement.

import { sql } from "../db.ts";
import { ApiError } from "./errors.ts";
import { requireNotFutureInstant } from "./validate.ts";

// A weigh-in outside this band is not a weigh-in. The band is deliberately
// far wider than any human Marco will ever be, because its job is not to
// judge a plausible weight — it is to catch a decimal point or a digit that
// went missing. 8.2 for 82.4 is the one that actually happens, and it is
// invisible downstream: it reads as a real number, the EMA absorbs it, and a
// single such row is enough to drag the trend by tens of kilos and hand back
// a calorie target hundreds of kcal wrong. Caught here it costs one retry;
// caught later it costs a fortnight of estimates.
export const MIN_PLAUSIBLE_KG = 25;
export const MAX_PLAUSIBLE_KG = 300;

export interface BodyweightRow {
  id: number;
  value_kg: number;
  measured_at: string;
  source: string;
}

export interface RecordedBodyweight {
  row: BodyweightRow;
  /** False when the row was already there and matched — an idempotent retry. */
  created: boolean;
}

/**
 * Writes one measurement, or recognises that it is already written.
 *
 * Deduped on (measured_at, source): resending the same measurement is a no-op,
 * so retries never plant a phantom point in the trend. Throws ApiError 409 when
 * the same instant already holds a *different* value from the same source —
 * see the message for why that is not something to resolve automatically.
 */
export async function recordBodyweight(input: {
  valueKg: number;
  measuredAt: string;
  source: string;
}): Promise<RecordedBodyweight> {
  const { valueKg, measuredAt, source } = input;

  if (valueKg < MIN_PLAUSIBLE_KG || valueKg > MAX_PLAUSIBLE_KG) {
    throw new ApiError(
      422,
      `${valueKg} kg is not a plausible bodyweight (expected ${MIN_PLAUSIBLE_KG}–${MAX_PLAUSIBLE_KG} kg). A missing or misplaced decimal point is the usual cause — 8.2 for 82.4. Send the weight as it was read off the scale, in kilograms.`,
    );
  }
  requireNotFutureInstant(measuredAt, "measured_at");

  const [row] = await sql`
    insert into bodyweight (value_kg, measured_at, source)
    values (${valueKg}, ${measuredAt}, ${source})
    on conflict (measured_at, source) do nothing
    returning id, value_kg::float8, measured_at, source`;
  if (row) return { row: row as BodyweightRow, created: true };

  const [existing] = await sql`
    select id, value_kg::float8, measured_at, source
    from bodyweight
    where measured_at = ${measuredAt} and source = ${source}`;
  if (existing.value_kg === valueKg) {
    return { row: existing as BodyweightRow, created: false };
  }
  throw new ApiError(
    409,
    `A different value (${existing.value_kg} kg) is already recorded for ${measuredAt} from source "${source}". If this new value is a correction, something has gone wrong upstream — a measurement is a fact and should not change.`,
  );
}
