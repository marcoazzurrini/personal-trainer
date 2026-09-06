import { assertEquals } from "@std/assert";

Deno.test("active hosting explanations do not describe retired isolates or project pausing", async () => {
  for (
    const file of [
      "api/index.ts",
      "api/body/withings.ts",
      "api/body/withings.routes.ts",
      "api/body/withings_client.ts",
      "api/access/jwt.ts",
      "api/surfaces/github.ts",
    ]
  ) {
    const text = await Deno.readTextFile(file);
    assertEquals(
      /edge[- ]runtime|isolate|free project|Deno\s+Deploy|function's own name/i
        .test(text),
      false,
      file,
    );
  }
});
