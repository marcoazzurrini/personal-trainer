import { test } from "node:test";

import { z } from "zod";

import { forgetJwks } from "../access/jwt.ts";
import type { Bindings } from "../environment.ts";
import { assert, assertEquals } from "./assertions.ts";
import { webSigner } from "./web_signer.ts";

test("the API enforces the dashboard's one read across the whole documented surface", async () => {
  // The helper verifies the disposable Worker/D1 identity before fixture reads.
  const { TOKEN } = await import("./helpers.ts");
  const { handleRequest } = await import("../index.ts");
  const { database } = await import("./d1.ts");
  const signer = await webSigner();
  const values = {
    WEB_AUTH_ISSUER: "https://web.example.test",
    WEB_AUTH_CLIENT_ID: "client_web",
    WEB_AUTH_JWKS_URL: "https://web.example.test/jwks",
    ALLOWED_SUBJECT: "owner",
  };
  const env: Bindings = { DB: database, ...values };
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
    const init: RequestInit = {
      method,
      headers: { authorization: `Bearer ${token}` },
    };
    if (method === "POST" || method === "PATCH" || method === "PUT") {
      init.body = "{}";
    }
    const response = await handleRequest(
      new Request(`http://localhost${path}`, init),
      env,
      {
        waitUntil() {
          /* empty */
        },
        passThroughOnException() {
          /* empty */
        },
      }
    );
    const text = await response.text();
    return { response, text };
  };
  try {
    forgetJwks();
    globalThis.fetch = Object.assign(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        if (String(input) === values.WEB_AUTH_JWKS_URL) {
          keyReads += 1;
          return Promise.resolve(Response.json(signer.jwks));
        }
        return originalFetch(input, init);
      },
      { preconnect: originalFetch.preconnect }
    );
    const token = await signer.sign(good);
    const allowed = await call("/api/bodyweight", token);
    assertEquals(allowed.response.status, 200);
    assert(Array.isArray(JSON.parse(allowed.text).bodyweight));
    assertEquals(
      allowed.response.headers.get("cache-control"),
      "private, no-store"
    );
    const spec = z
      .object({
        paths: z.record(z.string(), z.record(z.string(), z.unknown())),
      })
      .parse(JSON.parse((await call("/api/openapi.json", "")).text));
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods)) {
        if (method === "get" && path === "/api/bodyweight") {
          continue;
        }
        const denied = await call(
          path.replaceAll(/\{[^}]+\}/gu, "x"),
          token,
          method.toUpperCase()
        );
        assertEquals(denied.response.status, 403, `${method} ${path}`);
        assertEquals(Object.keys(JSON.parse(denied.text)), ["error"]);
      }
    }
    for (const method of [
      "HEAD",
      "OPTIONS",
      "DELETE",
      "PATCH",
      "POST",
      "PUT",
    ]) {
      assertEquals(
        (await call("/api/bodyweight", token, method)).response.status,
        403,
        method
      );
    }
    assertEquals((await call("/api/not-a-route", token)).response.status, 403);
    assertEquals(
      (
        await call(
          "/api/bodyweight",
          await signer.sign({ ...good, sub: "another_person" })
        )
      ).response.status,
      403
    );
    for (const patch of [
      { client_id: "other" },
      { exp: 1 },
      {
        aud: "https://trainer.example.test/api/mcp",
      },
      { sid: undefined },
    ]) {
      const denied = await call(
        "/api/bodyweight",
        await signer.sign({ ...good, ...patch })
      );
      assertEquals(denied.response.status, 401);
      assert(!denied.text.includes(token));
    }
    const readsBefore = keyReads;
    for (const key of [
      "WEB_AUTH_ISSUER",
      "WEB_AUTH_CLIENT_ID",
      "WEB_AUTH_JWKS_URL",
      "ALLOWED_SUBJECT",
    ] as const) {
      // oxlint-disable-next-line typescript/no-dynamic-delete -- Exercise missing bindings individually, preserving the absent-property case.
      delete env[key];
      assertEquals((await call("/api/bodyweight", token)).response.status, 401);
      env[key] = values[key];
    }
    assertEquals(keyReads, readsBefore);
    // A provider outage is not an invalid login, and never falls back to coach auth.
    forgetJwks();
    globalThis.fetch = Object.assign(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        if (String(input) === values.WEB_AUTH_JWKS_URL) {
          return Promise.reject(new Error("synthetic provider outage"));
        }
        return originalFetch(input, init);
      },
      { preconnect: originalFetch.preconnect }
    );
    assertEquals((await call("/api/bodyweight", token)).response.status, 503);
    assertEquals((await call("/api/exercises", TOKEN)).response.status, 200);
    assertEquals(
      (await call("/api/bodyweight", "not-the-token")).response.status,
      401
    );
  } finally {
    globalThis.fetch = originalFetch;
    forgetJwks();
  }
});
