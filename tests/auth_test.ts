import { assert, assertEquals, assertRejects } from "@std/assert";
import { api, BASE, mintToken, revokeToken, TOKEN } from "./helpers.ts";
import { loadCatalogue } from "../scripts/load_catalogue.ts";

Deno.test("catalogue loading requires a credential before reads or requests", async () => {
  for (const token of ["", "   "]) {
    await assertRejects(
      () => loadCatalogue("http://127.0.0.1:1/api", token),
      Error,
      "get_api_token",
    );
  }
});

Deno.test("legacy environment tokens cannot bypass expiry or revocation", async () => {
  const { handleRequest } = await import("../api/index.ts");
  const { sql } = await import("../api/db.ts");
  try {
    for (const key of ["API_TOKEN", "API_TOKEN_PREVIOUS"]) {
      const previous = Deno.env.get(key);
      const token = await mintToken({ expiresInMs: -1000 });
      Deno.env.set(key, token);
      const status = async () => {
        const response = await handleRequest(
          new Request("http://localhost/api/exercises", {
            headers: { authorization: `Bearer ${token}` },
          }),
        );
        await response.body?.cancel();
        return response.status;
      };
      try {
        assertEquals(await status(), 401); // expired, even if configured
        await mintToken({ token });
        assertEquals(await status(), 200); // a live row is the only authority
        await revokeToken(token);
        assertEquals(await status(), 401); // revoked, even if configured
      } finally {
        await revokeToken(token);
        if (previous === undefined) Deno.env.delete(key);
        else Deno.env.set(key, previous);
      }
    }
  } finally {
    await sql.end();
  }
});

// zod-openapi's media-type gate must not bypass our JSON forgiveness or turn
// actionable object/schema refusals into an upstream 415 or internal error.
Deno.test("JSON body contracts survive dependency updates", async (t) => {
  for (
    const contentType of [
      undefined,
      "application/json",
      "application/json; charset=utf-8",
      "Application/JSON",
      "application/vnd.api+json",
      "text/plain",
      "application/x-www-form-urlencoded",
    ]
  ) {
    await t.step(contentType ?? "missing Content-Type", async () => {
      const payload = {
        topic: `media-type-${crypto.randomUUID()}`,
        content: "Synthetic contract check",
        request_id: crypto.randomUUID(),
      };
      const headers = new Headers({ Authorization: `Bearer ${TOKEN}` });
      if (contentType) headers.set("Content-Type", contentType);
      // Bytes avoid fetch silently adding text/plain when testing no header.
      async function send(raw: string) {
        const response = await fetch(`${BASE}/api/user-context`, {
          method: "POST",
          headers,
          body: new TextEncoder().encode(raw),
        });
        return { status: response.status, body: await response.json() };
      }
      const created = await send(JSON.stringify(payload));
      assertEquals(created.status, 201);
      assertEquals(created.body.entry.topic, payload.topic);
      assertEquals(created.body.entry.content, payload.content);
      // The standard helper also validates the replay against generated OpenAPI.
      const replay = await api.post("/user-context", payload);
      assertEquals(replay.status, 200);
      assertEquals(replay.body, created.body);

      for (const raw of ["null", "[]", '"text"', "not JSON"]) {
        const refused = await send(raw);
        assertEquals(refused.status, 422);
        assertEquals(Object.keys(refused.body), ["error"]);
        assert(refused.body.error.includes("JSON object"));
      }
      const unknown = await send(JSON.stringify({
        ...payload,
        request_id: crypto.randomUUID(),
        unexpected: true,
      }));
      assertEquals(unknown.status, 422);
      assertEquals(Object.keys(unknown.body), ["error"]);
      assert(unknown.body.error.includes("unexpected"));
    });
  }
  await t.step("body-less sync still reaches query validation", async () => {
    const response = await fetch(`${BASE}/withings/sync?since=invalid`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assertEquals(response.status, 422);
    const body = await response.json();
    assertEquals(Object.keys(body), ["error"]);
    assert(body.error.includes('"since"'));
  });
});

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
    assert(body.error.includes("get_api_token"));
  });

  await t.step("coach endpoints reject a wrong token", async () => {
    const { status } = await api.get("/exercises", "not-the-token");
    assertEquals(status, 401);
  });

  await t.step("a minted token opens a coach endpoint", async () => {
    // The path the connector uses: a fresh token whose hash is a row in
    // api_tokens with its expiry ahead. Nothing about it is configured on the
    // server: only the stored hash and expiry authorize it.
    const minted = await mintToken();
    const { status } = await api.get("/exercises", minted);
    assertEquals(status, 200);
  });

  await t.step("a token past its expiry is refused", async () => {
    const stale = await mintToken({ expiresInMs: -1000 });
    const { status } = await api.get("/exercises", stale);
    assertEquals(status, 401);
  });

  await t.step("a token whose row is gone is refused", async () => {
    // Revocation is a delete; there is no state on the token itself.
    const revoked = await mintToken();
    assertEquals((await api.get("/exercises", revoked)).status, 200);
    await revokeToken(revoked);
    assertEquals((await api.get("/exercises", revoked)).status, 401);
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
