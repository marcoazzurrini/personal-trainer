import postgres from "postgres";
import { sql } from "../db.ts";

// The retry answer, in one place.
//
// Every creating POST carries a request_id, and http/schema.ts promises the
// caller what it buys: "resending the same id returns the original result
// instead of writing a second row." That promise is kept by a preamble — look
// the id up, answer the original if it is there, write only if it is not —
// which was hand-copied into twelve handlers. Twelve copies is twelve chances
// to omit it, and the omission does not fail: it writes a second row and
// answers 201 as though nothing were wrong. A duplicated meal is
// indistinguishable from eating twice.
//
// A thirteenth handler had already omitted it. POST /mesocycles/{id}/decisions
// asked for a request_id, wrote it, and never looked it up, so a retry reached
// the unique constraint and came back 409 — the promise broken loudly rather
// than quietly, and only because the column happened to carry that constraint.
//
// So the sequence lives here and the handlers no longer spell it out. What
// they still choose is what a repeat should answer with, which is not
// mechanical: some replay a row they just read, some re-read the whole entity
// through its detail function, and one answers with the day rather than the
// entry.
//
// The status codes are part of the guarantee and are decided here too. 201
// means this call wrote the row; 200 means an earlier one did and this is its
// answer arriving again. A handler that chose its own could tell a retry it
// had created something.

type Fragment = postgres.PendingQuery<postgres.Row[]>;

// Discriminated on the status so a handler whose retry answers a different
// shape from its creation — nutrition targets replay the row without the
// computation that justified it — narrows to the right one.
export type Written<Replayed, Created> =
  | { status: 200; body: Replayed }
  | { status: 201; body: Created };

/**
 * Answers a repeat with the original result, and writes only on the first
 * attempt.
 *
 * `select` is the projection of the row that proves the write already
 * happened — whatever `replay` needs to answer with, or `sql`1`` when the
 * handler only needs to know that it happened.
 */
export async function writeOnce<Found extends object, Replayed, Created>(
  spec: {
    table: string;
    requestId: string;
    select: Fragment;
    replay: (found: Found) => Replayed | Promise<Replayed>;
    write: () => Created | Promise<Created>;
  },
): Promise<Written<Replayed, Created>> {
  // Two retries racing each other are not settled here but by the unique
  // constraint every request_id column carries: the loser's insert fails
  // rather than duplicating. This lookup catches the ordinary case, a lost
  // response retried after the first call finished.
  const [found] = await sql<Found[]>`
    select ${spec.select} from ${sql(spec.table)}
    where request_id = ${spec.requestId}`;
  if (found !== undefined) {
    return { body: await spec.replay(found), status: 200 };
  }
  return { body: await spec.write(), status: 201 };
}
