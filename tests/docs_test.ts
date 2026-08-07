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
        "tasks/programming",
        "tasks/session-generation",
        "tasks/logging",
        "tasks/evaluation",
        "tasks/charts",
        "tasks/improving-docs",
        "reference/planning",
        "reference/sessions",
        "reference/exercises",
        "reference/tracking",
        "tasks/nutrition-logging",
        "tasks/nutrition-checkin",
        "reference/nutrition",
        "method/nutrition",
      ]
    ) {
      assert(text.includes(name), `index should mention ${name}`);
    }
  });

  await t.step("every document the index names actually serves", async () => {
    const token = (await import("./helpers.ts")).TOKEN;
    const index = await fetch(`${BASE}/docs/index`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await index.text();
    // The index is the coach's map. A row pointing at a document that 404s
    // sends it looking for a procedure that isn't there.
    const named = [...text.matchAll(/GET \/docs\/([a-z0-9-]+\/[a-z0-9-]+)/g)]
      .map((m) => m[1]);
    assert(named.length >= 12);
    for (const name of new Set(named)) {
      const res = await fetch(`${BASE}/docs/${name}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assertEquals(res.status, 200, `${name} should serve`);
      await res.body?.cancel();
    }
  });

  await t.step("a reference document serves from its folder", async () => {
    const res = await fetch(`${BASE}/docs/reference/sessions`, {
      headers: {
        Authorization: `Bearer ${(await import("./helpers.ts")).TOKEN}`,
      },
    });
    assertEquals(res.status, 200);
    const text = await res.text();
    assert(text.includes("targets or actuals, never both"));
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
