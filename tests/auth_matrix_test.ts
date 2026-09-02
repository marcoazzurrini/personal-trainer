import { assert, assertEquals } from "@std/assert";

// Auth as a property of the whole surface, not of the routes someone
// remembered to test.
//
// This file used to read index.ts as text: find `app.use(`, split the
// `app.route` calls on either side of it, and call everything before the
// middleware public. That inferred a security property from the order of a
// source file, and it failed in the quiet direction — a middleware registered
// any other way, or renamed, and every mount reclassifies as public with this
// file still green. It also asserted a floor on how many guarded mounts
// existed, which is a proxy for coverage rather than coverage, and one that
// goes stale the moment mounts consolidate behind topic modules (#31).
//
// It asks the running function now. /openapi.json is generated from the routes
// that actually serve, so it *is* the guarded surface: every operation in it
// must answer 401 without a bearer token, before any handler runs. The public
// surface is the short list below, probed to confirm it still opens.
//
// Those two sets have to be everything, and the claim that they are is the
// part worth defending — a route the document cannot describe is exactly where
// a public one would hide. So the two ways out of the document are scanned for
// and held against named lists at the bottom of this file.
//
// auth_test.ts checks the token itself (rotation, malformed JSON); this is the
// matrix that catches a new route landing on the wrong side of the line.

const BASE = Deno.env.get("API_URL") ??
  "http://127.0.0.1:54321/functions/v1/api";
const TOKEN = Deno.env.get("API_TOKEN") ?? "local-dev-token";
const API_DIR = "supabase/functions/api";

// deno-lint-ignore no-explicit-any
const spec: any = await (await fetch(`${BASE}/openapi.json`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
})).json();

// Tokenless by design, each with the story that stands in for the token.
// /health is the uptime probe, and the reference pair publishes the shape of
// the surface and never its contents — public because a browser cannot put a
// bearer token on a page load, so a documentation page behind the middleware
// is one nobody can open. The Withings pair is called by Withings, which has
// no way to send our token, and a notification that 401s vanishes without a
// trace; what guards it is that nothing in the body is believed. The
// sign-in pair belongs to the plugin's connector: the consent page is where
// Marco arrives with no token yet, and the discovery document is what a
// client reads before it has one — it says where to sign in and nothing
// else, the way /openapi.json says the shape and never the data.
const PUBLIC: Array<{ method: string; path: string }> = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/openapi.json" },
  { method: "GET", path: "/reference" },
  { method: "GET", path: "/consent" },
  { method: "GET", path: "/mcp/oauth-protected-resource" },
  { method: "GET", path: "/withings/callback" },
  { method: "HEAD", path: "/withings/notify" },
];

// Routers mounted above the middleware, whose public routes are listed above
// and whose other routes answer for themselves.
const MOUNTED_PUBLIC_PREFIXES = ["/withings", "/mcp"];

// A tokenless request is refused before any handler runs, so a placeholder is
// enough to reach the middleware and nothing downstream ever sees it.
function probeable(path: string): string {
  return path.replace(/^\/api/, "").replace(/\{[^}]+\}/g, "x");
}

