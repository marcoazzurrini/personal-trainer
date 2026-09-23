import { ApiError } from "../shared/errors.ts";
import {
  type Database,
  databaseError,
  type Statement,
  statement,
} from "../shared/d1.ts";

/** Retry only the batch's failed version assertion, never an uncertain write. */
export async function retrySessionWrite<T>(
  id: number,
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // The operation re-reads and revalidates on every attempt. It must not
      // contain provider calls or other nontransactional side effects.
      return await operation();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/CHECK constraint failed: api_session_changed\b/.test(error.message)
      ) {
        throw databaseError(error);
      }
    }
  }
  throw new ApiError(
    409,
    `The session kept changing. Nothing was saved by this request. Read GET /sessions/${id} before retrying.`,
  );
}

export function sessionVersion(
  db: Database,
  id: number,
  version: number,
): Statement {
  return statement(
    db,
    `INSERT INTO api_write_assertions (id, version_matches)
    VALUES (1, COALESCE((SELECT write_version = ? FROM sessions WHERE id = ?), 0))`,
    version,
    id,
  );
}

/** Place immediately after the statement whose direct row count it checks. */
export function affectedRows(db: Database, expected: number): Statement {
  return statement(
    db,
    `UPDATE api_write_assertions SET rows_match = (changes() = ?) WHERE id = 1`,
    expected,
  );
}

export function finishWrite(db: Database): Statement {
  return statement(db, "DELETE FROM api_write_assertions WHERE id = 1");
}
