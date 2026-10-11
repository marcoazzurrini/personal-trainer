import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { assert, assertEquals, assertThrows } from "./assertions.ts";

function assertBunVersions(version: string, workflow: string): void {
  assert(/^\d+\.\d+\.\d+$/u.test(version), "Pin an exact Bun tool version.");
  const jobs = [...workflow.matchAll(/uses: oven-sh\/setup-bun@/gu)];
  const versions = [...workflow.matchAll(/bun-version:\s*(?<version>\S+)/gu)];
  assertEquals(
    jobs.length,
    5,
    "Every CI job uses the same Bun workspace lock."
  );
  assertEquals(
    versions.map((match) => match[1]),
    jobs.map(() => version)
  );
}

const manifest = JSON.parse(await readFile("package.json", "utf-8"));
const workflow = await readFile(".github/workflows/ci.yml", "utf-8");

test("CI pins Bun independently of the Cloudflare production runtime", () => {
  assertBunVersions(manifest.engines.bun, workflow);
  assertEquals(manifest.packageManager, `bun@${manifest.engines.bun}`);
  assertEquals(Bun.version, manifest.engines.bun);
  assertEquals(manifest.engines.deno);
  assert(!workflow.includes("setup-deno"));
  assert(!workflow.includes("npm ci"));
  assertEquals(
    [...workflow.matchAll(/bun install --frozen-lockfile/gu)].length,
    5
  );
});

test("formatting excludes generated files and preserves the skill contract", async () => {
  const config = await readFile("oxfmt.config.ts", "utf-8");
  for (const ignored of [
    ".delta/**",
    "**/node_modules/**",
    "apps/web/src/routeTree.gen.ts",
    "plugin/**",
  ]) {
    assert(
      config.includes(JSON.stringify(ignored)),
      `Formatting must exclude ${ignored}.`
    );
  }
  const lint = await readFile("oxlint.config.ts", "utf-8");
  assert(lint.includes('"ultracite/oxlint/anti-slop"'));
  assert(lint.includes("antiSlop"));
});

test("one Bun lock covers every workspace and installs the pinned tools", async () => {
  assertEquals(manifest.workspaces, ["apps/*", "packages/*"]);
  assert((await readFile("bun.lock", "utf-8")).includes('"lockfileVersion"'));
  const api = JSON.parse(await readFile("apps/api/package.json", "utf-8"));
  for (const [name, pinned] of [
    ["ajv", api.devDependencies.ajv],
    ["fast-check", api.devDependencies["fast-check"]],
    ["ultracite", manifest.devDependencies.ultracite],
    ["oxlint", manifest.devDependencies.oxlint],
    ["oxfmt", manifest.devDependencies.oxfmt],
  ]) {
    const installed = JSON.parse(
      await readFile(`node_modules/${name}/package.json`, "utf-8")
    );
    assertEquals(
      installed.version,
      pinned,
      `${name} must match the pinned workspace dependency.`
    );
  }
});

test("a floating, missing or mismatched Bun tool pin fails", () => {
  for (const version of ["1", "1.x", "^1.4.2", "", "0.0.0"]) {
    assertThrows(() => assertBunVersions(version, workflow));
  }
  for (const match of workflow.matchAll(/bun-version:\s*\S+/gu)) {
    for (const replacement of ["bun-version: 0.0.0", ""]) {
      const changed =
        workflow.slice(0, match.index) +
        replacement +
        workflow.slice(match.index + match[0].length);
      assertThrows(() => assertBunVersions(manifest.engines.bun, changed));
    }
  }
});
