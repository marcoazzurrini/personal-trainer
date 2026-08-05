import { assert, assertEquals } from "@std/assert";
import { api } from "./helpers.ts";

Deno.test("auth and error envelope", async (t) => {
  await t.step("/health is public", async () => {
    const { status, body } = await api.get("/health", null);
    assertEquals(status, 200);
    assertEquals(body.status, "ok");
  });

  await t.step("coach endpoints reject a missing token", async () => {
    const { status, body } = await api.get("/exercises", null);
    assertEquals(status, 401);
    assert(body.error.includes("Bearer"));
  });

  await t.step("coach endpoints reject a wrong token", async () => {
    const { status } = await api.get("/exercises", "not-the-token");
    assertEquals(status, 401);
  });

  await t.step("unknown routes return JSON with guidance", async () => {
    const { status, body } = await api.get("/nope");
    assertEquals(status, 404);
    assert(body.error.includes("/api/nope"));
  });

  await t.step("bad JSON body is a 422, not a crash", async () => {
    const res = await fetch(
      `${(await import("./helpers.ts")).BASE}/user-context`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${(await import("./helpers.ts")).TOKEN}`,
        },
        body: "not json",
      },
    );
    assertEquals(res.status, 422);
    const body = await res.json();
    assert(body.error.includes("JSON"));
  });
});
