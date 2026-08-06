import { assert, assertEquals } from "@std/assert";
import { api, BASE } from "./helpers.ts";

Deno.test("skill documents", async (t) => {
  await t.step("docs are behind the token", async () => {
    const res = await fetch(`${BASE}/docs/index`);
    assertEquals(res.status, 401);
    await res.body?.cancel();
  });

  await t.step("the index names the other documents", async () => {
    const res = await fetch(`${BASE}/docs/index`, {
      headers: {
        Authorization: `Bearer ${(await import("./helpers.ts")).TOKEN}`,
      },
    });
    assertEquals(res.status, 200);
    const text = await res.text();
    for (
      const name of [
        "programming",
        "session-generation",
        "logging",
        "evaluation",
        "charts",
      ]
    ) {
      assert(text.includes(name), `index should mention ${name}`);
    }
  });

  await t.step("an unknown document lists what exists", async () => {
    const { status, body } = await api.get("/docs/nope");
    assertEquals(status, 404);
    assert(body.error.includes("programming"));
  });
});
