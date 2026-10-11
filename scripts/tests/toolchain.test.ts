import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import test from "node:test";

import antiSlop from "ultracite/oxlint/anti-slop";

import lintConfig from "../../oxlint.config.ts";

const { join } = nodePath;
const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf-8");
const manifest = JSON.parse(await read("package.json"));
const workflow = await read(".github/workflows/ci.yml");

test("operational scripts stay small and first-party tooling stays TypeScript", async () => {
  assert.deepEqual((await readdir(new URL("scripts/", root))).toSorted(), [
    "build-worker.ts",
    "deploy-worker.ts",
    "secrets.ts",
    "source-revision.ts",
    "tests",
  ]);
  assert.equal(existsSync(new URL("tests/", root)), false);
  const files = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf-8" }
  );
  assert.equal(files.status, 0, files.stderr);
  assert.deepEqual(
    files.stdout
      .split("\0")
      .filter(
        (path) =>
          /\.(?:mjs|mts)$/u.test(path) && existsSync(new URL(path, root))
      ),
    [],
    "First-party source must use .ts; generated output and dependencies are ignored."
  );
  assert.equal(
    manifest.scripts["test:tooling"],
    "bun --no-env-file test ./scripts/tests/ --timeout 60000"
  );
  for (const file of [
    "api/tests/run.ts",
    "api/tests/fixtures/catalogue.ts",
    "api/tests/fixtures/catalogue.json",
  ]) {
    await read(file);
  }
});

test("local tests and every CI job use the pinned Bun version and frozen workspace lock", async () => {
  const version = manifest.engines.bun;
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  assert.equal(manifest.packageManager, `bun@${version}`);
  assert.equal(
    process.versions.bun,
    version,
    "Run tooling tests with the pinned Bun version."
  );
  const ciVersions = [...workflow.matchAll(/bun-version:\s*(?<version>\S+)/gu)];
  assert.equal(ciVersions.length, 5);
  for (const match of ciVersions) {
    assert.equal(match.groups?.version, version);
  }
  assert.equal(workflow.match(/bun install --frozen-lockfile/gu)?.length, 5);
  assert.doesNotMatch(
    workflow,
    /denoland\/setup-deno|npm ci|npm install|npm run/u
  );
  assert.doesNotMatch(workflow, /bun --cwd \S+ run/u);
  assert.match(await read("bun.lock"), /"lockfileVersion":/u);
  assert.deepEqual(manifest.workspaces, ["web"]);
  for (const file of [
    "deno.json",
    "deno.lock",
    "package-lock.json",
    "web/package-lock.json",
    "db/package.json",
    "scripts/test.ts",
  ]) {
    await assert.rejects(read(file), { code: "ENOENT" });
  }
});

