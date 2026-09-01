// The bodyfat_estimates table: what an estimate is, and every question asked
// of it.
//
// Body fat exists here for one reason: the energy density of a weight change
// is composition-weighted, not a flat 7,700 kcal/kg. Forbes gives
// p = C / (C + FM) with C = 10.4 kg, and FM comes from this series. Precision
// is not the point — the result is only modestly sensitive to FM error — but
// it has to be a number the server can read, and it has to have history,
// because the estimate gets re-anchored as a phase runs on.

import { sql } from "../db.ts";
import { romeToday } from "../record/calendar.ts";
import { writeOnce } from "../record/idempotency.ts";
import { requireNotFuture } from "../rules/dates.ts";
import { ApiError, requireRow } from "../http/errors.ts";

export const METHODS = ["bia", "dxa", "caliper", "visual", "other"] as const;
export type Method = (typeof METHODS)[number];

export interface BodyfatRow {
  id: number;
  day: string;
  percent: number;
  method: Method;
  note: string | null;
  created_at: string;
}

// A function and not a shared constant, for the reason record/calendar.ts
// gives about its own fragments: a postgres.js fragment is a query object
// rather than a string, so callers splice a fresh one instead of sharing an
// instance.
function estimateColumns() {
  return sql`id, day, percent::float8, method, note, created_at`;
}

/** Every estimate, by day then method. */
export async function listBodyfat(): Promise<BodyfatRow[]> {
  return await sql<BodyfatRow[]>`
    select ${estimateColumns()}
    from bodyfat_estimates order by day, method`;
}

export interface RecordedBodyfat {
  row: BodyfatRow;
  /** False when the estimate was already on record — an idempotent retry. */
  created: boolean;
}

/**
 * Records one estimate, or recognises that it is already recorded.
 *
 * `day` defaults to Rome's today, which is why it is not a caller's decision:
 * the answer comes from the same clock that stamped the rows. Throws ApiError
 * 422 for a day in the future, and 409 when that day and method already hold a
 * *different* reading.
 */
export async function recordBodyfat(input: {
  percent: number;
  method: Method;
  day?: string | null;
  note?: string | null;
  requestId: string;
}): Promise<RecordedBodyfat> {
  const today = await romeToday();
  // Rome's today comes from Postgres, so the rule cannot be expressed in the
  // schema: it is a comparison against a value the schema never sees.
  const day = requireNotFuture(input.day ?? today, today, "day");

  // Deduped on (day, method), like bodyweight on (measured_at, source):
  // resending is a no-op, and a genuinely different value for the same day and
  // method is a conflict worth asking about rather than silently overwriting.
  //
  // That key alone cannot keep the request_id promise, because it is not the
  // same question. It asks whether the record already holds an estimate for a
  // day; the request_id asks whether this call has already been answered. They
  // part company when day moves under a retry — it defaults to Rome's today,
  // so a call retried after midnight lands on a free (day, method) and writes
  // a second estimate of the same reading a day late.
  //
  // The natural key is settled first, because it asks about the record rather
  // than about this call: an estimate for this day and method either exists or
  // it does not, whoever sent it. Asking the other way round would answer a
  // retry that arrived carrying a changed reading with the reading it replaced.
  const [existing] = await sql<BodyfatRow[]>`
    select ${estimateColumns()}
    from bodyfat_estimates where day = ${day} and method = ${input.method}`;
  if (existing !== undefined) {
    if (existing.percent === input.percent) {
      return { row: existing, created: false }; // idempotent retry
    }
    throw new ApiError(
      409,
      `A different estimate (${existing.percent}%) is already recorded for ${day} from method "${input.method}". Record the new reading under its own method, or on the day it was actually taken — an estimate is a measurement, not a running opinion.`,
    );
  }

  const { body: row, status } = await writeOnce<
    BodyfatRow,
    BodyfatRow,
    BodyfatRow
  >({
    table: "bodyfat_estimates",
    requestId: input.requestId,
    select: estimateColumns(),
    // The original estimate, on the day it was recorded against — which is
    // the point of replaying rather than writing: a retry after midnight
    // gets back the day it meant, not the day it arrived on.
    replay: (found) => found,
    write: async () => {
      // No on-conflict clause: the select above has already established that
      // this day and method are free, so the only way the natural key can
      // still fire is a concurrent write between the two, and that is a
      // refusal rather than something to swallow.
      const [written] = await sql<BodyfatRow[]>`
        insert into bodyfat_estimates (day, percent, method, note, request_id)
        values (${day}, ${input.percent}, ${input.method}, ${
        input.note ?? null
      }, ${input.requestId})
        returning ${estimateColumns()}`;
      return written;
    },
  });
  return { row, created: status === 201 };
}

/**
 * The most recent estimate's percentage, or null when none is on record.
 *
 * Tie-broken by id, because several methods can land on one day and the
 * back-solve needs one number. rules/dates.ts documents the hazard that
 * ordering creates.
 */
export async function latestBodyfat(): Promise<number | null> {
  const [row] = await sql`
    select percent::float8 from bodyfat_estimates
    order by day desc, id desc limit 1`;
  return row ? row.percent : null;
}

// A mistyped estimate is a mistake, not a measurement. 41% instead of 14%
// changes fat mass by 22 kg, which changes the energy density of every kg of
// weight change, which moves the calorie target — and the natural key means it
// cannot simply be overwritten. Removing it is the way out.
export async function removeBodyfat(
  id: number,
): Promise<Pick<BodyfatRow, "day" | "percent" | "method">> {
  return requireRow(
    await sql<Array<Pick<BodyfatRow, "day" | "percent" | "method">>>`
    delete from bodyfat_estimates where id = ${id}
    returning day, percent::float8, method`,
    `No body-fat estimate with id ${id}.`,
  );
}
