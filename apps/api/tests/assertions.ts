import { deepStrictEqual, fail, ok } from "node:assert/strict";

export { ok as assert } from "node:assert/strict";

export function assertEquals(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Assertions compare unparsed test values, including deliberately malformed inputs.
  actual: unknown,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Expectations can contain arbitrary test values, including absent fields.
  expected?: unknown,
  message?: string
): void {
  // Always pass the expected argument to Node, even when callers assert absence.
  deepStrictEqual(actual, expected, message);
}

type ErrorClass<E extends Error> = abstract new (...args: never[]) => E;

function checkError(
  error: Error,
  expected: ErrorClass<Error> | undefined,
  includes: string | undefined,
  message: string | undefined
): void {
  if (expected) {
    ok(
      error instanceof expected,
      message ?? `Expected ${expected.name}, received ${error.name}.`
    );
  }
  if (includes !== undefined) {
    assertStringIncludes(error.message, includes, message);
  }
}

export function assertStringIncludes(
  actual: string,
  expected: string,
  message?: string
): void {
  ok(
    actual.includes(expected),
    message ??
      `${JSON.stringify(actual)} must include ${JSON.stringify(expected)}.`
  );
}

export function assertAlmostEquals(
  actual: number,
  expected: number,
  tolerance = 1e-7,
  message?: string
): void {
  ok(
    Object.is(actual, expected) || Math.abs(actual - expected) <= tolerance,
    message ?? `Expected ${actual} to be within ${tolerance} of ${expected}.`
  );
}

// Returning the validated error lets callers also check structured error fields.
export function assertThrows<T, E extends Error>(
  action: () => T,
  expected: ErrorClass<E>,
  includes?: string,
  message?: string
): E;
export function assertThrows<T>(action: () => T): Error;
export function assertThrows<T>(
  action: () => T,
  expected?: ErrorClass<Error>,
  includes?: string,
  message?: string
): Error {
  try {
    action();
  } catch (error) {
    ok(error instanceof Error, "Expected an Error instance.");
    checkError(error, expected, includes, message);
    return error;
  }
  return fail(message ?? "Expected the operation to throw.");
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- Rejection assertions discard successful values and validate only the caught Error.
type RejectionProbe = () => PromiseLike<unknown>;

export function assertRejects<E extends Error>(
  action: RejectionProbe,
  expected: ErrorClass<E>,
  includes?: string,
  message?: string
): Promise<E>;
export function assertRejects(action: RejectionProbe): Promise<Error>;
export async function assertRejects(
  action: RejectionProbe,
  expected?: ErrorClass<Error>,
  includes?: string,
  message?: string
): Promise<Error> {
  let pending: ReturnType<RejectionProbe>;
  try {
    pending = action();
  } catch {
    return fail(
      message ??
        "Expected a rejected promise, but the operation threw synchronously."
    );
  }
  try {
    await pending;
  } catch (error) {
    ok(error instanceof Error, "Expected an Error instance.");
    checkError(error, expected, includes, message);
    return error;
  }
  return fail(message ?? "Expected the operation to reject.");
}
