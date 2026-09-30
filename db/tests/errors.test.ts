import assert from "node:assert/strict";
import { test } from "node:test";

import { DrizzleQueryError } from "drizzle-orm/errors";
import { Hono } from "hono";

import {
  ApiError,
  constraintMessages,
  databaseError,
  errorResponse,
} from "../../api/shared/errors.ts";
import type { Diagnostic } from "../../api/shared/errors.ts";
import { retrySessionWrite } from "../../api/training/session_write.ts";
import { classifyDatabaseFailure, DatabaseFailureError } from "../errors.ts";
import type { DatabaseFailureKind } from "../errors.ts";
import { jsonChunks } from "../write.ts";

const uniqueConstraints = [
  ["exercises.name_key", "exercises_name_key"],
  ["exercise_aliases.alias_key", "exercise_aliases_alias_key"],
  ["muscles.name", "muscles_name_key"],
  ["mesocycles.track", "mesocycles_one_active_per_track"],
  ["mesocycle_decisions.request_id", "mesocycle_decisions_request_id_key"],
  [
    "mesocycle_exercises.mesocycle_id, mesocycle_exercises.exercise_id",
    "mesocycle_exercises_mesocycle_exercise_key",
  ],
  ["sets.session_id, sets.position", "sets_position_key"],
  ["foods.name_key", "foods_name_key"],
  ["food_aliases.alias_key", "food_aliases_alias_key"],
  ["meals.name_key", "meals_name_key"],
  ["meal_aliases.alias_key", "meal_aliases_alias_key"],
  ["meal_items.meal_id, meal_items.food_id", "meal_items_meal_food_key"],
  [
    "intake_entries.request_id, intake_entries.food_id",
    "intake_entries_request_food_key",
  ],
  ["intake_entries.request_id", "intake_entries_request_food_key"],
  ["day_flags.day, day_flags.flag", "day_flags_day_flag_key"],
  [
    "bodyfat_estimates.day, bodyfat_estimates.method",
    "bodyfat_estimates_day_method_key",
  ],
  ["week_schedules.week_start", "week_schedules_week_start_key"],
] satisfies [string, keyof typeof constraintMessages][];

function wrapped(cause: Error): DrizzleQueryError {
  return new DrizzleQueryError(
    "INSERT private_sql VALUES (?)",
    ["private_token"],
    cause
  );
}

test("oversized repository writes retain the public 413 refusal", () => {
  assert.throws(
    () => jsonChunks(["x".repeat(1536 * 1024)]),
    new DatabaseFailureError("too_large", "")
  );
  const refusal = databaseError(new DatabaseFailureError("too_large", ""));
  assert.ok(refusal instanceof ApiError);
  assert.equal(refusal.status, 413);
  assert.equal(
    refusal.message,
    "One entry exceeds the database value limit. Shorten its text before retrying. Nothing was written."
  );
});

test("raw and Drizzle UNIQUE failures retain every public constraint message", () => {
  for (const [columns, name] of uniqueConstraints) {
    const native = new Error(
      `D1_ERROR: UNIQUE constraint failed: ${columns}: SQLITE_CONSTRAINT`
    );
    for (const error of [native, wrapped(native)]) {
      const failure = classifyDatabaseFailure(error);
      assert.ok(failure instanceof DatabaseFailureError);
      assert.equal(failure.kind, "unique");
      assert.equal(failure.subject, columns);
      assert.equal(classifyDatabaseFailure(failure), failure);
      const refusal = databaseError(failure);
      assert.ok(refusal instanceof ApiError);
      assert.equal(refusal.status, 409);
      assert.equal(refusal.message, constraintMessages[name]);
      assert.deepEqual(databaseError(error), refusal);
    }
  }
});

test("raw and Drizzle constraints retain classification, fallback text and HTTP status", () => {
  const cases: [string, DatabaseFailureKind, string, number, string][] = [
    [
      "UNIQUE constraint failed: unmapped.id",
      "unique",
      "unmapped.id",
      409,
      "That would duplicate an existing record. Read the existing record; reuse the original request_id only when retrying the same operation.",
    ],
    [
      "CHECK constraint failed: foods_source_check",
      "check",
      "foods_source_check",
      422,
      constraintMessages.foods_source_check,
    ],
    [
      "CHECK constraint failed: unmapped_check",
      "check",
      "unmapped_check",
      422,
      'The database rejected a value (check constraint "unmapped_check"). Fix the offending field and retry.',
    ],
    [
      "CHECK constraint failed: api_incomplete_write",
      "check",
      "api_incomplete_write",
      409,
      "The record changed while saving it. Nothing was saved. Read the record before retrying.",
    ],
    [
      "CHECK constraint failed: api_session_changed",
      "check",
      "api_session_changed",
      422,
      'The database rejected a value (check constraint "api_session_changed"). Fix the offending field and retry.',
    ],
    [
      "NOT NULL constraint failed: foods.kcal_100g",
      "required",
      "kcal_100g",
      422,
      '"kcal_100g" is required and cannot be null. Omit the field to leave it unchanged, or send a real value.',
    ],
    [
      "FOREIGN KEY constraint failed",
      "foreign_key",
      "",
      422,
      "A referenced row does not exist. Read the referenced record and use its current id.",
    ],
  ];
  for (const [message, kind, subject, status, expected] of cases) {
    const native = new Error(`D1_ERROR: ${message}: SQLITE_CONSTRAINT`);
    for (const error of [native, wrapped(native)]) {
      const failure = classifyDatabaseFailure(error);
      assert.ok(failure instanceof DatabaseFailureError);
      assert.equal(failure.kind, kind);
      assert.equal(failure.subject, subject);
      assert.equal(failure.message, "The database rejected a write.");
      assert.equal(failure.cause, undefined);
      for (const input of [error, failure]) {
        const refusal = databaseError(input);
        assert.ok(refusal instanceof ApiError);
        assert.equal(refusal.status, status);
        assert.equal(refusal.message, expected);
      }
    }
  }
});

