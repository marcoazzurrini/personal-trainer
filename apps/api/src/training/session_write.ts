import { Effect } from "effect";

import { Conflict, DatabaseFailure } from "../shared/refusals.ts";

// The batch's version assertion, and nothing else: an unknown outcome is a
// defect and is never retried, and any other constraint is the caller's.
function sessionChanged<E>(error: E): boolean {
  return (
    error instanceof DatabaseFailure &&
    error.kind === "check" &&
    error.subject === "api_session_changed"
  );
}

/** Retry only the batch's failed version assertion, never an uncertain write. */
export function retrySessionWrite<A, E, R>(
  id: number,
  // The operation re-reads and revalidates on every attempt. It must not
  // contain provider calls or other nontransactional side effects.
  operation: Effect.Effect<A, E, R>
): Effect.Effect<A, E | Conflict, R> {
  return operation.pipe(
    // Three attempts in all: the first and two retries.
    Effect.retry({ times: 2, while: sessionChanged }),
    Effect.mapError((error) =>
      sessionChanged(error)
        ? new Conflict({
            message: `The session kept changing. Nothing was saved by this request. Read GET /sessions/${id} before retrying.`,
          })
        : error
    )
  );
}
