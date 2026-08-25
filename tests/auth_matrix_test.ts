import { assert, assertEquals } from "@std/assert";

// Auth as a property of the whole surface, not of the routes someone
// remembered to test. index.ts's ordering is the mechanism — anything
// registered above the token middleware is public forever — so this file
// reads the ordering and then proves it against the live function: the
// public set is exactly the documented one, and every mount below the line
// answers 401 to a missing or wrong token before any route logic runs.
//
// auth_test.ts checks the token itself (rotation, malformed JSON); this is
// the matrix that catches a new route landing on the wrong side of the line.

const BASE = Deno.env.get("API_URL") ??
  "http://127.0.0.1:54321/functions/v1/api";

// The three tokenless surfaces, each with its own auth story: /health is the
// uptime probe, /s is guarded by the public_id's entropy, /withings (the
// webhook half) is guarded by dropping anything that names the wrong account.
const PUBLIC_MOUNTS = ["/s", "/withings"];

const source = await Deno.readTextFile(
  new URL("../supabase/functions/api/index.ts", import.meta.url),
);

const middlewareAt = source.indexOf("app.use(");
assert(middlewareAt > 0, "index.ts no longer registers the token middleware");

const above: string[] = [];
const below: string[] = [];
for (const m of source.matchAll(/app\.route\("([^"]+)"/g)) {
  (m.index < middlewareAt ? above : below).push(m[1]);
}

Deno.test("the public surface is exactly the documented one", () => {
  // A mount added above the middleware would appear here and fail by name.
  // If it is meant to be public, it belongs in PUBLIC_MOUNTS with a comment
  // saying what guards it instead of the token.
  assertEquals(above.sort(), [...PUBLIC_MOUNTS].sort());
  assert(below.length >= 20, `only ${below.length} guarded mounts found`);
});

Deno.test("every guarded mount refuses a tokenless request", async (t) => {
  for (const prefix of below) {
    await t.step(`${prefix} without a token is 401`, async () => {
      const res = await fetch(`${BASE}${prefix}`);
      const body = await res.json();
      assertEquals(res.status, 401);
      // The envelope contract, asserted here because raw fetch bypasses the
      // helpers that normally enforce it.
      assertEquals(Object.keys(body), ["error"]);
      assertEquals(typeof body.error, "string");
    });
  }
});

Deno.test("a wrong token is as refused as none", async () => {
  // One probe per HTTP method that writes, so the middleware is known to sit
  // in front of writes as well as reads.
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    const res = await fetch(`${BASE}/exercises`, {
      method,
      headers: { authorization: "Bearer not-the-token" },
    });
    assertEquals(res.status, 401, method);
    await res.body?.cancel();
  }
});

Deno.test("the tokenless surfaces answer without credentials", async () => {
  // Public means public: the probe and the webhook must not have quietly
  // slid behind the middleware either.
  const health = await fetch(`${BASE}/health`);
  assertEquals(health.status, 200);
  await health.body?.cancel();
  const head = await fetch(`${BASE}/withings/notify`, { method: "HEAD" });
  assertEquals(head.status, 200);
  await head.body?.cancel();
});
