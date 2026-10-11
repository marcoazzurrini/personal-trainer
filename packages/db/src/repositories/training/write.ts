import type { Client } from "../../client.ts";
import { statement } from "../../native.ts";
import type { Statement } from "../../native.ts";

export function sessionVersion(
  db: Client,
  id: number,
  version: number
): Statement {
  return statement(
    db,
    `INSERT INTO api_write_assertions (id, version_matches)
    VALUES (1, COALESCE((SELECT write_version = ? FROM sessions WHERE id = ?), 0))`,
    version,
    id
  );
}

/** Place immediately after the statement whose direct row count it checks. */
export function affectedRows(db: Client, expected: number): Statement {
  return statement(
    db,
    `UPDATE api_write_assertions SET rows_match = (changes() = ?) WHERE id = 1`,
    expected
  );
}

export function finishWrite(db: Client): Statement {
  return statement(db, "DELETE FROM api_write_assertions WHERE id = 1");
}
