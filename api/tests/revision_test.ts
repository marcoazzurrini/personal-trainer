import { assertEquals, assertThrows } from "@std/assert";
import { readBuildRevision } from "../shared/revision.ts";

Deno.test("build revision comes from the image file, never a runtime environment label", () => {
  const sha = "a".repeat(40);
  assertEquals(readBuildRevision(() => `${sha}\n`), sha);
  assertEquals(
    readBuildRevision(() => {
      throw new Deno.errors.NotFound();
    }),
    null,
  );
  for (const invalid of ["", "HEAD", "abc1234", "A".repeat(40)]) {
    assertThrows(
      () => readBuildRevision(() => invalid),
      Error,
      "build revision",
    );
  }
  assertThrows(() =>
    readBuildRevision(() => {
      throw new Deno.errors.PermissionDenied();
    }), Deno.errors.PermissionDenied);
});

Deno.test("the Dockerfile requires source metadata and stores it outside runtime environment", async () => {
  const dockerfile = await Deno.readTextFile("Dockerfile");
  assertEquals(/^ARG SOURCE_COMMIT$/m.test(dockerfile), true);
  assertEquals(dockerfile.includes('Deno.env.get("SOURCE_COMMIT")'), true);
  assertEquals(
    dockerfile.includes('Deno.writeTextFileSync("build-revision.txt"'),
    true,
  );
  assertEquals(
    /^ENV (SOURCE_COMMIT|BUILD_SHA|REVISION)=/m.test(dockerfile),
    false,
  );
  const reader = await Deno.readTextFile("api/shared/revision.ts");
  assertEquals(reader.includes("Deno.env"), false);
});
