import { DatabaseFailureError } from "../../db/errors.ts";
import { databaseError, ApiError } from "../shared/errors.ts";

/** Retry only the batch's failed version assertion, never an uncertain write. */
export async function retrySessionWrite<T>(
  id: number,
  operation: () => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // The operation re-reads and revalidates on every attempt. It must not
      // contain provider calls or other nontransactional side effects.
      return await operation();
    } catch (error) {
      if (
        !(error instanceof DatabaseFailureError) ||
        error.kind !== "check" ||
        error.subject !== "api_session_changed"
      ) {
        throw databaseError(error);
      }
    }
  }
  throw new ApiError(
    409,
    `The session kept changing. Nothing was saved by this request. Read GET /sessions/${id} before retrying.`
  );
}
