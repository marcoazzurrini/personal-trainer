import {
  classifyDatabaseFailure,
  DatabaseFailureError,
} from "@trainer/db/errors.ts";
import { Effect, Predicate } from "effect";

import { DatabaseFailure } from "./refusals.ts";

// The repositories in @trainer/db return promises and know nothing of Effect.
// This is the one place their results enter the error channel: a recognised
// constraint violation becomes a DatabaseFailure the caller can see in the
// type, and anything else — an outage, a bug, a driver error carrying SQL — is
// a defect that only ever reaches the safe diagnostic envelope.

/** A repository whose promise-returning operations are Effects. */
export type Effectful<T> = {
  readonly [K in keyof T]: T[K] extends (
    ...args: infer Args
  ) => Promise<infer Result>
    ? (...args: Args) => Effect.Effect<Result, DatabaseFailure>
    : T[K] extends (...args: never[]) => void
      ? T[K]
      : T[K] extends object
        ? Effectful<T[K]>
        : T[K];
};

/** Run one repository call, classifying what it can refuse. */
export function fromDatabase<A>(
  query: () => Promise<A>
): Effect.Effect<A, DatabaseFailure> {
  return Effect.tryPromise(query).pipe(
    Effect.catch(({ cause }) => {
      const failure = classifyDatabaseFailure(cause);
      return failure instanceof DatabaseFailureError
        ? Effect.fail(
            new DatabaseFailure({
              kind: failure.kind,
              subject: failure.subject,
            })
          )
        : Effect.die(cause);
    })
  );
}

/**
 * Wrap every operation of a repository, nested ones included. A call returns
 * a lazy Effect, so a retry re-runs the query instead of reusing its promise.
 */
export function effectful<T extends object>(repository: T): Effectful<T> {
  const wrapped = Object.fromEntries(
    Object.entries(repository).map(([name, member]) => {
      if (Predicate.isFunction(member)) {
        return [
          name,
          (...args: unknown[]) => fromDatabase(() => member(...args)),
        ];
      }
      return [name, Predicate.isObject(member) ? effectful(member) : member];
    })
  );
  // SAFETY: each member was wrapped exactly as Effectful<T> maps its type.
  return wrapped as Effectful<T>;
}
