/* oxlint-disable max-classes-per-file -- The closed set of refusals is one vocabulary and reads as one list. */
import type { DatabaseFailureKind } from "@trainer/db/errors.ts";
import { Data, Effect } from "effect";

// A refusal is an expected outcome, so it travels in the Effect error channel
// and every function's type names the refusals it can produce. Anything else
// that fails is a defect: a bug or an outage, answered with a diagnostic and
// never with its own text. The client is an LLM, so every message states what
// was wrong and what a correct call looks like.
//
// One class per status rather than per message: the sentence is the contract,
// and the status is what a caller branches on.
export class BadRequest extends Data.TaggedError("BadRequest")<{
  readonly message: string;
}> {
  readonly status = 400;
}

export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly message: string;
}> {
  readonly status = 401;
}

export class Forbidden extends Data.TaggedError("Forbidden")<{
  readonly message: string;
}> {
  readonly status = 403;
}

export class NotFound extends Data.TaggedError("NotFound")<{
  readonly message: string;
}> {
  readonly status = 404;
}

export class Conflict extends Data.TaggedError("Conflict")<{
  readonly message: string;
}> {
  readonly status = 409;
}

export class TooLarge extends Data.TaggedError("TooLarge")<{
  readonly message: string;
}> {
  readonly status = 413;
}

export class Invalid extends Data.TaggedError("Invalid")<{
  readonly message: string;
}> {
  readonly status = 422;
}

// The server lacks configuration the operation needs. The caller cannot fix
// it, but the sentence still names what is missing.
export class Misconfigured extends Data.TaggedError("Misconfigured")<{
  readonly message: string;
}> {
  readonly status = 500;
}

// A provider answered badly or not at all.
export class Upstream extends Data.TaggedError("Upstream")<{
  readonly message: string;
}> {
  readonly status = 502;
}

export class Unavailable extends Data.TaggedError("Unavailable")<{
  readonly message: string;
}> {
  readonly status = 503;
}

export type Refusal =
  | BadRequest
  | Unauthorized
  | Forbidden
  | NotFound
  | Conflict
  | TooLarge
  | Invalid
  | Misconfigured
  | Upstream
  | Unavailable;

const refusals = [
  BadRequest,
  Unauthorized,
  Forbidden,
  NotFound,
  Conflict,
  TooLarge,
  Invalid,
  Misconfigured,
  Upstream,
  Unavailable,
];

/** Everything a store can fail with in the error channel. */
export type Failure = Refusal | DatabaseFailure;

export function isRefusal<T>(value: T): value is T & Refusal {
  return refusals.some((refusal) => value instanceof refusal);
}

// A recognised constraint violation, classified at the repository boundary.
// It names the constraint, never the SQL or the bound values; the edge turns
// it into the refusal below.
export class DatabaseFailure extends Data.TaggedError("DatabaseFailure")<{
  readonly kind: DatabaseFailureKind;
  readonly subject: string;
}> {}

// A read that found nothing, turned into the refusal that says so. Thirteen
// sites ran a query, tested the result and failed; only the sentence differed,
// and it has to — the client is a model, and "No session with id 4." sends it
// somewhere different from "No food with id 4."
//
// 404 is fixed rather than a parameter because an absent row is the only thing
// this answers. A query that comes back empty for some other reason — an
// exercise that exists but is not in the plan, a name that resolves to nothing
// — is refusing something else, and those sites state their own status and
// often run a second query to say what the caller should have sent instead.
export function requireRow<T>(
  rows: readonly T[],
  message: string
): Effect.Effect<T, NotFound> {
  return rows.length === 0
    ? Effect.fail(new NotFound({ message }))
    : Effect.succeed(rows[0]);
}
