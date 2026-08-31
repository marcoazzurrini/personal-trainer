import { assert, assertEquals } from "@std/assert";

// The document is generated, which makes it trustworthy only as far as the
// generator sees. Two ways it can lie, and one test for each.
//
// It can describe a route that does not exist — a path renamed in code while
// createRoute kept the old string. And it can miss a route that does exist:
// a handler registered with .get() instead of .openapi() serves traffic and
// appears nowhere, which is the worse failure, because nothing looks wrong.

const BASE = Deno.env.get("API_URL") ??
  "http://127.0.0.1:54321/functions/v1/api";
const TOKEN = Deno.env.get("API_TOKEN") ?? "local-dev-token";
const API_DIR = "supabase/functions/api";

// deno-lint-ignore no-explicit-any
const spec: any = await (await fetch(`${BASE}/openapi.json`)).json();

Deno.test("the document describes the surface it claims to", () => {
  const ops = Object.values(spec.paths).reduce<number>(
    (n, methods) => n + Object.keys(methods as object).length,
    0,
  );
  assert(ops > 60, `only ${ops} operations described`);
  // Every path is mounted under the function's own name, which is what makes
  // the relative server URL resolve.
  for (const path of Object.keys(spec.paths)) {
    assert(path.startsWith("/api/"), `${path} is not under /api`);
  }
});

Deno.test("every described GET actually routes", async (t) => {
  // Only the parameterless ones: a path with {id} would need a real row, and
  // a POST would write. This is enough to catch a renamed path — the failure
  // it exists for — without the suite inventing data to prove it.
  const paths = Object.entries(spec.paths)
    .filter(([p, methods]) =>
      !p.includes("{") && Object.hasOwn(methods as object, "get")
    )
    .map(([p]) => p.replace(/^\/api/, ""));

  assert(paths.length >= 10, `only ${paths.length} parameterless GETs`);

  for (const path of paths) {
    await t.step(`GET ${path}`, async () => {
      const res = await fetch(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      await res.body?.cancel();
      assert(
        res.status !== 404,
        `the document describes GET ${path}, which the router does not serve`,
      );
    });
  }
});

async function routeFiles(): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(`${API_DIR}/routes`)) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      found.push(`${API_DIR}/routes/${entry.name}`);
    }
  }
  return found.sort();
}

Deno.test("no route hides from the document", async () => {
  // A router built with OpenAPIHono still accepts .get() and friends, and a
  // route registered that way serves traffic while appearing nowhere in the
  // document. That is the silent failure this file exists for, so it is
  // caught by reading the source rather than by hoping someone notices.
  //
  // The exceptions are named, each with the reason it cannot be declared.
  const allowed = new Map([
    [
      "docs.get",
      "the wildcard: /{name} compiles to /:name and stops at a slash, so " +
      "method/… would 404. Described with registerPath instead.",
    ],
  ]);

  const offenders: string[] = [];
  for (const file of await routeFiles()) {
    const src = await Deno.readTextFile(file);
    // The routers that promised to describe themselves.
    const declared = new Set(
      [...src.matchAll(/(?:const|export const)\s+(\w+)\s*=\s*new OpenAPIHono/g)]
        .map((m) => m[1]),
    );
    for (
      const m of src.matchAll(/^\s*(\w+)\.(get|post|patch|put|delete)\(/gm)
    ) {
      const [, router, method] = m;
      if (!declared.has(router)) continue; // a plain Hono router: not its job
      if (allowed.has(`${router}.${method}`)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`${file}:${line} ${router}.${method}()`);
    }
  }

  assertEquals(
    offenders,
    [],
    `registered with a plain method on an OpenAPIHono router, so it serves ` +
      `traffic but is absent from /openapi.json:\n  ${
        offenders.join("\n  ")
      }\nUse .openapi(createRoute({…})), or add it to the allowlist above ` +
      `with the reason it cannot be declared.`,
  );
});
