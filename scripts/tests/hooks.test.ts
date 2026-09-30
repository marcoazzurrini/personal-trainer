import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(
  await readFile(nodePath.join(root, "package.json"), "utf-8")
);

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
      // Hooks use only the project's installed package, not an inherited override.
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

test("Bun owns the pinned Lefthook installation without custom launchers", async () => {
  assert.match(manifest.devDependencies.lefthook ?? "", /^\d+\.\d+\.\d+$/u);
  assert.equal(manifest.scripts.prepare, "lefthook install");
  const installed = JSON.parse(
    await readFile(
      nodePath.join(root, "node_modules/lefthook/package.json"),
      "utf-8"
    )
  );
  assert.equal(installed.version, manifest.devDependencies.lefthook);
  assert.match(
    await readFile(nodePath.join(root, "bun.lock"), "utf-8"),
    /"lefthook":/u
  );
  const config = await readFile(nodePath.join(root, "lefthook.yml"), "utf-8");
  assert.doesNotMatch(config, /^rc:/mu);
  for (const obsolete of [".lefthookrc", "scripts/lefthook"]) {
    await assert.rejects(readFile(nodePath.join(root, obsolete)), {
      code: "ENOENT",
    });
  }
  assert.equal(manifest.engines.deno, undefined);
});

test("prepare installs a real Git hook that blocks a failing check", async () => {
  const cwd = await mkdtemp(nodePath.join(tmpdir(), "trainer-hooks-"));
  try {
    successful("git", ["init", "--quiet"], cwd);
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({
        private: true,
        scripts: { prepare: manifest.scripts.prepare },
      })
    );
    await symlink(
      nodePath.join(root, "node_modules"),
      nodePath.join(cwd, "node_modules"),
      "dir"
    );
    const config = (exit: number) =>
      `pre-commit:\n  jobs:\n    - name: fixture\n      run: bun --no-env-file -e 'process.exit(${exit})'\n`;
    await writeFile(nodePath.join(cwd, "lefthook.yml"), config(0));
    successful(process.execPath, ["--no-env-file", "run", "prepare"], cwd);
    const hook = await readFile(
      nodePath.join(cwd, ".git/hooks/pre-commit"),
      "utf-8"
    );
    assert.match(hook, /lefthook/u);
    assert.doesNotMatch(hook, /\.lefthookrc|scripts\/lefthook/u);
    await writeFile(nodePath.join(cwd, "fixture.txt"), "Hook fixture.\n");
    successful("git", ["add", "--", "fixture.txt"], cwd);
    const passed = successful("git", ["hook", "run", "pre-commit"], cwd);
    assert.match(passed.stdout + passed.stderr, /fixture/u);
    await writeFile(nodePath.join(cwd, "lefthook.yml"), config(1));
    const failed = run("git", ["hook", "run", "pre-commit"], cwd);
    assert.notEqual(failed.status, 0, "A failed check must block the commit.");
    assert.match(failed.stdout + failed.stderr, /fixture/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