test("Bun replaces the client runner, not Vitest, Playwright or the Worker runtime", async () => {
  const web = JSON.parse(await read("web/package.json"));
  assert.equal(web.scripts.test, "vitest run");
  assert.equal(web.scripts["test:browser"], "playwright test");
  assert.match(
    manifest.scripts["test:api"],
    /^bun --no-env-file api\/tests\/run\.ts$/u
  );
  assert.equal(
    manifest.scripts["test:d1"],
    "WRANGLER_SEND_METRICS=false bun --no-env-file test ./db/tests/ --timeout 120000"
  );
  const runner = await read("api/tests/run.ts");
  assert.match(runner, /new Miniflare\(/u);
  assert.match(runner, /d1Persist: false/u);
  assert.match(runner, /outboundService\(/u);
  assert.match(runner, /--preload=\.\/api\/tests\/preload\.ts/u);
  for (const file of ["bunfig.toml", "web/bunfig.toml"]) {
    assert.match(await read(file), /^env = false$/mu);
  }
});

test(
  "workspace scripts and tests do not load local dotenv credentials",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pt-toolchain-dotenv-"));
    try {
      for (const [index, file] of [
        "bunfig.toml",
        "web/bunfig.toml",
      ].entries()) {
        const cwd = join(directory, String(index));
        await mkdir(cwd);
        await writeFile(join(cwd, "bunfig.toml"), await read(file));
        await writeFile(
          join(cwd, ".env"),
          "PT_TOOLCHAIN_DOTENV_FIXTURE=unexpected\n"
        );
        await writeFile(
          join(cwd, "package.json"),
          JSON.stringify({
            private: true,
            scripts: { probe: "bun probe.ts" },
          })
        );
        await writeFile(
          join(cwd, "probe.ts"),
          'console.log(process.env.PT_TOOLCHAIN_DOTENV_FIXTURE ?? "absent");\n'
        );
        await writeFile(
          join(cwd, "probe.test.ts"),
          'import { test, expect } from "bun:test"; test("dotenv stays disabled", () => expect(process.env.PT_TOOLCHAIN_DOTENV_FIXTURE).toBeUndefined());\n'
        );
        const options: SpawnSyncOptionsWithStringEncoding = {
          cwd: directory,
          env: { PATH: process.env.PATH, HOME: directory },
          encoding: "utf-8",
          timeout: 10_000,
        };
        const script = spawnSync(
          process.execPath,
          ["run", "--cwd", cwd, "probe"],
          options
        );
        assert.equal(script.status, 0, script.stderr);
        assert.equal(script.stdout.trim(), "absent", file);
        const tests = spawnSync(
          process.execPath,
          ["test", "--cwd", cwd, "./probe.test.ts"],
          options
        );
        assert.equal(tests.status, 0, tests.stderr);
        assert.match(tests.stderr, /1 pass/u);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("the API documents one local dotenv file without retired hosting settings", async () => {
  const template = await read(".env.example");
  const keys = new Set(
    [...template.matchAll(/^\s*(?:#\s*)?(?<key>[A-Z_]+)=/gmu)].map(
      (match) => match.groups?.key ?? ""
    )
  );
  for (const key of [
    "AUTH_ISSUER",
    "ALLOWED_SUBJECT",
    "WITHINGS_CLIENT_ID",
    "WITHINGS_CLIENT_SECRET",
    "GITHUB_TOKEN",
    "GITHUB_REPO",
  ]) {
    assert.ok(keys.has(key), key);
  }
  for (const key of keys) {
    assert.doesNotMatch(
      key,
      /^(?:DATABASE_URL|WITHINGS_USER_ID|SERVER_IP|COOLIFY_.*|SUPABASE_.*)$/u
    );
  }
  await assert.rejects(read(".dev.vars.example"), { code: "ENOENT" });
  for (const [path, expectedStatus] of [
    [".env", 0],
    [".env.production", 0],
    ["web/.env", 0],
    [".dev.vars", 0],
    [".env.example", 1],
    ["web/.env.example", 1],
  ] as const) {
    const result = spawnSync("git", ["check-ignore", "--no-index", path], {
      cwd: root,
      encoding: "utf-8",
    });
    assert.equal(result.status, expectedStatus, path);
  }
});

test(
  "Wrangler loads the local .env, not templates or retired hosting files",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pt-wrangler-dotenv-"));
    try {
      const configPath = join(directory, "wrangler.json");
      await writeFile(
        configPath,
        JSON.stringify({
          name: "dotenv-fixture",
          compatibility_date: "2026-08-03",
        })
      );
      await writeFile(
        join(directory, ".env"),
        "PT_LOCAL_ENV_FIXTURE=fixture-local\n"
      );
      await writeFile(
        join(directory, ".env.example"),
        "PT_TEMPLATE_FIXTURE=unexpected\n"
      );
      await writeFile(
        join(directory, ".env.hosting"),
        "PT_RETIRED_HOSTING_FIXTURE=unexpected\n"
      );
      const result = spawnSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `
      import assert from "node:assert/strict";
      import { getPlatformProxy } from "wrangler";
      const worker = await getPlatformProxy({
        configPath: process.argv[1],
        persist: false,
        remoteBindings: false,
      });
      try {
        assert.equal(worker.env.PT_LOCAL_ENV_FIXTURE, "fixture-local");
        assert.equal(worker.env.PT_TEMPLATE_FIXTURE, undefined);
        assert.equal(worker.env.PT_RETIRED_HOSTING_FIXTURE, undefined);
      } finally {
        await worker.dispose();
      }
    `,
          configPath,
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            WRANGLER_SEND_METRICS: "false",
          },
          encoding: "utf-8",
          timeout: 25_000,
        }
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("formatting preserves the JSON subset accepted by Nitro's Wrangler reader", () => {
  const fixture = {
    routes: [{ pattern: "fixture.invalid", custom_domain: true }],
    vars: { FIXTURE: "local" },
  };
  const formatted = spawnSync(
    new URL("node_modules/.bin/oxfmt", root).pathname,
    ["--stdin-filepath", "web/wrangler.jsonc"],
    {
      cwd: root,
      input: JSON.stringify(fixture, null, 2),
      encoding: "utf-8",
      timeout: 10_000,
    }
  );
  assert.equal(formatted.status, 0, formatted.stderr);
  assert.deepEqual(JSON.parse(formatted.stdout), fixture);
});

test("Oxfmt, Oxlint and bundled Ultracite anti-slop guard the same workspace", async () => {
  for (const name of ["oxfmt", "oxlint", "ultracite"]) {
    assert.match(manifest.devDependencies[name], /^\d+\.\d+\.\d+$/u);
  }
  assert.equal(manifest.scripts.fmt, "oxfmt");
  assert.equal(manifest.scripts.lint, "oxlint --deny-warnings");
  assert.equal(manifest.scripts["check:style"], "ultracite check");
  assert.ok(lintConfig.extends?.includes(antiSlop));
  assert.match(workflow, /bun run check:style/u);
  const hooks = await read("lefthook.yml");
  assert.match(hooks, /bun run fmt \{staged_files\}/u);
  assert.match(hooks, /bun run lint \{staged_files\}/u);
  assert.match(hooks, /bun run --cwd web check/u);
  assert.doesNotMatch(hooks, /deno|rc: \.lefthookrc/u);
});
