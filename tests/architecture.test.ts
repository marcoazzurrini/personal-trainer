import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { dependencies, queryViolations } from "./source.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
async function sources(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(directoryPath: string): Promise<void> {
    for (const entry of await readdir(path.resolve(root, directoryPath), {
      withFileTypes: true,
    })) {
      if (
        ["tests", "node_modules", ".output", ".wrangler"].includes(entry.name)
      ) {
        continue;
      }
      const name = `${directoryPath}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(name);
      } else if (/\.tsx?$/u.test(name)) {
        result.set(name, await readFile(path.resolve(root, name), "utf-8"));
      }
    }
  }
  await walk(directory);
  return result;
}

// Package specifiers resolve to their source, so one rule set covers both
// relative imports and @trainer/db imports.
function targetPath(file: string, target: string): string {
  if (target.startsWith("@trainer/db/testing/")) {
    return `packages/db/testing/${target.slice("@trainer/db/testing/".length)}`;
  }
  if (target.startsWith("@trainer/db/")) {
    return `packages/db/src/${target.slice("@trainer/db/".length)}`;
  }
  return target.startsWith(".")
    ? path.posix.normalize(`${path.dirname(file)}/${target}`)
    : target;
}

const API = "apps/api/src/";
const DATABASE = "packages/db/";

function violations(files: Map<string, string>): string[] {
  const errors: string[] = [];
  for (const [file, source] of files) {
    for (const dependency of dependencies(source)) {
      const target = targetPath(file, dependency.target);
      const description = `${file} imports ${target}`;
      if (
        file.startsWith(DATABASE) &&
        /^(?:apps\/|plugin\/|@trainer\/(?:api|web)(?:\/|$)|hono(?:\/|$)|@hono\/)/u.test(
          target
        )
      ) {
        errors.push(description);
      }
      if (
        file.startsWith("apps/web/") &&
        /^(?:packages\/db\/|drizzle-orm(?:\/|$))/u.test(target)
      ) {
        errors.push(description);
      }
      if (
        !file.startsWith(API) ||
        dependency.typeOnly ||
        file === `${API}services.ts`
      ) {
        continue;
      }
      const pureBoundary =
        (target === `${DATABASE}src/storage.ts` &&
          file === `${API}shared/values.ts`) ||
        target === `${DATABASE}src/errors.ts`;
      if (
        !pureBoundary &&
        /^(?:packages\/db\/|drizzle-orm(?:\/|$))/u.test(target)
      ) {
        errors.push(description);
      }
      if (target === `${API}services.ts`) {
        const composition = [`${API}index.ts`, `${API}worker.ts`];
        if (!composition.includes(file)) {
          errors.push(description);
        }
      }
    }
  }
  return errors;
}

test("persistence belongs to the database package, never HTTP or dashboard modules", async () => {
  const files = new Map([
    ...(await sources("apps/api/src")),
    ...(await sources("packages/db")),
    ...(await sources("apps/web/src")),
  ]);
  assert.equal(violations(files).join("\n"), "");
  assert.ok(files.has("packages/db/src/client.ts"));
  assert.ok(files.has("apps/api/src/services.ts"));
});

test("boundary checker sees re-exports, dynamic imports and erased contracts", () => {
  const files = new Map([
    [
      "apps/api/src/training/leak.ts",
      'export { createClient } from "@trainer/db/client.ts";',
    ],
    [
      "apps/api/src/nutrition/leak.ts",
      'const db = await import("../../../../packages/db/src/client.ts");',
    ],
    [
      "packages/db/src/repositories/leak.ts",
      'import type { ApiError } from "../../../../apps/api/src/shared/errors.ts";',
    ],
    [
      "apps/api/src/body/contract.ts",
      'import type { BodyweightRepository } from "@trainer/db/repositories/bodyweight.ts";',
    ],
    [
      "apps/api/src/body/bridge.ts",
      'import { type Client, createClient } from "@trainer/db/client.ts";',
    ],
    [
      "apps/api/src/body/indirect.ts",
      'import { createServices } from "../services.ts";',
    ],
  ]);
  assert.equal(violations(files).length, 5);
});

test("API modules do not construct SQL or reach raw D1 methods", async () => {
  const offenders: string[] = [];
  for (const [file, source] of await sources("apps/api/src")) {
    offenders.push(...queryViolations(file, source));
  }
  assert.equal(offenders.join("\n"), "");
});

test("the client uses an invocation binding, not environment lookup or a global handle", async () => {
  const client = await readFile(
    path.resolve(root, "packages/db/src/client.ts"),
    "utf-8"
  );
  assert.match(client, /export function createClient\(binding: D1Database\)/u);
  assert.doesNotMatch(
    client,
    /process\.env|Deno\.env|from ["']cloudflare:workers|connect\(/u
  );
});
