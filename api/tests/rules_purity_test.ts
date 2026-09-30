import { readdir, readFile, stat } from "node:fs/promises";
import { test } from "node:test";

import { dependencies } from "../../db/tests/source.ts";
import { assert, assertEquals } from "./assertions.ts";

// ADR-0017 moves persistence into db/. Arithmetic may use pure value conversion
// and failure contracts, but must never acquire a query builder or repository.
const PURE = [
  "api/body/trend.ts",
  "api/nutrition/expenditure.ts",
  "api/nutrition/rules.ts",
  "api/shared/dates.ts",
  "api/training/rules.ts",
  "api/training/set_correction.ts",
];

function databaseCapability(file: string): boolean {
  return /^(?:db\/(?:client\.ts|native\.ts|schema\/|repositories\/)|drizzle-orm(?:$|\/(?!errors$)))/u.test(
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
  return specifier.startsWith(".")
    ? new URL(specifier, `file:///${file}`).pathname.slice(1)
    : specifier;
}

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "tests") {
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
    if (!specifier.startsWith(".") || seen.has(next)) {
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
    ...(await filesUnder("api")),
    ...(await filesUnder("db")),
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
  const routes = (await filesUnder("api")).filter((file) =>
    file.endsWith(".routes.ts")
  );
  assert(routes.length > 0, "No *.routes.ts found under api.");
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
    import type { Client } from "../db/client.ts";
    import { type Client as Database } from "../db/client.ts";
    import { type Services, createServices } from "./services.ts";
    export { createClient } from "../db/client.ts";
    await import("../db/native.ts");
  `);
  assertEquals(
    imports.map((item) => item.specifier),
    ["./services.ts", "../db/client.ts", "../db/native.ts"]
  );
  assert(databaseCapability("db/repositories/bodyweight.ts"));
  assert(databaseCapability("drizzle-orm/d1"));
  assert(!databaseCapability("db/storage.ts"));
  assert(!databaseCapability("db/errors.ts"));
});
