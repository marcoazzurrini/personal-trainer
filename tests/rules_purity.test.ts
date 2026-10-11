import { readdir, readFile, stat } from "node:fs/promises";
import { test } from "node:test";

import { assert, assertEquals } from "../apps/api/tests/assertions.ts";
import { dependencies } from "./source.ts";

// Persistence lives in packages/db. Arithmetic may use pure value conversion and failure
// contracts, but must never acquire a query builder or repository.
//
// Throwing ApiError is allowed on purpose. The API's client is a model, and the
// refusal sentence is what tells it how a correct call looks. The code that
// knows why a value is refused writes that sentence; a stricter "no HTTP" rule
// would split one message across two modules and leave a single pure file.
const PURE = [
  "apps/api/src/body/trend.ts",
  "apps/api/src/nutrition/expenditure.ts",
  "apps/api/src/nutrition/rules.ts",
  "apps/api/src/shared/dates.ts",
  "apps/api/src/training/rules.ts",
  "apps/api/src/training/set_correction.ts",
];

function databaseCapability(file: string): boolean {
  return /^(?:packages\/db\/src\/(?:client\.ts|native\.ts|schema\/|repositories\/)|drizzle-orm(?:$|\/(?!errors$)))/u.test(
    file
  );
}

// Type-only imports describe the operations a service receives. They do not
// grant access to the database at runtime and must not create false graph edges.
function runtimeImports(source: string): { specifier: string; line: number }[] {
  return dependencies(source)
    .filter((item) => !item.typeOnly)
    .map((item) => ({ specifier: item.target, line: item.line }));
}

function target(file: string, specifier: string): string {
  if (specifier.startsWith("@trainer/db/")) {
    return `packages/db/src/${specifier.slice("@trainer/db/".length)}`;
  }
  return specifier.startsWith(".")
    ? new URL(specifier, `file:///${file}`).pathname.slice(1)
    : specifier;
}

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "tests" || entry.name === "node_modules") {
      continue;
    }
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await filesUnder(path)));
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found.toSorted();
}

async function chainToDatabase(
  file: string,
  seen: Set<string>,
  taken: string[]
): Promise<string[] | null> {
  const source = await readFile(file, "utf-8");
  for (const { specifier, line } of runtimeImports(source)) {
    const next = target(file, specifier);
    const hops = [...taken, `${file}:${line}`];
    if (databaseCapability(next)) {
      return [...hops, next];
    }
    const local =
      specifier.startsWith(".") || specifier.startsWith("@trainer/db/");
    if (!local || seen.has(next)) {
      continue;
    }
    seen.add(next);
    const found = await chainToDatabase(next, seen, hops);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

test("application runtime has no PostgreSQL driver or Deno process globals", async () => {
  const offenders: string[] = [];
  for (const file of [
    ...(await filesUnder("apps/api/src")),
    ...(await filesUnder("packages/db")),
  ]) {
    const source = await readFile(file, "utf-8");
    if (
      /\bDeno\./u.test(source) ||
      /(?:from\s*|import\s*\(?\s*)["'][^"']*(?:postgres|\/db\.ts)["']/u.test(
        source
      )
    ) {
      offenders.push(file);
    }
  }
  assertEquals(
    offenders,
    [],
    "Workers use invocation bindings, not PostgreSQL or Deno process state."
  );
});

test("nothing pure reaches the database", async () => {
  const offenders: string[] = [];
  for (const file of PURE) {
    assert(
      (await stat(file)).isFile(),
      `${file} is listed as pure and must exist.`
    );
    const chain = await chainToDatabase(file, new Set([file]), []);
    if (chain !== null) {
      offenders.push(chain.join("\n      -> "));
    }
  }
  assertEquals(
    offenders,
    [],
    `Pure modules may refuse but cannot query. Pass values from a service instead:\n${offenders.join("\n")}`
  );
});

test("no file declaring HTTP routes imports the database", async () => {
  const routes = (await filesUnder("apps/api/src")).filter((file) =>
    file.endsWith(".routes.ts")
  );
  assert(routes.length > 0, "No *.routes.ts found under apps/api/src.");
  const offenders: string[] = [];
  for (const file of routes) {
    const source = await readFile(file, "utf-8");
    for (const { specifier, line } of runtimeImports(source)) {
      if (databaseCapability(target(file, specifier))) {
        offenders.push(`${file}:${line}`);
      }
    }
    for (const [line, text] of source.split("\n").entries()) {
      if (
        !text.trimStart().startsWith("//") &&
        /\.DB\b|\.prepare\s*\(|\.batch\s*\(/u.test(text)
      ) {
        offenders.push(`${file}:${line + 1}`);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "Routes call application services; repositories own queries."
  );
});

test("purity imports preserve runtime edges and ignore erased contracts", () => {
  const imports = runtimeImports(`
    import type { Client } from "@trainer/db/client.ts";
    import { type Client as Database } from "@trainer/db/client.ts";
    import { type Services, createServices } from "./services.ts";
    export { createClient } from "@trainer/db/client.ts";
    await import("@trainer/db/native.ts");
  `);
  assertEquals(
    imports.map((item) => item.specifier),
    ["./services.ts", "@trainer/db/client.ts", "@trainer/db/native.ts"]
  );
  assert(databaseCapability("packages/db/src/repositories/bodyweight.ts"));
  assert(databaseCapability("drizzle-orm/d1"));
  assert(!databaseCapability("packages/db/src/storage.ts"));
  assert(!databaseCapability("packages/db/src/errors.ts"));
});
