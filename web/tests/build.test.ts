import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { createNitro } from "nitro/builder";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("nitro/builder", () => ({
  createNitro: vi.fn(() => Promise.resolve({})),
}));
vi.mock("nitro/vite", () => ({ nitro: vi.fn(() => ({})) }));
vi.mock("@tanstack/react-start/plugin/vite", () => ({
  tanstackStart: () => ({}),
}));
vi.mock("@vitejs/plugin-react", () => ({ default: () => ({}) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

it("builds the pinned Workers preset without reading Vite or Nitro dotenv files", async () => {
  vi.stubEnv("BUILD_REVISION", "a".repeat(40));
  const { default: configure } = await import("../vite.config.ts");
  if (typeof configure !== "function") {
    throw new TypeError("Expected a config factory");
  }
  const config = await configure({ command: "build", mode: "production" });
  expect(config.envDir).toBe(false);
  expect(config.define?.["import.meta.env.TRAINER_BUILD_REVISION"]).toBe(
    JSON.stringify("a".repeat(40))
  );
  expect(createNitro).toHaveBeenCalledWith(
    expect.objectContaining({
      dev: false,
      preset: "cloudflare_module",
      cloudflare: { nodeCompat: true, deployConfig: true },
    }),
    { dotenv: false }
  );
});

it.each(["nested", "hoisted"])(
  "build and development resolve %s Vite under Node without leaking build dotenv",
  async (layout) => {
    const directory = await mkdtemp(nodePath.join(tmpdir(), "trainer-vite-"));
    const web = nodePath.join(directory, "web");
    const modules = nodePath.join(
      layout === "nested" ? web : directory,
      "node_modules"
    );
    const options = {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory },
      encoding: "utf-8" as const,
      timeout: 15_000,
    };
    try {
      await mkdir(nodePath.join(web, "scripts"), { recursive: true });
      await mkdir(nodePath.join(modules, "vite", "bin"), { recursive: true });
      await mkdir(nodePath.join(modules, ".bin"));
      await writeFile(
        nodePath.join(web, "scripts", "dev.ts"),
        await readFile(new URL("../scripts/dev.ts", import.meta.url), "utf-8")
      );
      for (const location of [directory, web]) {
        await writeFile(
          nodePath.join(location, "bunfig.toml"),
          "env = false\n"
        );
      }
      await writeFile(
        nodePath.join(web, ".env"),
        "PT_VITE_DOTENV_FIXTURE=development-only\n"
      );
      const manifest = JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf-8")
      );
      await writeFile(
        nodePath.join(web, "package.json"),
        JSON.stringify({ type: "module", scripts: manifest.scripts })
      );
      await writeFile(
        nodePath.join(modules, "vite", "package.json"),
        JSON.stringify({
          name: "vite",
          type: "module",
          exports: { "./package.json": "./package.json" },
        })
      );
      const cli = nodePath.join(modules, "vite", "bin", "vite.js");
      await writeFile(
        cli,
        `#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
assert.equal(process.versions.bun, undefined, "Vite must run under Node.");
if (process.argv[2] === "build") {
  assert.equal(process.env.PT_VITE_DOTENV_FIXTURE, undefined);
  await mkdir(".output");
  await writeFile(".output/worker.js", "built");
} else {
  assert.deepEqual(process.argv.slice(2), ["--port", "3000"]);
  assert.equal(process.env.PT_VITE_DOTENV_FIXTURE, "development-only");
  console.log("Development dotenv loaded under Node.");
}
`
      );
      await chmod(cli, 0o755);
      await symlink(
        "../vite/bin/vite.js",
        nodePath.join(modules, ".bin", "vite")
      );
      const build = spawnSync(
        "bun",
        ["--no-env-file", "run", "--cwd", web, "build"],
        options
      );
      expect(build.status, build.stderr).toBe(0);
      expect(
        await readFile(nodePath.join(web, ".output", "worker.js"), "utf-8")
      ).toBe("built");
      const dev = spawnSync("bun", ["run", "--cwd", web, "dev"], options);
      expect(dev.status, dev.stderr).toBe(0);
      expect(dev.stdout).toContain("Development dotenv loaded under Node.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

it.each(["", "HEAD", "abc1234", "A".repeat(40)])(
  "refuses invalid build revision %j",
  async (revision) => {
    vi.stubEnv("BUILD_REVISION", revision);
    await expect(import("../vite.config.ts")).rejects.toThrow(
      "BUILD_REVISION must be the full lowercase source commit."
    );
  }
);