test("unknown exceptions pass through unchanged; wrapper SQL never classifies a failure", () => {
  const native = new Error("private_token private_sql");
  const errors = [
    native,
    wrapped(native),
    new DrizzleQueryError(
      "CHECK constraint failed: foods_source_check",
      [],
      native
    ),
    new Error("outer message", {
      cause: new Error("CHECK constraint failed: foods_source_check"),
    }),
    "CHECK constraint failed: foods_source_check",
    { message: "CHECK constraint failed: foods_source_check" },
    null,
    undefined,
    42,
  ];
  for (const error of errors) {
    assert.equal(classifyDatabaseFailure(error), error);
    assert.equal(databaseError(error), error);
  }
  const refusal = new ApiError(
    418,
    "CHECK constraint failed: foods_source_check"
  );
  assert.equal(databaseError(refusal), refusal);
});

test("HTTP error boundary accepts raw, wrapped and classified failures without logging", async () => {
  const native = new Error("UNIQUE constraint failed: foods.name_key");
  const failures = [
    native,
    wrapped(native),
    classifyDatabaseFailure(native),
    new ApiError(409, constraintMessages.foods_name_key),
  ];
  const logged: string[] = [];
  const original = console.error;
  console.error = (message: string) => {
    logged.push(message);
  };
  try {
    for (const failure of failures) {
      const app = new Hono();
      app.post("/", (c) => errorResponse(failure, c));
      const response = await app.request("/", { method: "POST" });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: constraintMessages.foods_name_key,
      });
      assert.equal(response.headers.get("X-Request-ID"), null);
    }
    assert.deepEqual(logged, []);
  } finally {
    console.error = original;
  }
});

test("unknown HTTP failures retain safe read/write diagnostics and log no private values", async () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (message: string) => {
    logged.push(message);
  };
  try {
    for (const method of ["GET", "POST"]) {
      for (const attached of [false, true]) {
        const diagnostic: Diagnostic = { id: "known-diagnostic", route: "/" };
        const app = new Hono<{ Variables: { diagnostic: Diagnostic } }>();
        app.all("/", (c) => {
          if (attached) {
            c.set("diagnostic", diagnostic);
          }
          return errorResponse(
            wrapped(new Error("private_token private_sql")),
            c
          );
        });
        const count = logged.length;
        const response = await app.request("/", { method });
        assert.equal(response.status, 500);
        const id = response.headers.get("X-Request-ID");
        assert.ok(id);
        const guidance =
          method === "GET"
            ? "Try this read again later."
            : "Write outcome is uncertain. Read the affected record first; keep the original write request_id for the same operation. Reconcile GitHub issues or comments before repeating an external write.";
        assert.deepEqual(await response.json(), {
          error: `Internal error. Diagnostic ID: ${id}. ${guidance}`,
        });
        if (attached) {
          assert.equal(id, diagnostic.id);
          assert.equal(diagnostic.error, "unexpected");
          assert.equal(logged.length, count);
        } else {
          assert.equal(logged.length, count + 1);
          assert.equal(
            logged[count],
            JSON.stringify({ id, route: "/", error: "unexpected" })
          );
        }
      }
    }
  } finally {
    console.error = original;
  }
});

test("session retries recognize classified version assertions before HTTP translation", async () => {
  const native = new Error(
    "D1_ERROR: CHECK constraint failed: api_session_changed: SQLITE_CONSTRAINT"
  );
  for (const error of [native, wrapped(native)]) {
    const conflict = classifyDatabaseFailure(error);
    let attempts = 0;
    const result = await retrySessionWrite(7, () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(conflict)
        : Promise.resolve("saved");
    });
    assert.equal(result, "saved");
    assert.equal(attempts, 2);
    attempts = 0;
    await assert.rejects(
      retrySessionWrite(7, () => {
        attempts += 1;
        return Promise.reject(conflict);
      }),
      {
        status: 409,
        message:
          "The session kept changing. Nothing was saved by this request. Read GET /sessions/7 before retrying.",
      }
    );
    assert.equal(attempts, 3);
  }
});

test("session writes do not retry unknown outcomes or unrelated constraints", async () => {
  for (const error of [
    new Error("connection lost after write"),
    wrapped(new Error("unknown outcome")),
    new DatabaseFailureError("check", "api_incomplete_write"),
    new DatabaseFailureError("unique", "sets.session_id, sets.position"),
  ]) {
    let attempts = 0;
    await assert.rejects(
      retrySessionWrite(7, () => {
        attempts += 1;
        return Promise.reject(error);
      })
    );
    assert.equal(attempts, 1);
  }
});
