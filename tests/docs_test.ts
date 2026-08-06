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

  await t.step(
    "a method document with a slash in its name serves",
    async () => {
      const res = await fetch(`${BASE}/docs/method/hypertrophy`, {
        headers: {
          Authorization: `Bearer ${(await import("./helpers.ts")).TOKEN}`,
        },
      });
      assertEquals(res.status, 200);
      const text = await res.text();
      assert(text.includes("# Hypertrophy"));
    },
  );

  await t.step("the index lists the method document", async () => {
    const res = await fetch(`${BASE}/docs/index`, {
      headers: {
        Authorization: `Bearer ${(await import("./helpers.ts")).TOKEN}`,
      },
    });
    const text = await res.text();
    assert(text.includes("method/hypertrophy"));
  });

  await t.step("an unknown document points at the index", async () => {
    const { status, body } = await api.get("/docs/nope");
    assertEquals(status, 404);
    assert(body.error.includes("/docs/index"));
  });

  await t.step("traversal-looking paths are rejected", async () => {
    const { status } = await api.get("/docs/method/../../index.ts");
    assertEquals(status, 404);
  });
});