Deno.test("every documented operation refuses a tokenless request", async (t) => {
  const paths = Object.entries(spec.paths) as Array<[string, object]>;
  assert(paths.length > 0, "the document describes no paths to check");

  for (const [path, methods] of paths) {
    await t.step(path, async () => {
      for (const method of Object.keys(methods)) {
        const res = await fetch(`${BASE}${probeable(path)}`, {
          method: method.toUpperCase(),
        });
        const body = await res.json();
        assertEquals(res.status, 401, `${method.toUpperCase()} ${path}`);
        // The envelope contract, asserted here because raw fetch bypasses the
        // helpers that normally enforce it.
        assertEquals(Object.keys(body), ["error"]);
        assertEquals(typeof body.error, "string");
      }
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

Deno.test("the tokenless surfaces answer without credentials", async (t) => {
  // Public means public: none of these may have quietly slid behind the
  // middleware either.
  for (const { method, path } of PUBLIC) {
    await t.step(`${method} ${path}`, async () => {
      const res = await fetch(`${BASE}${path}`, { method });
      assertEquals(res.status, 200);
      await res.body?.cancel();
    });
  }

  await t.step("the document describes the routes mounted after it", () => {
    assertEquals(spec.openapi, "3.0.0");
    // Registered above the middleware but built per request, which is the
    // whole point of it existing there.
    assert(
      Object.keys(spec.paths).length > 0,
      "the document describes no paths: app.doc() stopped seeing later mounts",
    );
  });

  await t.step("the reference page opens", async () => {
    const page = await fetch(`${BASE}/reference`);
    assert((await page.text()).includes("createApiReference"));
  });
});

// --- What the document cannot see ------------------------------------------

// The check above is only as complete as the claim that /openapi.json plus the
// PUBLIC list is the whole surface. Two things escape the document, and both
// are scanned for rather than trusted.

async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) found.push(...await filesUnder(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found.sort();
}

Deno.test("no plain router serves traffic unseen", async () => {
  // A route on a plain Hono router never reaches /openapi.json — openapi_test
  // exempts them for that reason, since they cannot be declared. That makes
  // them the one place a public route is invisible to both files, so each is
  // named here with what answers for it instead of the token.
  const allowed = new Map([
    [
      `${API_DIR}/body/withings.routes.ts`,
      "the two routes Withings itself calls, public because Withings cannot " +
      "send our token. Guarded by believing nothing in the body: the payload " +
      "carries no weight, and one naming the wrong account is dropped.",
    ],
    [
      `${API_DIR}/access/mcp.routes.ts`,
      "the plugin's connector, guarded by a Supabase sign-in token checked " +
      "on every call rather than by the coach token. A tokenless call is " +
      "answered 401 with where to sign in; its one credential-free route is " +
      "the discovery document, which says that and nothing else.",
    ],
  ]);

  const found: string[] = [];
  for (const file of await filesUnder(API_DIR)) {
    if ((await Deno.readTextFile(file)).includes("new Hono(")) {
      if (!allowed.has(file)) found.push(file);
    }
  }

  assertEquals(
    found,
    [],
    `a plain Hono router holds routes that /openapi.json cannot describe and ` +
      `this file cannot probe:\n  ${found.join("\n  ")}\nUse OpenAPIHono, or ` +
      `add it above with what guards it and whether its routes are public.`,
  );
});

Deno.test("nothing is registered on the app but the public four", async () => {
  // The composition root is the other way out: a route registered directly on
  // `app` rather than mounted, above the middleware and therefore public
  // forever. These four are, deliberately. A fifth has to be argued for
  // here before it can serve.
  const source = await Deno.readTextFile(`${API_DIR}/index.ts`);
  const registered = [
    ...source.matchAll(/app\.(?:get|post|patch|put|delete|doc)\("([^"]+)"/g),
  ].map((m) => m[1]);

  assertEquals(
    registered.sort(),
    PUBLIC.filter((p) =>
      !MOUNTED_PUBLIC_PREFIXES.some((prefix) => p.path.startsWith(prefix))
    ).map((p) => p.path).sort(),
  );
});

Deno.test("the connector refuses a tokenless call and says where to sign in", async () => {
  // The third kind of route, named so it is not mistaken for either of the
  // other two: neither behind the coach token nor public, but guarded by a
  // credential of its own. What a tokenless caller gets is the pointer to
  // the discovery document, which is the public route listed above.
  const res = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
  assertEquals(res.status, 401);
  const challenge = res.headers.get("www-authenticate") ?? "";
  assert(
    challenge.startsWith("Bearer resource_metadata="),
    `no pointer to sign in: ${challenge}`,
  );
  assertEquals(Object.keys(await res.json()), ["error"]);
});
