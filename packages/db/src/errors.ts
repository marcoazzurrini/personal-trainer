import { DrizzleQueryError } from "drizzle-orm/errors";

export type DatabaseFailureKind =
  | "unique"
  | "check"
  | "required"
  | "foreign_key"
  | "too_large";

/** A database failure has no HTTP status, raw SQL or bound parameter values. */
export class DatabaseFailureError extends Error {
  readonly kind: DatabaseFailureKind;
  readonly subject: string;

  constructor(kind: DatabaseFailureKind, subject: string) {
    super("The database rejected a write.");
    this.name = "DatabaseFailureError";
    this.kind = kind;
    this.subject = subject;
  }
}

/** Preserve unknown outcomes unchanged; classify only recognized engine constraints. */
export function classifyDatabaseFailure<T>(error: T): T | DatabaseFailureError {
  if (error instanceof DatabaseFailureError) {
    return error;
  }
  // Drizzle embeds SQL and parameters in its outer message. Only the native
  // cause can identify a constraint; never parse or expose the query wrapper.
  const native = error instanceof DrizzleQueryError ? error.cause : error;
  if (!(native instanceof Error)) {
    return error;
  }
  const unique =
    /UNIQUE constraint failed: (?<columns>[a-z_]+\.[a-z_]+(?:, [a-z_]+\.[a-z_]+)*)/iu.exec(
      native.message
    );
  if (unique) {
    return new DatabaseFailureError("unique", unique[1]);
  }
  const check =
    /CHECK constraint failed: (?<constraint>[a-z_][a-z_0-9]*)/iu.exec(
      native.message
    );
  if (check) {
    return new DatabaseFailureError("check", check[1]);
  }
  const required =
    /NOT NULL constraint failed: [a-z_][a-z_0-9]*\.(?<column>[a-z_][a-z_0-9]*)/iu.exec(
      native.message
    );
  if (required) {
    return new DatabaseFailureError("required", required[1]);
  }
  if (native.message.includes("FOREIGN KEY constraint failed")) {
    return new DatabaseFailureError("foreign_key", "");
  }
  return error;
}
