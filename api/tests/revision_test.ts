import { assert, assertEquals, assertThrows } from "@std/assert";
import { sourceRevision } from "../../scripts/build-worker.mjs";

const sha = "a".repeat(40);
const git = (dirty = false) => (...args: string[]) => {
  assert(["rev-parse", "status"].includes(args[0]));
  return args[0] === "rev-parse" ? sha : dirty ? " M api/worker.ts" : "";
};

Deno.test("a Worker release revision must match the exact clean checkout", () => {
  assertEquals(sourceRevision(sha, git()), sha);
  assertEquals(sourceRevision("", git()), sha);
  assertEquals(sourceRevision("", git(true)), null);
  for (const invalid of ["HEAD", "abc1234", "A".repeat(40), "b".repeat(40)]) {
    assertThrows(
      () => sourceRevision(invalid, git()),
      Error,
      "exact clean GITHUB_SHA",
    );
  }
  assertThrows(
    () => sourceRevision(sha, git(true)),
    Error,
    "exact clean GITHUB_SHA",
  );
});

Deno.test("Worker build identity stamps one compiler result, never a runtime label", async () => {
  const builder = await Deno.readTextFile("scripts/build-worker.mjs");
  assertEquals([...builder.matchAll(/await build\(/g)].length, 1);
  assert(builder.includes('createHash("sha256").update(source).digest("hex")'));
  assert(builder.includes("source.replace(placeholder, digest)"));
  assert(builder.includes('resolve(root, "dist/build.json")'));
  assert(builder.includes("JSON.stringify(metadata)"));
  assert(builder.includes("sourceRevision() !== revision"));
  assert(builder.includes("production Worker must not include"));
  const reader = await Deno.readTextFile("api/shared/build.ts");
  assert(reader.includes("__BUILD_METADATA__"));
  assert(!reader.includes("Deno.env"));
  assert(!reader.includes("process.env"));
  assert(!reader.includes("readTextFile"));
});
