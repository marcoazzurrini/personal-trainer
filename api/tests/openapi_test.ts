import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  assertMatchesDocument,
  BASE,
  ensureCatalogue,
  resetNutrition,
  resetTraining,
  seedPlan,
  TOKEN,
} from "./helpers.ts";

// The document is generated, which makes it trustworthy only as far as the
// generator sees. Two ways it can lie, and one test for each.
//
// It can describe a route that does not exist — a path renamed in code while
// createRoute kept the old string. And it can miss a route that does exist:
// a handler registered with .get() instead of .openapi() serves traffic and
// appears nowhere, which is the worse failure, because nothing looks wrong.

const API_DIR = "api";

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

Deno.test("contract checks reject undocumented successes and malformed responses", () => {
  assertThrows(
    () => assertMatchesDocument("GET", "/not-declared", 200, {}),
    Error,
    "no declared route",
  );
  assertThrows(
    () => assertMatchesDocument("GET", "/foods", 200, {}),
    Error,
    "schema and the SQL have drifted",
  );
  assertThrows(
    () => assertMatchesDocument("GET", "/foods", 299, []),
    Error,
    "does not declare",
  );
  assertMatchesDocument("GET", "/foods", 200, { foods: [] });
});

Deno.test("calendar constraints remain visible in generated requests", () => {
  const pattern = String.raw`^\d{4}-\d{2}-\d{2}$`;
  const fields =
    spec.paths["/api/blocks"].post.requestBody.content["application/json"]
      .schema.properties;
  assertEquals(fields.started_on.pattern, pattern);
  assert(
    (fields.ended_on.anyOf ?? [fields.ended_on]).some((
      node: { pattern?: string },
    ) => node.pattern === pattern),
  );
  const day = spec.paths["/api/intake"].get.parameters.find((
    p: { name: string; in: string },
  ) => p.name === "day" && p.in === "query");
  assert(day, "GET /intake must declare its day query");
  assertEquals(day.schema.pattern, pattern);
});

Deno.test("every declared success describes its JSON body", () => {
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (
      const [method, operation] of Object.entries(
        methods as Record<
          string,
          {
            responses: Record<
              string,
              { content?: Record<string, { schema?: unknown }> }
            >;
          }
        >,
      )
    ) {
      const successes = Object.entries(operation.responses).filter(([status]) =>
        /^2\d\d$/.test(status)
      );
      assert(successes.length > 0, `${method} ${path} declares no success`);
      for (const [status, response] of successes) {
        assert(
          response.content?.["application/json"]?.schema,
          `${method} ${path} ${status} has no JSON schema`,
        );
      }
    }
  }
});

Deno.test("every described GET actually routes", async (t) => {
  // Own the fixture: plan-scoped reads must not depend on a preceding test
  // leaving an active plan behind. Parameterized routes have domain tests.
  await resetTraining();
  await resetNutrition();
  await ensureCatalogue();
  await seedPlan({ exercises: [{ exercise: "squat" }] });
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
      // The disposable server deliberately has no GitHub credentials. Prove
      // that exact configuration refusal, not an arbitrary server failure.
      if (path === "/issues") {
        const body = await res.json();
        assertEquals(res.status, 500, `GET ${path}`);
        assertStringIncludes(body.error, "GITHUB_TOKEN and GITHUB_REPO");
      } else {
        await res.body?.cancel();
        assertEquals(res.status, 200, `GET ${path}`);
      }
    });
  }
});

async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (path === `${API_DIR}/tests`) continue;
    if (entry.isDirectory) found.push(...await filesUnder(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

// The whole tree, not one directory. This scanned routes/ while that folder
// was being drained a topic at a time, which would have gone on passing while
// checking less and less of the surface with every move — green, silent, and
// covering nothing by the end. The failure it protects against is a route
// registered with .get() instead of .openapi(), which is invisible by
// construction, so a check that quietly stops looking is the same failure one
// level up.
//
// A non-empty guard would not have caught it either: it stays green with one
// file left. So the set is defined by what a route file *is* rather than by
// where it sits — the *.routes.ts convention ADR-0006 establishes — and that
// is why a topic added tomorrow is covered without anyone remembering to add
// it.
async function routeFiles(): Promise<string[]> {
  const files = await filesUnder(API_DIR);
  return files.filter((f) => f.endsWith(".routes.ts")).sort();
}

Deno.test("no route hides from the document", async () => {
  // A router built with OpenAPIHono still accepts .get() and friends, and a
  // route registered that way serves traffic while appearing nowhere in the
  // document. That is the silent failure this file exists for, so it is
  // caught by reading the source rather than by hoping someone notices.
  //
  // The exceptions are named, each with the reason it cannot be declared.
  // Empty today: the documents route was the one (a wildcard that
  // createRoute could not express), and the documents ship in the plugin
  // now. The map stays, so the next exception is argued for here.
  const allowed = new Map<string, string>();

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
