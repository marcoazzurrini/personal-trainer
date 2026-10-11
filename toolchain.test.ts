import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import test from "node:test";

import formatConfig from "./oxfmt.config.ts";

// The repository's own tooling: the pinned Bun, local secrets, the commit
// hook, CI and the release. Each package tests its own code.
const root = import.meta.dirname;
const { join } = nodePath;
const read = (path: string) => readFile(join(root, path), "utf-8");
const manifest = JSON.parse(await read("package.json"));
const workflowText = await read(".github/workflows/ci.yml");
const hooksText = await read("lefthook.yml");

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}
interface Job {
  needs?: string[];
  if?: string;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  steps: Step[];
}
// SAFETY: this repository's own workflow; GitHub refuses to run one whose jobs
// are not a map of steps.
const workflow = Bun.YAML.parse(workflowText) as { jobs: Record<string, Job> };
// SAFETY: this repository's own hook file; Lefthook refuses one of any other shape.
const hooks = Bun.YAML.parse(hooksText) as {
  "pre-commit": { jobs: { name: string; run: string }[] };
};

// Every package that runs Bun scripts or tests keeps dotenv loading off.
const bunfigs = [
  "bunfig.toml",
  "apps/api/bunfig.toml",
  "apps/web/bunfig.toml",
  "packages/db/bunfig.toml",
];

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      LEFTHOOK_VERBOSE: "0",
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function successful(command: string, args: string[], cwd: string) {
  const result = run(command, args, cwd);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}

test("one pinned Bun runs locally and in every CI job, from the frozen lock", () => {
  const version = manifest.engines.bun;
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  assert.equal(manifest.packageManager, `bun@${version}`);
  assert.equal(process.versions.bun, version, "Run with the pinned Bun.");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const setup = job.steps.find((step) =>
      step.uses?.startsWith("oven-sh/setup-bun@")
    );
    assert.equal(setup?.with?.["bun-version"], version, name);
    assert.ok(
      job.steps.some((step) => step.run === "bun install --frozen-lockfile"),
      `${name} must install from the frozen lock.`
    );
  }
});

