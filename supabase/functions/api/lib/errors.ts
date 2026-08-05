import type { Context } from "@hono/hono";
import type { ContentfulStatusCode } from "@hono/hono/utils/http-status";

// Thrown anywhere in a route; the app-level onError turns it into JSON.
// The client is an LLM: every message states what was wrong and what a
// correct call looks like.
export class ApiError extends Error {
  constructor(public status: ContentfulStatusCode, message: string) {
    super(message);
  }
}

// Human messages for constraint violations that a well-formed request can
// still trigger. Everything else falls through to a generic message that
// quotes the constraint name.
const constraintMessages: Record<string, string> = {
  exercises_name_key:
    "An exercise with that name already exists (names are case-insensitive). Fetch GET /api/exercises to see it.",
  exercise_aliases_alias_key:
    "That alias already points at an exercise (aliases are case-insensitive). Fetch GET /api/exercises to see which.",
  muscles_name_key: "That muscle already exists.",
};

export function errorResponse(err: unknown, c: Context): Response {
  if (err instanceof ApiError) {
    return c.json({ error: err.message }, err.status);
  }
  // postgres.js surfaces Postgres errors with code + constraint_name.
  const pg = err as {
    code?: string;
    constraint_name?: string;
    message?: string;
  };
  if (pg.code === "23505") {
    const message = constraintMessages[pg.constraint_name ?? ""] ??
      `That would duplicate an existing row (unique constraint "${pg.constraint_name}").`;
    return c.json({ error: message }, 409);
  }
  if (pg.code === "23514") {
    return c.json({
      error:
        `The database rejected a value (check constraint "${pg.constraint_name}"). Fix the offending field and retry.`,
    }, 422);
  }
  if (pg.code === "23503") {
    return c.json({
      error:
        `A referenced row does not exist (foreign key "${pg.constraint_name}").`,
    }, 422);
  }
  console.error(err);
  return c.json({ error: "Internal error. See function logs." }, 500);
}
