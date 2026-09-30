import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { dependencies, queryViolations } from "./source.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
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

function targetPath(file: string, target: string): string {
  return target.startsWith(".")
    ? path.posix.normalize(`${path.dirname(file)}/${target}`)
    : target;
}

function violations(files: Map<string, string>): string[] {
  const errors: string[] = [];
  for (const [file, source] of files) {
    for (const dependency of dependencies(source)) {
      const target = targetPath(file, dependency.target);
      const description = `${file} imports ${target}`;
      if (
        file.startsWith("db/") &&
        /^(?:api\/|web\/|plugin\/|hono(?:\/|$)|@hono\/)/u.test(target)
      ) {
        errors.push(description);
      }
      if (
        file.startsWith("web/") &&
        /^(?:db\/|drizzle-orm(?:\/|$))/u.test(target)
      ) {
        errors.push(description);
      }
      if (
        !file.startsWith("api/") ||
        dependency.typeOnly ||
        file === "api/services.ts"
      ) {
        continue;
      }
      const pureBoundary =
        (target === "db/storage.ts" && file === "api/shared/values.ts") ||
        target === "db/errors.ts";
      if (!pureBoundary && /^(?:db\/|drizzle-orm(?:\/|$))/u.test(target)) {
        errors.push(description);
      }
      if (target === "api/services.ts") {
        const composition = ["api/index.ts", "api/worker.ts"];
        if (!composition.includes(file)) {
          errors.push(description);
        }
      }
    }
  }
  return errors;
}

test("persistence belongs to db, never HTTP or dashboard modules", async () => {
  const files = new Map([
    ...(await sources("api")),
    ...(await sources("db")),
    ...(await sources("web/src")),
  ]);
  assert.equal(violations(files).join("\n"), "");
  assert.ok(files.has("db/client.ts"));
  assert.ok(files.has("api/services.ts"));
});

test("boundary checker sees re-exports, dynamic imports and erased contracts", () => {
  const files = new Map([
    [
      "api/training/leak.ts",
      'export { createClient } from "../../db/client.ts";',
    ],
    ["api/nutrition/leak.ts", 'const db = await import("../../db/client.ts");'],
    [
      "db/repositories/leak.ts",
      'import type { ApiError } from "../../api/shared/errors.ts";',
    ],
    [
      "api/body/contract.ts",
      'import type { BodyweightRepository } from "../../db/repositories/bodyweight.ts";',
    ],
    [
      "api/body/bridge.ts",
      'import { type Client, createClient } from "../../db/client.ts";',
    ],
    [
      "api/body/indirect.ts",
      'import { createServices } from "../services.ts";',
    ],
  ]);
  assert.equal(violations(files).length, 5);
});

test("API modules do not construct SQL or reach raw D1 methods", async () => {
  const offenders: string[] = [];
  for (const [file, source] of await sources("api")) {
    offenders.push(...queryViolations(file, source));
  }
  assert.equal(offenders.join("\n"), "");
});

test("the client uses an invocation binding, not environment lookup or a global handle", async () => {
  const client = await readFile(path.resolve(root, "db/client.ts"), "utf-8");
  assert.match(client, /export function createClient\(binding: D1Database\)/u);
  assert.doesNotMatch(
    client,
    /process\.env|Deno\.env|from ["']cloudflare:workers|connect\(/u
  );
});
