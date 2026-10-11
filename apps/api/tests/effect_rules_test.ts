import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

import { parse } from "@babel/parser";
import { traverseFast } from "@babel/types";

import {
  BadRequest,
  Conflict,
  Forbidden,
  Invalid,
  Misconfigured,
  NotFound,
  TooLarge,
  Unauthorized,
  Unavailable,
  Upstream,
} from "../src/shared/refusals.ts";
import { assertEquals } from "./assertions.ts";

// The Effect error channel only helps if refusals stay in it. These look
// inside the code for the two ways out.
const SOURCE = "apps/api/src";

const REFUSALS = new Set(
  [
    BadRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    TooLarge,
    Invalid,
    Misconfigured,
    Upstream,
    Unavailable,
  ].map((refusal) => refusal.name)
);

// The JSON logger writes every line; the error handler keeps one fallback for
// routers mounted without the request boundary.
const CONSOLE_WRITERS = new Set([
  `${SOURCE}/shared/runtime.ts`,
  `${SOURCE}/shared/errors.ts`,
]);

async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await files(path)));
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found.toSorted();
}

interface Violations {
  thrown: string[];
  logged: string[];
}

/** Throw statements whose argument constructs a refusal, and console calls. */
function violations(file: string, source: string): Violations {
  const thrown: string[] = [];
  const logged: string[] = [];
  traverseFast(
    parse(source, { sourceType: "module", plugins: ["typescript"] }),
    (node) => {
      const at = `${file}:${node.loc?.start.line ?? 1}`;
      if (
        node.type === "ThrowStatement" &&
        node.argument.type === "NewExpression" &&
        node.argument.callee.type === "Identifier" &&
        REFUSALS.has(node.argument.callee.name)
      ) {
        thrown.push(at);
      }
      if (
        node.type === "MemberExpression" &&
        node.object.type === "Identifier" &&
        node.object.name === "console"
      ) {
        logged.push(at);
      }
    }
  );
  return { thrown, logged };
}

// Thrown inside Effect code, a refusal is a defect: the caller gets a 500 and
// a diagnostic ID instead of the sentence saying what a correct call looks
// like. Refusals are yielded, never thrown.
test("no source file throws a refusal", async () => {
  const offenders: string[] = [];
  for (const file of await files(SOURCE)) {
    offenders.push(...violations(file, await readFile(file, "utf-8")).thrown);
  }
  assertEquals(offenders, [], "Refuse with `return yield* new Refusal(...)`.");
});

// Every log line goes through the JSON logger, which never prints a cause:
// database and provider errors can carry credentials and personal input.
test("only the JSON logger writes to the console", async () => {
  const offenders: string[] = [];
  for (const file of await files(SOURCE)) {
    if (!CONSOLE_WRITERS.has(file)) {
      offenders.push(...violations(file, await readFile(file, "utf-8")).logged);
    }
  }
  assertEquals(offenders, [], "Log with Effect.logInfo/logWarning/logError.");
});

test("the scan sees thrown refusals and console calls apart from comments", () => {
  assertEquals(
    violations(
      "fixture.ts",
      'throw new NotFound({ message: "x" });\nthrow new Error("defect");\n// throw new Invalid()\nconsole.error("x");\n'
    ),
    { thrown: ["fixture.ts:1"], logged: ["fixture.ts:4"] }
  );
});
