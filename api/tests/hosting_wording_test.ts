import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { assertEquals } from "./assertions.ts";

test("active hosting explanations do not describe retired platforms or project pausing", async () => {
  for (const file of [
    "api/index.ts",
    "api/body/withings.ts",
    "api/body/withings.routes.ts",
    "api/body/withings_client.ts",
    "api/access/jwt.ts",
    "api/surfaces/github.ts",
  ]) {
    const text = await readFile(file, "utf-8");
    assertEquals(
      /free project|Deno\s+Deploy|function's own name/iu.test(text),
      false,
      file
    );
  }
});
