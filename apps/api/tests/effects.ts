import { Cause, Clock, Effect, Exit } from "effect";
import type { Context } from "effect";

import type { Bindings } from "../src/environment.ts";
import { invocationContext, run } from "../src/shared/runtime.ts";
import type { Invocation } from "../src/shared/runtime.ts";
import { fixedClock } from "../src/shared/values.ts";
import { assert } from "./assertions.ts";

// Stores and rules answer with Effects. These run one the way a request
// would, so a test can assert on the value or on the typed failure.

/** The typed failure an Effect ends with; fails the test on success or a defect. */
export function failureOf<A, E>(effect: Effect.Effect<A, E>): E {
  const exit = Effect.runSyncExit(effect);
  assert(Exit.isFailure(exit), "Expected the effect to fail.");
  const error = Cause.findErrorOption(exit.cause);
  assert(error._tag === "Some", "Expected a typed failure, not a defect.");
  return error.value;
}

/** The same, for an Effect that waits on I/O. */
export async function failureOfAsync<A, E>(
  effect: Effect.Effect<A, E>
): Promise<E> {
  const exit = await Effect.runPromiseExit(effect);
  assert(Exit.isFailure(exit), "Expected the effect to fail.");
  const error = Cause.findErrorOption(exit.cause);
  assert(error._tag === "Some", "Expected a typed failure, not a defect.");
  return error.value;
}

/** Run with the wall clock stopped at `at`. */
export function at<A, E, R>(
  instant: Date | number | string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return Effect.provideService(effect, Clock.Clock, fixedClock(instant));
}

/**
 * An invocation context for running stores outside HTTP: no background work,
 * no bindings beyond the ones passed, and the wall clock stopped at `now`.
 */
export function testContext(
  now: Date | number | string,
  env: Partial<Bindings> = {}
): Context.Context<Invocation> {
  return invocationContext({
    // SAFETY: tests pass only the bindings the code under test reads.
    env: env as Bindings,
    invocation: {
      waitUntil() {
        // Tests await every operation before asserting.
      },
      passThroughOnException() {
        // No upstream service exists in tests.
      },
    },
    diagnostic: { id: crypto.randomUUID(), route: "test" },
    clock: fixedClock(now),
  });
}

/** Run a store's Effect in a test context; a refusal rejects as itself. */
export function runAt<A, E>(
  now: Date | number | string,
  effect: Effect.Effect<A, E, Invocation>
): Promise<A> {
  return run(testContext(now), effect);
}
