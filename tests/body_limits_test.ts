import { assert, assertEquals } from "@std/assert";
import { handleRequest } from "../api/index.ts";
import { MAX_BODY_BYTES } from "../api/shared/body.ts";

Deno.test("body limits count streamed bytes before auth, normalization and webhooks", async () => {
  for (
    const path of [
      "/api/exercises",
      "/api/api/exercises",
      "/api/withings/notify",
      "/api/mcp",
    ]
  ) {
    for (
      const type of [
        "application/json",
        "text/plain",
        "application/x-www-form-urlencoded",
      ]
    ) {
      let pulls = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          pulls++;
          c.enqueue(new Uint8Array(MAX_BODY_BYTES / 4));
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 });
      const response = await handleRequest(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": type, "content-length": "1" },
          body,
        }),
      );
      assertEquals(response.status, 413);
      assertEquals(Object.keys(await response.json()), ["error"]);
      assert(pulls <= 6); // stream plumbing may prefetch one bounded chunk
      assert(cancelled);
    }
  }
  const oversized = await handleRequest(
    new Request("http://localhost/api/exercises", {
      method: "POST",
      body: "x".repeat(MAX_BODY_BYTES + 1),
    }),
  );
  assertEquals(oversized.status, 413);
  await oversized.body?.cancel();
  const small = await handleRequest(
    new Request("http://localhost/api/exercises", {
      method: "POST",
      body: "not JSON",
    }),
  );
  assertEquals(small.status, 401); // object refusal never precedes auth
  await small.body?.cancel();
  const form = await handleRequest(
    new Request("http://localhost/api/api/withings/notify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "appli=2",
    }),
  );
  assertEquals(form.status, 200);
  await form.body?.cancel();
});
