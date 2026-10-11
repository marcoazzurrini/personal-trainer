import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { assertEquals } from "./assertions.ts";

test("active hosting explanations do not describe retired platforms or project pausing", async () => {
  for (const file of [
    "apps/api/src/index.ts",
    "apps/api/src/body/withings.ts",
    "apps/api/src/body/withings.routes.ts",
    "apps/api/src/body/withings_client.ts",
    "apps/api/src/access/jwt.ts",
    "apps/api/src/surfaces/github.ts",
  ]) {
    const text = await readFile(file, "utf-8");
    assertEquals(
      /free project|Deno\s+Deploy|function's own name/iu.test(text),
      false,
      file
    );
  }
});
