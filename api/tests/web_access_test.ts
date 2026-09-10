import { assert, assertEquals } from "@std/assert";
import { forgetJwks } from "../access/jwt.ts";
import { webSigner } from "./web_signer.ts";

Deno.test("the API enforces the dashboard's one read across the whole documented surface", async () => {
  // The helper verifies disposable cluster identity before index.ts reaches SQL.
  const { TOKEN } = await import("./helpers.ts");
  const { handleRequest } = await import("../index.ts");
  const { sql } = await import("../db.ts");
  const signer = await webSigner();
  const values = {
    WEB_AUTH_ISSUER: "https://web.example.test",
    WEB_AUTH_CLIENT_ID: "client_web",
    WEB_AUTH_JWKS_URL: "https://web.example.test/jwks",
    ALLOWED_SUBJECT: "owner",
  };
  const previous = new Map(
    Object.keys(values).map((key) => [key, Deno.env.get(key)]),
  );
  const originalFetch = globalThis.fetch;
  let keyReads = 0;
  const good = {
    iss: values.WEB_AUTH_ISSUER,
    sub: "owner",
    client_id: values.WEB_AUTH_CLIENT_ID,
    sid: "session_test",
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const call = async (path: string, token: string, method = "GET") => {
    const response = await handleRequest(
      new Request(`http://localhost${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        ...(method === "POST" || method === "PATCH" || method === "PUT"
          ? { body: "{}" }
          : {}),
      }),
    );
    const text = await response.text();
    return { response, text };
  };
  try {
    for (const [key, value] of Object.entries(values)) Deno.env.set(key, value);
    forgetJwks();
    globalThis.fetch = (input, init) => {
      if (String(input) === values.WEB_AUTH_JWKS_URL) {
        keyReads++;
        return Promise.resolve(Response.json(signer.jwks));
      }
      return originalFetch(input, init);
    };
    const token = await signer.sign(good);
    const allowed = await call("/api/bodyweight", token);
    assertEquals(allowed.response.status, 200);
    assert(Array.isArray(JSON.parse(allowed.text).bodyweight));
    assertEquals(
      allowed.response.headers.get("cache-control"),
      "private, no-store",
    );

    const spec = JSON.parse((await call("/api/openapi.json", "")).text);
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods as object)) {
        if (method === "get" && path === "/api/bodyweight") continue;
        const denied = await call(
          path.replace(/\{[^}]+\}/g, "x"),
          token,
          method.toUpperCase(),
        );
        assertEquals(denied.response.status, 403, `${method} ${path}`);
        assertEquals(Object.keys(JSON.parse(denied.text)), ["error"]);
      }
    }
    for (
      const method of ["HEAD", "OPTIONS", "DELETE", "PATCH", "POST", "PUT"]
    ) {
      assertEquals(
        (await call("/api/bodyweight", token, method)).response.status,
        403,
        method,
      );
    }
    assertEquals((await call("/api/not-a-route", token)).response.status, 403);
    assertEquals(
      (await call(
        "/api/bodyweight",
        await signer.sign({ ...good, sub: "another_person" }),
      )).response.status,
      403,
    );
    for (
      const patch of [{ client_id: "other" }, { exp: 1 }, {
        aud: "https://trainer.example.test/api/mcp",
      }, { sid: undefined }]
    ) {
      const denied = await call(
        "/api/bodyweight",
        await signer.sign({ ...good, ...patch }),
      );
      assertEquals(denied.response.status, 401);
      assert(!denied.text.includes(token));
    }
    const readsBefore = keyReads;
    for (const key of Object.keys(values)) {
      Deno.env.delete(key);
      assertEquals((await call("/api/bodyweight", token)).response.status, 401);
      Deno.env.set(key, values[key as keyof typeof values]);
    }
    assertEquals(keyReads, readsBefore);
    // A provider outage is not an invalid login, and never falls back to coach auth.
    forgetJwks();
    globalThis.fetch = () =>
      Promise.reject(new Error("synthetic provider outage"));
    assertEquals((await call("/api/bodyweight", token)).response.status, 503);
    assertEquals((await call("/api/exercises", TOKEN)).response.status, 200);
    assertEquals(
      (await call("/api/bodyweight", "not-the-token")).response.status,
      401,
    );
  } finally {
    globalThis.fetch = originalFetch;
    forgetJwks();
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await sql.end();
  }
});
