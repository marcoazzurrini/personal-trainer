import {
  AssertionError,
  doesNotThrow,
  rejects,
  strictEqual,
  throws,
} from "node:assert/strict";
import { test } from "node:test";

import { assertEquals, assertRejects, assertThrows } from "./assertions.ts";

test("an omitted equality expectation means undefined, not any falsy value", () => {
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Explicitly exercise an absent actual value, not a zero-argument call.
  doesNotThrow(() => assertEquals(undefined));
  for (const value of [null, false, 0, ""]) {
    throws(() => assertEquals(value), AssertionError);
  }
});

test("equality retains strict nested values and distinguishes absent properties", () => {
  doesNotThrow(() =>
    assertEquals(
      { values: [1, null, Number.NaN] },
      { values: [1, null, Number.NaN] }
    )
  );
  throws(() => assertEquals({ value: 1 }, { value: "1" }), AssertionError);
  throws(() => assertEquals({ value: undefined }, {}), AssertionError);
});

test("rejection assertions reject synchronous throws", async () => {
  await rejects(
    assertRejects(() => {
      throw new TypeError("synchronous failure");
    }, TypeError),
    AssertionError
  );
});

test("rejection assertions accept callbacks with different success types", async () => {
  const error = new TypeError("synthetic failure");
  const actions = [
    (): Promise<string> => Promise.reject(error),
    (): Promise<number[]> => Promise.reject(error),
  ];
  for (const action of actions) {
    strictEqual(await assertRejects(action, TypeError, "synthetic"), error);
  }
});

test("error assertions validate and return the original error", async () => {
  const error = new TypeError("synthetic failure");
  strictEqual(
    assertThrows(
      () => {
        throw error;
      },
      TypeError,
      "synthetic"
    ),
    error
  );
  strictEqual(
    await assertRejects(() => Promise.reject(error), TypeError, "synthetic"),
    error
  );
  throws(
    () =>
      assertThrows(() => {
        throw error;
      }, RangeError),
    AssertionError
  );
  throws(
    () =>
      assertThrows(
        () => {
          throw error;
        },
        TypeError,
        "missing text"
      ),
    AssertionError
  );
});
