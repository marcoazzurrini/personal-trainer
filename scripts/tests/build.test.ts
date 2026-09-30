import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  assert,
  assertEquals,
  assertThrows,
} from "../../api/tests/assertions.ts";
import { sourceRevision } from "../build-worker.ts";

const sha = "a".repeat(40);
const git =
  (dirty = false) =>
  (...args: string[]) => {
    assert(["rev-parse", "status"].includes(args[0]));
    if (args[0] === "rev-parse") {
      return sha;
    }
    return dirty ? " M api/worker.ts" : "";
  };
test("a Worker release revision must match the exact clean checkout", () => {
  assertEquals(sourceRevision(sha, git()), sha);
  assertEquals(sourceRevision("", git()), sha);
  assertEquals(sourceRevision(null, git()), sha);
  assertEquals(sourceRevision("", git(true)), null);
  assertEquals(sourceRevision(null, git(true)), null);
  for (const invalid of ["HEAD", "abc1234", "A".repeat(40), "b".repeat(40)]) {
    assertThrows(
      () => sourceRevision(invalid, git()),
      Error,
      "exact clean GITHUB_SHA"
    );
  }
  assertThrows(
    () => sourceRevision(sha, git(true)),
    Error,
    "exact clean GITHUB_SHA"
  );
});
test("an unstamped Worker module does not require a build metadata global", async () => {
  const { buildMetadata } = await import("../../api/shared/build.ts");
  assertEquals(buildMetadata, { revision: null, digest: "local-development" });
});

test("Worker build identity stamps one compiler result, never a runtime label", async () => {
  const builder = await readFile("scripts/build-worker.ts", "utf-8");
  assertEquals([...builder.matchAll(/await build\(/gu)].length, 1);
  assert(builder.includes('createHash("sha256").update(source).digest("hex")'));
  assert(builder.includes("source.replace(placeholder, digest)"));
  assert(builder.includes('resolve(root, "dist/build.json")'));
  assert(builder.includes("JSON.stringify(metadata)"));
  assert(builder.includes("sourceRevision() !== revision"));
  assert(builder.includes("production Worker must not include"));
  const reader = await readFile("api/shared/build.ts", "utf-8");
  assert(reader.includes("__BUILD_METADATA__"));
  assert(!reader.includes("Deno.env"));
  assert(!reader.includes("process.env"));
  assert(!reader.includes("readTextFile"));
});