test(
  "scripts and tests in every package leave local .env files unread",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pt-toolchain-dotenv-"));
    try {
      for (const [index, file] of bunfigs.entries()) {
        const cwd = join(directory, String(index));
        await mkdir(cwd);
        await writeFile(join(cwd, "bunfig.toml"), await read(file));
        await writeFile(
          join(cwd, ".env"),
          "PT_TOOLCHAIN_DOTENV_FIXTURE=unexpected\n"
        );
        await writeFile(
          join(cwd, "package.json"),
          JSON.stringify({ private: true, scripts: { probe: "bun probe.ts" } })
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

test("local secret files stay out of Git and their templates stay in", () => {
  for (const [path, ignored] of [
    [".env", true],
    [".env.production", true],
    [".dev.vars", true],
    ["apps/api/.env", true],
    ["apps/web/.env", true],
    ["apps/api/.env.example", false],
    ["apps/web/.env.example", false],
  ] as const) {
    const result = spawnSync("git", ["check-ignore", "--no-index", path], {
      cwd: root,
      encoding: "utf-8",
    });
    assert.equal(result.status, ignored ? 0 : 1, path);
  }
});

test("formatting leaves the skill documents and Nitro's Wrangler file readable", () => {
  // Skill frontmatter is an executable contract, not formatter input.
  assert.ok(formatConfig.ignorePatterns?.includes("plugin/**"));
  const fixture = {
    routes: [{ pattern: "fixture.invalid", custom_domain: true }],
    vars: { FIXTURE: "local" },
  };
  const formatted = spawnSync(
    join(root, "node_modules/.bin/oxfmt"),
    ["--stdin-filepath", "apps/web/wrangler.jsonc"],
    {
      cwd: root,
      input: JSON.stringify(fixture, null, 2),
      encoding: "utf-8",
      timeout: 10_000,
    }
  );
  assert.equal(formatted.status, 0, formatted.stderr);
  // Nitro's reader accepts comments but rejects trailing commas.
  assert.deepEqual(JSON.parse(formatted.stdout), fixture);
});

test("prepare installs a real Git hook that blocks a failing check", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "trainer-hooks-"));
  try {
    successful("git", ["init", "--quiet"], cwd);
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        private: true,
        scripts: { prepare: manifest.scripts.prepare },
      })
    );
    await symlink(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
    const config = (exit: number) =>
      `pre-commit:\n  jobs:\n    - name: fixture\n      run: bun --no-env-file -e 'process.exit(${exit})'\n`;
    await writeFile(join(cwd, "lefthook.yml"), config(0));
    successful(process.execPath, ["--no-env-file", "run", "prepare"], cwd);
    assert.match(
      await readFile(join(cwd, ".git/hooks/pre-commit"), "utf-8"),
      /lefthook/u
    );
    await writeFile(join(cwd, "fixture.txt"), "Hook fixture.\n");
    successful("git", ["add", "--", "fixture.txt"], cwd);
    const passed = successful("git", ["hook", "run", "pre-commit"], cwd);
    assert.match(passed.stdout + passed.stderr, /fixture/u);
    await writeFile(join(cwd, "lefthook.yml"), config(1));
    const failed = run("git", ["hook", "run", "pre-commit"], cwd);
    assert.notEqual(failed.status, 0, "A failed check must block the commit.");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// The repository is public, so a pushed secret is published before CI runs.
// The commit hook is the gate that matters; this runs its real command.
test("the commit hook refuses a staged secret without printing it", async () => {
  const scan = hooks["pre-commit"].jobs.find((job) => job.name === "secrets");
  assert.ok(scan, "lefthook.yml must keep a secrets job.");
  const cwd = await mkdtemp(join(tmpdir(), "trainer-secrets-"));
  try {
    successful("git", ["init", "--quiet"], cwd);
    const token = `ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
    await writeFile(join(cwd, "leak.ts"), `const t = "${token}";\n`);
    successful("git", ["add", "--", "leak.ts"], cwd);
    const refused = run("sh", ["-c", scan.run], cwd);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.doesNotMatch(
      refused.stdout + refused.stderr,
      new RegExp(token, "u")
    );
    successful("git", ["rm", "--quiet", "--cached", "--", "leak.ts"], cwd);
    await writeFile(join(cwd, "clean.ts"), "export const ok = 1;\n");
    successful("git", ["add", "--", "clean.ts"], cwd);
    successful("sh", ["-c", scan.run], cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// A command that names a missing script fails only when CI or a commit runs it.
test("every bun run in CI and the commit hook names a script that exists", async () => {
  const calls = [
    ...`${workflowText}\n${hooksText}`.matchAll(
      /bun run (?:--cwd (?<cwd>\S+) )?(?<script>[\w:-]+)/gu
    ),
  ];
  assert.ok(
    calls.length > 10,
    "Expected the workflow and hooks to run scripts."
  );
  for (const call of calls) {
    const cwd = call.groups?.cwd ?? ".";
    const { scripts } = JSON.parse(await read(`${cwd}/package.json`));
    const script = call.groups?.script ?? "";
    // `bun run playwright` runs the installed binary, not a script.
    assert.ok(
      script in scripts || script === "playwright",
      `${call[0]} names no script in ${cwd}/package.json.`
    );
  }
});

// dependency-cruiser reports success when its parser reads nothing, so prove
// that it read every tracked source file.
test("the dependency rules read every source file in apps and packages", () => {
  const cruise = spawnSync(
    join(root, "node_modules/.bin/depcruise"),
    [
      "--config",
      ".dependency-cruiser.cjs",
      "--output-type",
      "json",
      "apps",
      "packages",
    ],
    {
      cwd: root,
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 256 * 1024 * 1024,
    }
  );
  assert.equal(cruise.status, 0, cruise.stderr);
  const cruised = new Set(
    JSON.parse(cruise.stdout).modules.map(
      (module: { source: string }) => module.source
    )
  );
  const tracked = spawnSync("git", ["ls-files", "apps", "packages"], {
    cwd: root,
    encoding: "utf-8",
  })
    .stdout.split("\n")
    .filter((file) => /\.tsx?$/u.test(file) && !file.endsWith(".d.ts"));
  assert.ok(tracked.length > 200, "git ls-files found no sources.");
  assert.deepEqual(
    tracked.filter((file) => !cruised.has(file)),
    []
  );
});

// A release changes production in an order that a rollback cannot undo:
// migrations first, then the API, then the dashboard. Each later step waits
// for proof that the earlier one is live.
test("production changes only after every check, once, in a safe order", () => {
  const { deploy } = workflow.jobs;
  assert.deepEqual(deploy.needs?.toSorted(), ["checks", "d1", "test", "web"]);
  assert.match(deploy.if ?? "", /github\.ref == 'refs\/heads\/main'/u);
  assert.match(deploy.if ?? "", /github\.event_name != 'pull_request'/u);
  assert.equal(deploy.concurrency?.["cancel-in-progress"], false);
  const position = (pattern: RegExp) => {
    const index = deploy.steps.findIndex((step) =>
      pattern.test(`${step.name ?? ""}\n${step.run ?? ""}`)
    );
    assert.notEqual(index, -1, `The release has no step matching ${pattern}.`);
    return index;
  };
  const order = [
    position(/run --cwd apps\/web build/u),
    position(/db:migrate:remote/u),
    position(/--cwd apps\/api deploy .*__BUILD_REVISION__/u),
    position(/Wait for the API/u),
    position(/run --cwd apps\/web deploy/u),
    position(/Wait for the dashboard/u),
  ];
  assert.deepEqual(
    order,
    order.toSorted((a, b) => a - b)
  );
  const waits = deploy.steps.filter((step) =>
    step.name?.startsWith("Wait for")
  );
  assert.equal(waits.length, 2);
  for (const step of waits) {
    assert.match(step.run ?? "", /\.revision == \$sha/u);
    assert.match(step.run ?? "", /exit 1/u);
  }
});
