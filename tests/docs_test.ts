import { assert, assertEquals } from "@std/assert";
import { isDocName } from "../supabase/functions/api/lib/doc_names.ts";
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
        "tasks/reporting-problems",
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

  await t.step("documents never point at documents that 404", async () => {
    const token = (await import("./helpers.ts")).TOKEN;
    const auth = { Authorization: `Bearer ${token}` };
    const index = await fetch(`${BASE}/docs/index`, { headers: auth });
    const named = new Set(
      [...(await index.text()).matchAll(
        /GET \/docs\/([a-z0-9-]+\/[a-z0-9-]+)/g,
      )]
        .map((m) => m[1]),
    );

    // Cross-references inside the documents, not just the index's own table.
    // A task doc telling the coach to fetch `tasks/training-onboarding` when
    // the route is `tasks/onboarding` sends it looking for a procedure that
    // isn't there, and the index-coverage check above cannot see that.
    const seen = new Set<string>();
    for (const name of named) {
      const res = await fetch(`${BASE}/docs/${name}`, { headers: auth });
      assertEquals(res.status, 200, `${name} should serve`);
      const body = await res.text();
      for (
        const m of body.matchAll(/`(tasks|reference|method)\/([a-z0-9-]+)`/g)
      ) {
        seen.add(`${m[1]}/${m[2]}`);
      }
    }
    assert(seen.size >= 8, `expected cross-references, found ${seen.size}`);
    for (const ref of seen) {
      const res = await fetch(`${BASE}/docs/${ref}`, { headers: auth });
      assertEquals(res.status, 200, `a document references ${ref}, which 404s`);
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

// The rule that lets the docs route serve any merged file without an
// allowlist, and that /issues reuses to validate the documents a report
// names. No dots at all, so a name can never spell ".." and leave the folder.
Deno.test("document names", () => {
  for (const good of ["index", "method/hypertrophy", "a-b/c-d/e2"]) {
    assert(isDocName(good), good);
  }
  for (
    const bad of ["", "..", "a..b", "a.md", "/a", "a/", "A", "a b", "a//b"]
  ) {
    assert(!isDocName(bad), bad);
  }
  assert(!isDocName("x".repeat(81)), "over the length cap");
});
